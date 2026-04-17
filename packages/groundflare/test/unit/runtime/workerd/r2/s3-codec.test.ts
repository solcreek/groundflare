/**
 * Unit tests for the R2 ↔ S3 codec.
 *
 * Each test calls a pure function in s3-codec.ts and asserts the
 * structured output. No I/O, no fetch.
 */

import { describe, expect, it } from 'vitest'

import {
  EMPTY_SHA256,
  conditionalToS3Headers,
  customFieldsToS3Headers,
  encodeS3Key,
  httpFieldsToS3Headers,
  parseCompleteMultipartXml,
  parseInitiateMultipartXml,
  parseListXmlV2,
  r2OpToS3Request,
  rangeToS3Header,
  s3ResponseToR2Meta,
  s3StatusToR2Error,
  type R2Conditional,
  type R2HttpFields,
  type R2KV,
  type R2Range,
  type S3CodecContext,
} from '../../../../../src/runtime/workerd/r2/s3-codec.js'

const CTX: S3CodecContext = {
  bucket: 'media',
  endpoint: 'http://127.0.0.1:8333',
}

// ─── encodeS3Key ────────────────────────────────────────────────────

describe('encodeS3Key', () => {
  it('passes ASCII unreserved through unchanged', () => {
    expect(encodeS3Key('abc123-._~')).toBe('abc123-._~')
  })

  it('preserves slashes (multi-segment keys)', () => {
    expect(encodeS3Key('a/b/c.txt')).toBe('a/b/c.txt')
  })

  it('percent-encodes spaces', () => {
    expect(encodeS3Key('hello world.txt')).toBe('hello%20world.txt')
  })

  it('percent-encodes URL-reserved chars', () => {
    expect(encodeS3Key('a?b#c&d=e')).toBe('a%3Fb%23c%26d%3De')
  })

  it('percent-encodes Unicode (Chinese)', () => {
    // 你 is U+4F60 → UTF-8 E4 BD A0
    expect(encodeS3Key('hi/你.txt')).toBe('hi/%E4%BD%A0.txt')
  })

  it('handles empty key', () => {
    expect(encodeS3Key('')).toBe('')
  })

  it('preserves leading/trailing slashes literally', () => {
    expect(encodeS3Key('/a/')).toBe('/a/')
  })

  it('encodes percent itself', () => {
    expect(encodeS3Key('100%off')).toBe('100%25off')
  })
})

// ─── rangeToS3Header ───────────────────────────────────────────────

describe('rangeToS3Header', () => {
  it('returns null when both inputs absent', () => {
    expect(rangeToS3Header(undefined, undefined)).toBeNull()
  })

  it('rangeHeader takes precedence over structured range', () => {
    expect(
      rangeToS3Header({ offset: 0, length: 99 }, 'bytes=10-20'),
    ).toBe('bytes=10-20')
  })

  it('translates offset+length to closed range', () => {
    expect(rangeToS3Header({ offset: 100, length: 50 }, undefined)).toBe(
      'bytes=100-149',
    )
  })

  it('translates offset only to open-ended range', () => {
    expect(rangeToS3Header({ offset: 100 }, undefined)).toBe('bytes=100-')
  })

  it('translates length only to 0-length range', () => {
    expect(rangeToS3Header({ length: 50 }, undefined)).toBe('bytes=0-49')
  })

  it('translates suffix to suffix range', () => {
    expect(rangeToS3Header({ suffix: 100 }, undefined)).toBe('bytes=-100')
  })

  it('suffix takes precedence over offset/length', () => {
    expect(rangeToS3Header({ offset: 10, length: 20, suffix: 50 }, undefined))
      .toBe('bytes=-50')
  })

  it('empty rangeHeader treated as absent', () => {
    expect(rangeToS3Header({ offset: 5 }, '')).toBe('bytes=5-')
  })
})

// ─── conditionalToS3Headers ────────────────────────────────────────

describe('conditionalToS3Headers', () => {
  it('returns empty when undefined', () => {
    expect(conditionalToS3Headers(undefined)).toEqual({})
  })

  it('formats strong etag match', () => {
    const cond: R2Conditional = {
      etagMatches: [{ value: 'abc', type: { strong: null } }],
    }
    expect(conditionalToS3Headers(cond)).toEqual({ 'if-match': '"abc"' })
  })

  it('formats weak etag match', () => {
    const cond: R2Conditional = {
      etagMatches: [{ value: 'abc', type: { weak: null } }],
    }
    expect(conditionalToS3Headers(cond)).toEqual({ 'if-match': 'W/"abc"' })
  })

  it('formats wildcard etag match', () => {
    const cond: R2Conditional = {
      etagMatches: [{ value: '', type: { wildcard: null } }],
    }
    expect(conditionalToS3Headers(cond)).toEqual({ 'if-match': '*' })
  })

  it('combines multiple etag values with comma', () => {
    const cond: R2Conditional = {
      etagMatches: [
        { value: 'a', type: { strong: null } },
        { value: 'b', type: { weak: null } },
      ],
    }
    expect(conditionalToS3Headers(cond)['if-match']).toBe('"a", W/"b"')
  })

  it('formats etagDoesNotMatch as if-none-match', () => {
    const cond: R2Conditional = {
      etagDoesNotMatch: [{ value: 'x', type: { strong: null } }],
    }
    expect(conditionalToS3Headers(cond)).toEqual({ 'if-none-match': '"x"' })
  })

  it('formats uploadedAfter as if-modified-since', () => {
    const cond: R2Conditional = { uploadedAfter: 1700000000000 }
    const h = conditionalToS3Headers(cond)
    expect(h['if-modified-since']).toBe(new Date(1700000000000).toUTCString())
  })

  it('formats uploadedBefore as if-unmodified-since', () => {
    const cond: R2Conditional = { uploadedBefore: 1700000000000 }
    const h = conditionalToS3Headers(cond)
    expect(h['if-unmodified-since']).toBe(new Date(1700000000000).toUTCString())
  })

  it('combines all condition types', () => {
    const cond: R2Conditional = {
      etagMatches: [{ value: 'a', type: { strong: null } }],
      etagDoesNotMatch: [{ value: 'b', type: { strong: null } }],
      uploadedBefore: 1000,
      uploadedAfter: 500,
    }
    const h = conditionalToS3Headers(cond)
    expect(h['if-match']).toBe('"a"')
    expect(h['if-none-match']).toBe('"b"')
    expect(h['if-modified-since']).toBeDefined()
    expect(h['if-unmodified-since']).toBeDefined()
  })

  // Workerd's actual on-the-wire form: type is a STRING discriminator,
  // not a nested object. Both shapes must work.
  it('accepts string-form etag type discriminator (capnp $Json wire form)', () => {
    expect(
      conditionalToS3Headers({
        etagMatches: [{ value: 'abc', type: 'strong' }],
      }),
    ).toEqual({ 'if-match': '"abc"' })
    expect(
      conditionalToS3Headers({
        etagMatches: [{ value: 'abc', type: 'weak' }],
      }),
    ).toEqual({ 'if-match': 'W/"abc"' })
    expect(
      conditionalToS3Headers({
        etagMatches: [{ value: '', type: 'wildcard' }],
      }),
    ).toEqual({ 'if-match': '*' })
  })
})

// ─── httpFieldsToS3Headers / customFieldsToS3Headers ────────────────

describe('httpFieldsToS3Headers', () => {
  it('returns empty when undefined', () => {
    expect(httpFieldsToS3Headers(undefined)).toEqual({})
  })

  it('maps every field', () => {
    const fields: R2HttpFields = {
      contentType: 'text/plain',
      contentLanguage: 'en-US',
      contentDisposition: 'inline',
      contentEncoding: 'gzip',
      cacheControl: 'public, max-age=3600',
      cacheExpiry: 1700000000000,
    }
    const h = httpFieldsToS3Headers(fields)
    expect(h['content-type']).toBe('text/plain')
    expect(h['content-language']).toBe('en-US')
    expect(h['content-disposition']).toBe('inline')
    expect(h['content-encoding']).toBe('gzip')
    expect(h['cache-control']).toBe('public, max-age=3600')
    expect(h['expires']).toBe(new Date(1700000000000).toUTCString())
  })

  it('omits absent fields', () => {
    const h = httpFieldsToS3Headers({ contentType: 'text/plain' })
    expect(Object.keys(h)).toEqual(['content-type'])
  })
})

describe('customFieldsToS3Headers', () => {
  it('returns empty when absent', () => {
    expect(customFieldsToS3Headers(undefined)).toEqual({})
    expect(customFieldsToS3Headers([])).toEqual({})
  })

  it('emits x-amz-meta-* with lowercased keys', () => {
    const f: R2KV[] = [
      { k: 'Source', v: 'poc' },
      { k: 'Author', v: 'alice' },
    ]
    expect(customFieldsToS3Headers(f)).toEqual({
      'x-amz-meta-source': 'poc',
      'x-amz-meta-author': 'alice',
    })
  })

  it('preserves values verbatim (no encoding)', () => {
    const f: R2KV[] = [{ k: 'note', v: 'hello world! 你好' }]
    expect(customFieldsToS3Headers(f)['x-amz-meta-note']).toBe('hello world! 你好')
  })
})

// ─── r2OpToS3Request — head / get / put / delete / list ────────────

describe('r2OpToS3Request - head', () => {
  it('builds HEAD request to object URL', () => {
    const plan = r2OpToS3Request({ method: 'head', object: 'k' }, null, CTX)
    expect(plan.method).toBe('HEAD')
    expect(plan.url).toBe('http://127.0.0.1:8333/media/k')
    expect(plan.body).toBeNull()
    expect(plan.payloadHash).toBe(EMPTY_SHA256)
  })

  it('encodes special chars in key', () => {
    const plan = r2OpToS3Request({ method: 'head', object: 'a b/c' }, null, CTX)
    expect(plan.url).toBe('http://127.0.0.1:8333/media/a%20b/c')
  })

  it('throws when object missing', () => {
    expect(() => r2OpToS3Request({ method: 'head' }, null, CTX)).toThrowError(
      /head\.object must be a string/,
    )
  })
})

describe('r2OpToS3Request - get', () => {
  it('builds simple GET', () => {
    const plan = r2OpToS3Request({ method: 'get', object: 'k' }, null, CTX)
    expect(plan.method).toBe('GET')
    expect(plan.headers).toEqual({})
  })

  it('translates structured range to Range header', () => {
    const plan = r2OpToS3Request(
      { method: 'get', object: 'k', range: { offset: 0, length: 100 } },
      null,
      CTX,
    )
    expect(plan.headers['range']).toBe('bytes=0-99')
  })

  it('uses rangeHeader literal if both present', () => {
    const plan = r2OpToS3Request(
      {
        method: 'get',
        object: 'k',
        range: { offset: 0, length: 100 },
        rangeHeader: 'bytes=200-299',
      },
      null,
      CTX,
    )
    expect(plan.headers['range']).toBe('bytes=200-299')
  })

  it('attaches conditional headers', () => {
    const plan = r2OpToS3Request(
      {
        method: 'get',
        object: 'k',
        onlyIf: {
          etagMatches: [{ value: 'abc', type: { strong: null } }],
        },
      },
      null,
      CTX,
    )
    expect(plan.headers['if-match']).toBe('"abc"')
  })
})

describe('r2OpToS3Request - put', () => {
  function streamFromText(s: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(s))
        c.close()
      },
    })
  }

  it('builds PUT with payload stream and UNSIGNED-PAYLOAD hash', () => {
    const stream = streamFromText('hi')
    const plan = r2OpToS3Request({ method: 'put', object: 'k' }, stream, CTX)
    expect(plan.method).toBe('PUT')
    expect(plan.url).toBe('http://127.0.0.1:8333/media/k')
    expect(plan.body).toBe(stream)
    expect(plan.payloadHash).toBe('UNSIGNED-PAYLOAD')
  })

  it('uses EMPTY_SHA256 when payload is null', () => {
    const plan = r2OpToS3Request({ method: 'put', object: 'k' }, null, CTX)
    expect(plan.payloadHash).toBe(EMPTY_SHA256)
  })

  it('attaches httpFields as standard headers', () => {
    const stream = streamFromText('x')
    const plan = r2OpToS3Request(
      {
        method: 'put',
        object: 'k',
        httpFields: { contentType: 'image/png', cacheControl: 'no-cache' },
      },
      stream,
      CTX,
    )
    expect(plan.headers['content-type']).toBe('image/png')
    expect(plan.headers['cache-control']).toBe('no-cache')
  })

  it('attaches customFields as x-amz-meta-*', () => {
    const stream = streamFromText('x')
    const plan = r2OpToS3Request(
      {
        method: 'put',
        object: 'k',
        customFields: [{ k: 'source', v: 'poc' }],
      },
      stream,
      CTX,
    )
    expect(plan.headers['x-amz-meta-source']).toBe('poc')
  })

  it('attaches storageClass as x-amz-storage-class', () => {
    const stream = streamFromText('x')
    const plan = r2OpToS3Request(
      { method: 'put', object: 'k', storageClass: 'STANDARD_IA' },
      stream,
      CTX,
    )
    expect(plan.headers['x-amz-storage-class']).toBe('STANDARD_IA')
  })

  it('attaches conditional headers', () => {
    const stream = streamFromText('x')
    const plan = r2OpToS3Request(
      {
        method: 'put',
        object: 'k',
        onlyIf: {
          etagDoesNotMatch: [{ value: '', type: { wildcard: null } }],
        },
      },
      stream,
      CTX,
    )
    expect(plan.headers['if-none-match']).toBe('*')
  })
})

describe('r2OpToS3Request - delete', () => {
  it('builds DELETE for single object', () => {
    const plan = r2OpToS3Request({ method: 'delete', object: 'k' }, null, CTX)
    expect(plan.method).toBe('DELETE')
    expect(plan.url).toBe('http://127.0.0.1:8333/media/k')
  })

  it('throws on batch delete (objects array) — not yet supported', () => {
    expect(() =>
      r2OpToS3Request({ method: 'delete', objects: ['a', 'b'] }, null, CTX),
    ).toThrowError(/Batch delete not yet supported/)
  })
})

describe('r2OpToS3Request - list', () => {
  it('builds GET with list-type=2', () => {
    const plan = r2OpToS3Request({ method: 'list' }, null, CTX)
    const u = new URL(plan.url)
    expect(u.pathname).toBe('/media/')
    expect(u.searchParams.get('list-type')).toBe('2')
  })

  it('passes through prefix, limit, cursor, delimiter, startAfter', () => {
    const plan = r2OpToS3Request(
      {
        method: 'list',
        prefix: 'foo/',
        limit: 50,
        cursor: 'abc',
        delimiter: '/',
        startAfter: 'foo/x',
      },
      null,
      CTX,
    )
    const u = new URL(plan.url)
    expect(u.searchParams.get('prefix')).toBe('foo/')
    expect(u.searchParams.get('max-keys')).toBe('50')
    expect(u.searchParams.get('continuation-token')).toBe('abc')
    expect(u.searchParams.get('delimiter')).toBe('/')
    expect(u.searchParams.get('start-after')).toBe('foo/x')
  })

  it('caps max-keys at 1000', () => {
    const plan = r2OpToS3Request({ method: 'list', limit: 5000 }, null, CTX)
    const u = new URL(plan.url)
    expect(u.searchParams.get('max-keys')).toBe('1000')
  })

  it('drops the R2 sentinel limit (0xffffffff) instead of forwarding', () => {
    const plan = r2OpToS3Request({ method: 'list', limit: 0xffffffff }, null, CTX)
    const u = new URL(plan.url)
    expect(u.searchParams.get('max-keys')).toBeNull()
  })

  it('drops empty-string params', () => {
    const plan = r2OpToS3Request(
      { method: 'list', prefix: '', cursor: '', delimiter: '', startAfter: '' },
      null,
      CTX,
    )
    const u = new URL(plan.url)
    expect(u.searchParams.get('prefix')).toBeNull()
    expect(u.searchParams.get('continuation-token')).toBeNull()
  })
})

// ─── r2OpToS3Request — multipart 4 ops ─────────────────────────────

describe('r2OpToS3Request - createMultipartUpload', () => {
  it('builds POST ?uploads with metadata', () => {
    const plan = r2OpToS3Request(
      {
        method: 'createMultipartUpload',
        object: 'big.bin',
        httpFields: { contentType: 'application/octet-stream' },
        customFields: [{ k: 'origin', v: 'upload-form' }],
      },
      null,
      CTX,
    )
    expect(plan.method).toBe('POST')
    expect(plan.url).toBe('http://127.0.0.1:8333/media/big.bin?uploads=')
    expect(plan.headers['content-type']).toBe('application/octet-stream')
    expect(plan.headers['x-amz-meta-origin']).toBe('upload-form')
  })

  it('throws when object missing', () => {
    expect(() =>
      r2OpToS3Request({ method: 'createMultipartUpload' }, null, CTX),
    ).toThrowError(/object must be a string/)
  })
})

describe('r2OpToS3Request - uploadPart', () => {
  it('builds PUT ?partNumber&uploadId with payload', () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        c.close()
      },
    })
    const plan = r2OpToS3Request(
      {
        method: 'uploadPart',
        object: 'k',
        uploadId: 'UID',
        partNumber: 3,
      },
      stream,
      CTX,
    )
    expect(plan.method).toBe('PUT')
    const u = new URL(plan.url)
    expect(u.pathname).toBe('/media/k')
    expect(u.searchParams.get('partNumber')).toBe('3')
    expect(u.searchParams.get('uploadId')).toBe('UID')
    expect(plan.body).toBe(stream)
    expect(plan.payloadHash).toBe('UNSIGNED-PAYLOAD')
  })

  it('throws on missing uploadId', () => {
    expect(() =>
      r2OpToS3Request({ method: 'uploadPart', object: 'k', partNumber: 1 }, null, CTX),
    ).toThrowError(/uploadId/)
  })

  it('throws on non-positive partNumber', () => {
    expect(() =>
      r2OpToS3Request(
        { method: 'uploadPart', object: 'k', uploadId: 'X', partNumber: 0 },
        null,
        CTX,
      ),
    ).toThrowError(/positive integer/)
  })
})

describe('r2OpToS3Request - completeMultipartUpload', () => {
  it('builds POST with XML body listing parts', () => {
    const plan = r2OpToS3Request(
      {
        method: 'completeMultipartUpload',
        object: 'k',
        uploadId: 'UID',
        parts: [
          { part: 1, etag: 'etag1' },
          { part: 2, etag: '"etag2"' },
        ],
      },
      null,
      CTX,
    )
    expect(plan.method).toBe('POST')
    const u = new URL(plan.url)
    expect(u.searchParams.get('uploadId')).toBe('UID')
    expect(plan.headers['content-type']).toBe('application/xml')
    expect(plan.body).toBeInstanceOf(Uint8Array)
    const xml = new TextDecoder().decode(plan.body as Uint8Array)
    expect(xml).toContain('<PartNumber>1</PartNumber>')
    expect(xml).toContain('<ETag>"etag1"</ETag>')
    expect(xml).toContain('<PartNumber>2</PartNumber>')
    // Already-quoted etag stays quoted (not double-quoted)
    expect(xml).toContain('<ETag>"etag2"</ETag>')
  })

  it('throws on empty parts array', () => {
    expect(() =>
      r2OpToS3Request(
        {
          method: 'completeMultipartUpload',
          object: 'k',
          uploadId: 'UID',
          parts: [],
        },
        null,
        CTX,
      ),
    ).toThrowError(/non-empty array/)
  })
})

describe('r2OpToS3Request - abortMultipartUpload', () => {
  it('builds DELETE ?uploadId', () => {
    const plan = r2OpToS3Request(
      { method: 'abortMultipartUpload', object: 'k', uploadId: 'UID' },
      null,
      CTX,
    )
    expect(plan.method).toBe('DELETE')
    const u = new URL(plan.url)
    expect(u.pathname).toBe('/media/k')
    expect(u.searchParams.get('uploadId')).toBe('UID')
  })
})

describe('r2OpToS3Request - unknown method', () => {
  it('throws TypeError for forward-compat methods we have not wired', () => {
    expect(() =>
      r2OpToS3Request({ method: 'futureOp', object: 'k' }, null, CTX),
    ).toThrowError(/Unsupported R2 op method: futureOp/)
  })
})

// ─── s3ResponseToR2Meta ────────────────────────────────────────────

describe('s3ResponseToR2Meta', () => {
  function makeResponse(headers: Record<string, string>): Response {
    return new Response(null, { status: 200, headers })
  }

  it('extracts size from content-length', () => {
    const m = s3ResponseToR2Meta(makeResponse({ 'content-length': '42' }), 'k')
    expect(m.size).toBe(42)
  })

  it('uses sizeOverride when provided', () => {
    const m = s3ResponseToR2Meta(
      makeResponse({ 'content-length': '0' }),
      'k',
      99,
    )
    expect(m.size).toBe(99)
  })

  it('strips quotes from etag', () => {
    const m = s3ResponseToR2Meta(makeResponse({ etag: '"abc123"' }), 'k')
    expect(m.etag).toBe('abc123')
  })

  it('parses last-modified into millis', () => {
    const lm = 'Sun, 17 Apr 2026 03:15:26 GMT'
    const m = s3ResponseToR2Meta(makeResponse({ 'last-modified': lm }), 'k')
    expect(m.uploaded).toBe(Date.parse(lm))
  })

  it('falls back to now() if last-modified absent', () => {
    const before = Date.now()
    const m = s3ResponseToR2Meta(makeResponse({}), 'k')
    const after = Date.now()
    expect(m.uploaded).toBeGreaterThanOrEqual(before)
    expect(m.uploaded).toBeLessThanOrEqual(after)
  })

  it('extracts all R2HttpFields', () => {
    const m = s3ResponseToR2Meta(
      makeResponse({
        'content-type': 'image/png',
        'content-language': 'en-US',
        'content-disposition': 'inline',
        'content-encoding': 'gzip',
        'cache-control': 'public',
        expires: 'Sun, 17 Apr 2026 03:15:26 GMT',
      }),
      'k',
    )
    expect(m.httpFields.contentType).toBe('image/png')
    expect(m.httpFields.contentLanguage).toBe('en-US')
    expect(m.httpFields.contentDisposition).toBe('inline')
    expect(m.httpFields.contentEncoding).toBe('gzip')
    expect(m.httpFields.cacheControl).toBe('public')
    expect(m.httpFields.cacheExpiry).toBe(Date.parse('Sun, 17 Apr 2026 03:15:26 GMT'))
  })

  it('extracts custom metadata from x-amz-meta-*', () => {
    const m = s3ResponseToR2Meta(
      makeResponse({
        'x-amz-meta-source': 'poc',
        'x-amz-meta-author': 'alice',
      }),
      'k',
    )
    const sorted = [...m.customFields].sort((a, b) => a.k.localeCompare(b.k))
    expect(sorted).toEqual([
      { k: 'author', v: 'alice' },
      { k: 'source', v: 'poc' },
    ])
  })

  it('uses x-amz-version-id as version, falls back to etag', () => {
    const withVersion = s3ResponseToR2Meta(
      makeResponse({ etag: '"e"', 'x-amz-version-id': 'v123' }),
      'k',
    )
    expect(withVersion.version).toBe('v123')
    const withoutVersion = s3ResponseToR2Meta(
      makeResponse({ etag: '"e"' }),
      'k',
    )
    expect(withoutVersion.version).toBe('e')
  })

  it('attaches storage class when present', () => {
    const m = s3ResponseToR2Meta(
      makeResponse({ 'x-amz-storage-class': 'STANDARD_IA' }),
      'k',
    )
    expect(m.storageClass).toBe('STANDARD_IA')
  })
})

// ─── parseListXmlV2 ────────────────────────────────────────────────

describe('parseListXmlV2', () => {
  it('parses empty bucket', () => {
    const xml = `<?xml version="1.0"?>
      <ListBucketResult>
        <Name>media</Name>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`
    const r = parseListXmlV2(xml)
    expect(r.objects).toEqual([])
    expect(r.delimitedPrefixes).toEqual([])
    expect(r.truncated).toBe(false)
    expect(r.cursor).toBeUndefined()
  })

  it('parses a single object', () => {
    const xml = `
      <ListBucketResult>
        <Contents>
          <Key>hello</Key>
          <Size>11</Size>
          <ETag>&#34;abc&#34;</ETag>
          <LastModified>2026-04-17T03:15:26Z</LastModified>
          <StorageClass>STANDARD</StorageClass>
        </Contents>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`
    const r = parseListXmlV2(xml)
    expect(r.objects).toHaveLength(1)
    expect(r.objects[0]!.name).toBe('hello')
    expect(r.objects[0]!.size).toBe(11)
    expect(r.objects[0]!.etag).toBe('abc')
    expect(r.objects[0]!.uploaded).toBe(Date.parse('2026-04-17T03:15:26Z'))
    expect(r.objects[0]!.storageClass).toBe('STANDARD')
  })

  it('parses multiple objects', () => {
    const xml = `
      <ListBucketResult>
        <Contents><Key>a</Key><Size>1</Size><ETag>"e1"</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>
        <Contents><Key>b</Key><Size>2</Size><ETag>"e2"</ETag><LastModified>2026-01-02T00:00:00Z</LastModified></Contents>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`
    const r = parseListXmlV2(xml)
    expect(r.objects.map((o) => o.name)).toEqual(['a', 'b'])
  })

  it('parses CommonPrefixes (delimited prefixes)', () => {
    const xml = `
      <ListBucketResult>
        <CommonPrefixes><Prefix>foo/</Prefix></CommonPrefixes>
        <CommonPrefixes><Prefix>bar/</Prefix></CommonPrefixes>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`
    const r = parseListXmlV2(xml)
    expect(r.delimitedPrefixes).toEqual(['foo/', 'bar/'])
  })

  it('reports truncated + cursor', () => {
    const xml = `
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>abc-token</NextContinuationToken>
      </ListBucketResult>`
    const r = parseListXmlV2(xml)
    expect(r.truncated).toBe(true)
    expect(r.cursor).toBe('abc-token')
  })

  it('decodes XML entities in keys', () => {
    const xml = `
      <ListBucketResult>
        <Contents><Key>a&amp;b</Key><Size>0</Size><ETag>"x"</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`
    const r = parseListXmlV2(xml)
    expect(r.objects[0]!.name).toBe('a&b')
  })

  it('skips Contents missing a Key', () => {
    const xml = `
      <ListBucketResult>
        <Contents><Size>1</Size></Contents>
        <Contents><Key>good</Key><Size>2</Size><ETag>"e"</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`
    const r = parseListXmlV2(xml)
    expect(r.objects).toHaveLength(1)
    expect(r.objects[0]!.name).toBe('good')
  })
})

// ─── parseInitiateMultipartXml / parseCompleteMultipartXml ────────

describe('parseInitiateMultipartXml', () => {
  it('extracts UploadId', () => {
    const xml = `<?xml version="1.0"?>
      <InitiateMultipartUploadResult>
        <Bucket>media</Bucket>
        <Key>k</Key>
        <UploadId>upload-abc-123</UploadId>
      </InitiateMultipartUploadResult>`
    expect(parseInitiateMultipartXml(xml).uploadId).toBe('upload-abc-123')
  })

  it('throws when UploadId missing', () => {
    expect(() => parseInitiateMultipartXml('<root/>')).toThrowError(/UploadId/)
  })
})

describe('parseCompleteMultipartXml', () => {
  it('extracts unquoted final ETag', () => {
    const xml = `<?xml version="1.0"?>
      <CompleteMultipartUploadResult>
        <ETag>&#34;final-etag-abc&#34;</ETag>
      </CompleteMultipartUploadResult>`
    expect(parseCompleteMultipartXml(xml).etag).toBe('final-etag-abc')
  })
})

// ─── s3StatusToR2Error ─────────────────────────────────────────────

describe('s3StatusToR2Error', () => {
  it('maps 404 → NoSuchKey (10007)', () => {
    expect(s3StatusToR2Error(404, '')).toEqual({
      httpStatus: 404,
      v4code: 10007,
      message: 'NoSuchKey',
    })
  })

  it('maps 403 → AccessDenied (10004)', () => {
    expect(s3StatusToR2Error(403, '').v4code).toBe(10004)
  })

  it('maps 412 → PreconditionFailed (10031)', () => {
    expect(s3StatusToR2Error(412, '').v4code).toBe(10031)
  })

  it('maps 304 → NotModified (10032)', () => {
    expect(s3StatusToR2Error(304, '').v4code).toBe(10032)
  })

  it('maps 416 → InvalidRange (10039)', () => {
    expect(s3StatusToR2Error(416, '').v4code).toBe(10039)
  })

  it('maps 5xx → InternalError (10001)', () => {
    expect(s3StatusToR2Error(500, '').v4code).toBe(10001)
    expect(s3StatusToR2Error(503, '').v4code).toBe(10001)
  })

  it('prefers AWS Code over status mapping when both inform', () => {
    // 500 status but body says EntityTooLarge → use the specific code
    const xml = '<Error><Code>EntityTooLarge</Code><Message>too big</Message></Error>'
    const r = s3StatusToR2Error(500, xml)
    expect(r.v4code).toBe(10025)
    expect(r.message).toBe('too big')
  })

  it('falls back to status mapping when AWS Code unknown', () => {
    const xml = '<Error><Code>FutureMysteryError</Code><Message>?</Message></Error>'
    const r = s3StatusToR2Error(500, xml)
    expect(r.v4code).toBe(10001) // generic 500
  })

  it('uses message from AWS Error when available', () => {
    const xml = '<Error><Code>NoSuchKey</Code><Message>nope</Message></Error>'
    const r = s3StatusToR2Error(404, xml)
    expect(r.message).toBe('nope')
  })

  it('truncates excessively long messages', () => {
    const big = 'X'.repeat(500)
    const r = s3StatusToR2Error(400, big)
    expect(r.message.length).toBeLessThanOrEqual(200)
  })
})
