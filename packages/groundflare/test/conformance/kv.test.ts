/**
 * KV conformance suite (vitest / Node / better-sqlite3).
 *
 * The behavioural test bodies live in `./shared/kv-spec.ts` so that the
 * Bun-runner equivalent (test/bun/adapters/kv.test.ts) invokes the same
 * spec against bun:sqlite. A drift between the two adapters fails both
 * runners simultaneously — that's the whole point of Phase 2e.
 *
 * Adapter-internals tests (upperBoundFor, connection ownership) remain
 * below, because they probe Node-specific concerns that don't apply to
 * the Bun adapter.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteKVAdapter } from '../../src/runtime/kv/index.js'
import {
  runKvConformanceSuite,
  type KvFixture,
} from './shared/kv-spec.js'

const sqliteFixture: KvFixture = {
  name: 'sqlite (better-sqlite3)',
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
}

runKvConformanceSuite(
  { describe, test, expect, beforeEach, afterEach } as never,
  sqliteFixture,
)

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
