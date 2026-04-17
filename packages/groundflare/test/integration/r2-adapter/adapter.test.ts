/**
 * L2 integration tests for the R2 ↔ S3 adapter Worker.
 *
 * Real workerd binary, real adapter Worker, mock S3 backend (Node
 * http.Server in-process). Catches end-to-end wire protocol bugs that
 * pure-function unit tests would miss — most notably the GET/PUT
 * asymmetry where workerd puts the metadata in the body prefix on PUT
 * but in a header on GET.
 *
 * Architecture:
 *   user worker  → R2 binding → adapter Worker → outbound HTTP → mock S3
 *
 * Each test sends a JSON spec to the user worker's /op endpoint, asserts
 * the user-facing R2 result, AND inspects the mock-server's captured
 * requests to verify the adapter sent the right S3 request shape.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  listXml,
  s3ObjectHeaders,
  setupAdapterStack,
  type AdapterStack,
} from './harness.js'

let stack: AdapterStack

beforeAll(async () => {
  stack = await setupAdapterStack()
}, 30_000)

afterAll(async () => {
  await stack?.stop()
})

beforeEach(() => {
  stack.mock.reset()
})

// ─── HEAD ──────────────────────────────────────────────────────────

describe('R2 head()', () => {
  it('returns object metadata from a HEAD response', async () => {
    stack.mock.setHandler(() => ({
      status: 200,
      headers: s3ObjectHeaders({ size: 42, etag: 'abc', contentType: 'text/plain' }),
    }))
    const r = (await stack.sendOp({ op: 'head', key: 'k' })) as {
      ok: boolean
      result: { size: number; etag: string; httpMetadata: { contentType: string } }
    }
    expect(r.ok).toBe(true)
    expect(r.result.size).toBe(42)
    expect(r.result.etag).toBe('abc')
    expect(r.result.httpMetadata.contentType).toBe('text/plain')

    expect(stack.mock.requests).toHaveLength(1)
    expect(stack.mock.requests[0]!.method).toBe('HEAD')
    expect(stack.mock.requests[0]!.url).toBe('/media/k')
  })

  it('returns null on 404 (not thrown)', async () => {
    stack.mock.setHandler(() => ({
      status: 404,
      headers: { 'content-type': 'application/xml' },
      body: '<Error><Code>NoSuchKey</Code><Message>nope</Message></Error>',
    }))
    const r = (await stack.sendOp({ op: 'head', key: 'missing' })) as {
      ok: boolean
      result: unknown
    }
    expect(r.ok).toBe(true)
    expect(r.result).toBeNull()
  })

  it('round-trips custom metadata', async () => {
    stack.mock.setHandler(() => ({
      status: 200,
      headers: s3ObjectHeaders({
        size: 0,
        customMeta: { source: 'poc', author: 'alice' },
      }),
    }))
    const r = (await stack.sendOp({ op: 'head', key: 'k' })) as {
      ok: boolean
      result: { customMetadata: Record<string, string> }
    }
    expect(r.result.customMetadata).toEqual({ source: 'poc', author: 'alice' })
  })

  it('URL-encodes special chars in key', async () => {
    stack.mock.setHandler(() => ({ status: 200, headers: s3ObjectHeaders({ size: 0 }) }))
    await stack.sendOp({ op: 'head', key: 'a b/你' })
    // 你 → %E4%BD%A0
    expect(stack.mock.requests[0]!.url).toBe('/media/a%20b/%E4%BD%A0')
  })
})

// ─── GET ───────────────────────────────────────────────────────────

describe('R2 get()', () => {
  it('returns object body + metadata', async () => {
    stack.mock.setHandler(() => ({
      status: 200,
      headers: s3ObjectHeaders({ size: 5, etag: 'xyz', contentType: 'text/plain' }),
      body: 'hello',
    }))
    const r = (await stack.sendOp({ op: 'get', key: 'k' })) as {
      ok: boolean
      result: { body: string; etag: string }
    }
    expect(r.ok).toBe(true)
    expect(r.result.body).toBe('hello')
    expect(r.result.etag).toBe('xyz')

    expect(stack.mock.requests[0]!.method).toBe('GET')
  })

  it('returns null on 404', async () => {
    stack.mock.setHandler(() => ({
      status: 404,
      body: '<Error><Code>NoSuchKey</Code></Error>',
    }))
    const r = (await stack.sendOp({ op: 'get', key: 'missing' })) as { result: null }
    expect(r.result).toBeNull()
  })

  it('forwards Range header from R2 GetOptions.range', async () => {
    let receivedRange: string | undefined
    stack.mock.setHandler((req) => {
      receivedRange = req.headers['range']
      return { status: 206, headers: s3ObjectHeaders({ size: 10 }), body: '0123456789' }
    })
    await stack.sendOp({
      op: 'get',
      key: 'k',
      options: { range: { offset: 10, length: 10 } },
    })
    // R2's SDK may transform structured range internally (workerd has been
    // observed to widen `length=10` into a larger byte window before sending
    // the wire request). What we verify is that *some* Range header reached
    // S3 starting at the requested offset — the adapter forwards faithfully.
    expect(receivedRange).toBeDefined()
    expect(receivedRange!.startsWith('bytes=10-')).toBe(true)
  })

  it('forwards If-None-Match from R2 GetOptions.onlyIf.etagDoesNotMatch', async () => {
    stack.mock.setHandler((req) => {
      expect(req.headers['if-none-match']).toBe('"abc"')
      return { status: 200, headers: s3ObjectHeaders({ size: 0 }) }
    })
    await stack.sendOp({
      op: 'get',
      key: 'k',
      options: { onlyIf: { etagDoesNotMatch: 'abc' } },
    })
  })

  it('maps S3 416 (range error) to R2 InvalidRange', async () => {
    stack.mock.setHandler(() => ({
      status: 416,
      body: '<Error><Code>InvalidRange</Code><Message>out of range</Message></Error>',
    }))
    const r = (await stack.sendOp({
      op: 'get',
      key: 'k',
      options: { range: { offset: 1000000, length: 100 } },
    })) as { ok: boolean; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/out of range|InvalidRange/)
  })
})

// ─── PUT ───────────────────────────────────────────────────────────

describe('R2 put()', () => {
  it('uploads body bytes + returns metadata after HEAD-back', async () => {
    let putReceived: string | null = null
    stack.mock.setHandler((req) => {
      if (req.method === 'PUT') {
        putReceived = req.body.toString('utf-8')
        return { status: 200, headers: { etag: '"e1"' } }
      }
      // The HEAD-back call after PUT
      return {
        status: 200,
        headers: s3ObjectHeaders({ size: putReceived!.length, etag: 'e1' }),
      }
    })
    const r = (await stack.sendOp({ op: 'put', key: 'k', body: 'hello-world' })) as {
      ok: boolean
      result: { etag: string; size: number }
    }
    expect(r.ok).toBe(true)
    expect(putReceived).toBe('hello-world')
    expect(r.result.etag).toBe('e1')
    expect(r.result.size).toBe(11)

    // Two captured S3 requests: PUT then HEAD
    expect(stack.mock.requests.map((r) => r.method)).toEqual(['PUT', 'HEAD'])
    expect(stack.mock.requests[0]!.url).toBe('/media/k')
  })

  it('forwards httpMetadata as standard S3 headers', async () => {
    stack.mock.setHandler((req) => {
      if (req.method === 'PUT') {
        expect(req.headers['content-type']).toBe('image/png')
        expect(req.headers['cache-control']).toBe('public, max-age=3600')
      }
      return { status: 200, headers: s3ObjectHeaders({ size: 1, contentType: 'image/png' }) }
    })
    await stack.sendOp({
      op: 'put',
      key: 'k',
      body: 'x',
      options: {
        httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=3600' },
      },
    })
  })

  it('forwards customMetadata as x-amz-meta-*', async () => {
    stack.mock.setHandler((req) => {
      if (req.method === 'PUT') {
        expect(req.headers['x-amz-meta-source']).toBe('poc')
        expect(req.headers['x-amz-meta-author']).toBe('alice')
      }
      return {
        status: 200,
        headers: s3ObjectHeaders({
          size: 1,
          customMeta: { source: 'poc', author: 'alice' },
        }),
      }
    })
    const r = (await stack.sendOp({
      op: 'put',
      key: 'k',
      body: 'x',
      options: { customMetadata: { source: 'poc', author: 'alice' } },
    })) as { result: { customMetadata: Record<string, string> } }
    expect(r.result.customMetadata).toEqual({ source: 'poc', author: 'alice' })
  })

  it('handles empty body (zero-byte object)', async () => {
    let putBodyLen: number | null = null
    stack.mock.setHandler((req) => {
      if (req.method === 'PUT') {
        putBodyLen = req.body.byteLength
        return { status: 200, headers: { etag: '"empty"' } }
      }
      return { status: 200, headers: s3ObjectHeaders({ size: 0, etag: 'empty' }) }
    })
    const r = (await stack.sendOp({ op: 'put', key: 'k', body: '' })) as {
      ok: boolean
      result: { size: number }
    }
    expect(r.ok).toBe(true)
    expect(putBodyLen).toBe(0)
    expect(r.result.size).toBe(0)
  })

  it('streams a 1MB body without buffering (round-trips full content)', async () => {
    const size = 1024 * 1024
    let receivedLen: number | null = null
    let receivedFirstByte: number | null = null
    let receivedLastByte: number | null = null
    stack.mock.setHandler((req) => {
      if (req.method === 'PUT') {
        receivedLen = req.body.byteLength
        receivedFirstByte = req.body[0] ?? null
        receivedLastByte = req.body[req.body.byteLength - 1] ?? null
        return { status: 200, headers: { etag: '"big"' } }
      }
      return { status: 200, headers: s3ObjectHeaders({ size, etag: 'big' }) }
    })
    // Build a recognisable payload: byte i = i & 0xff
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = i & 0xff
    const b64 = Buffer.from(bytes).toString('base64')
    await stack.sendOp({ op: 'put', key: 'big', bodyBase64: b64 })
    expect(receivedLen).toBe(size)
    expect(receivedFirstByte).toBe(0)
    expect(receivedLastByte).toBe((size - 1) & 0xff)
  }, 15_000)

  it('forwards conditional headers (if-none-match: "*")', async () => {
    stack.mock.setHandler((req) => {
      if (req.method === 'PUT') {
        expect(req.headers['if-none-match']).toBe('*')
        return { status: 200, headers: { etag: '"new"' } }
      }
      return { status: 200, headers: s3ObjectHeaders({ size: 0 }) }
    })
    await stack.sendOp({
      op: 'put',
      key: 'k',
      body: 'x',
      options: { onlyIf: { etagDoesNotMatch: '*' } },
    })
  })

  it('maps S3 412 (precondition failed) to R2 null result (per CF spec)', async () => {
    stack.mock.setHandler(() => ({
      status: 412,
      body: '<Error><Code>PreconditionFailed</Code></Error>',
    }))
    // CF R2 contract: put({ onlyIf }) returns null on precondition failure
    // rather than throwing — workerd's R2Bucket binding swallows the
    // 10031 v4code and surfaces null. Adapter must emit the right v4code
    // for that swallowing to happen.
    const r = (await stack.sendOp({
      op: 'put',
      key: 'k',
      body: 'x',
      options: { onlyIf: { etagMatches: 'no-match' } },
    })) as { ok: boolean; result: unknown }
    expect(r.ok).toBe(true)
    expect(r.result).toBeNull()
    // S3 saw the conditional PUT
    expect(stack.mock.requests[0]!.method).toBe('PUT')
    expect(stack.mock.requests[0]!.headers['if-match']).toBe('"no-match"')
  })
})

// ─── DELETE ────────────────────────────────────────────────────────

describe('R2 delete()', () => {
  it('issues DELETE on the object URL', async () => {
    stack.mock.setHandler(() => ({ status: 204 }))
    const r = (await stack.sendOp({ op: 'delete', key: 'k' })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(stack.mock.requests[0]!.method).toBe('DELETE')
    expect(stack.mock.requests[0]!.url).toBe('/media/k')
  })

  it('treats 404 from S3 as idempotent success (R2 spec)', async () => {
    stack.mock.setHandler(() => ({
      status: 404,
      body: '<Error><Code>NoSuchKey</Code></Error>',
    }))
    const r = (await stack.sendOp({ op: 'delete', key: 'missing' })) as { ok: boolean }
    // R2.delete() is idempotent: deleting a non-existent key does NOT throw.
    // Workerd's R2Bucket binding swallows the NoSuchKey (10007) v4 code
    // before it reaches user code, so even though the adapter correctly
    // maps S3 404 → cf-r2-error 10007, the user worker observes success.
    expect(r.ok).toBe(true)
    // S3 still received the DELETE attempt
    expect(stack.mock.requests[0]!.method).toBe('DELETE')
  })
})

// ─── LIST ──────────────────────────────────────────────────────────

describe('R2 list()', () => {
  it('returns objects from a list response', async () => {
    stack.mock.setHandler(() => ({
      status: 200,
      headers: { 'content-type': 'application/xml' },
      body: listXml({
        objects: [
          { key: 'a', size: 1, etag: 'e1' },
          { key: 'b', size: 2, etag: 'e2' },
        ],
      }),
    }))
    const r = (await stack.sendOp({ op: 'list' })) as {
      ok: boolean
      result: { objects: Array<{ key: string; size: number }>; truncated: boolean }
    }
    expect(r.ok).toBe(true)
    expect(r.result.objects.map((o) => o.key)).toEqual(['a', 'b'])
    expect(r.result.truncated).toBe(false)
  })

  it('forwards prefix to S3', async () => {
    stack.mock.setHandler((req) => {
      const url = new URL(`http://x${req.url}`)
      expect(url.searchParams.get('prefix')).toBe('foo/')
      return { status: 200, body: listXml({ objects: [] }) }
    })
    await stack.sendOp({ op: 'list', options: { prefix: 'foo/' } })
  })

  it('returns cursor + truncated for paginated results', async () => {
    stack.mock.setHandler(() => ({
      status: 200,
      body: listXml({
        objects: [{ key: 'a', size: 1 }],
        truncated: true,
        nextCursor: 'page-2',
      }),
    }))
    const r = (await stack.sendOp({ op: 'list' })) as {
      result: { truncated: boolean; cursor: string }
    }
    expect(r.result.truncated).toBe(true)
    expect(r.result.cursor).toBe('page-2')
  })

  it('returns delimitedPrefixes when delimiter set', async () => {
    stack.mock.setHandler(() => ({
      status: 200,
      body: listXml({
        objects: [],
        prefixes: ['photos/', 'videos/'],
      }),
    }))
    const r = (await stack.sendOp({ op: 'list', options: { delimiter: '/' } })) as {
      result: { delimitedPrefixes: string[] }
    }
    expect(r.result.delimitedPrefixes).toEqual(['photos/', 'videos/'])
  })

  it('caps R2 limit at 1000 (S3 max-keys upper bound)', async () => {
    stack.mock.setHandler((req) => {
      const url = new URL(`http://x${req.url}`)
      expect(url.searchParams.get('max-keys')).toBe('1000')
      return { status: 200, body: listXml({ objects: [] }) }
    })
    await stack.sendOp({ op: 'list', options: { limit: 5000 } })
  })
})

// ─── Multipart upload (4 ops) ──────────────────────────────────────

describe('R2 multipart upload', () => {
  it('full happy path: create → upload 2 parts → complete', async () => {
    const requestLog: Array<{ method: string; url: string; bodyLen: number }> = []
    stack.mock.setHandler((req) => {
      requestLog.push({ method: req.method, url: req.url, bodyLen: req.body.byteLength })
      // Initiate
      if (req.method === 'POST' && req.url.endsWith('?uploads=')) {
        return {
          status: 200,
          body: `<?xml version="1.0"?>
<InitiateMultipartUploadResult>
  <UploadId>UPLOAD-XYZ</UploadId>
</InitiateMultipartUploadResult>`,
        }
      }
      // UploadPart
      if (req.method === 'PUT' && req.url.includes('partNumber=')) {
        const url = new URL(`http://x${req.url}`)
        const partNum = url.searchParams.get('partNumber')
        return { status: 200, headers: { etag: `"part-${partNum}"` } }
      }
      // Complete (POST + uploadId, no partNumber)
      if (req.method === 'POST' && req.url.includes('uploadId=')) {
        return {
          status: 200,
          body: `<?xml version="1.0"?>
<CompleteMultipartUploadResult>
  <ETag>"final-etag"</ETag>
</CompleteMultipartUploadResult>`,
        }
      }
      // HEAD-back after complete
      if (req.method === 'HEAD') {
        return { status: 200, headers: s3ObjectHeaders({ size: 1024, etag: 'final-etag' }) }
      }
      return { status: 500, body: 'unexpected' }
    })

    // Create
    const createR = (await stack.sendOp({
      op: 'createMultipartUpload',
      key: 'big.bin',
      options: { httpMetadata: { contentType: 'application/octet-stream' } },
    })) as { ok: boolean; result: { uploadId: string } }
    expect(createR.ok).toBe(true)
    expect(createR.result.uploadId).toBe('UPLOAD-XYZ')

    // Upload two parts
    const part1 = (await stack.sendOp({
      op: 'uploadPart',
      key: 'big.bin',
      uploadId: 'UPLOAD-XYZ',
      partNumber: 1,
      body: 'part-one-data',
    })) as { result: { partNumber: number; etag: string } }
    expect(part1.result.etag).toBe('part-1')

    const part2 = (await stack.sendOp({
      op: 'uploadPart',
      key: 'big.bin',
      uploadId: 'UPLOAD-XYZ',
      partNumber: 2,
      body: 'part-two-data',
    })) as { result: { partNumber: number; etag: string } }
    expect(part2.result.etag).toBe('part-2')

    // Complete
    const completeR = (await stack.sendOp({
      op: 'completeMultipartUpload',
      key: 'big.bin',
      uploadId: 'UPLOAD-XYZ',
      parts: [
        { partNumber: 1, etag: 'part-1' },
        { partNumber: 2, etag: 'part-2' },
      ],
    })) as { ok: boolean; result: { etag: string; size: number } }
    expect(completeR.ok).toBe(true)
    expect(completeR.result.etag).toBe('final-etag')

    // Verify the S3 wire sequence: POST?uploads, PUT?partNumber, PUT?partNumber, POST?uploadId, HEAD
    const methods = requestLog.map((r) => r.method)
    expect(methods).toEqual(['POST', 'PUT', 'PUT', 'POST', 'HEAD'])
  }, 30_000)

  it('abortMultipartUpload sends DELETE ?uploadId', async () => {
    stack.mock.setHandler(() => ({ status: 204 }))
    const r = (await stack.sendOp({
      op: 'abortMultipartUpload',
      key: 'k',
      uploadId: 'XYZ',
    })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(stack.mock.requests[0]!.method).toBe('DELETE')
    const url = new URL(`http://x${stack.mock.requests[0]!.url}`)
    expect(url.searchParams.get('uploadId')).toBe('XYZ')
  })
})

// ─── Cross-cutting: error mapping ──────────────────────────────────

describe('S3 error mapping', () => {
  it('5xx → InternalError', async () => {
    stack.mock.setHandler(() => ({
      status: 503,
      body: '<Error><Code>ServiceUnavailable</Code><Message>down</Message></Error>',
    }))
    const r = (await stack.sendOp({ op: 'head', key: 'k' })) as { ok: boolean; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/down|10001|InternalError|ServiceUnavailable/)
  })

  it('403 → AccessDenied', async () => {
    stack.mock.setHandler(() => ({
      status: 403,
      body: '<Error><Code>AccessDenied</Code><Message>nope</Message></Error>',
    }))
    const r = (await stack.sendOp({ op: 'put', key: 'k', body: 'x' })) as {
      ok: boolean
      error: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/nope|AccessDenied|10004|403/)
  })
})
