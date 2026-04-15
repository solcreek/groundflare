/**
 * Minimal AWS SigV4 signer for R2 (S3-compatible).
 *
 * Implements just enough of the SigV4 spec to sign requests to
 * Cloudflare R2 at `<account-id>.r2.cloudflarestorage.com`. Region is
 * always `"auto"`, service is `"s3"`. Uses Bun's Web Crypto for SHA-256
 * + HMAC so there's no external dependency.
 *
 * Reference: https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 *
 * Scope note: signs REQUESTS, not pre-signed URLs. Streaming payloads
 * are supported via the UNSIGNED-PAYLOAD mode (set `payloadHash` to
 * the literal string "UNSIGNED-PAYLOAD"); inline payloads must have
 * their SHA-256 pre-computed by the caller to keep the signer stream-
 * independent.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256'

export interface SigV4Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** Session token for temporary credentials (STS); rarely used with R2. */
  readonly sessionToken?: string
}

export interface SignOptions {
  readonly method: string
  readonly url: string
  /** Request headers, lower-cased keys. `host` is computed from `url`. */
  readonly headers: Record<string, string>
  /** Hex-encoded SHA-256 of the body, or the literal "UNSIGNED-PAYLOAD". */
  readonly payloadHash: string
  /** Region. R2 is always "auto". */
  readonly region: string
  /** Service. S3-compatible is "s3". */
  readonly service: string
  /** Injectable for deterministic tests. Defaults to Date.now(). */
  readonly nowMs?: number
  readonly credentials: SigV4Credentials
}

export interface SignedHeaders {
  readonly authorization: string
  readonly xAmzContentSha256: string
  readonly xAmzDate: string
  readonly xAmzSecurityToken?: string
}

export async function signRequest(
  opts: SignOptions,
): Promise<Record<string, string>> {
  const now = opts.nowMs ?? Date.now()
  const { date, dateTime } = formatAmzDate(now)
  const url = new URL(opts.url)

  const headers: Record<string, string> = {
    ...lowerKeys(opts.headers),
    host: url.host,
    'x-amz-content-sha256': opts.payloadHash,
    'x-amz-date': dateTime,
  }
  if (opts.credentials.sessionToken) {
    headers['x-amz-security-token'] = opts.credentials.sessionToken
  }

  const signedHeaderNames = Object.keys(headers).sort()
  const canonicalHeaders =
    signedHeaderNames.map((k) => `${k}:${headers[k]!.trim()}`).join('\n') + '\n'
  const signedHeaders = signedHeaderNames.join(';')

  const canonicalQuery = canonicalizeQuery(url.searchParams)
  const canonicalRequest = [
    opts.method.toUpperCase(),
    encodeURIPathPreservingSlashes(url.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join('\n')

  const credentialScope = `${date}/${opts.region}/${opts.service}/aws4_request`
  const stringToSign = [
    ALGORITHM,
    dateTime,
    credentialScope,
    await hexSha256(canonicalRequest),
  ].join('\n')

  const signingKey = await deriveSigningKey(
    opts.credentials.secretAccessKey,
    date,
    opts.region,
    opts.service,
  )
  const signature = await hexHmac(signingKey, stringToSign)

  const authorization =
    `${ALGORITHM} Credential=${opts.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`

  const out: Record<string, string> = {
    ...headers,
    authorization,
  }
  return out
}

// ─── helpers ───────────────────────────────────────────────────────

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v
  return out
}

function formatAmzDate(now: number): { date: string; dateTime: string } {
  const iso = new Date(now).toISOString()
  // "2026-04-15T01:02:03.456Z" → "20260415T010203Z" and "20260415"
  const dateTime = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return { date: dateTime.slice(0, 8), dateTime }
}

export async function hexSha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  )
  return toHex(new Uint8Array(buf))
}

export async function hexSha256Bytes(input: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', input as BufferSource)
  return toHex(new Uint8Array(buf))
}

async function hexHmac(key: Uint8Array, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    k,
    new TextEncoder().encode(message),
  )
  return toHex(new Uint8Array(sig))
}

async function hmacRaw(
  key: Uint8Array,
  message: string,
): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    k,
    new TextEncoder().encode(message),
  )
  return new Uint8Array(sig)
}

async function deriveSigningKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kSecret = new TextEncoder().encode('AWS4' + secret)
  const kDate = await hmacRaw(kSecret, date)
  const kRegion = await hmacRaw(kDate, region)
  const kService = await hmacRaw(kRegion, service)
  return hmacRaw(kService, 'aws4_request')
}

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * URL-encode every path segment individually; preserve "/". Matches
 * AWS's "URI Encode" rules (RFC 3986 unreserved set).
 */
function encodeURIPathPreservingSlashes(path: string): string {
  if (path === '' || path === '/') return '/'
  return path
    .split('/')
    .map((seg) => seg.replace(/[^A-Za-z0-9\-._~]/g, (c) => percentEncode(c)))
    .join('/')
}

function canonicalizeQuery(params: URLSearchParams): string {
  const pairs: [string, string][] = []
  for (const [k, v] of params) pairs.push([k, v])
  pairs.sort(([ak, av], [bk, bv]) =>
    ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1,
  )
  return pairs
    .map(
      ([k, v]) =>
        `${encodeRFC3986(k)}=${encodeRFC3986(v)}`,
    )
    .join('&')
}

function encodeRFC3986(s: string): string {
  return s.replace(/[^A-Za-z0-9\-._~]/g, (c) => percentEncode(c))
}

function percentEncode(c: string): string {
  const bytes = new TextEncoder().encode(c)
  let out = ''
  for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  return out
}
