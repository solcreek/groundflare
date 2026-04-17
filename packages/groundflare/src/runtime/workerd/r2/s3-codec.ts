/**
 * R2 ↔ S3 codec.
 *
 * Pure functions that translate parsed R2 wire ops (from r2-codec) into
 * S3 REST request plans, and S3 responses back into R2-shaped metadata.
 * No I/O — adapter.worker.ts orchestrates the actual fetch + signing.
 *
 * Reference for R2 op shapes: workerd `src/workerd/api/r2-api.capnp`.
 * Reference for S3 wire format: AWS S3 REST API + ListObjectsV2 spec.
 *
 * Design notes:
 * - Capnp's JSON codec omits fields with default values, so all op
 *   sub-fields are checked with `op.foo !== undefined` rather than
 *   schema-validated. Forward-compat (workerd adds new fields) just
 *   means we ignore them.
 * - List XML uses a regex-based parser rather than a real XML library
 *   to keep the bundle small. ListObjectsV2 schema is well-defined and
 *   stable; the regex form has been battle-tested in this codebase
 *   (bun/adapters/r2.ts).
 * - Streaming PUT/UploadPart use 'UNSIGNED-PAYLOAD' as the SHA256 — full
 *   buffering would defeat the streaming pipeline. SigV4 still authenticates
 *   the headers; the body integrity is left to TLS/transport.
 */

import type { R2Op } from './r2-codec.js'

// ─── Type shapes (mirror workerd's R2BindingRequest payloads) ────

export interface R2HttpFields {
  contentType?: string
  contentLanguage?: string
  contentDisposition?: string
  contentEncoding?: string
  cacheControl?: string
  /** Milliseconds since epoch — capnp UInt64. */
  cacheExpiry?: number
}

export interface R2KV {
  k: string
  v: string
}

export interface R2Range {
  offset?: number
  length?: number
  suffix?: number
}

/**
 * R2 etag matcher discriminator.
 *
 * Capnp's `$Json.discriminator(name="type")` serializes the type union
 * as a STRING (e.g. `"strong"`), but some R2 SDK paths still emit the
 * legacy nested-object form (`{ strong: null }`). We accept both and
 * normalize internally — saves brittle assumption breakage.
 */
export type R2EtagType =
  | 'strong'
  | 'weak'
  | 'wildcard'
  | { strong?: null }
  | { weak?: null }
  | { wildcard?: null }

export interface R2EtagMatcher {
  value: string
  type: R2EtagType
}

export interface R2Conditional {
  etagMatches?: R2EtagMatcher[]
  etagDoesNotMatch?: R2EtagMatcher[]
  /** Milliseconds since epoch. */
  uploadedBefore?: number
  /** Milliseconds since epoch. */
  uploadedAfter?: number
  secondsGranularity?: boolean
}

export interface R2HeadResponse {
  name: string
  version: string
  size: number
  etag: string
  /** Milliseconds since epoch. */
  uploaded: number
  httpFields: R2HttpFields
  customFields: R2KV[]
  range?: R2Range
  storageClass?: string
}

export interface R2ListResponse {
  objects: R2HeadResponse[]
  truncated: boolean
  cursor?: string
  delimitedPrefixes: string[]
}

// ─── Request planner ───────────────────────────────────────────────

export interface S3CodecContext {
  /** S3 bucket name (path-style first segment, e.g. 'media'). */
  readonly bucket: string
  /** Endpoint URL with no trailing slash, e.g. 'http://127.0.0.1:8333'. */
  readonly endpoint: string
}

export interface S3RequestPlan {
  method: string
  url: string
  headers: Record<string, string>
  /**
   * Body for the S3 request. ReadableStream means use chunked transfer
   * (and pair with payloadHash='UNSIGNED-PAYLOAD'). Uint8Array means
   * inline body with computed SHA256.
   */
  body: Uint8Array | ReadableStream<Uint8Array> | null
  /** Hex SHA256 of body, or 'UNSIGNED-PAYLOAD' literal for streaming. */
  payloadHash: string
}

/**
 * Build an S3 REST request plan for the given R2 op.
 *
 * Throws TypeError for ops we don't yet support (with a message the
 * adapter can convert to an R2 error response).
 */
export function r2OpToS3Request(
  op: R2Op,
  payload: ReadableStream<Uint8Array> | null,
  ctx: S3CodecContext,
): S3RequestPlan {
  switch (op.method) {
    case 'head':
      return planHead(op, ctx)
    case 'get':
      return planGet(op, ctx)
    case 'put':
      return planPut(op, payload, ctx)
    case 'delete':
      return planDelete(op, ctx)
    case 'list':
      return planList(op, ctx)
    case 'createMultipartUpload':
      return planCreateMultipart(op, ctx)
    case 'uploadPart':
      return planUploadPart(op, payload, ctx)
    case 'completeMultipartUpload':
      return planCompleteMultipart(op, ctx)
    case 'abortMultipartUpload':
      return planAbortMultipart(op, ctx)
    default:
      throw new TypeError(`Unsupported R2 op method: ${String(op.method)}`)
  }
}

function planHead(op: R2Op, ctx: S3CodecContext): S3RequestPlan {
  const key = requireString(op.object, 'head.object')
  return {
    method: 'HEAD',
    url: objectUrl(ctx, key),
    headers: {},
    body: null,
    payloadHash: EMPTY_SHA256,
  }
}

function planGet(op: R2Op, ctx: S3CodecContext): S3RequestPlan {
  const key = requireString(op.object, 'get.object')
  const headers: Record<string, string> = {}
  const rangeHeader = rangeToS3Header(op.range as R2Range | undefined, op.rangeHeader as string | undefined)
  if (rangeHeader !== null) headers['range'] = rangeHeader
  Object.assign(headers, conditionalToS3Headers(op.onlyIf as R2Conditional | undefined))
  return {
    method: 'GET',
    url: objectUrl(ctx, key),
    headers,
    body: null,
    payloadHash: EMPTY_SHA256,
  }
}

function planPut(
  op: R2Op,
  payload: ReadableStream<Uint8Array> | null,
  ctx: S3CodecContext,
): S3RequestPlan {
  const key = requireString(op.object, 'put.object')
  const headers: Record<string, string> = {}
  Object.assign(headers, httpFieldsToS3Headers(op.httpFields as R2HttpFields | undefined))
  Object.assign(headers, customFieldsToS3Headers(op.customFields as R2KV[] | undefined))
  Object.assign(headers, conditionalToS3Headers(op.onlyIf as R2Conditional | undefined))
  if (typeof op.storageClass === 'string' && op.storageClass !== '') {
    headers['x-amz-storage-class'] = op.storageClass
  }
  return {
    method: 'PUT',
    url: objectUrl(ctx, key),
    headers,
    body: payload,
    payloadHash: payload === null ? EMPTY_SHA256 : 'UNSIGNED-PAYLOAD',
  }
}

function planDelete(op: R2Op, ctx: S3CodecContext): S3RequestPlan {
  // Single-object delete only for v0.5; batch delete (POST ?delete) is
  // a separate S3 op we map separately if op.objects[] is present.
  if (Array.isArray(op.objects)) {
    throw new TypeError('Batch delete not yet supported (object array form)')
  }
  const key = requireString(op.object, 'delete.object')
  return {
    method: 'DELETE',
    url: objectUrl(ctx, key),
    headers: {},
    body: null,
    payloadHash: EMPTY_SHA256,
  }
}

function planList(op: R2Op, ctx: S3CodecContext): S3RequestPlan {
  const params = new URLSearchParams()
  params.set('list-type', '2')
  if (typeof op.prefix === 'string' && op.prefix !== '') params.set('prefix', op.prefix)
  if (typeof op.limit === 'number' && op.limit > 0 && op.limit < 0xffffffff) {
    params.set('max-keys', String(Math.min(1000, op.limit)))
  }
  if (typeof op.cursor === 'string' && op.cursor !== '') {
    params.set('continuation-token', op.cursor)
  }
  if (typeof op.delimiter === 'string' && op.delimiter !== '') {
    params.set('delimiter', op.delimiter)
  }
  if (typeof op.startAfter === 'string' && op.startAfter !== '') {
    params.set('start-after', op.startAfter)
  }
  return {
    method: 'GET',
    url: `${ctx.endpoint}/${encodePathSegment(ctx.bucket)}/?${params.toString()}`,
    headers: {},
    body: null,
    payloadHash: EMPTY_SHA256,
  }
}

function planCreateMultipart(op: R2Op, ctx: S3CodecContext): S3RequestPlan {
  const key = requireString(op.object, 'createMultipartUpload.object')
  const headers: Record<string, string> = {}
  Object.assign(headers, httpFieldsToS3Headers(op.httpFields as R2HttpFields | undefined))
  Object.assign(headers, customFieldsToS3Headers(op.customFields as R2KV[] | undefined))
  if (typeof op.storageClass === 'string' && op.storageClass !== '') {
    headers['x-amz-storage-class'] = op.storageClass
  }
  return {
    method: 'POST',
    url: `${objectUrl(ctx, key)}?uploads=`,
    headers,
    body: null,
    payloadHash: EMPTY_SHA256,
  }
}

function planUploadPart(
  op: R2Op,
  payload: ReadableStream<Uint8Array> | null,
  ctx: S3CodecContext,
): S3RequestPlan {
  const key = requireString(op.object, 'uploadPart.object')
  const uploadId = requireString(op.uploadId, 'uploadPart.uploadId')
  const partNumber = requirePositiveInt(op.partNumber, 'uploadPart.partNumber')
  const params = new URLSearchParams({
    partNumber: String(partNumber),
    uploadId,
  })
  return {
    method: 'PUT',
    url: `${objectUrl(ctx, key)}?${params.toString()}`,
    headers: {},
    body: payload,
    payloadHash: payload === null ? EMPTY_SHA256 : 'UNSIGNED-PAYLOAD',
  }
}

function planCompleteMultipart(op: R2Op, ctx: S3CodecContext): S3RequestPlan {
  const key = requireString(op.object, 'completeMultipartUpload.object')
  const uploadId = requireString(op.uploadId, 'completeMultipartUpload.uploadId')
  const parts = op.parts
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError('completeMultipartUpload.parts must be a non-empty array')
  }
  const xmlParts: string[] = ['<CompleteMultipartUpload>']
  for (const p of parts as Array<{ part: number; etag: string }>) {
    xmlParts.push('<Part>')
    xmlParts.push(`<PartNumber>${p.part}</PartNumber>`)
    // Escape XML-significant chars in element content. Don't touch quotes
    // (quotes are only special inside attribute values; S3's
    // CompleteMultipartUpload spec wants literal " around the etag value).
    xmlParts.push(`<ETag>${escapeXmlContent(quoteEtag(p.etag))}</ETag>`)
    xmlParts.push('</Part>')
  }
  xmlParts.push('</CompleteMultipartUpload>')
  const xml = xmlParts.join('')
  const body = new TextEncoder().encode(xml)
  return {
    method: 'POST',
    url: `${objectUrl(ctx, key)}?uploadId=${encodeURIComponent(uploadId)}`,
    headers: { 'content-type': 'application/xml', 'content-length': String(body.byteLength) },
    body,
    payloadHash: 'UNSIGNED-PAYLOAD', // small body; signer can recompute if it wants
  }
}

function planAbortMultipart(op: R2Op, ctx: S3CodecContext): S3RequestPlan {
  const key = requireString(op.object, 'abortMultipartUpload.object')
  const uploadId = requireString(op.uploadId, 'abortMultipartUpload.uploadId')
  return {
    method: 'DELETE',
    url: `${objectUrl(ctx, key)}?uploadId=${encodeURIComponent(uploadId)}`,
    headers: {},
    body: null,
    payloadHash: EMPTY_SHA256,
  }
}

// ─── Response decoder ──────────────────────────────────────────────

/**
 * Build an R2HeadResponse from an S3 response (HeadObject / GetObject /
 * PutObject all share the same metadata header set on success).
 *
 * `sizeOverride` is used when we know the size from elsewhere (e.g. PUT
 * after we wrote N bytes) — S3's HEAD-after-PUT can race in some
 * backends and return Content-Length 0.
 */
export function s3ResponseToR2Meta(
  res: Response,
  key: string,
  sizeOverride?: number,
): R2HeadResponse {
  const etag = unquoteEtag(res.headers.get('etag') ?? '')
  const lastMod = res.headers.get('last-modified')
  const uploaded = lastMod ? Date.parse(lastMod) : Date.now()
  const sizeHeader = res.headers.get('content-length')
  const size = sizeOverride ?? (sizeHeader ? parseInt(sizeHeader, 10) : 0)

  const httpFields: R2HttpFields = {}
  const ct = res.headers.get('content-type')
  if (ct !== null) httpFields.contentType = ct
  const cl = res.headers.get('content-language')
  if (cl !== null) httpFields.contentLanguage = cl
  const cd = res.headers.get('content-disposition')
  if (cd !== null) httpFields.contentDisposition = cd
  const ce = res.headers.get('content-encoding')
  if (ce !== null) httpFields.contentEncoding = ce
  const cc = res.headers.get('cache-control')
  if (cc !== null) httpFields.cacheControl = cc
  const exp = res.headers.get('expires')
  if (exp !== null) {
    const t = Date.parse(exp)
    if (Number.isFinite(t)) httpFields.cacheExpiry = t
  }

  const customFields: R2KV[] = []
  for (const [name, value] of res.headers) {
    const lower = name.toLowerCase()
    if (lower.startsWith('x-amz-meta-')) {
      customFields.push({ k: lower.slice('x-amz-meta-'.length), v: value })
    }
  }

  const out: R2HeadResponse = {
    name: key,
    version: res.headers.get('x-amz-version-id') ?? etag,
    size,
    etag,
    uploaded,
    httpFields,
    customFields,
  }
  const sc = res.headers.get('x-amz-storage-class')
  if (sc !== null) out.storageClass = sc
  return out
}

/**
 * Parse an S3 ListObjectsV2 XML response into an R2ListResponse.
 * Permissive regex parser — handles the well-formed output that
 * SeaweedFS / MinIO / B2 / S3 emit. Throws on parse failure.
 */
export function parseListXmlV2(xml: string): R2ListResponse {
  const objects: R2HeadResponse[] = []
  const delimitedPrefixes: string[] = []

  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const inner = m[1]!
    const key = decodeXmlEntities(extractTag(inner, 'Key') ?? '')
    if (key === '') continue
    const etag = unquoteEtag(decodeXmlEntities(extractTag(inner, 'ETag') ?? ''))
    const sizeText = extractTag(inner, 'Size')
    const size = sizeText !== null ? parseInt(sizeText, 10) : 0
    const lastMod = extractTag(inner, 'LastModified')
    const uploaded = lastMod !== null ? Date.parse(lastMod) : 0
    const storageClass = extractTag(inner, 'StorageClass')
    const obj: R2HeadResponse = {
      name: key,
      version: etag,
      size,
      etag,
      uploaded: Number.isFinite(uploaded) ? uploaded : 0,
      httpFields: {},
      customFields: [],
    }
    if (storageClass !== null) obj.storageClass = storageClass
    objects.push(obj)
  }

  for (const m of xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) {
    const p = decodeXmlEntities(extractTag(m[1]!, 'Prefix') ?? '')
    if (p !== '') delimitedPrefixes.push(p)
  }

  const truncated = extractTag(xml, 'IsTruncated') === 'true'
  const cursor = extractTag(xml, 'NextContinuationToken')

  const out: R2ListResponse = {
    objects,
    truncated,
    delimitedPrefixes,
  }
  if (cursor !== null && cursor !== '') out.cursor = cursor
  return out
}

/**
 * Parse the response from S3 InitiateMultipartUpload (returns UploadId
 * in XML). Returns the upload id, throws on parse failure.
 */
export function parseInitiateMultipartXml(xml: string): { uploadId: string } {
  const id = extractTag(xml, 'UploadId')
  if (id === null || id === '') {
    throw new Error('InitiateMultipartUpload XML missing UploadId')
  }
  return { uploadId: id }
}

/**
 * Parse the response from S3 UploadPart — actually we only need the
 * etag from the response headers, but for S3 the part etag comes back
 * as a header. This helper is for when we need the etag from a CompleteMultipart
 * response (which is XML with the final object etag).
 */
export function parseCompleteMultipartXml(xml: string): { etag: string } {
  const etag = unquoteEtag(decodeXmlEntities(extractTag(xml, 'ETag') ?? ''))
  return { etag }
}

// ─── Error mapping ─────────────────────────────────────────────────

export interface R2ErrorMapping {
  httpStatus: number
  v4code: number
  message: string
}

/**
 * Translate an S3 error response (status + optional XML body) into
 * an R2 error code mapping. Extracts the AWS error code if present
 * for clearer messages.
 */
export function s3StatusToR2Error(
  status: number,
  errorBody: string,
): R2ErrorMapping {
  const code = extractTag(errorBody, 'Code')
  const message = extractTag(errorBody, 'Message') ?? errorBody.slice(0, 200)

  // Map by S3 error Code first (most specific), then status code.
  if (code !== null) {
    const v4 = AWS_CODE_TO_R2[code]
    if (v4 !== undefined) {
      return { httpStatus: status, v4code: v4, message: message || code }
    }
  }

  if (status === 404) return { httpStatus: 404, v4code: 10007, message: message || 'NoSuchKey' }
  if (status === 403) return { httpStatus: 403, v4code: 10004, message: message || 'AccessDenied' }
  if (status === 412) return { httpStatus: 412, v4code: 10031, message: message || 'PreconditionFailed' }
  if (status === 304) return { httpStatus: 304, v4code: 10032, message: message || 'NotModified' }
  if (status === 416) return { httpStatus: 416, v4code: 10039, message: message || 'InvalidRange' }
  if (status >= 500) return { httpStatus: 500, v4code: 10001, message: message || `S3 ${status}` }
  return { httpStatus: status, v4code: 10001, message: message || `S3 ${status}` }
}

/**
 * Common AWS S3 error codes → R2 v4codes. Not exhaustive; falls back
 * to status-based mapping in s3StatusToR2Error.
 */
const AWS_CODE_TO_R2: Record<string, number> = {
  NoSuchKey: 10007,
  NoSuchBucket: 10006,
  AccessDenied: 10004,
  InvalidAccessKeyId: 10004,
  SignatureDoesNotMatch: 10004,
  PreconditionFailed: 10031,
  NotModified: 10032,
  InvalidRange: 10039,
  EntityTooLarge: 10025,
  EntityTooSmall: 10026,
  InvalidDigest: 10037,
  BadDigest: 10037,
  MalformedXML: 10001,
  InternalError: 10001,
  ServiceUnavailable: 10001,
  SlowDown: 10001,
  RequestTimeout: 10001,
}

// ─── Header / range / conditional translation ────────────────────

export function httpFieldsToS3Headers(
  fields: R2HttpFields | undefined,
): Record<string, string> {
  const h: Record<string, string> = {}
  if (fields === undefined) return h
  if (fields.contentType !== undefined) h['content-type'] = fields.contentType
  if (fields.contentLanguage !== undefined) h['content-language'] = fields.contentLanguage
  if (fields.contentDisposition !== undefined) h['content-disposition'] = fields.contentDisposition
  if (fields.contentEncoding !== undefined) h['content-encoding'] = fields.contentEncoding
  if (fields.cacheControl !== undefined) h['cache-control'] = fields.cacheControl
  if (fields.cacheExpiry !== undefined) {
    h['expires'] = new Date(fields.cacheExpiry).toUTCString()
  }
  return h
}

export function customFieldsToS3Headers(
  fields: R2KV[] | undefined,
): Record<string, string> {
  const h: Record<string, string> = {}
  if (!fields) return h
  for (const { k, v } of fields) {
    // S3 normalizes x-amz-meta-* to lowercase; we do the same up-front.
    h[`x-amz-meta-${k.toLowerCase()}`] = v
  }
  return h
}

export function conditionalToS3Headers(
  cond: R2Conditional | undefined,
): Record<string, string> {
  const h: Record<string, string> = {}
  if (cond === undefined) return h
  if (cond.etagMatches && cond.etagMatches.length > 0) {
    h['if-match'] = cond.etagMatches.map((e) => formatEtagMatcher(e)).join(', ')
  }
  if (cond.etagDoesNotMatch && cond.etagDoesNotMatch.length > 0) {
    h['if-none-match'] = cond.etagDoesNotMatch
      .map((e) => formatEtagMatcher(e))
      .join(', ')
  }
  if (cond.uploadedAfter !== undefined) {
    h['if-modified-since'] = new Date(cond.uploadedAfter).toUTCString()
  }
  if (cond.uploadedBefore !== undefined) {
    h['if-unmodified-since'] = new Date(cond.uploadedBefore).toUTCString()
  }
  return h
}

function formatEtagMatcher(e: R2EtagMatcher): string {
  const kind = etagKind(e.type)
  if (kind === 'wildcard') return '*'
  if (kind === 'weak') return `W/"${e.value}"`
  return `"${e.value}"`
}

function etagKind(t: R2EtagType): 'strong' | 'weak' | 'wildcard' {
  if (typeof t === 'string') {
    if (t === 'wildcard' || t === 'weak') return t
    return 'strong'
  }
  // Defensive: if `t` is null/undefined the worker's input was malformed —
  // fall through to 'strong' rather than throwing inside a hot path.
  if (t === null || typeof t !== 'object') return 'strong'
  if ('wildcard' in t) return 'wildcard'
  if ('weak' in t) return 'weak'
  return 'strong'
}

/**
 * Translate R2's range representation to an HTTP Range header.
 * If both a structured `range` and explicit `rangeHeader` are present,
 * the rangeHeader wins (workerd passes both through; rangeHeader is
 * the user's literal input from `request.headers.get('Range')`).
 */
export function rangeToS3Header(
  range: R2Range | undefined,
  rangeHeader: string | undefined,
): string | null {
  if (rangeHeader !== undefined && rangeHeader !== '') return rangeHeader
  if (range === undefined) return null

  if (range.suffix !== undefined && range.suffix > 0) {
    return `bytes=-${range.suffix}`
  }
  const offset = range.offset ?? 0
  if (range.length !== undefined && range.length > 0) {
    return `bytes=${offset}-${offset + range.length - 1}`
  }
  return `bytes=${offset}-`
}

// ─── Utilities ─────────────────────────────────────────────────────

export const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function objectUrl(ctx: S3CodecContext, key: string): string {
  return `${ctx.endpoint}/${encodePathSegment(ctx.bucket)}/${encodeS3Key(key)}`
}

/**
 * Encode an object key for use in an S3 URL path. Matches AWS SigV4's
 * canonical URI encoding: percent-encode everything except the RFC 3986
 * unreserved set [A-Za-z0-9-._~] and forward slashes (which are kept
 * literal so multi-segment keys round-trip correctly).
 */
export function encodeS3Key(key: string): string {
  return key
    .split('/')
    .map((seg) => seg.replace(/[^A-Za-z0-9\-._~]/g, percentEncodeChar))
    .join('/')
}

/** Percent-encode a single bucket-name segment (no slashes preserved). */
function encodePathSegment(seg: string): string {
  return seg.replace(/[^A-Za-z0-9\-._~]/g, percentEncodeChar)
}

function percentEncodeChar(c: string): string {
  const bytes = new TextEncoder().encode(c)
  let out = ''
  for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  return out
}

function unquoteEtag(etag: string): string {
  return etag.replace(/^"|"$/g, '')
}

function quoteEtag(etag: string): string {
  if (etag.startsWith('"')) return etag
  return `"${etag}"`
}

function escapeXmlContent(s: string): string {
  // Only `<`, `>`, `&` need escaping in element content per XML spec.
  // Quotes are safe here (and S3 expects literal quotes around etags).
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function extractTag(xml: string, name: string): string | null {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)
  const m = re.exec(xml)
  return m ? m[1]! : null
}

function requireString(v: unknown, label: string): string {
  if (typeof v !== 'string') {
    throw new TypeError(`${label} must be a string, got ${typeof v}`)
  }
  return v
}

function requirePositiveInt(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new TypeError(`${label} must be a positive integer, got ${String(v)}`)
  }
  return v
}
