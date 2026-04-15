/**
 * D1 conformance suite (vitest / Node / better-sqlite3).
 *
 * Delegates the behavioural test bodies to `./shared/d1-spec.ts`. The
 * Bun runner (test/bun/adapters/d1.test.ts) exercises the same spec
 * against bun:sqlite so divergence between the two adapters fails both
 * runners simultaneously.
 *
 * Adapter-internals tests (countStatements, connection ownership,
 * statement-cache behaviour) remain here since they probe Node-specific
 * concerns.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteD1Adapter } from '../../src/runtime/d1/index.js'
import {
  runD1ConformanceSuite,
  type D1Fixture,
} from './shared/d1-spec.js'

const sqliteFixture: D1Fixture = {
  name: 'sqlite (better-sqlite3)',
  async create(now) {
    const dir = await mkdtemp(join(tmpdir(), 'gf-d1-conf-'))
    const adapter = SqliteD1Adapter.open(join(dir, 'db.sqlite'), { now })
    return {
      adapter,
      teardown: async () => {
        adapter.close()
        await rm(dir, { recursive: true, force: true })
      },
    }
  },
}

runD1ConformanceSuite(
  { describe, test, expect, beforeEach, afterEach } as never,
  sqliteFixture,
)

describe('SqliteD1Adapter internals', () => {
  test('countStatements handles empty / whitespace / trailing semicolons', async () => {
    const { countStatements } = await import('../../src/runtime/d1/sqlite.js')
    expect(countStatements('')).toBe(0)
    expect(countStatements('   ')).toBe(0)
    expect(countStatements('SELECT 1;')).toBe(1)
    expect(countStatements('SELECT 1; SELECT 2;')).toBe(2)
    expect(countStatements('SELECT 1;;;; SELECT 2;')).toBe(2)
  })

  test('connection ownership — .open() closes its own db cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-d1-leak-'))
    const adapter = SqliteD1Adapter.open(join(dir, 'db.sqlite'))
    await adapter.exec('CREATE TABLE t(x TEXT)')
    await adapter.prepare('INSERT INTO t VALUES (?)').bind('hi').run()
    adapter.close()
    // Re-opening the same file after close must succeed — a leaked
    // connection would hold WAL locks indefinitely.
    const again = SqliteD1Adapter.open(join(dir, 'db.sqlite'))
    const row = await again.prepare('SELECT x FROM t').first<{ x: string }>()
    expect(row?.x).toBe('hi')
    again.close()
    await rm(dir, { recursive: true, force: true })
  })

  test('prepared statement cache reuses statements across calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-d1-cache-'))
    try {
      const adapter = SqliteD1Adapter.open(join(dir, 'db.sqlite'))
      await adapter.exec('CREATE TABLE t(x INTEGER)')
      for (let i = 0; i < 50; i++) {
        await adapter.prepare('INSERT INTO t VALUES (?)').bind(i).run()
      }
      const count = await adapter
        .prepare('SELECT COUNT(*) AS n FROM t')
        .first<{ n: number }>('n')
      expect(count).toBe(50)
      adapter.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
