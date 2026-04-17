/**
 * Bun-runtime R2 adapter — implements the Cloudflare Workers R2 surface
 * backed by the Cloudflare R2 S3-compatible API. Ships as source to the
 * VPS; server.ts imports from this file at deploy time.
 *
 * Phase 2d scope:
 *   - get, head, put, delete, list
 *   - SigV4 auth against <accountId>.r2.cloudflarestorage.com
 *   - Payload sent inline (string / ArrayBuffer / Uint8Array) —
 *     streaming bodies not yet supported (revisit in Phase 3)
 *   - customMetadata via x-amz-meta-* headers
 *   - Multipart upload API surface deferred to Phase 3
 *
 * Credentials come from process.env at construction time, not baked
 * into server.ts — keeps secrets out of the compiled artifact. The
 * shim reads `process.env.R2_<BINDING>_{ACCESS_KEY_ID, SECRET_ACCESS_KEY,
 * ACCOUNT_ID}` and hands them to this adapter.
 */

import { signRequest, hexSha256Bytes, type SigV4Credentials } from './sigv4.ts'

// ─── result shapes (mirror CF R2) ─────────────────────────────────

export interface R2HTTPMetadata {
  contentType?: string
  contentLanguage?: string
  contentDisposition?: string
  contentEncoding?: string
  cacheControl?: string
  cacheExpiry?: Date
}

export interface R2Object {
  readonly key: string
  readonly version: string
  readonly size: number
  readonly etag: string
  readonly httpEtag: string
  readonly uploaded: Date
  readonly httpMetadata?: R2HTTPMetadata
  readonly customMetadata?: Record<string, string>
}

export interface R2ObjectBody extends R2Object {
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
  blob(): Promise<Blob>
}

export interface R2ListOptions {
  prefix?: string
  limit?: number
  cursor?: string
  delimiter?: string
}

export interface R2Listed {
  readonly objects: R2Object[]
  readonly truncated: boolean
  readonly cursor?: string
  readonly delimitedPrefixes: string[]
}

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata
  customMetadata?: Record<string, string>
}

export type R2PutValue = ArrayBuffer | ArrayBufferView | string | null

export interface R2Adapter {
  get(key: string): Promise<R2ObjectBody | null>
  head(key: string): Promise<R2Object | null>
  put(
    key: string,
    value: R2PutValue,
    options?: R2PutOptions,
  ): Promise<R2Object>
  delete(key: string | string[]): Promise<void>
  list(options?: R2ListOptions): Promise<R2Listed>
}

// ─── adapter ──────────────────────────────────────────────────────

export interface BunR2AdapterOptions {
  /** Bucket name. Always required. */
  readonly bucket: string

  /**
   * Endpoint URL (no trailing slash) the adapter routes S3 traffic to.
   * Mutually exclusive with `accountId`. When neither is set, defaults
   * to `http://127.0.0.1:8333` — the local SeaweedFS sidecar
   * groundflare's cloud-init installs on the Bun track (same default
   * as the Mirror track).
   */
  readonly endpoint?: string

  /**
   * Cloudflare account ID shortcut. Equivalent to setting
   * `endpoint = "https://<accountId>.r2.cloudflarestorage.com"`.
   * Preserved for backwards compatibility with the pre-v0.5.1 Bun
   * adapter where accountId was the only way to target CF R2.
   */
  readonly accountId?: string

  /**
   * AWS region for SigV4 signing. Default `"auto"` when using
   * accountId (CF R2 convention), `"us-east-1"` otherwise.
   */
  readonly region?: string

  /**
   * SigV4 access key. Optional — when absent (along with
   * secretAccessKey), requests go out unsigned, which is fine for a
   * local SeaweedFS sidecar in anonymous mode. Signed mode is
   * required for CF R2 / B2 / Wasabi / any other S3-compatible
   * endpoint with authentication.
   */
  readonly accessKeyId?: string
  readonly secretAccessKey?: string

  /**
   * Override the fetch implementation (tests inject a mock; production
   * uses globalThis.fetch). Must match the standard fetch signature.
   */
  readonly fetch?: typeof fetch
  /** Injectable clock for deterministic test timings. */
  readonly now?: () => number
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8333'
const SERVICE = 's3'

export class BunR2Adapter implements R2Adapter {
  private readonly baseUrl: string
  private readonly credentials: SigV4Credentials | null
  private readonly region: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly opts: BunR2AdapterOptions) {
    if (!opts.bucket) {
      throw new TypeError('BunR2Adapter: bucket is required')
    }
    const hasAccessKey = Boolean(opts.accessKeyId)
    const hasSecret = Boolean(opts.secretAccessKey)
    if (hasAccessKey !== hasSecret) {
      throw new TypeError(
        'BunR2Adapter: accessKeyId and secretAccessKey must be set together',
      )
    }
    // Resolve endpoint precedence: explicit endpoint > accountId shortcut
    // > local SeaweedFS default. accountId + endpoint both set is a
    // config error worth shouting about.
    let root: string
    let defaultRegion: string
    if (opts.endpoint) {
      if (opts.accountId) {
        throw new TypeError(
          'BunR2Adapter: pass either endpoint or accountId, not both',
        )
      }
      root = opts.endpoint.replace(/\/$/, '')
      defaultRegion = 'us-east-1'
    } else if (opts.accountId) {
      root = `https://${opts.accountId}.r2.cloudflarestorage.com`
      defaultRegion = 'auto'
    } else {
      root = DEFAULT_ENDPOINT
      defaultRegion = 'us-east-1'
    }
    this.baseUrl = `${root}/${encodeURIComponent(opts.bucket)}`
    this.credentials =
      hasAccessKey && hasSecret
        ? { accessKeyId: opts.accessKeyId!, secretAccessKey: opts.secretAccessKey! }
        : null
    this.region = opts.region ?? defaultRegion
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    this.now = opts.now ?? Date.now
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const res = await this.request('GET', key)
    if (res.status === 404) return null
    if (!res.ok) throw await toR2Error(res, 'get', key)
    return toObjectBody(res, key)
  }

  async head(key: string): Promise<R2Object | null> {
    const res = await this.request('HEAD', key)
    if (res.status === 404) return null
    if (!res.ok) throw await toR2Error(res, 'head', key)
    return toObject(res, key)
  }

  async put(
    key: string,
    value: R2PutValue,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    if (value === null) {
      // CF R2 treats put(key, null) as writing a zero-byte object.
      value = new Uint8Array(0)
    }
    const body = toBytes(value)
    const payloadHash = await hexSha256Bytes(body)
    const headers: Record<string, string> = {
      'content-length': String(body.byteLength),
    }
    if (options?.httpMetadata) {
      writeHttpMetadataHeaders(headers, options.httpMetadata)
    }
    if (options?.customMetadata) {
      for (const [k, v] of Object.entries(options.customMetadata)) {
        headers[`x-amz-meta-${k.toLowerCase()}`] = v
      }
    }
    const res = await this.request('PUT', key, {
      headers,
      body,
      payloadHash,
    })
    if (!res.ok) throw await toR2Error(res, 'put', key)
    return toObject(res, key, body.byteLength)
  }

  async delete(key: string | string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key]
    for (const k of keys) {
      const res = await this.request('DELETE', k)
      // R2 returns 204 on successful delete; 404 is idempotent-OK.
      if (!res.ok && res.status !== 404) {
        throw await toR2Error(res, 'delete', k)
      }
    }
  }

  async list(options: R2ListOptions = {}): Promise<R2Listed> {
    const query = new URLSearchParams({ 'list-type': '2' })
    if (options.prefix) query.set('prefix', options.prefix)
    if (options.limit !== undefined) {
      query.set('max-keys', String(Math.min(1000, Math.max(1, options.limit))))
    }
    if (options.cursor) query.set('continuation-token', options.cursor)
    if (options.delimiter) query.set('delimiter', options.delimiter)

    const res = await this.requestAt('GET', '', query.toString())
    if (!res.ok) throw await toR2Error(res, 'list', options.prefix ?? '')

    const xml = await res.text()
    return parseListResult(xml)
  }

  // ─── low-level request helpers ─────────────────────────────────

  private async request(
    method: string,
    key: string,
    init: {
      headers?: Record<string, string>
      body?: Uint8Array
      payloadHash?: string
    } = {},
  ): Promise<Response> {
    return this.requestAt(method, key, '', init)
  }

  private async requestAt(
    method: string,
    key: string,
    query: string,
    init: {
      headers?: Record<string, string>
      body?: Uint8Array
      payloadHash?: string
    } = {},
  ): Promise<Response> {
    const path = key ? '/' + encodeKey(key) : ''
    const url = this.baseUrl + path + (query ? '?' + query : '')
    const headers = init.headers ?? {}
    // Unsigned path: local SeaweedFS in anonymous mode. The adapter
    // skips SigV4 entirely — headers pass through, no x-amz-date,
    // no Authorization. weed serves the request the same as any
    // direct curl would.
    if (this.credentials === null) {
      return this.fetchImpl(url, {
        method,
        headers,
        body: init.body ? (init.body as BodyInit) : undefined,
      })
    }
    const payloadHash =
      init.payloadHash ??
      (init.body ? await hexSha256Bytes(init.body) : EMPTY_SHA256)
    const signed = await signRequest({
      method,
      url,
      headers,
      payloadHash,
      region: this.region,
      service: SERVICE,
      nowMs: this.now(),
      credentials: this.credentials,
    })
    return this.fetchImpl(url, {
      method,
      headers: signed,
      body: init.body ? (init.body as BodyInit) : undefined,
    })
  }
}

// ─── helpers ───────────────────────────────────────────────────────

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function encodeKey(key: string): string {
  // Preserve '/', encode per RFC 3986 unreserved set — matches SigV4's
  // canonical path encoding.
  return key
    .split('/')
    .map((seg) =>
      seg.replace(/[^A-Za-z0-9\-._~]/g, (c) => {
        const bytes = new TextEncoder().encode(c)
        let out = ''
        for (const b of bytes)
          out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
        return out
      }),
    )
    .join('/')
}

function toBytes(value: R2PutValue): Uint8Array {
  if (value === null) return new Uint8Array(0)
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new TypeError('R2 put: unsupported value type')
}

function writeHttpMetadataHeaders(
  headers: Record<string, string>,
  m: R2HTTPMetadata,
): void {
  if (m.contentType) headers['content-type'] = m.contentType
  if (m.contentLanguage) headers['content-language'] = m.contentLanguage
  if (m.contentDisposition) headers['content-disposition'] = m.contentDisposition
  if (m.contentEncoding) headers['content-encoding'] = m.contentEncoding
  if (m.cacheControl) headers['cache-control'] = m.cacheControl
  if (m.cacheExpiry) headers['expires'] = m.cacheExpiry.toUTCString()
}

function readHttpMetadata(res: Response): R2HTTPMetadata {
  const m: R2HTTPMetadata = {}
  const ct = res.headers.get('content-type')
  if (ct) m.contentType = ct
  const cl = res.headers.get('content-language')
  if (cl) m.contentLanguage = cl
  const cd = res.headers.get('content-disposition')
  if (cd) m.contentDisposition = cd
  const ce = res.headers.get('content-encoding')
  if (ce) m.contentEncoding = ce
  const cc = res.headers.get('cache-control')
  if (cc) m.cacheControl = cc
  const ex = res.headers.get('expires')
  if (ex) {
    const d = new Date(ex)
    if (!Number.isNaN(d.getTime())) m.cacheExpiry = d
  }
  return m
}

function readCustomMetadata(res: Response): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [k, v] of res.headers) {
    if (k.toLowerCase().startsWith('x-amz-meta-')) {
      out[k.slice('x-amz-meta-'.length).toLowerCase()] = v
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function toObject(res: Response, key: string, sizeOverride?: number): R2Object {
  const etag = (res.headers.get('etag') ?? '').replace(/^"|"$/g, '')
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  const lastModified = res.headers.get('last-modified')
  const uploaded = lastModified ? new Date(lastModified) : new Date()
  const httpMetadata = readHttpMetadata(res)
  const customMetadata = readCustomMetadata(res)
  return {
    key,
    version: etag, // R2 uses the etag as an opaque version token
    size: sizeOverride ?? contentLength,
    etag,
    httpEtag: `"${etag}"`,
    uploaded,
    httpMetadata,
    customMetadata,
  }
}

function toObjectBody(res: Response, key: string): R2ObjectBody {
  const meta = toObject(res, key)
  return {
    ...meta,
    async arrayBuffer() {
      return await res.arrayBuffer()
    },
    async text() {
      return await res.text()
    },
    async json<T = unknown>() {
      return (await res.json()) as T
    },
    async blob() {
      return await res.blob()
    },
  }
}

async function toR2Error(
  res: Response,
  op: string,
  key: string,
): Promise<Error> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    // Body read failed — fall back to status/statusText below.
  }
  const msg = body
    ? body.replace(/\n+/g, ' ').slice(0, 400)
    : `${res.status} ${res.statusText}`
  return new Error(`R2.${op}(${JSON.stringify(key)}) failed: ${msg}`)
}

// ─── minimal S3 ListObjectsV2 XML parser ─────────────────────────

function parseListResult(xml: string): R2Listed {
  const objects: R2Object[] = []
  const prefixes: string[] = []
  let truncated = false
  let cursor: string | undefined

  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const chunk = m[1]!
    const key = extractTag(chunk, 'Key')
    const etag = extractTag(chunk, 'ETag')?.replace(/^"|"$/g, '') ?? ''
    const sizeText = extractTag(chunk, 'Size')
    const lastModified = extractTag(chunk, 'LastModified')
    if (!key) continue
    objects.push({
      key,
      version: etag,
      size: sizeText ? Number(sizeText) : 0,
      etag,
      httpEtag: etag ? `"${etag}"` : '',
      uploaded: lastModified ? new Date(lastModified) : new Date(),
    })
  }
  for (const m of xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) {
    const p = extractTag(m[1]!, 'Prefix')
    if (p) prefixes.push(p)
  }
  const truncatedTag = extractTag(xml, 'IsTruncated')
  if (truncatedTag === 'true') truncated = true
  const nextCursor = extractTag(xml, 'NextContinuationToken')
  if (nextCursor) cursor = nextCursor

  return { objects, truncated, cursor, delimitedPrefixes: prefixes }
}

function extractTag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return m ? decodeXmlEntities(m[1]!) : undefined
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
