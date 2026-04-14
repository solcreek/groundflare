/**
 * KV conformance suite — runs against every adapter implementation.
 *
 * This is the Tier 2 suite defined in design/testing.md: the same
 * test body is parameterized across adapter fixtures so Mirror-track
 * (workerd + SQLite), Bun-track (bun:sqlite), and any other future
 * adapter must satisfy identical CF KV semantics.
 *
 * v0.1 has one fixture (Node-side SqliteKVAdapter); future fixtures
 * plug in at `ADAPTERS` without touching any test body.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteKVAdapter } from '../../src/runtime/kv/index.js'
import type { KVAdapter } from '../../src/runtime/kv/index.js'

interface AdapterFixture {
  name: string
  /** Allow the test to inject a clock; default uses Date.now. */
  create(now?: () => number): Promise<{ adapter: KVAdapter; teardown: () => Promise<void> }>
  /**
   * Some adapters need manual invocation of TTL cleanup in tests (e.g. the
   * SQLite adapter's `cleanupExpired()`); others handle it intrinsically.
   */
  cleanup?(adapter: KVAdapter): void
}

const ADAPTERS: AdapterFixture[] = [
  {
    name: 'sqlite',
    async create(now) {
      const dir = await mkdtemp(join(tmpdir(), 'gf-kv-conf-'))
      const adapter = SqliteKVAdapter.open(join(dir, 'kv.sqlite'), { now })
      return {
        adapter,
        teardown: async () => {
          adapter.close()
          await rm(dir, { recursive: true, force: true })
        },
      }
    },
    cleanup(adapter) {
      ;(adapter as SqliteKVAdapter).cleanupExpired()
    },
  },
]

for (const fixture of ADAPTERS) {
  describe(`KV conformance [${fixture.name}]`, () => {
    let adapter: KVAdapter
    let teardown: () => Promise<void>
    let currentTime = 0

    beforeEach(async () => {
      currentTime = 1_700_000_000_000 // arbitrary stable epoch ms
      const created = await fixture.create(() => currentTime)
      adapter = created.adapter
      teardown = created.teardown
    })

    afterEach(async () => {
      await teardown()
    })

    function advanceTime(ms: number): void {
      currentTime += ms
    }

    describe('get / put / delete', () => {
      test('put then get returns the text value', async () => {
        await adapter.put('k', 'hello')
        expect(await adapter.get('k')).toBe('hello')
      })

      test('get returns null for a missing key', async () => {
        expect(await adapter.get('nope')).toBe(null)
      })

      test('put with string, get with type=arrayBuffer yields matching bytes', async () => {
        await adapter.put('bin', 'hello')
        const buf = (await adapter.get('bin', 'arrayBuffer')) as ArrayBuffer
        expect(new TextDecoder().decode(buf)).toBe('hello')
      })

      test('put with ArrayBuffer, get as arrayBuffer round-trips exactly', async () => {
        const payload = new Uint8Array([1, 2, 3, 4, 5]).buffer
        await adapter.put('b', payload)
        const got = (await adapter.get('b', 'arrayBuffer')) as ArrayBuffer
        expect(new Uint8Array(got)).toEqual(new Uint8Array(payload))
      })

      test('put with Uint8Array view, get as arrayBuffer round-trips', async () => {
        const base = new Uint8Array([9, 8, 7, 6, 5])
        await adapter.put('v', base)
        const got = (await adapter.get('v', 'arrayBuffer')) as ArrayBuffer
        expect(new Uint8Array(got)).toEqual(base)
      })

      test('get with type=json parses stored JSON', async () => {
        await adapter.put('cfg', JSON.stringify({ a: 1, b: [2, 3] }))
        expect(await adapter.get('cfg', 'json')).toEqual({ a: 1, b: [2, 3] })
      })

      test('put overwrites the previous value', async () => {
        await adapter.put('k', 'v1')
        await adapter.put('k', 'v2')
        expect(await adapter.get('k')).toBe('v2')
      })

      test('delete removes the key', async () => {
        await adapter.put('k', 'v')
        await adapter.delete('k')
        expect(await adapter.get('k')).toBe(null)
      })

      test('delete on missing key is a no-op', async () => {
        await expect(adapter.delete('nope')).resolves.toBeUndefined()
      })
    })

    describe('metadata', () => {
      test('metadata is available via getWithMetadata', async () => {
        await adapter.put('k', 'v', { metadata: { owner: 'alice' } })
        const got = await adapter.getWithMetadata<{ owner: string }>('k')
        expect(got.value).toBe('v')
        expect(got.metadata).toEqual({ owner: 'alice' })
      })

      test('absent metadata yields null, not undefined', async () => {
        await adapter.put('k', 'v')
        const got = await adapter.getWithMetadata('k')
        expect(got.metadata).toBe(null)
      })

      test('nested JSON metadata round-trips', async () => {
        const meta = { tags: ['a', 'b'], count: 3, nested: { deep: true } }
        await adapter.put('k', 'v', { metadata: meta })
        const got = await adapter.getWithMetadata<typeof meta>('k')
        expect(got.metadata).toEqual(meta)
      })

      test('getWithMetadata on missing key returns {value: null, metadata: null}', async () => {
        const got = await adapter.getWithMetadata('nope')
        expect(got).toEqual({ value: null, metadata: null })
      })
    })

    describe('TTL (expirationTtl)', () => {
      test('put with expirationTtl stores the row', async () => {
        await adapter.put('k', 'v', { expirationTtl: 60 })
        expect(await adapter.get('k')).toBe('v')
      })

      test('get returns null after expirationTtl seconds have passed', async () => {
        await adapter.put('k', 'v', { expirationTtl: 60 })
        advanceTime(59_000)
        expect(await adapter.get('k')).toBe('v')
        advanceTime(2_000) // total +61s, past the TTL
        expect(await adapter.get('k')).toBe(null)
      })

      test('cleanupExpired sweeps expired rows', async () => {
        await adapter.put('a', '1', { expirationTtl: 10 })
        await adapter.put('b', '2', { expirationTtl: 20 })
        await adapter.put('c', '3') // no TTL
        advanceTime(15_000)
        fixture.cleanup?.(adapter)

        const list = await adapter.list<unknown>()
        const names = list.keys.map((k) => k.name).sort()
        expect(names).toEqual(['b', 'c'])
      })

      test('put rejects expirationTtl and expiration together', async () => {
        await expect(
          adapter.put('k', 'v', { expirationTtl: 60, expiration: 2_000_000_000 }),
        ).rejects.toThrow(/either expirationTtl or expiration/)
      })

      test('put rejects non-positive expirationTtl', async () => {
        await expect(adapter.put('k', 'v', { expirationTtl: 0 })).rejects.toThrow(
          /expirationTtl/,
        )
        await expect(adapter.put('k', 'v', { expirationTtl: -5 })).rejects.toThrow(
          /expirationTtl/,
        )
      })
    })

    describe('TTL (expiration absolute)', () => {
      test('put with expiration stores the row and expires at that time', async () => {
        const expireAt = Math.floor(currentTime / 1000) + 60
        await adapter.put('k', 'v', { expiration: expireAt })
        advanceTime(59_000)
        expect(await adapter.get('k')).toBe('v')
        advanceTime(2_000)
        expect(await adapter.get('k')).toBe(null)
      })

      test('list() reports expiration in unix seconds', async () => {
        const expireAt = Math.floor(currentTime / 1000) + 120
        await adapter.put('k', 'v', { expiration: expireAt })
        const { keys } = await adapter.list()
        expect(keys[0]?.expiration).toBe(expireAt)
      })
    })

    describe('list', () => {
      test('returns all keys in lexicographic order', async () => {
        await adapter.put('b', '1')
        await adapter.put('a', '2')
        await adapter.put('c', '3')
        const { keys, list_complete } = await adapter.list()
        expect(keys.map((k) => k.name)).toEqual(['a', 'b', 'c'])
        expect(list_complete).toBe(true)
      })

      test('empty namespace returns an empty list, list_complete = true', async () => {
        const { keys, list_complete } = await adapter.list()
        expect(keys).toEqual([])
        expect(list_complete).toBe(true)
      })

      test('prefix filter returns only matching keys', async () => {
        await adapter.put('user:alice', 'a')
        await adapter.put('user:bob', 'b')
        await adapter.put('post:1', 'p')
        const { keys } = await adapter.list({ prefix: 'user:' })
        expect(keys.map((k) => k.name)).toEqual(['user:alice', 'user:bob'])
      })

      test('prefix filter does not match keys that share a prefix but diverge', async () => {
        await adapter.put('usera', '1')
        await adapter.put('user:1', '2')
        const { keys } = await adapter.list({ prefix: 'user:' })
        expect(keys.map((k) => k.name)).toEqual(['user:1'])
      })

      test('limit paginates results with a cursor', async () => {
        for (let i = 0; i < 5; i++) await adapter.put(`k${i}`, String(i))
        const first = await adapter.list({ limit: 2 })
        expect(first.keys.map((k) => k.name)).toEqual(['k0', 'k1'])
        expect(first.list_complete).toBe(false)
        expect(typeof first.cursor).toBe('string')

        const second = await adapter.list({ limit: 2, cursor: first.cursor })
        expect(second.keys.map((k) => k.name)).toEqual(['k2', 'k3'])
        expect(second.list_complete).toBe(false)

        const third = await adapter.list({ limit: 2, cursor: second.cursor })
        expect(third.keys.map((k) => k.name)).toEqual(['k4'])
        expect(third.list_complete).toBe(true)
      })

      test('list excludes expired keys without needing explicit cleanup', async () => {
        await adapter.put('live', '1')
        await adapter.put('expired', '2', { expirationTtl: 10 })
        advanceTime(11_000)
        const { keys } = await adapter.list()
        expect(keys.map((k) => k.name)).toEqual(['live'])
      })

      test('list returns metadata alongside keys', async () => {
        await adapter.put('a', 'v', { metadata: { x: 1 } })
        const { keys } = await adapter.list<{ x: number }>()
        expect(keys[0]?.metadata).toEqual({ x: 1 })
      })

      test('list applies prefix + cursor + limit in the same call', async () => {
        for (let i = 0; i < 4; i++) await adapter.put(`p:${i}`, String(i))
        await adapter.put('other', 'x')
        const first = await adapter.list({ prefix: 'p:', limit: 2 })
        expect(first.keys.map((k) => k.name)).toEqual(['p:0', 'p:1'])
        const second = await adapter.list({
          prefix: 'p:',
          limit: 2,
          cursor: first.cursor,
        })
        expect(second.keys.map((k) => k.name)).toEqual(['p:2', 'p:3'])
        expect(second.list_complete).toBe(true)
      })
    })

    describe('value sizes', () => {
      test('handles empty string values', async () => {
        await adapter.put('empty', '')
        expect(await adapter.get('empty')).toBe('')
      })

      test('handles binary values with embedded nulls', async () => {
        const bytes = new Uint8Array([0, 1, 0, 2, 0, 3])
        await adapter.put('b', bytes)
        const got = (await adapter.get('b', 'arrayBuffer')) as ArrayBuffer
        expect(new Uint8Array(got)).toEqual(bytes)
      })

      test('handles large (~1 MB) values', async () => {
        const big = new Uint8Array(1_000_000)
        for (let i = 0; i < big.length; i++) big[i] = i & 0xff
        await adapter.put('big', big)
        const got = (await adapter.get('big', 'arrayBuffer')) as ArrayBuffer
        expect(new Uint8Array(got).byteLength).toBe(big.byteLength)
        expect(new Uint8Array(got)[500_000]).toBe(500_000 & 0xff)
      })
    })
  })
}

describe('SqliteKVAdapter internals', () => {
  test('upperBoundFor is unique across simple prefixes', async () => {
    const { upperBoundFor } = await import('../../src/runtime/kv/sqlite.js')
    expect(upperBoundFor('')).toBe(null)
    expect(upperBoundFor('a')).toBe('b')
    expect(upperBoundFor('user:')).toBe('user;')
  })

  test('adapter does not leak connection when created via .open()', async () => {
    vi.useRealTimers()
    const dir = await mkdtemp(join(tmpdir(), 'gf-kv-leak-'))
    const adapter = SqliteKVAdapter.open(join(dir, 'kv.sqlite'))
    await adapter.put('k', 'v')
    adapter.close()
    // Re-opening the same file after close should succeed — a leaked
    // connection would hold the WAL lock.
    const again = SqliteKVAdapter.open(join(dir, 'kv.sqlite'))
    expect(await again.get('k')).toBe('v')
    again.close()
    await rm(dir, { recursive: true, force: true })
  })
})
