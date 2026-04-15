/**
 * Bun-native tests for the bun:sqlite R2 adapter.
 * Runs under `bun test`. See test/bun/README.md.
 *
 * These tests inject a mock fetch so we can exercise the request-
 * shape + SigV4 composition without contacting real Cloudflare R2.
 * A live R2 smoke test would require credentials and network access;
 * it belongs in Phase 4 e2e, not here.
 */

import { describe, test, expect } from 'bun:test'
import { BunR2Adapter } from '../../../src/runtime/bun/adapters/r2.ts'

type MockCall = {
  url: string
  method: string
  headers: Record<string, string>
  body: Uint8Array | undefined
}

function mockFetch(
  responses: (req: MockCall) => Response | Promise<Response>,
): {
  fetch: typeof fetch
  calls: MockCall[]
} {
  const calls: MockCall[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    const h = init?.headers
    if (h) {
      if (h instanceof Headers) {
        for (const [k, v] of h) headers[k.toLowerCase()] = v
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k.toLowerCase()] = v
      } else {
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v)
      }
    }
    let body: Uint8Array | undefined
    if (init?.body) {
      if (init.body instanceof Uint8Array) body = init.body
      else if (init.body instanceof ArrayBuffer)
        body = new Uint8Array(init.body)
      else if (typeof init.body === 'string')
        body = new TextEncoder().encode(init.body)
    }
    const call: MockCall = { url, method, headers, body }
    calls.push(call)
    return responses(call)
  }
  return { fetch: fn as typeof fetch, calls }
}

const BASE = {
  accountId: 'acc12345',
  bucket: 'assets',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}

describe('BunR2Adapter — constructor', () => {
  test('rejects missing accountId / bucket', () => {
    expect(
      () => new BunR2Adapter({ ...BASE, accountId: '' }),
    ).toThrow(/accountId/)
    expect(
      () => new BunR2Adapter({ ...BASE, bucket: '' }),
    ).toThrow(/bucket/)
  })

  test('rejects missing credentials', () => {
    expect(
      () => new BunR2Adapter({ ...BASE, accessKeyId: '' }),
    ).toThrow(/accessKeyId/)
    expect(
      () => new BunR2Adapter({ ...BASE, secretAccessKey: '' }),
    ).toThrow(/secretAccessKey/)
  })
})

describe('BunR2Adapter — request URL composition', () => {
  test('put targets <accountId>.r2.cloudflarestorage.com/<bucket>/<key>', async () => {
    const { fetch, calls } = mockFetch(
      () =>
        new Response(null, { status: 200, headers: { etag: '"abc"' } }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    await r2.put('logos/banner.png', 'hi')
    expect(calls[0]!.url).toBe(
      'https://acc12345.r2.cloudflarestorage.com/assets/logos/banner.png',
    )
    expect(calls[0]!.method).toBe('PUT')
  })

  test('special characters in the key are percent-encoded (slashes preserved)', async () => {
    const { fetch, calls } = mockFetch(
      () => new Response(null, { status: 200, headers: { etag: '"x"' } }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    await r2.put('files/hello world (v2).txt', 'x')
    expect(calls[0]!.url).toContain('/files/hello%20world%20%28v2%29.txt')
  })

  test('list appends S3 query parameters', async () => {
    const xml = emptyListXml()
    const { fetch, calls } = mockFetch(() => new Response(xml))
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    await r2.list({ prefix: 'logos/', limit: 50, cursor: 'next-page' })
    expect(calls[0]!.url).toContain('list-type=2')
    expect(calls[0]!.url).toContain('prefix=logos%2F')
    expect(calls[0]!.url).toContain('max-keys=50')
    expect(calls[0]!.url).toContain('continuation-token=next-page')
  })
})

describe('BunR2Adapter — SigV4 request signing', () => {
  test('signed requests carry Authorization + x-amz-date + payload hash', async () => {
    const { fetch, calls } = mockFetch(
      () =>
        new Response(null, { status: 200, headers: { etag: '"h"' } }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch, now: () => Date.UTC(2026, 3, 15, 10, 0, 0) })
    await r2.put('k', 'hello')
    const h = calls[0]!.headers
    expect(h['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260415\/auto\/s3\/aws4_request,/,
    )
    expect(h['x-amz-date']).toBe('20260415T100000Z')
    // sha256("hello")
    expect(h['x-amz-content-sha256']).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  test('custom metadata becomes x-amz-meta-* headers, signed in the request', async () => {
    const { fetch, calls } = mockFetch(
      () => new Response(null, { status: 200, headers: { etag: '"m"' } }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    await r2.put('k', 'v', {
      customMetadata: { 'Owner': 'alice', 'region': 'us-east-1' },
    })
    const h = calls[0]!.headers
    expect(h['x-amz-meta-owner']).toBe('alice')
    expect(h['x-amz-meta-region']).toBe('us-east-1')
    expect(h['authorization']).toContain('x-amz-meta-owner')
    expect(h['authorization']).toContain('x-amz-meta-region')
  })

  test('httpMetadata maps onto standard HTTP headers', async () => {
    const { fetch, calls } = mockFetch(
      () => new Response(null, { status: 200, headers: { etag: '"m"' } }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    await r2.put('k', 'v', {
      httpMetadata: {
        contentType: 'image/png',
        cacheControl: 'public, max-age=3600',
      },
    })
    expect(calls[0]!.headers['content-type']).toBe('image/png')
    expect(calls[0]!.headers['cache-control']).toBe('public, max-age=3600')
  })
})

describe('BunR2Adapter — response handling', () => {
  test('get on 404 returns null', async () => {
    const { fetch } = mockFetch(() => new Response(null, { status: 404 }))
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    expect(await r2.get('missing')).toBeNull()
  })

  test('get on 200 returns an R2ObjectBody with metadata', async () => {
    const { fetch } = mockFetch(
      () =>
        new Response('body-bytes', {
          status: 200,
          headers: {
            etag: '"d41d8cd98f00b204e9800998ecf8427e"',
            'content-length': '10',
            'content-type': 'text/plain',
            'x-amz-meta-owner': 'alice',
            'last-modified': 'Wed, 15 Apr 2026 10:00:00 GMT',
          },
        }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    const obj = await r2.get('file.txt')
    expect(obj).not.toBeNull()
    expect(obj!.key).toBe('file.txt')
    expect(obj!.etag).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(obj!.httpEtag).toBe('"d41d8cd98f00b204e9800998ecf8427e"')
    expect(obj!.size).toBe(10)
    expect(obj!.httpMetadata?.contentType).toBe('text/plain')
    expect(obj!.customMetadata?.['owner']).toBe('alice')
    expect(await obj!.text()).toBe('body-bytes')
  })

  test('head on 200 returns object metadata without body accessors', async () => {
    const { fetch } = mockFetch(
      () =>
        new Response(null, {
          status: 200,
          headers: { etag: '"abc"', 'content-length': '42' },
        }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    const obj = await r2.head('f.bin')
    expect(obj?.size).toBe(42)
    expect(obj?.etag).toBe('abc')
  })

  test('put returns an R2Object with size + etag', async () => {
    const { fetch } = mockFetch(
      () => new Response(null, { status: 200, headers: { etag: '"xyz"' } }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    const obj = await r2.put('a', 'hello')
    expect(obj.key).toBe('a')
    expect(obj.size).toBe(5)
    expect(obj.etag).toBe('xyz')
  })

  test('delete treats 204 and 404 as success', async () => {
    const statuses = [204, 404]
    const { fetch } = mockFetch(() => new Response(null, { status: statuses.shift() ?? 500 }))
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    await r2.delete('a')
    await r2.delete('b')
  })

  test('delete on 500 throws with the op + key in the message', async () => {
    const { fetch } = mockFetch(
      () =>
        new Response('Permission denied', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    try {
      await r2.delete('blocked')
      throw new Error('expected throw')
    } catch (err) {
      expect((err as Error).message).toContain('R2.delete("blocked")')
      expect((err as Error).message).toContain('Permission denied')
    }
  })

  test('list parses S3 ListObjectsV2 XML response', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents>
    <Key>logos/a.png</Key>
    <ETag>"aaa"</ETag>
    <Size>120</Size>
    <LastModified>2026-04-15T10:00:00.000Z</LastModified>
  </Contents>
  <Contents>
    <Key>logos/b.png</Key>
    <ETag>"bbb"</ETag>
    <Size>240</Size>
    <LastModified>2026-04-15T10:05:00.000Z</LastModified>
  </Contents>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>next</NextContinuationToken>
</ListBucketResult>`
    const { fetch } = mockFetch(() => new Response(xml))
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    const res = await r2.list({ prefix: 'logos/' })
    expect(res.objects).toHaveLength(2)
    expect(res.objects[0]!.key).toBe('logos/a.png')
    expect(res.objects[0]!.size).toBe(120)
    expect(res.objects[1]!.etag).toBe('bbb')
    expect(res.truncated).toBe(true)
    expect(res.cursor).toBe('next')
  })

  test('list with delimiter collects CommonPrefixes', async () => {
    const xml = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <CommonPrefixes><Prefix>logos/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>icons/</Prefix></CommonPrefixes>
</ListBucketResult>`
    const { fetch } = mockFetch(() => new Response(xml))
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    const res = await r2.list({ delimiter: '/' })
    expect(res.delimitedPrefixes).toEqual(['logos/', 'icons/'])
  })
})

describe('BunR2Adapter — put value types', () => {
  test('null body is a zero-byte object', async () => {
    const { fetch, calls } = mockFetch(
      () => new Response(null, { status: 200, headers: { etag: '"0"' } }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    const obj = await r2.put('empty', null)
    expect(calls[0]!.body?.byteLength ?? 0).toBe(0)
    expect(obj.size).toBe(0)
  })

  test('ArrayBuffer body is forwarded verbatim', async () => {
    const { fetch, calls } = mockFetch(
      () => new Response(null, { status: 200, headers: { etag: '"a"' } }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    const buf = new Uint8Array([1, 2, 3, 4]).buffer
    await r2.put('k', buf)
    expect([...calls[0]!.body!]).toEqual([1, 2, 3, 4])
  })

  test('Uint8Array body is forwarded verbatim', async () => {
    const { fetch, calls } = mockFetch(
      () => new Response(null, { status: 200, headers: { etag: '"u"' } }),
    )
    const r2 = new BunR2Adapter({ ...BASE, fetch })
    await r2.put('k', new Uint8Array([9, 8, 7]))
    expect([...calls[0]!.body!]).toEqual([9, 8, 7])
  })
})

function emptyListXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`
}
