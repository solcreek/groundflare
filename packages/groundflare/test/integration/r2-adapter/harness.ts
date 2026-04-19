/**
 * Test harness for the R2 adapter integration tests.
 *
 * Spins up:
 *   - A Node http.Server acting as the S3 backend (programmable per-test)
 *   - A workerd process running:
 *       * a `user-worker` exposing /op endpoints that exercise an R2 binding
 *       * the real adapter.worker.js (built from src/) wired as the
 *         `r2Bucket` binding's backing service
 *       * outbound network access pointed at the mock S3 server
 *
 * Tests drive the user-worker via HTTP, assert the user-visible R2
 * result shape, AND inspect the mock-server's captured requests to
 * confirm the adapter's S3 wire format (method, URL, headers, body).
 *
 * Pure Node test process — no Docker, no real SeaweedFS. The L3 e2e
 * suite (test/e2e/r2/) covers the SeaweedFS interop path.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { bundleR2Adapter } from '../../../src/runtime/workerd/r2/bundle.js'
import { pickFreePort, spawnWorkerd, type SpawnedWorkerd } from '../spawn-workerd.js'

// ─── Mock S3 server ────────────────────────────────────────────────

export interface CapturedRequest {
  method: string
  /** Path + query string, no scheme/host. */
  url: string
  headers: Record<string, string>
  body: Buffer
}

export interface MockResponse {
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer
}

export type MockHandler = (
  req: CapturedRequest,
) => MockResponse | Promise<MockResponse>

export interface MockS3 {
  readonly port: number
  readonly requests: readonly CapturedRequest[]
  /** Replace the response handler. Default returns 200 with empty body. */
  setHandler(handler: MockHandler): void
  /** Convenience: queue scripted responses in order, one per request. */
  scriptResponses(responses: readonly MockResponse[]): void
  reset(): void
  stop(): Promise<void>
}

const DEFAULT_HANDLER: MockHandler = () => ({ status: 200, body: '' })

export async function startMockS3(): Promise<MockS3> {
  const requests: CapturedRequest[] = []
  let handler: MockHandler = DEFAULT_HANDLER

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: normalizeHeaders(req.headers),
        body: Buffer.concat(chunks),
      }
      requests.push(captured)
      Promise.resolve(handler(captured))
        .then((mock) => {
          const status = mock.status ?? 200
          const headers = mock.headers ?? {}
          res.writeHead(status, headers)
          if (mock.body !== undefined) {
            res.end(mock.body)
          } else {
            res.end()
          }
        })
        .catch((err: Error) => {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end(`mock handler error: ${err.message}`)
        })
    })
  })

  await new Promise<void>((resolveFn, rejectFn) => {
    server.once('error', rejectFn)
    server.listen(0, '127.0.0.1', resolveFn)
  })
  const port = (server.address() as AddressInfo).port

  return {
    port,
    get requests() {
      return requests
    },
    setHandler(h: MockHandler) {
      handler = h
    },
    scriptResponses(responses: readonly MockResponse[]) {
      let i = 0
      handler = () => {
        const r = responses[i++]
        if (!r) {
          return { status: 500, body: `mock: ran out of scripted responses (i=${i - 1})` }
        }
        return r
      }
    },
    reset() {
      requests.length = 0
      handler = DEFAULT_HANDLER
    },
    async stop() {
      await new Promise<void>((resolveFn) => server.close(() => resolveFn()))
    },
  }
}

function normalizeHeaders(
  raw: NodeJS.Dict<string | string[]>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

// ─── User worker source ────────────────────────────────────────────

/**
 * The user worker exposes a single POST /op endpoint that accepts a
 * JSON body describing what R2 operation to invoke. It returns the
 * R2 result (or thrown error) as JSON. Keeps each test definition
 * concise — the user worker doesn't need to encode every R2 quirk.
 */
const USER_WORKER_SOURCE = `
function r2ObjectToJson(obj) {
  if (!obj) return null
  return {
    key: obj.key,
    version: obj.version,
    size: obj.size,
    etag: obj.etag,
    httpEtag: obj.httpEtag,
    uploaded: obj.uploaded ? new Date(obj.uploaded).toISOString() : null,
    httpMetadata: obj.httpMetadata ?? null,
    customMetadata: obj.customMetadata ?? null,
  }
}

async function objectBodyToJson(obj) {
  if (!obj) return null
  const meta = r2ObjectToJson(obj)
  meta.body = await obj.text()
  return meta
}

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return new Response('only POST', { status: 405 })
    const spec = await req.json()
    const bucket = env.MEDIA
    try {
      if (spec.op === 'scrape-metrics') {
        const r = await env.ADAPTER_RAW.fetch('http://gf-internal/__gf_metrics')
        return Response.json({ ok: true, status: r.status, body: await r.text() })
      }
      switch (spec.op) {
        case 'head':
          return Response.json({ ok: true, result: r2ObjectToJson(await bucket.head(spec.key)) })
        case 'get':
          return Response.json({ ok: true, result: await objectBodyToJson(await bucket.get(spec.key, spec.options)) })
        case 'put': {
          const value = spec.bodyBase64 ? Uint8Array.from(atob(spec.bodyBase64), c => c.charCodeAt(0)) : (spec.body ?? null)
          const result = await bucket.put(spec.key, value, spec.options)
          return Response.json({ ok: true, result: r2ObjectToJson(result) })
        }
        case 'delete':
          await bucket.delete(spec.key)
          return Response.json({ ok: true })
        case 'list': {
          const list = await bucket.list(spec.options)
          return Response.json({
            ok: true,
            result: {
              objects: list.objects.map(r2ObjectToJson),
              truncated: list.truncated,
              cursor: list.cursor ?? null,
              delimitedPrefixes: list.delimitedPrefixes,
            },
          })
        }
        case 'createMultipartUpload': {
          const upload = await bucket.createMultipartUpload(spec.key, spec.options)
          return Response.json({ ok: true, result: { uploadId: upload.uploadId, key: upload.key } })
        }
        case 'uploadPart': {
          const upload = bucket.resumeMultipartUpload(spec.key, spec.uploadId)
          const value = spec.bodyBase64 ? Uint8Array.from(atob(spec.bodyBase64), c => c.charCodeAt(0)) : spec.body
          const part = await upload.uploadPart(spec.partNumber, value)
          return Response.json({ ok: true, result: { partNumber: part.partNumber, etag: part.etag } })
        }
        case 'completeMultipartUpload': {
          const upload = bucket.resumeMultipartUpload(spec.key, spec.uploadId)
          const result = await upload.complete(spec.parts)
          return Response.json({ ok: true, result: r2ObjectToJson(result) })
        }
        case 'abortMultipartUpload': {
          const upload = bucket.resumeMultipartUpload(spec.key, spec.uploadId)
          await upload.abort()
          return Response.json({ ok: true })
        }
        default:
          return Response.json({ ok: false, error: 'unknown op: ' + spec.op }, { status: 400 })
      }
    } catch (e) {
      return Response.json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        name: e instanceof Error ? e.name : null,
      }, { status: 200 })
    }
  },
}
`

// ─── Capnp generation ──────────────────────────────────────────────

interface CapnpOptions {
  port: number
  bucket: string
  s3Endpoint: string
  credentials?: { accessKey: string; secretKey: string; region?: string }
}

function generateCapnp(opts: CapnpOptions): string {
  const cred = opts.credentials
  const adapterBindings: string[] = [
    `( name = "BUCKET_NAME", text = "${opts.bucket}" )`,
    `( name = "S3_ENDPOINT", text = "${opts.s3Endpoint}" )`,
    // Labels so /__gf_metrics output distinguishes adapters. Mirror
    // what buildR2AdapterService emits in production.
    `( name = "GF_WORKER_NAME", text = "user" )`,
    `( name = "GF_BINDING_NAME", text = "MEDIA" )`,
  ]
  if (cred) {
    adapterBindings.push(`( name = "S3_REGION", text = "${cred.region ?? 'us-east-1'}" )`)
    adapterBindings.push(`( name = "S3_ACCESS_KEY", text = "${cred.accessKey}" )`)
    adapterBindings.push(`( name = "S3_SECRET_KEY", text = "${cred.secretKey}" )`)
  }
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "user",
      worker = (
        compatibilityDate = "2024-09-23",
        modules = [( name = "user.js", esModule = embed "user.js" )],
        bindings = [
          ( name = "MEDIA", r2Bucket = "r2-adapter" ),
          # Raw service binding used by the /scrape-metrics test op so
          # user code can hit the adapter's /__gf_metrics endpoint
          # without going through the R2 wire protocol. In production
          # the Router holds this binding, not user code.
          ( name = "ADAPTER_RAW", service = "r2-adapter" ),
        ],
      ),
    ),
    ( name = "r2-adapter",
      worker = (
        compatibilityDate = "2024-09-23",
        compatibilityFlags = ["nodejs_compat"],
        modules = [( name = "adapter.js", esModule = embed "adapter.js" )],
        bindings = [
          ${adapterBindings.join(',\n          ')}
        ],
        globalOutbound = "internet",
      ),
    ),
    ( name = "internet",
      network = ( allow = ["public", "private"] ),
    ),
  ],
  sockets = [
    ( name = "http", address = "*:${opts.port}", http = (), service = "user" ),
  ]
);
`
}

// ─── Stack lifecycle ───────────────────────────────────────────────

export interface AdapterStack {
  readonly mock: MockS3
  readonly workerd: SpawnedWorkerd
  /** POST /op to the user worker with the given spec. Returns parsed JSON. */
  sendOp(spec: Record<string, unknown>): Promise<unknown>
  stop(): Promise<void>
}

export interface SetupOptions {
  /** SigV4 credentials for the adapter (omit for unsigned). */
  readonly credentials?: { accessKey: string; secretKey: string; region?: string }
  /** Bucket name. Default 'media'. */
  readonly bucket?: string
}

export async function setupAdapterStack(
  opts: SetupOptions = {},
): Promise<AdapterStack> {
  const mock = await startMockS3()
  const workerdPort = await pickFreePort()
  const adapter = await bundleR2Adapter()
  const capnp = generateCapnp({
    port: workerdPort,
    bucket: opts.bucket ?? 'media',
    s3Endpoint: `http://127.0.0.1:${mock.port}`,
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  })

  let workerd: SpawnedWorkerd
  try {
    workerd = await spawnWorkerd({
      port: workerdPort,
      capnp,
      modules: {
        'user.js': USER_WORKER_SOURCE,
        'adapter.js': adapter.code,
      },
      healthTimeoutMs: 8_000,
    })
  } catch (err) {
    await mock.stop()
    throw err
  }

  return {
    mock,
    workerd,
    async sendOp(spec) {
      const res = await workerd.sendRequest({
        host: 'r2-test.example',
        method: 'POST',
        path: '/op',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(spec),
      })
      try {
        return JSON.parse(res.body)
      } catch {
        throw new Error(`non-JSON response from user worker (status=${res.status}): ${res.body.slice(0, 400)}`)
      }
    },
    async stop() {
      await workerd.stop()
      await mock.stop()
    },
  }
}

// ─── Common S3 fixtures ────────────────────────────────────────────

/**
 * Build a successful S3 response for HEAD/GET — sets the headers a
 * real S3 would return for an object.
 */
export function s3ObjectHeaders(opts: {
  size: number
  etag?: string
  contentType?: string
  lastModified?: string
  customMeta?: Record<string, string>
}): Record<string, string> {
  const h: Record<string, string> = {
    'content-length': String(opts.size),
    etag: `"${opts.etag ?? 'fixed-etag'}"`,
    'last-modified': opts.lastModified ?? 'Sun, 17 Apr 2026 00:00:00 GMT',
  }
  if (opts.contentType) h['content-type'] = opts.contentType
  if (opts.customMeta) {
    for (const [k, v] of Object.entries(opts.customMeta)) {
      h[`x-amz-meta-${k.toLowerCase()}`] = v
    }
  }
  return h
}

/** Build an S3 ListObjectsV2 XML body for a small fixture set. */
export function listXml(opts: {
  bucket?: string
  objects: Array<{ key: string; size: number; etag?: string }>
  truncated?: boolean
  nextCursor?: string
  prefixes?: string[]
}): string {
  const bucket = opts.bucket ?? 'media'
  const contents = opts.objects
    .map(
      (o) => `<Contents>
  <Key>${escapeXml(o.key)}</Key>
  <Size>${o.size}</Size>
  <ETag>"${o.etag ?? 'e'}"</ETag>
  <LastModified>2026-04-17T00:00:00Z</LastModified>
</Contents>`,
    )
    .join('\n')
  const prefixes = (opts.prefixes ?? [])
    .map((p) => `<CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`)
    .join('\n')
  const cursor = opts.nextCursor
    ? `<NextContinuationToken>${escapeXml(opts.nextCursor)}</NextContinuationToken>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucket)}</Name>
  <IsTruncated>${opts.truncated ?? false}</IsTruncated>
  ${cursor}
  ${contents}
  ${prefixes}
</ListBucketResult>`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
