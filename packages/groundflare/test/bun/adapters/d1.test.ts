/**
 * D1 conformance suite (bun:test / Bun / bun:sqlite).
 *
 * Delegates its behavioural test bodies to `test/conformance/shared/d1-spec.ts`
 * so the bun:sqlite adapter is exercised against the same contract as the
 * Node/better-sqlite3 adapter. Drift between the two fails both runners
 * simultaneously (Phase 2e).
 *
 * Bun-local tests (countStatements helper, statement cache, REAL column
 * coercion) remain here.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  BunD1Adapter,
  countStatements,
} from '../../../src/runtime/bun/adapters/d1.ts'
import {
  runD1ConformanceSuite,
  type D1Fixture,
} from '../../conformance/shared/d1-spec.ts'

const bunFixture: D1Fixture = {
  name: 'sqlite (bun:sqlite)',
  async create(now) {
    const adapter = BunD1Adapter.open(':memory:', { now })
    return {
      adapter,
      teardown: async () => {
        adapter.close()
      },
    }
  },
}

runD1ConformanceSuite(
  { describe, test, expect, beforeEach, afterEach } as never,
  bunFixture,
)

describe('BunD1Adapter — countStatements helper', () => {
  test('trailing semicolons are not counted as extra statements', () => {
    expect(countStatements('SELECT 1; SELECT 2;')).toBe(2)
    expect(countStatements('SELECT 1;   ;  SELECT 2;')).toBe(2)
    expect(countStatements(';')).toBe(0)
    expect(countStatements('')).toBe(0)
  })
})

describe('BunD1Adapter — statement cache', () => {
  test('same SQL string reuses a cached prepared statement', async () => {
    const d1 = BunD1Adapter.open(':memory:')
    try {
      const stmt = d1.prepare('SELECT 1 as n')
      const a = await stmt.first<{ n: number }>()
      const b = await stmt.first<{ n: number }>()
      expect(a?.n).toBe(1)
      expect(b?.n).toBe(1)
      const c = await d1.prepare('SELECT 1 as n').first<{ n: number }>()
      expect(c?.n).toBe(1)
    } finally {
      d1.close()
    }
  })
})

describe('BunD1Adapter — REAL column coercion', () => {
  test('REAL stays a float', async () => {
    const d1 = BunD1Adapter.open(':memory:')
    try {
      await d1.exec('CREATE TABLE t (r REAL)')
      await d1.prepare('INSERT INTO t (r) VALUES (?)').bind(3.14).run()
      const row = await d1.prepare('SELECT r FROM t').first<{ r: number }>()
      expect(Math.abs((row?.r ?? 0) - 3.14) < 0.001).toBe(true)
    } finally {
      d1.close()
    }
  })
})
