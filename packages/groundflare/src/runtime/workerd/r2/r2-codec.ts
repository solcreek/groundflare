/**
 * R2 wire protocol codec.
 *
 * workerd's R2Bucket binding speaks an internal HTTP-based wire protocol
 * to its backing service. This module parses inbound requests from that
 * wire protocol into structured R2 ops, and serializes our responses
 * back into the wire format.
 *
 * Reference: workerd source `src/workerd/api/r2-rpc.c++`. The protocol
 * is asymmetric:
 *
 *   GET / HEAD / LIST / DELETE / createMultipartUpload /
 *   completeMultipartUpload / abortMultipartUpload:
 *     - HTTP method: GET
 *     - Request body: empty
 *     - Op metadata: in `cf-r2-request` header (JSON, R2BindingRequest)
 *
 *   PUT / uploadPart:
 *     - HTTP method: PUT
 *     - Request body: <metadataJson> + <payload bytes>
 *     - `cf-r2-metadata-size` header tells how many bytes at the start
 *       of the body are the metadata JSON; everything after is payload
 *
 * Successful response (both forms):
 *     - HTTP status: 2xx
 *     - `cf-r2-metadata-size` header: byte length of metadata prefix
 *     - Response body: <metadataJson> + <stream payload>  (payload only
 *       for ops that return data — get + multipart parts)
 *     - For ops that return only metadata, body is just the JSON
 *
 * Error response:
 *     - HTTP status: >= 400
 *     - `cf-r2-error` header: JSON `{ version, v4code, message }`
 *     - Body: optional human-readable message (workerd ignores it)
 *
 * The codec is intentionally schema-loose: the `op` returned by
 * `parseR2Request` carries through unknown fields as-is, so this module
 * doesn't have to be updated when workerd adds new R2 features.
 * Downstream s3-client handles the field-level mapping.
 */

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

/** Header names — lowercase to match Headers.get() normalization. */
export const R2_HEADERS = {
  request: 'cf-r2-request',
  metadataSize: 'cf-r2-metadata-size',
  error: 'cf-r2-error',
} as const

/**
 * Known R2 op methods — matches workerd's R2BindingRequest.payload union.
 * Unknown methods round-trip as-is (typed as string so we don't reject
 * forward-compatibility additions).
 */
export type R2Method =
  | 'head'
  | 'get'
  | 'put'
  | 'list'
  | 'delete'
  | 'createBucket'
  | 'listBucket'
  | 'deleteBucket'
  | 'createMultipartUpload'
  | 'uploadPart'
  | 'completeMultipartUpload'
  | 'abortMultipartUpload'

/**
 * Parsed R2 op. The `method` field is the discriminator; all other
 * fields depend on the specific op (kept as `Record<string, unknown>`
 * since s3-client owns the mapping).
 */
export type R2Op = { method: R2Method | string } & Record<string, unknown>

export interface ParsedR2Request {
  op: R2Op
  /** Non-null only for ops that carry payload (put, uploadPart). */
  payload: ReadableStream<Uint8Array> | null
  /** Bearer token from Authorization header, if any. */
  jwt: string | null
}

export class R2WireProtocolError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly v4code: number,
    message: string,
  ) {
    super(message)
    this.name = 'R2WireProtocolError'
  }
}

/**
 * Parse an inbound HTTP request into a structured R2 op + payload.
 * Throws R2WireProtocolError for protocol violations the caller should
 * convert to cf-r2-error responses.
 */
export async function parseR2Request(req: Request): Promise<ParsedR2Request> {
  const jwt = extractBearer(req.headers.get('authorization'))
  if (req.method === 'PUT') {
    return parsePutForm(req, jwt)
  }
  if (req.method === 'GET') {
    return parseHeaderForm(req, jwt)
  }
  throw new R2WireProtocolError(
    405,
    10004,
    `Unsupported HTTP method ${req.method} on R2 binding service`,
  )
}

function parseHeaderForm(req: Request, jwt: string | null): ParsedR2Request {
  const opJson = req.headers.get(R2_HEADERS.request)
  if (opJson === null || opJson === '') {
    throw new R2WireProtocolError(
      400,
      10004,
      `Missing ${R2_HEADERS.request} header on ${req.method}`,
    )
  }
  const op = parseOpJson(opJson)
  return { op, payload: null, jwt }
}

async function parsePutForm(
  req: Request,
  jwt: string | null,
): Promise<ParsedR2Request> {
  const sizeStr = req.headers.get(R2_HEADERS.metadataSize)
  if (sizeStr === null) {
    throw new R2WireProtocolError(
      400,
      10004,
      `Missing ${R2_HEADERS.metadataSize} header on PUT`,
    )
  }
  const metadataSize = parseInt(sizeStr, 10)
  if (!Number.isFinite(metadataSize) || metadataSize < 0) {
    throw new R2WireProtocolError(
      400,
      10004,
      `Invalid ${R2_HEADERS.metadataSize}: ${sizeStr}`,
    )
  }
  if (metadataSize > MAX_METADATA_SIZE) {
    // R2's own limit is ~256 KiB; cap at 1 MiB to be tolerant but bounded.
    throw new R2WireProtocolError(
      413,
      10004,
      `Metadata prefix ${metadataSize} bytes exceeds 1 MiB limit`,
    )
  }
  if (req.body === null) {
    throw new R2WireProtocolError(
      400,
      10004,
      `PUT body required when ${R2_HEADERS.metadataSize}=${metadataSize}`,
    )
  }

  // Read at least `metadataSize` bytes from the body, then expose the
  // remainder as a ReadableStream so handlers stream large payloads
  // straight through without buffering.
  const [metaBytes, payload] = await readPrefix(req.body, metadataSize)
  if (metaBytes.byteLength < metadataSize) {
    throw new R2WireProtocolError(
      400,
      10004,
      `PUT body ended early: got ${metaBytes.byteLength} of ${metadataSize} metadata bytes`,
    )
  }

  let op: R2Op
  try {
    op = parseOpJson(DECODER.decode(metaBytes))
  } catch (e) {
    throw new R2WireProtocolError(
      400,
      10004,
      `PUT metadata JSON parse error: ${(e as Error).message}`,
    )
  }
  return { op, payload, jwt }
}

function parseOpJson(json: string): R2Op {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new R2WireProtocolError(
      400,
      10004,
      `R2 op JSON parse error: ${(e as Error).message}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new R2WireProtocolError(400, 10004, `R2 op must be a JSON object`)
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.method !== 'string' || obj.method === '') {
    throw new R2WireProtocolError(
      400,
      10004,
      `R2 op missing required "method" field`,
    )
  }
  return obj as R2Op
}

function extractBearer(authHeader: string | null): string | null {
  if (authHeader === null) return null
  const m = /^Bearer\s+(.+)$/.exec(authHeader)
  return m ? m[1]!.trim() : null
}

/**
 * Drain the first `prefixLen` bytes from `stream` into a Uint8Array,
 * then return a ReadableStream that emits the remaining bytes.
 *
 * The original stream is fully consumed by the time this returns —
 * we read it chunk by chunk, accumulate into the prefix buffer until
 * full, and feed leftover bytes plus subsequent chunks into the
 * returned stream.
 */
async function readPrefix(
  stream: ReadableStream<Uint8Array>,
  prefixLen: number,
): Promise<[Uint8Array, ReadableStream<Uint8Array>]> {
  const reader = stream.getReader()
  const prefixBuf = new Uint8Array(prefixLen)
  let prefixOffset = 0
  let leftover: Uint8Array | null = null
  let streamDone = false

  // Phase 1: read until we have prefixLen bytes (or stream ends early).
  while (prefixOffset < prefixLen && !streamDone) {
    const { done, value } = await reader.read()
    if (done) {
      streamDone = true
      break
    }
    const need = prefixLen - prefixOffset
    if (value.byteLength <= need) {
      prefixBuf.set(value, prefixOffset)
      prefixOffset += value.byteLength
    } else {
      prefixBuf.set(value.subarray(0, need), prefixOffset)
      prefixOffset += need
      leftover = value.subarray(need)
    }
  }

  const prefix =
    prefixOffset === prefixLen ? prefixBuf : prefixBuf.subarray(0, prefixOffset)

  // Phase 2: build a stream that emits leftover (if any) + remaining chunks.
  const payload = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (leftover && leftover.byteLength > 0) controller.enqueue(leftover)
        if (!streamDone) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            controller.enqueue(value)
          }
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // already released
        }
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {
        // best effort
      })
    },
  })

  return [prefix, payload]
}

/** Hard cap on metadata prefix size (well above R2's actual limits). */
const MAX_METADATA_SIZE = 1024 * 1024

// ─── Response builders ─────────────────────────────────────────────

/**
 * Build a successful R2 wire response.
 *
 * `meta` is serialized as JSON and emitted at the start of the body;
 * `payload` (if present) is appended as a stream. The response carries
 * `cf-r2-metadata-size` so workerd's binding code knows where the
 * metadata ends and the payload begins.
 */
export function buildR2Response(
  meta: Record<string, unknown>,
  payload?: ReadableStream<Uint8Array> | Uint8Array | null,
): Response {
  const metaBytes = ENCODER.encode(JSON.stringify(meta))
  const headers = new Headers({
    [R2_HEADERS.metadataSize]: String(metaBytes.byteLength),
  })

  if (payload === undefined || payload === null) {
    return new Response(metaBytes, { status: 200, headers })
  }

  if (payload instanceof Uint8Array) {
    // Inline small payload (e.g. test fixtures). Still emits as one body.
    const combined = new Uint8Array(metaBytes.byteLength + payload.byteLength)
    combined.set(metaBytes, 0)
    combined.set(payload, metaBytes.byteLength)
    return new Response(combined, { status: 200, headers })
  }

  // Stream payload: enqueue metadata first, then pipe through the stream.
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(metaBytes)
      const reader = payload.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // already released
        }
      }
    },
    cancel(reason) {
      payload.cancel(reason).catch(() => {
        // best effort
      })
    },
  })
  return new Response(out, { status: 200, headers })
}

/**
 * Build an R2 wire error response. workerd's R2Bucket binding parses
 * the `cf-r2-error` header into an R2Error thrown to user code.
 */
export function buildR2ErrorResponse(
  httpStatus: number,
  v4code: number,
  message: string,
): Response {
  const errorJson = JSON.stringify({ version: 0, v4code, message })
  return new Response(message, {
    status: httpStatus,
    headers: new Headers({
      [R2_HEADERS.error]: errorJson,
      'content-type': 'text/plain; charset=utf-8',
    }),
  })
}
