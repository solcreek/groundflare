/**
 * R2 ↔ S3 adapter Worker.
 *
 * This is the worker module that workerd loads as the backing service
 * for an R2 binding. It receives R2 wire-protocol requests, translates
 * them to S3 REST calls, optionally signs with SigV4, fetches the
 * configured S3-compatible backend, then translates the response back
 * to R2 wire format.
 *
 * Wire-protocol decode + encode lives in r2-codec.ts; R2↔S3 translation
 * in s3-codec.ts; SigV4 in bun/adapters/sigv4.ts (shared with the Bun
 * track). This module is the orchestrator.
 *
 * Bindings (set on the adapter Worker by capnp render):
 *   BUCKET_NAME     (text)   — S3 bucket name
 *   S3_ENDPOINT     (text)   — endpoint URL, no trailing slash
 *   S3_REGION       (text)   — defaults to 'us-east-1'
 *   S3_ACCESS_KEY   (text?)  — when present, requests are SigV4-signed
 *   S3_SECRET_KEY   (text?)  — paired with S3_ACCESS_KEY
 *
 * If both S3_ACCESS_KEY and S3_SECRET_KEY are absent, requests go out
 * unsigned (suitable for the local SeaweedFS sidecar in anonymous mode).
 * Mixed presence (one set, the other absent) is treated as unsigned —
 * a config-validation error at deploy time prevents this in practice.
 */

import {
  signRequest,
  type SigV4Credentials,
} from '../../bun/adapters/sigv4.js'
import {
  handleInternalMetrics,
  recordR2Op,
} from '../../metrics/r2-adapter-metrics.js'

import {
  R2WireProtocolError,
  buildR2ErrorResponse,
  buildR2Response,
  parseR2Request,
  type R2Op,
} from './r2-codec.js'

import {
  parseCompleteMultipartXml,
  parseInitiateMultipartXml,
  parseListXmlV2,
  r2OpToS3Request,
  s3ResponseToR2Meta,
  s3StatusToR2Error,
  type S3CodecContext,
  type S3RequestPlan,
} from './s3-codec.js'

interface Env {
  BUCKET_NAME: string
  S3_ENDPOINT: string
  S3_REGION?: string
  S3_ACCESS_KEY?: string
  S3_SECRET_KEY?: string
  /**
   * Tenant worker + binding names used as metric labels. Set by
   * buildR2AdapterService so one adapter's scraped series distinguishes
   * itself from another (worker, binding) pair's series.
   */
  GF_WORKER_NAME?: string
  GF_BINDING_NAME?: string
}

const DEFAULT_REGION = 'us-east-1'
const SERVICE = 's3'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Internal metrics endpoint — short-circuit before any R2 wire
    // parsing. Guarded by `gf-internal` hostname, which Caddy never
    // forwards to tenants / adapters.
    const internal = handleInternalMetrics(request)
    if (internal) return internal

    let parsed
    try {
      parsed = await parseR2Request(request)
    } catch (e) {
      if (e instanceof R2WireProtocolError) {
        return buildR2ErrorResponse(e.httpStatus, e.v4code, e.message)
      }
      return buildR2ErrorResponse(
        500,
        10001,
        `wire protocol error: ${asMessage(e)}`,
      )
    }
    const workerName = env.GF_WORKER_NAME ?? 'unknown'
    const bindingName = env.GF_BINDING_NAME ?? 'unknown'
    const start = Date.now()
    try {
      const response = await dispatch(parsed.op, parsed.payload, env)
      recordR2Op(
        workerName,
        bindingName,
        parsed.op.method,
        Date.now() - start,
        response.status < 400,
      )
      return response
    } catch (e) {
      recordR2Op(
        workerName,
        bindingName,
        parsed.op.method,
        Date.now() - start,
        false,
      )
      return buildR2ErrorResponse(
        500,
        10001,
        `adapter: ${asMessage(e)}`,
      )
    }
  },
}

async function dispatch(
  op: R2Op,
  payload: ReadableStream<Uint8Array> | null,
  env: Env,
): Promise<Response> {
  const ctx: S3CodecContext = {
    bucket: env.BUCKET_NAME,
    endpoint: env.S3_ENDPOINT.replace(/\/$/, ''),
  }
  const credentials = readCredentials(env)
  const region = env.S3_REGION ?? DEFAULT_REGION

  let plan: S3RequestPlan
  try {
    plan = r2OpToS3Request(op, payload, ctx)
  } catch (e) {
    return buildR2ErrorResponse(400, 10004, asMessage(e))
  }

  const headers = await signIfNeeded(plan, credentials, region)
  const res = await doFetch(plan, headers)

  if (res.status >= 400) {
    const body = await res.text().catch(() => '')
    const mapped = s3StatusToR2Error(res.status, body)
    return buildR2ErrorResponse(mapped.httpStatus, mapped.v4code, mapped.message)
  }

  return buildOpResponse(op, ctx, plan, res, env, credentials, region)
}

/**
 * Op-specific response shaping. Most ops return R2HeadResponse-shaped
 * metadata; LIST returns R2ListResponse; multipart variants have their
 * own shapes.
 */
async function buildOpResponse(
  op: R2Op,
  ctx: S3CodecContext,
  plan: S3RequestPlan,
  s3Res: Response,
  env: Env,
  credentials: SigV4Credentials | null,
  region: string,
): Promise<Response> {
  switch (op.method) {
    case 'list': {
      const xml = await s3Res.text()
      return buildR2Response(unbox(parseListXmlV2(xml)))
    }
    case 'get': {
      const meta = s3ResponseToR2Meta(s3Res, requireString(op.object))
      return buildR2Response(unbox(meta), s3Res.body)
    }
    case 'head': {
      const meta = s3ResponseToR2Meta(s3Res, requireString(op.object))
      return buildR2Response(unbox(meta))
    }
    case 'put': {
      // S3 PutObject returns ETag in headers but NOT the full metadata.
      // Issue a HEAD afterwards so the R2 user code receives a complete
      // R2HeadResponse (including custom metadata they just wrote).
      const headPlan: S3RequestPlan = {
        method: 'HEAD',
        url: plan.url,
        headers: {},
        body: null,
        payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }
      const headHeaders = await signIfNeeded(headPlan, credentials, region)
      const headRes = await doFetch(headPlan, headHeaders)
      if (headRes.status >= 400) {
        const body = await headRes.text().catch(() => '')
        const mapped = s3StatusToR2Error(headRes.status, body)
        return buildR2ErrorResponse(mapped.httpStatus, mapped.v4code, mapped.message)
      }
      const meta = s3ResponseToR2Meta(headRes, requireString(op.object))
      return buildR2Response(unbox(meta))
    }
    case 'delete':
    case 'abortMultipartUpload': {
      // R2's user-facing return type is void; we still need a metadata
      // payload (workerd's R2Bucket parses it but discards). Empty
      // object suffices.
      return buildR2Response({})
    }
    case 'createMultipartUpload': {
      const xml = await s3Res.text()
      const { uploadId } = parseInitiateMultipartXml(xml)
      return buildR2Response({ uploadId })
    }
    case 'uploadPart': {
      const etag = (s3Res.headers.get('etag') ?? '').replace(/^"|"$/g, '')
      // Drain body to release the connection.
      await s3Res.body?.cancel()
      return buildR2Response({ etag })
    }
    case 'completeMultipartUpload': {
      const xml = await s3Res.text()
      const { etag } = parseCompleteMultipartXml(xml)
      // R2 returns a full R2HeadResponse; we have the etag from the
      // CompleteMultipart response and need the rest. HEAD the object.
      const key = requireString(op.object)
      const headPlan: S3RequestPlan = {
        method: 'HEAD',
        url: `${ctx.endpoint}/${encodePathSegment(ctx.bucket)}/${encodeKey(key)}`,
        headers: {},
        body: null,
        payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }
      const headHeaders = await signIfNeeded(headPlan, credentials, region)
      const headRes = await doFetch(headPlan, headHeaders)
      if (headRes.status >= 400) {
        const body = await headRes.text().catch(() => '')
        const mapped = s3StatusToR2Error(headRes.status, body)
        return buildR2ErrorResponse(mapped.httpStatus, mapped.v4code, mapped.message)
      }
      const meta = s3ResponseToR2Meta(headRes, key)
      meta.etag = etag // override: completeMultipart final etag is canonical
      return buildR2Response(unbox(meta))
    }
    default:
      // Unknown method (forward-compat). Return whatever we got back.
      return buildR2Response({})
  }
}

// ─── SigV4 + fetch ─────────────────────────────────────────────────

function readCredentials(env: Env): SigV4Credentials | null {
  const id = env.S3_ACCESS_KEY
  const secret = env.S3_SECRET_KEY
  if (!id || !secret) return null
  return { accessKeyId: id, secretAccessKey: secret }
}

async function signIfNeeded(
  plan: S3RequestPlan,
  credentials: SigV4Credentials | null,
  region: string,
): Promise<Record<string, string>> {
  if (credentials === null) return { ...plan.headers }
  return signRequest({
    method: plan.method,
    url: plan.url,
    headers: plan.headers,
    payloadHash: plan.payloadHash,
    region,
    service: SERVICE,
    credentials,
  })
}

async function doFetch(
  plan: S3RequestPlan,
  signedHeaders: Record<string, string>,
): Promise<Response> {
  const init: RequestInit = {
    method: plan.method,
    headers: signedHeaders,
  }
  if (plan.body !== null) {
    init.body = plan.body as BodyInit
    // Streams over fetch require duplex on Node-style runtimes; workerd
    // accepts it but ignores it for one-direction PUT.
    ;(init as RequestInit & { duplex?: string }).duplex = 'half'
  }
  return fetch(plan.url, init)
}

// ─── helpers ──────────────────────────────────────────────────────

function asMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function requireString(v: unknown): string {
  if (typeof v !== 'string') throw new TypeError(`expected string, got ${typeof v}`)
  return v
}

function encodeKey(key: string): string {
  return key
    .split('/')
    .map((seg) => seg.replace(/[^A-Za-z0-9\-._~]/g, percentEncodeChar))
    .join('/')
}

function encodePathSegment(seg: string): string {
  return seg.replace(/[^A-Za-z0-9\-._~]/g, percentEncodeChar)
}

function percentEncodeChar(c: string): string {
  const bytes = new TextEncoder().encode(c)
  let out = ''
  for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  return out
}

/**
 * `buildR2Response` accepts `Record<string, unknown>` — our typed
 * R2HeadResponse / R2ListResponse satisfy that, but TS's structural
 * type checker doesn't see the index signature without help.
 */
function unbox<T>(v: T): Record<string, unknown> {
  return v as unknown as Record<string, unknown>
}
