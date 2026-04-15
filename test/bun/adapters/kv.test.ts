/**
 * Bun-native tests for the bun:sqlite KV adapter.
 *
 * These run under `bun test` (see test/bun/README.md), NOT vitest.
 * That's on purpose — the adapter ships as source to the VPS and
 * executes inside `bun run`, so correctness matters in Bun's runtime,
 * not in a Node-side shim. The vitest conformance suite
 * (test/conformance/kv.test.ts) separately covers the Node-side
 * SqliteKVAdapter against better-sqlite3. Both must produce byte-
 * identical SQLite files for the same inputs.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { BunKVAdapter, upperBoundFor } from '../../../src/runtime/bun/adapters/kv.ts'

let adapter: BunKVAdapter

beforeEach(() => {
  adapter = BunKVAdapter.open(':memory:')
})

describe('BunKVAdapter — put + get round-trip', () => {
  test('put then get returns the stored text value', async () => {
    await adapter.put('greeting', 'hello')
    expect(await adapter.get('greeting')).toBe('hello')
  })

  test('get on missing key returns null', async () => {
    expect(await adapter.get('missing')).toBeNull()
  })

  test('put overwrites an existing value', async () => {
    await adapter.put('k', 'v1')
    await adapter.put('k', 'v2')
    expect(await adapter.get('k')).toBe('v2')
  })

  test('delete removes the key', async () => {
    await adapter.put('k', 'v')
    await adapter.delete('k')
    expect(await adapter.get('k')).toBeNull()
  })

  test('delete on missing key is a no-op', async () => {
    await adapter.delete('never-existed')
    expect(await adapter.get('never-existed')).toBeNull()
  })
})

describe('BunKVAdapter — value types', () => {
  test('stores and decodes JSON values', async () => {
    await adapter.put('j', '{"a":1,"b":[2,3]}')
    expect(await adapter.get('j', 'json')).toEqual({ a: 1, b: [2, 3] })
    expect(await adapter.get('j', { type: 'json' })).toEqual({
      a: 1,
      b: [2, 3],
    })
  })

  test('returns an ArrayBuffer when type = "arrayBuffer"', async () => {
    await adapter.put('bin', 'hello')
    const result = await adapter.get('bin', 'arrayBuffer')
    expect(result).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(result as ArrayBuffer)).toBe('hello')
  })

  test('stores a Uint8Array value byte-for-byte', async () => {
    const bytes = new Uint8Array([1, 2, 3, 255, 0, 42])
    await adapter.put('u8', bytes)
    const back = new Uint8Array((await adapter.get('u8', 'arrayBuffer')) as ArrayBuffer)
    expect([...back]).toEqual([1, 2, 3, 255, 0, 42])
  })

  test('stores an ArrayBuffer value', async () => {
    const buf = new TextEncoder().encode('from-buffer').buffer
    await adapter.put('abuf', buf as ArrayBuffer)
    expect(await adapter.get('abuf')).toBe('from-buffer')
  })

  test('rejects unsupported put value types', async () => {
    await expect(
      adapter.put('k', 42 as unknown as string),
    ).rejects.toThrow(/unsupported/)
  })
})

describe('BunKVAdapter — metadata', () => {
  test('getWithMetadata returns null value + null metadata for missing key', async () => {
    expect(await adapter.getWithMetadata('missing')).toEqual({
      value: null,
      metadata: null,
    })
  })

  test('put without metadata yields null metadata', async () => {
    await adapter.put('k', 'v')
    const { metadata } = await adapter.getWithMetadata('k')
    expect(metadata).toBeNull()
  })

  test('metadata round-trips as JSON', async () => {
    const meta = { owner: 'alice', tags: [1, 2, 3], flag: true }
    await adapter.put('k', 'v', { metadata: meta })
    const { value, metadata } = await adapter.getWithMetadata('k')
    expect(value).toBe('v')
    expect(metadata).toEqual(meta)
  })
})

describe('BunKVAdapter — TTL / expiration', () => {
  test('expirationTtl computes expires_at from current time', async () => {
    let clock = 1_000_000_000_000
    const a = BunKVAdapter.open(':memory:', { now: () => clock })
    await a.put('k', 'v', { expirationTtl: 60 }) // 60s
    clock += 30_000 // +30s
    expect(await a.get('k')).toBe('v')
    clock += 31_000 // total +61s → expired
    expect(await a.get('k')).toBeNull()
  })

  test('absolute expiration (unix seconds) is honoured', async () => {
    let clock = 1_000_000_000_000
    const a = BunKVAdapter.open(':memory:', { now: () => clock })
    await a.put('k', 'v', { expiration: 1_000_000_050 }) // 50s from clock
    clock += 40_000
    expect(await a.get('k')).toBe('v')
    clock += 11_000
    expect(await a.get('k')).toBeNull()
  })

  test('rejects providing both expirationTtl and expiration', async () => {
    await expect(
      adapter.put('k', 'v', { expirationTtl: 60, expiration: 1 }),
    ).rejects.toThrow(/not both/)
  })

  test('rejects non-positive expirationTtl', async () => {
    await expect(adapter.put('k', 'v', { expirationTtl: 0 })).rejects.toThrow(
      /> 0/,
    )
    await expect(adapter.put('k', 'v', { expirationTtl: -5 })).rejects.toThrow(
      /> 0/,
    )
  })

  test('cleanupExpired removes expired rows and returns count', async () => {
    let clock = 1_000_000_000_000
    const a = BunKVAdapter.open(':memory:', { now: () => clock })
    await a.put('keep', 'v1', { expirationTtl: 60 })
    await a.put('expire', 'v2', { expirationTtl: 10 })
    clock += 20_000
    const removed = a.cleanupExpired()
    expect(removed).toBe(1)
    expect(await a.get('keep')).toBe('v1')
    expect(await a.get('expire')).toBeNull()
  })
})

describe('BunKVAdapter — list', () => {
  test('returns all keys sorted, list_complete = true by default', async () => {
    await adapter.put('c', '3')
    await adapter.put('a', '1')
    await adapter.put('b', '2')
    const res = await adapter.list()
    expect(res.keys.map((k) => k.name)).toEqual(['a', 'b', 'c'])
    expect(res.list_complete).toBe(true)
    expect(res.cursor).toBeUndefined()
  })

  test('prefix filter uses indexed range scan', async () => {
    await adapter.put('user:alice', '1')
    await adapter.put('user:bob', '2')
    await adapter.put('post:x', '3')
    const res = await adapter.list({ prefix: 'user:' })
    expect(res.keys.map((k) => k.name)).toEqual(['user:alice', 'user:bob'])
  })

  test('limit truncates and emits a cursor', async () => {
    for (const ch of ['a', 'b', 'c', 'd', 'e']) {
      await adapter.put(ch, ch)
    }
    const page1 = await adapter.list({ limit: 2 })
    expect(page1.keys.map((k) => k.name)).toEqual(['a', 'b'])
    expect(page1.list_complete).toBe(false)
    expect(page1.cursor).toBeDefined()

    const page2 = await adapter.list({ limit: 2, cursor: page1.cursor })
    expect(page2.keys.map((k) => k.name)).toEqual(['c', 'd'])
    expect(page2.list_complete).toBe(false)

    const page3 = await adapter.list({ limit: 2, cursor: page2.cursor })
    expect(page3.keys.map((k) => k.name)).toEqual(['e'])
    expect(page3.list_complete).toBe(true)
  })

  test('expired rows are filtered from list results', async () => {
    let clock = 1_000_000_000_000
    const a = BunKVAdapter.open(':memory:', { now: () => clock })
    await a.put('keep', 'v', { expirationTtl: 60 })
    await a.put('gone', 'v', { expirationTtl: 5 })
    clock += 10_000
    const res = await a.list()
    expect(res.keys.map((k) => k.name)).toEqual(['keep'])
  })

  test('list surfaces metadata and expiration on each entry', async () => {
    let clock = 1_000_000_000_000
    const a = BunKVAdapter.open(':memory:', { now: () => clock })
    await a.put('k', 'v', {
      metadata: { tag: 'x' },
      expirationTtl: 60,
    })
    const res = await a.list()
    const key = res.keys[0]!
    expect(key.metadata).toEqual({ tag: 'x' })
    // expiration is reported in unix seconds, not ms
    expect(key.expiration).toBe(Math.floor((clock + 60_000) / 1000))
  })
})

describe('upperBoundFor (exported helper)', () => {
  test('returns null for empty prefix', () => {
    expect(upperBoundFor('')).toBeNull()
  })

  test('increments the last codepoint', () => {
    expect(upperBoundFor('user:')).toBe('user;')
    expect(upperBoundFor('a')).toBe('b')
  })

  test('bumps the last codepoint for BMP prefixes (practical case)', () => {
    // In practice KV prefixes are ASCII/BMP; the "max codepoint" null
    // branch is only reachable from a surrogate-pair prefix whose low
    // surrogate equals 0x10FFFF. Not a real workload, not promised.
    expect(upperBoundFor('\uffff')).toBe(String.fromCodePoint(0x10000))
  })
})

describe('BunKVAdapter — SQLite compatibility', () => {
  test('works against an on-disk file (not only :memory:)', async () => {
    const tmpPath = `/tmp/gf-bun-kv-${Date.now()}-${Math.random()}.sqlite`
    const a = BunKVAdapter.open(tmpPath)
    try {
      await a.put('persisted', 'yes')
      expect(await a.get('persisted')).toBe('yes')
    } finally {
      a.close()
      // bun:sqlite writes WAL files too; leave cleanup to the OS tmpdir sweeper.
    }
  })
})
