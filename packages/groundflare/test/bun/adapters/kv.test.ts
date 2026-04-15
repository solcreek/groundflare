/**
 * KV conformance suite (bun:test / Bun / bun:sqlite).
 *
 * Delegates its behavioural test bodies to `test/conformance/shared/kv-spec.ts`
 * so the bun:sqlite adapter is exercised against the same contract as the
 * Node/better-sqlite3 adapter. A drift between the two fails both runners
 * simultaneously (Phase 2e).
 *
 * Adapter-internals tests (upperBoundFor behaviour, on-disk SQLite file,
 * unsupported value types) remain below since they probe Bun-specific
 * behaviour.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  BunKVAdapter,
  upperBoundFor,
} from '../../../src/runtime/bun/adapters/kv.ts'
import {
  runKvConformanceSuite,
  type KvFixture,
} from '../../conformance/shared/kv-spec.ts'

const bunFixture: KvFixture = {
  name: 'sqlite (bun:sqlite)',
  async create(now) {
    const adapter = BunKVAdapter.open(':memory:', { now })
    return {
      adapter,
      teardown: async () => {
        adapter.close()
      },
    }
  },
  cleanup(adapter) {
    ;(adapter as BunKVAdapter).cleanupExpired()
  },
}

runKvConformanceSuite(
  { describe, test, expect, beforeEach, afterEach } as never,
  bunFixture,
)

describe('BunKVAdapter — unsupported value types', () => {
  test('rejects numeric value', async () => {
    const a = BunKVAdapter.open(':memory:')
    try {
      await expect(
        a.put('k', 42 as unknown as string),
      ).rejects.toThrow(/unsupported/)
    } finally {
      a.close()
    }
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

describe('BunKVAdapter — on-disk SQLite file', () => {
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
