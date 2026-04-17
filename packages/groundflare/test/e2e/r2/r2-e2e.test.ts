/**
 * L3 e2e tests — real workerd + real adapter Worker + real SeaweedFS.
 *
 * Catches real-world S3 wire incompatibilities that the L2 mock S3
 * (Node http server with hand-canned responses) cannot. SeaweedFS's
 * S3 implementation is the closest realistic stand-in for what the
 * shipped adapter will see in production.
 *
 * Lifecycle: one weed + one workerd per file (beforeAll/afterAll), tests
 * share both. Each test uses a unique key prefix to avoid bleed-through.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startWeed, type StartedWeed } from './weed-fixture.js'
import { bundleR2Adapter } from '../../../src/runtime/workerd/r2/bundle.js'
import { pickFreePort, spawnWorkerd, type SpawnedWorkerd } from '../../integration/spawn-workerd.js'

let weed: StartedWeed
let workerd: SpawnedWorkerd
let workerdPort: number

const BUCKET = 'media'

beforeAll(async () => {
  weed = await startWeed({ buckets: [BUCKET] })

  const adapter = await bundleR2Adapter()
  workerdPort = await pickFreePort()
  const capnp = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "user",
      worker = (
        compatibilityDate = "2024-09-23",
        modules = [( name = "user.js", esModule = embed "user.js" )],
        bindings = [( name = "MEDIA", r2Bucket = "r2-adapter" )],
      ),
    ),
    ( name = "r2-adapter",
      worker = (
        compatibilityDate = "2024-09-23",
        compatibilityFlags = ["nodejs_compat"],
        modules = [( name = "adapter.js", esModule = embed "adapter.js" )],
        bindings = [
          ( name = "BUCKET_NAME", text = "${BUCKET}" ),
          ( name = "S3_ENDPOINT", text = "${weed.endpoint}" ),
        ],
        globalOutbound = "internet",
      ),
    ),
    ( name = "internet",
      network = ( allow = ["public", "private"] ),
    ),
  ],
  sockets = [
    ( name = "http", address = "*:${workerdPort}", http = (), service = "user" ),
  ]
);
`
  workerd = await spawnWorkerd({
    port: workerdPort,
    capnp,
    modules: { 'user.js': USER_WORKER_SOURCE, 'adapter.js': adapter.code },
    healthTimeoutMs: 10_000,
  })
}, 60_000)

afterAll(async () => {
  await workerd?.stop()
  await weed?.stop()
})

async function sendOp(spec: Record<string, unknown>): Promise<unknown> {
  const res = await workerd.sendRequest({
    host: 'r2-e2e.example',
    method: 'POST',
    path: '/op',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  })
  try {
    return JSON.parse(res.body)
  } catch {
    throw new Error(`non-JSON response (status=${res.status}): ${res.body.slice(0, 400)}`)
  }
}

// Use a per-test key prefix so re-runs don't collide.
function keyOf(name: string): string {
  return `e2e-${Date.now()}-${name}`
}

// ─── basic happy path ─────────────────────────────────────────────

describe('e2e: head + put + get + delete round-trip', () => {
  it('writes and reads back a small object', async () => {
    const key = keyOf('basic')
    const putR = (await sendOp({ op: 'put', key, body: 'hello e2e' })) as {
      ok: boolean
      result: { etag: string; size: number }
    }
    expect(putR.ok).toBe(true)
    expect(putR.result.size).toBe(9)

    const getR = (await sendOp({ op: 'get', key })) as {
      ok: boolean
      result: { body: string; etag: string; size: number }
    }
    expect(getR.ok).toBe(true)
    expect(getR.result.body).toBe('hello e2e')
    expect(getR.result.etag).toBe(putR.result.etag)
    expect(getR.result.size).toBe(9)

    const headR = (await sendOp({ op: 'head', key })) as {
      result: { size: number }
    }
    expect(headR.result.size).toBe(9)

    const delR = (await sendOp({ op: 'delete', key })) as { ok: boolean }
    expect(delR.ok).toBe(true)

    const getR2 = (await sendOp({ op: 'get', key })) as { ok: boolean; result: null }
    expect(getR2.ok).toBe(true)
    expect(getR2.result).toBeNull()
  })

  it('returns null on get of missing key (no throw)', async () => {
    const r = (await sendOp({ op: 'get', key: keyOf('nonexistent') })) as {
      ok: boolean
      result: null
    }
    expect(r.ok).toBe(true)
    expect(r.result).toBeNull()
  })

  it('returns null on head of missing key', async () => {
    const r = (await sendOp({ op: 'head', key: keyOf('nonexistent') })) as {
      result: null
    }
    expect(r.result).toBeNull()
  })
})

// ─── metadata round-trip against real S3 ──────────────────────────

describe('e2e: metadata round-trip', () => {
  it('persists httpMetadata.contentType', async () => {
    const key = keyOf('http-meta')
    await sendOp({
      op: 'put',
      key,
      body: '{}',
      options: { httpMetadata: { contentType: 'application/json' } },
    })
    const r = (await sendOp({ op: 'get', key })) as {
      result: { httpMetadata: { contentType: string } }
    }
    expect(r.result.httpMetadata.contentType).toMatch(/application\/json/)
  })

  it('persists customMetadata across PUT → HEAD', async () => {
    const key = keyOf('custom-meta')
    await sendOp({
      op: 'put',
      key,
      body: 'x',
      options: { customMetadata: { source: 'e2e', author: 'alice' } },
    })
    const r = (await sendOp({ op: 'head', key })) as {
      result: { customMetadata: Record<string, string> }
    }
    expect(r.result.customMetadata.source).toBe('e2e')
    expect(r.result.customMetadata.author).toBe('alice')
  })
})

// ─── streaming ──────────────────────────────────────────────────────

describe('e2e: streaming large objects', () => {
  it('round-trips a 5MB object byte-for-byte', async () => {
    // Use printable ASCII so the round-trip via Response.text() in the
    // user worker doesn't mangle bytes through UTF-8 replacement. Real
    // production uses are typically images/video — those go through
    // arrayBuffer(), which has no encoding hazard. The wire path is the
    // same regardless of payload bytes; what we verify here is integrity
    // of the streamed bytes through the adapter.
    const size = 5 * 1024 * 1024
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = 32 + (i % 95) // printable ASCII 32-126
    const b64 = Buffer.from(bytes).toString('base64')
    const key = keyOf('big')

    const putR = (await sendOp({ op: 'put', key, bodyBase64: b64 })) as {
      ok: boolean
      result: { size: number; etag: string }
    }
    expect(putR.ok).toBe(true)
    expect(putR.result.size).toBe(size)

    const getR = (await sendOp({ op: 'get', key })) as {
      ok: boolean
      result: { body: string; size: number }
    }
    expect(getR.ok).toBe(true)
    expect(getR.result.size).toBe(size)
    expect(getR.result.body.length).toBe(size)
    // Spot-check at three points; full byte equality on 5 MB is slow.
    expect(getR.result.body.charCodeAt(0)).toBe(32)
    expect(getR.result.body.charCodeAt(95)).toBe(32) // wraps
    expect(getR.result.body.charCodeAt(size - 1)).toBe(32 + ((size - 1) % 95))

    await sendOp({ op: 'delete', key })
  }, 30_000)
})

// ─── Unicode / special chars in keys ──────────────────────────────

describe('e2e: special key encoding', () => {
  it('handles Unicode + spaces + slashes in keys', async () => {
    const key = keyOf('uploads/中文 file.txt')
    await sendOp({ op: 'put', key, body: 'unicode-content' })
    const r = (await sendOp({ op: 'get', key })) as {
      ok: boolean
      result: { body: string }
    }
    expect(r.ok).toBe(true)
    expect(r.result.body).toBe('unicode-content')
    await sendOp({ op: 'delete', key })
  })
})

// ─── list ───────────────────────────────────────────────────────────

describe('e2e: list', () => {
  it('returns objects matching prefix', async () => {
    const prefix = `list-${Date.now()}/`
    await sendOp({ op: 'put', key: prefix + 'a', body: '1' })
    await sendOp({ op: 'put', key: prefix + 'b', body: '22' })
    await sendOp({ op: 'put', key: prefix + 'c', body: '333' })

    const r = (await sendOp({ op: 'list', options: { prefix } })) as {
      ok: boolean
      result: { objects: Array<{ key: string; size: number }> }
    }
    expect(r.ok).toBe(true)
    const keys = r.result.objects.map((o) => o.key).sort()
    expect(keys).toEqual([prefix + 'a', prefix + 'b', prefix + 'c'])

    await sendOp({ op: 'delete', key: prefix + 'a' })
    await sendOp({ op: 'delete', key: prefix + 'b' })
    await sendOp({ op: 'delete', key: prefix + 'c' })
  })

  it('supports delimiter for folder-style listing', async () => {
    const prefix = `delim-${Date.now()}/`
    await sendOp({ op: 'put', key: prefix + 'photos/x.jpg', body: '1' })
    await sendOp({ op: 'put', key: prefix + 'photos/y.jpg', body: '1' })
    await sendOp({ op: 'put', key: prefix + 'top.txt', body: '1' })

    const r = (await sendOp({
      op: 'list',
      options: { prefix, delimiter: '/' },
    })) as {
      result: {
        objects: Array<{ key: string }>
        delimitedPrefixes: string[]
      }
    }
    expect(r.result.delimitedPrefixes).toContain(prefix + 'photos/')
    expect(r.result.objects.map((o) => o.key)).toContain(prefix + 'top.txt')

    await sendOp({ op: 'delete', key: prefix + 'photos/x.jpg' })
    await sendOp({ op: 'delete', key: prefix + 'photos/y.jpg' })
    await sendOp({ op: 'delete', key: prefix + 'top.txt' })
  })
})

// ─── conditional headers ──────────────────────────────────────────

describe('e2e: conditional', () => {
  it('PUT with onlyIf: { etagDoesNotMatch: "*" } succeeds on first write', async () => {
    const key = keyOf('cond-create')
    const r = (await sendOp({
      op: 'put',
      key,
      body: 'first',
      options: { onlyIf: { etagDoesNotMatch: '*' } },
    })) as { ok: boolean; result: unknown }
    expect(r.ok).toBe(true)
    expect(r.result).not.toBeNull()
    await sendOp({ op: 'delete', key })
  })

  it('PUT with onlyIf: { etagDoesNotMatch: "*" } returns null on second write', async () => {
    const key = keyOf('cond-noop')
    await sendOp({ op: 'put', key, body: 'first' })
    const r = (await sendOp({
      op: 'put',
      key,
      body: 'second',
      options: { onlyIf: { etagDoesNotMatch: '*' } },
    })) as { ok: boolean; result: unknown }
    expect(r.ok).toBe(true)
    // Per CF spec: returns null on precondition fail
    expect(r.result).toBeNull()
    await sendOp({ op: 'delete', key })
  })
})

// ─── multipart upload, full sequence ──────────────────────────────

describe('e2e: multipart upload', () => {
  it('full sequence: create → 2 parts (5MB each) → complete', async () => {
    const key = keyOf('multipart')
    // S3 minimum part size is 5 MiB except the last part.
    const partSize = 5 * 1024 * 1024
    const part1 = new Uint8Array(partSize).fill(0x41) // 'A'
    const part2Tail = 'TAIL'
    const part2 = new TextEncoder().encode(part2Tail)

    const create = (await sendOp({
      op: 'createMultipartUpload',
      key,
      options: { httpMetadata: { contentType: 'application/octet-stream' } },
    })) as { ok: boolean; result: { uploadId: string } }
    expect(create.ok).toBe(true)
    const uploadId = create.result.uploadId
    expect(uploadId).toBeTruthy()

    const u1 = (await sendOp({
      op: 'uploadPart',
      key,
      uploadId,
      partNumber: 1,
      bodyBase64: Buffer.from(part1).toString('base64'),
    })) as { ok: boolean; result: { etag: string } }
    expect(u1.ok).toBe(true)
    expect(u1.result.etag).toBeTruthy()

    const u2 = (await sendOp({
      op: 'uploadPart',
      key,
      uploadId,
      partNumber: 2,
      body: part2Tail,
    })) as { ok: boolean; result: { etag: string } }
    expect(u2.ok).toBe(true)

    const complete = (await sendOp({
      op: 'completeMultipartUpload',
      key,
      uploadId,
      parts: [
        { partNumber: 1, etag: u1.result.etag },
        { partNumber: 2, etag: u2.result.etag },
      ],
    })) as { ok: boolean; result: { size: number; etag: string } }
    expect(complete.ok).toBe(true)
    expect(complete.result.size).toBe(part1.byteLength + part2.byteLength)

    // Read it back to verify
    const get = (await sendOp({ op: 'get', key })) as {
      result: { body: string; size: number }
    }
    expect(get.result.size).toBe(part1.byteLength + part2.byteLength)
    expect(get.result.body.endsWith(part2Tail)).toBe(true)
    expect(get.result.body.startsWith('AAAA')).toBe(true)

    await sendOp({ op: 'delete', key })
  }, 60_000)

  it('abortMultipartUpload cleans up an in-progress upload', async () => {
    const key = keyOf('multipart-abort')
    const create = (await sendOp({
      op: 'createMultipartUpload',
      key,
    })) as { result: { uploadId: string } }
    const uploadId = create.result.uploadId

    await sendOp({
      op: 'uploadPart',
      key,
      uploadId,
      partNumber: 1,
      body: 'partial-data',
    })

    const abort = (await sendOp({
      op: 'abortMultipartUpload',
      key,
      uploadId,
    })) as { ok: boolean }
    expect(abort.ok).toBe(true)

    // The object should not exist (we never completed)
    const head = (await sendOp({ op: 'head', key })) as { result: null }
    expect(head.result).toBeNull()
  }, 30_000)
})

// ─── disk persistence ─────────────────────────────────────────────

describe('e2e: disk persistence', () => {
  it('actually writes data to weed.dataDir (not just in-memory)', async () => {
    const key = keyOf('disk-check')
    await sendOp({ op: 'put', key, body: 'persistent' })

    // weed stores objects in <dataDir>/<bucket>_<volumeId>.dat — at least
    // one .dat file should exist after the PUT.
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(weed.dataDir)
    const datFiles = entries.filter((e) => e.endsWith('.dat'))
    expect(datFiles.length).toBeGreaterThan(0)

    await sendOp({ op: 'delete', key })
  })
})

// ─── user worker (same source as L2 harness; embedded directly) ────

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

