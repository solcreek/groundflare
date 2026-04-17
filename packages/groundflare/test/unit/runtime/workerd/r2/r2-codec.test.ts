/**
 * Unit tests for the R2 wire protocol codec.
 *
 * Covers every branch of parseR2Request + buildR2Response +
 * buildR2ErrorResponse, including the streaming-PUT path that historically
 * cost us hours to debug (workerd's PUT puts the metadata in the body
 * prefix, not in a header).
 */

import { describe, expect, it } from 'vitest'

import {
  R2_HEADERS,
  R2WireProtocolError,
  buildR2ErrorResponse,
  buildR2Response,
  parseR2Request,
} from '../../../../../src/runtime/workerd/r2/r2-codec.js'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

function streamFromChunks(
  chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) {
        c.enqueue(chunks[i++]!)
      } else {
        c.close()
      }
    },
  })
}

async function streamToBytes(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = s.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

describe('parseR2Request — header form (GET)', () => {
  it('parses a well-formed GET op', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: { [R2_HEADERS.request]: '{"version":1,"method":"head","object":"hello"}' },
    })
    const { op, payload, jwt } = await parseR2Request(req)
    expect(op.method).toBe('head')
    expect(op.object).toBe('hello')
    expect(payload).toBeNull()
    expect(jwt).toBeNull()
  })

  it('extracts JWT from Authorization header', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: {
        [R2_HEADERS.request]: '{"version":1,"method":"list"}',
        authorization: 'Bearer eyJhbGc.payload.sig',
      },
    })
    const { jwt } = await parseR2Request(req)
    expect(jwt).toBe('eyJhbGc.payload.sig')
  })

  it('returns null jwt when Authorization absent', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: { [R2_HEADERS.request]: '{"version":1,"method":"list"}' },
    })
    const { jwt } = await parseR2Request(req)
    expect(jwt).toBeNull()
  })

  it('returns null jwt for non-Bearer auth schemes', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: {
        [R2_HEADERS.request]: '{"version":1,"method":"list"}',
        authorization: 'Basic dXNlcjpwYXNz',
      },
    })
    const { jwt } = await parseR2Request(req)
    expect(jwt).toBeNull()
  })

  it('throws when cf-r2-request header is missing', async () => {
    const req = new Request('https://fake-host/', { method: 'GET' })
    await expect(parseR2Request(req)).rejects.toThrowError(R2WireProtocolError)
    await expect(parseR2Request(req)).rejects.toMatchObject({
      httpStatus: 400,
      v4code: 10004,
    })
  })

  it('throws when cf-r2-request header is empty string', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: { [R2_HEADERS.request]: '' },
    })
    await expect(parseR2Request(req)).rejects.toMatchObject({
      v4code: 10004,
    })
  })

  it('throws on malformed JSON', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: { [R2_HEADERS.request]: '{not json' },
    })
    await expect(parseR2Request(req)).rejects.toMatchObject({
      httpStatus: 400,
      v4code: 10004,
    })
  })

  it('throws when JSON is not an object (array)', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: { [R2_HEADERS.request]: '[1,2,3]' },
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/must be a JSON object/)
  })

  it('throws when JSON is not an object (string)', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: { [R2_HEADERS.request]: '"a string"' },
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/must be a JSON object/)
  })

  it('throws when JSON is null', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: { [R2_HEADERS.request]: 'null' },
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/must be a JSON object/)
  })

  it('throws when method field is missing', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: { [R2_HEADERS.request]: '{"version":1,"object":"hello"}' },
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/missing required "method"/)
  })

  it('throws when method field is empty', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: { [R2_HEADERS.request]: '{"method":""}' },
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/missing required "method"/)
  })

  it('passes through unknown method values (forward compat)', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: { [R2_HEADERS.request]: '{"method":"futureOp","data":42}' },
    })
    const { op } = await parseR2Request(req)
    expect(op.method).toBe('futureOp')
    expect(op.data).toBe(42)
  })

  it('passes through arbitrary fields', async () => {
    const req = new Request('https://fake-host/', {
      method: 'GET',
      headers: {
        [R2_HEADERS.request]:
          '{"method":"get","object":"k","range":{"offset":0,"length":99},"onlyIf":{"etagMatches":[{"value":"x","type":{"strong":null}}]}}',
      },
    })
    const { op } = await parseR2Request(req)
    expect(op.method).toBe('get')
    expect(op.object).toBe('k')
    expect(op.range).toEqual({ offset: 0, length: 99 })
    expect(op.onlyIf).toBeDefined()
  })
})

describe('parseR2Request — body-prefix form (PUT)', () => {
  it('parses a well-formed PUT op (small inline payload)', async () => {
    const meta = '{"version":1,"method":"put","object":"hello"}'
    const metaBytes = ENCODER.encode(meta)
    const payloadBytes = ENCODER.encode('the actual payload')
    const body = new Uint8Array(metaBytes.byteLength + payloadBytes.byteLength)
    body.set(metaBytes, 0)
    body.set(payloadBytes, metaBytes.byteLength)

    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: String(metaBytes.byteLength) },
      body: streamFromBytes(body),
      duplex: 'half',
    })

    const { op, payload, jwt } = await parseR2Request(req)
    expect(op.method).toBe('put')
    expect(op.object).toBe('hello')
    expect(jwt).toBeNull()
    expect(payload).not.toBeNull()
    const got = await streamToBytes(payload!)
    expect(DECODER.decode(got)).toBe('the actual payload')
  })

  it('parses PUT with empty payload', async () => {
    const meta = '{"method":"put","object":"k"}'
    const metaBytes = ENCODER.encode(meta)
    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: String(metaBytes.byteLength) },
      body: streamFromBytes(metaBytes),
      duplex: 'half',
    })
    const { op, payload } = await parseR2Request(req)
    expect(op.method).toBe('put')
    const got = await streamToBytes(payload!)
    expect(got.byteLength).toBe(0)
  })

  it('streams large payload without buffering', async () => {
    const meta = '{"method":"put","object":"big"}'
    const metaBytes = ENCODER.encode(meta)
    // 1 MB of recognisable bytes
    const payloadSize = 1024 * 1024
    const payloadBytes = new Uint8Array(payloadSize)
    for (let i = 0; i < payloadSize; i++) payloadBytes[i] = i & 0xff

    const body = new Uint8Array(metaBytes.byteLength + payloadSize)
    body.set(metaBytes, 0)
    body.set(payloadBytes, metaBytes.byteLength)

    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: String(metaBytes.byteLength) },
      body: streamFromBytes(body),
      duplex: 'half',
    })

    const { op, payload } = await parseR2Request(req)
    expect(op.object).toBe('big')
    const got = await streamToBytes(payload!)
    expect(got.byteLength).toBe(payloadSize)
    expect(got[0]).toBe(0)
    expect(got[255]).toBe(255)
    expect(got[payloadSize - 1]).toBe((payloadSize - 1) & 0xff)
  })

  it('handles metadata split across multiple chunks', async () => {
    const meta = '{"method":"put","object":"chunked"}'
    const metaBytes = ENCODER.encode(meta)
    const payloadBytes = ENCODER.encode('PAYLOAD!')
    // Split metadata across 3 chunks, payload across 2 chunks
    const m1 = metaBytes.subarray(0, 5)
    const m2 = metaBytes.subarray(5, 20)
    const m3 = metaBytes.subarray(20)
    const p1 = payloadBytes.subarray(0, 4)
    const p2 = payloadBytes.subarray(4)

    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: String(metaBytes.byteLength) },
      body: streamFromChunks([m1, m2, m3, p1, p2]),
      duplex: 'half',
    })

    const { op, payload } = await parseR2Request(req)
    expect(op.object).toBe('chunked')
    const got = await streamToBytes(payload!)
    expect(DECODER.decode(got)).toBe('PAYLOAD!')
  })

  it('handles a chunk that straddles the metadata/payload boundary', async () => {
    const meta = '{"method":"put","object":"straddle"}'
    const metaBytes = ENCODER.encode(meta)
    const payloadBytes = ENCODER.encode('payload-suffix')
    // Single chunk containing both metadata and payload
    const single = new Uint8Array(metaBytes.byteLength + payloadBytes.byteLength)
    single.set(metaBytes, 0)
    single.set(payloadBytes, metaBytes.byteLength)
    // Plus a follow-up chunk to make sure the leftover-tail path also drains
    const followUp = ENCODER.encode('-tail2')
    const expectedTotal = payloadBytes.byteLength + followUp.byteLength

    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: String(metaBytes.byteLength) },
      body: streamFromChunks([single, followUp]),
      duplex: 'half',
    })

    const { op, payload } = await parseR2Request(req)
    expect(op.object).toBe('straddle')
    const got = await streamToBytes(payload!)
    expect(got.byteLength).toBe(expectedTotal)
    expect(DECODER.decode(got)).toBe('payload-suffix-tail2')
  })

  it('throws when cf-r2-metadata-size header is missing', async () => {
    const req = new Request('https://fake-host/', {
      method: 'PUT',
      body: streamFromBytes(ENCODER.encode('{}')),
      duplex: 'half',
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/Missing cf-r2-metadata-size/)
  })

  it('throws when cf-r2-metadata-size is non-numeric', async () => {
    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: 'abc' },
      body: streamFromBytes(ENCODER.encode('{}')),
      duplex: 'half',
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/Invalid cf-r2-metadata-size/)
  })

  it('throws when cf-r2-metadata-size is negative', async () => {
    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: '-1' },
      body: streamFromBytes(ENCODER.encode('{}')),
      duplex: 'half',
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/Invalid cf-r2-metadata-size/)
  })

  it('throws 413 when cf-r2-metadata-size exceeds 1 MiB', async () => {
    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: String(2 * 1024 * 1024) },
      body: streamFromBytes(new Uint8Array(0)),
      duplex: 'half',
    })
    await expect(parseR2Request(req)).rejects.toMatchObject({
      httpStatus: 413,
      v4code: 10004,
    })
  })

  it('throws when body is missing on PUT', async () => {
    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: '5' },
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/PUT body required/)
  })

  it('throws when body ends before declared metadata size', async () => {
    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: '50' },
      body: streamFromBytes(ENCODER.encode('{"method":"put"}')), // 16 bytes
      duplex: 'half',
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/PUT body ended early/)
  })

  it('throws on malformed metadata JSON in body', async () => {
    const meta = '{not-json'
    const metaBytes = ENCODER.encode(meta)
    const req = new Request('https://fake-host/', {
      method: 'PUT',
      headers: { [R2_HEADERS.metadataSize]: String(metaBytes.byteLength) },
      body: streamFromBytes(metaBytes),
      duplex: 'half',
    })
    await expect(parseR2Request(req)).rejects.toThrowError(/PUT metadata JSON parse error/)
  })
})

describe('parseR2Request — unsupported HTTP methods', () => {
  it('throws 405 for POST', async () => {
    const req = new Request('https://fake-host/', { method: 'POST' })
    await expect(parseR2Request(req)).rejects.toMatchObject({
      httpStatus: 405,
      v4code: 10004,
    })
  })

  it('throws 405 for DELETE (R2 delete uses GET wire form)', async () => {
    const req = new Request('https://fake-host/', { method: 'DELETE' })
    await expect(parseR2Request(req)).rejects.toMatchObject({
      httpStatus: 405,
    })
  })
})

describe('buildR2Response', () => {
  it('emits metadata-only response with correct size header', async () => {
    const meta = { name: 'x', size: 0, etag: 'abc' }
    const res = await buildR2Response(meta)
    expect(res.status).toBe(200)
    const sizeHeader = res.headers.get(R2_HEADERS.metadataSize)
    expect(sizeHeader).not.toBeNull()
    const expectedSize = ENCODER.encode(JSON.stringify(meta)).byteLength
    expect(parseInt(sizeHeader!, 10)).toBe(expectedSize)
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.byteLength).toBe(expectedSize)
    expect(JSON.parse(DECODER.decode(body))).toEqual(meta)
  })

  it('inlines Uint8Array payload after metadata', async () => {
    const meta = { name: 'k', size: 5 }
    const payload = ENCODER.encode('hello')
    const res = await buildR2Response(meta, payload)
    const expectedMetaSize = ENCODER.encode(JSON.stringify(meta)).byteLength
    expect(parseInt(res.headers.get(R2_HEADERS.metadataSize)!, 10)).toBe(
      expectedMetaSize,
    )
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.byteLength).toBe(expectedMetaSize + 5)
    expect(DECODER.decode(body.subarray(expectedMetaSize))).toBe('hello')
  })

  it('streams ReadableStream payload after metadata', async () => {
    const meta = { name: 'k', size: 11 }
    const payload = streamFromBytes(ENCODER.encode('hello-world'))
    const res = await buildR2Response(meta, payload)
    const body = new Uint8Array(await res.arrayBuffer())
    const metaSize = parseInt(res.headers.get(R2_HEADERS.metadataSize)!, 10)
    expect(JSON.parse(DECODER.decode(body.subarray(0, metaSize)))).toEqual(meta)
    expect(DECODER.decode(body.subarray(metaSize))).toBe('hello-world')
  })

  it('streams multi-chunk payload', async () => {
    const meta = { name: 'k', size: 12 }
    const payload = streamFromChunks([
      ENCODER.encode('chunk-1-'),
      ENCODER.encode('chunk2'),
    ])
    const res = await buildR2Response(meta, payload)
    const body = new Uint8Array(await res.arrayBuffer())
    const metaSize = parseInt(res.headers.get(R2_HEADERS.metadataSize)!, 10)
    expect(DECODER.decode(body.subarray(metaSize))).toBe('chunk-1-chunk2')
  })

  it('handles null payload identical to undefined (no payload)', async () => {
    const meta = { foo: 'bar' }
    const res = await buildR2Response(meta, null)
    const body = new Uint8Array(await res.arrayBuffer())
    expect(JSON.parse(DECODER.decode(body))).toEqual(meta)
  })
})

describe('buildR2ErrorResponse', () => {
  it('sets cf-r2-error header with the right shape', () => {
    const res = buildR2ErrorResponse(404, 10007, 'object not found')
    expect(res.status).toBe(404)
    const errHeader = res.headers.get(R2_HEADERS.error)
    expect(errHeader).not.toBeNull()
    const parsed = JSON.parse(errHeader!)
    expect(parsed).toEqual({ version: 0, v4code: 10007, message: 'object not found' })
  })

  it('passes status code through', () => {
    expect(buildR2ErrorResponse(403, 10004, 'denied').status).toBe(403)
    expect(buildR2ErrorResponse(412, 10031, 'precond').status).toBe(412)
    expect(buildR2ErrorResponse(500, 10001, 'oops').status).toBe(500)
  })

  it('puts message in body for human readers', async () => {
    const res = buildR2ErrorResponse(403, 10004, 'access denied')
    expect(await res.text()).toBe('access denied')
  })
})
