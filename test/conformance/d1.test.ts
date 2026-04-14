/**
 * D1 conformance suite — parameterized across adapter fixtures.
 *
 * Mirrors the structure of test/conformance/kv.test.ts: one fixture
 * today (Node-side SqliteD1Adapter), future Bun / workerd fixtures
 * plug in at `ADAPTERS` without touching test bodies.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteD1Adapter } from '../../src/runtime/d1/index.js'
import type { D1Adapter } from '../../src/runtime/d1/index.js'

interface AdapterFixture {
  name: string
  create(now?: () => number): Promise<{
    adapter: D1Adapter
    teardown: () => Promise<void>
  }>
}

const ADAPTERS: AdapterFixture[] = [
  {
    name: 'sqlite',
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
  },
]

for (const fixture of ADAPTERS) {
  describe(`D1 conformance [${fixture.name}]`, () => {
    let adapter: D1Adapter
    let teardown: () => Promise<void>
    let currentTime = 0

    beforeEach(async () => {
      currentTime = 1_700_000_000_000
      const created = await fixture.create(() => currentTime)
      adapter = created.adapter
      teardown = created.teardown
      await adapter.exec(
        `CREATE TABLE IF NOT EXISTS users (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL,
           email TEXT UNIQUE,
           age INTEGER,
           bio BLOB
         )`,
      )
    })

    afterEach(async () => {
      await teardown()
    })

    describe('prepare + bind + first/all/run', () => {
      test('run INSERT returns meta with last_row_id and changes', async () => {
        const result = await adapter
          .prepare('INSERT INTO users(name, email) VALUES (?, ?)')
          .bind('alice', 'alice@example.com')
          .run()
        expect(result.success).toBe(true)
        expect(result.meta.last_row_id).toBeGreaterThan(0)
        expect(result.meta.changes).toBe(1)
        expect(result.meta.rows_written).toBe(1)
        expect(result.results).toEqual([])
      })

      test('all() returns rows matching CF shape', async () => {
        await adapter
          .prepare('INSERT INTO users(name, email) VALUES (?, ?), (?, ?)')
          .bind('a', 'a@e.com', 'b', 'b@e.com')
          .run()
        const res = await adapter
          .prepare('SELECT name, email FROM users ORDER BY name')
          .all()
        expect(res.success).toBe(true)
        expect(res.results).toEqual([
          { name: 'a', email: 'a@e.com' },
          { name: 'b', email: 'b@e.com' },
        ])
        expect(res.meta.rows_read).toBe(2)
        expect(res.meta.rows_written).toBe(0)
      })

      test('all() on empty result returns [], success=true', async () => {
        const res = await adapter.prepare('SELECT * FROM users').all()
        expect(res.success).toBe(true)
        expect(res.results).toEqual([])
      })

      test('first() returns only the first row', async () => {
        await adapter
          .prepare('INSERT INTO users(name) VALUES (?), (?), (?)')
          .bind('x', 'y', 'z')
          .run()
        const row = await adapter
          .prepare('SELECT name FROM users ORDER BY name')
          .first()
        expect(row).toEqual({ name: 'x' })
      })

      test('first() with column name returns only that column value', async () => {
        await adapter.prepare('INSERT INTO users(name) VALUES (?)').bind('alice').run()
        const name = await adapter
          .prepare('SELECT name FROM users WHERE name = ?')
          .bind('alice')
          .first<string>('name')
        expect(name).toBe('alice')
      })

      test('first() returns null for no rows', async () => {
        expect(await adapter.prepare('SELECT * FROM users').first()).toBe(null)
      })

      test('first() with column returns null for no rows', async () => {
        expect(
          await adapter.prepare('SELECT name FROM users').first<string>('name'),
        ).toBe(null)
      })

      test('bind() creates a fresh statement (original unchanged)', async () => {
        const ps = adapter.prepare('INSERT INTO users(name) VALUES (?)')
        await ps.bind('alice').run()
        await ps.bind('bob').run()
        const res = await adapter.prepare('SELECT name FROM users ORDER BY name').all()
        expect(res.results.map((r: unknown) => (r as { name: string }).name)).toEqual([
          'alice',
          'bob',
        ])
      })

      test('multiple bind() calls append positional args', async () => {
        const ps = adapter
          .prepare('INSERT INTO users(name, email) VALUES (?, ?)')
          .bind('alice')
          .bind('alice@example.com')
        await ps.run()
        const row = await adapter.prepare('SELECT name, email FROM users').first<{
          name: string
          email: string
        }>()
        expect(row).toEqual({ name: 'alice', email: 'alice@example.com' })
      })
    })

    describe('data types', () => {
      test('NULL is preserved', async () => {
        await adapter.prepare('INSERT INTO users(name, age) VALUES (?, ?)').bind('x', null).run()
        const row = await adapter.prepare('SELECT age FROM users').first<{ age: number | null }>()
        expect(row?.age).toBe(null)
      })

      test('INTEGER round-trips', async () => {
        await adapter.prepare('INSERT INTO users(name, age) VALUES (?, ?)').bind('x', 42).run()
        const row = await adapter.prepare('SELECT age FROM users').first<{ age: number }>()
        expect(row?.age).toBe(42)
      })

      test('TEXT with unicode round-trips', async () => {
        await adapter.prepare('INSERT INTO users(name) VALUES (?)').bind('小明').run()
        const row = await adapter.prepare('SELECT name FROM users').first<{ name: string }>()
        expect(row?.name).toBe('小明')
      })

      test('BLOB round-trips', async () => {
        const bytes = new Uint8Array([0, 1, 2, 3, 255])
        await adapter.prepare('INSERT INTO users(name, bio) VALUES (?, ?)').bind('x', Buffer.from(bytes)).run()
        const row = await adapter
          .prepare('SELECT bio FROM users')
          .first<{ bio: Buffer }>()
        expect(Array.from(row?.bio ?? [])).toEqual(Array.from(bytes))
      })
    })

    describe('raw()', () => {
      test('returns arrays instead of objects', async () => {
        await adapter
          .prepare('INSERT INTO users(name, age) VALUES (?, ?), (?, ?)')
          .bind('a', 1, 'b', 2)
          .run()
        const rows = await adapter
          .prepare('SELECT name, age FROM users ORDER BY name')
          .raw<[string, number]>()
        expect(rows).toEqual([
          ['a', 1],
          ['b', 2],
        ])
      })
    })

    describe('batch()', () => {
      test('runs statements in order, returns per-statement results', async () => {
        const results = await adapter.batch([
          adapter.prepare('INSERT INTO users(name) VALUES (?)').bind('a'),
          adapter.prepare('INSERT INTO users(name) VALUES (?)').bind('b'),
          adapter.prepare('SELECT COUNT(*) AS n FROM users'),
        ])
        expect(results).toHaveLength(3)
        expect(results[0]?.meta.changes).toBe(1)
        expect(results[1]?.meta.changes).toBe(1)
        expect((results[2]?.results[0] as { n: number })?.n).toBe(2)
      })

      test('rolls back all statements if one fails', async () => {
        await adapter.prepare('INSERT INTO users(name) VALUES (?)').bind('pre').run()
        await expect(
          adapter.batch([
            adapter.prepare('INSERT INTO users(name) VALUES (?)').bind('a'),
            // Will fail due to NOT NULL constraint on name
            adapter.prepare('INSERT INTO users(name) VALUES (?)').bind(null),
            adapter.prepare('INSERT INTO users(name) VALUES (?)').bind('c'),
          ]),
        ).rejects.toThrow()

        const res = await adapter
          .prepare('SELECT name FROM users ORDER BY name')
          .all<{ name: string }>()
        expect(res.results.map((r) => r.name)).toEqual(['pre'])
      })

      test('empty batch returns empty array', async () => {
        expect(await adapter.batch([])).toEqual([])
      })

      test('rejects statements from a different adapter instance', async () => {
        const { adapter: other, teardown: otherTeardown } = await fixture.create()
        try {
          const ps = other.prepare('SELECT 1')
          await expect(adapter.batch([ps])).rejects.toThrow(/same adapter instance/)
        } finally {
          await otherTeardown()
        }
      })
    })

    describe('exec()', () => {
      test('runs a multi-statement migration', async () => {
        const res = await adapter.exec(
          `CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT);
           CREATE INDEX tags_label ON tags(label);`,
        )
        expect(res.count).toBe(2)
        const probe = await adapter
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tags'")
          .first<{ name: string }>()
        expect(probe?.name).toBe('tags')
      })

      test('trailing semicolons are not counted as extra statements', async () => {
        const res = await adapter.exec('SELECT 1;;;')
        expect(res.count).toBe(1)
      })
    })

    describe('meta.served_by', () => {
      test('identifies the runtime in every result', async () => {
        const run = await adapter.prepare('INSERT INTO users(name) VALUES (?)').bind('x').run()
        expect(run.meta.served_by).toMatch(/groundflare/)
        const all = await adapter.prepare('SELECT * FROM users').all()
        expect(all.meta.served_by).toMatch(/groundflare/)
      })
    })

    describe('RETURNING clause', () => {
      test('INSERT ... RETURNING delivers rows via run()', async () => {
        const res = await adapter
          .prepare('INSERT INTO users(name) VALUES (?) RETURNING id, name')
          .bind('alice')
          .all<{ id: number; name: string }>()
        expect(res.results).toHaveLength(1)
        expect(res.results[0]?.name).toBe('alice')
      })

      test('batch handles mixed RETURNING + plain statements', async () => {
        const results = await adapter.batch<{ id: number; name: string }>([
          adapter.prepare('INSERT INTO users(name) VALUES (?)').bind('a'),
          adapter
            .prepare('INSERT INTO users(name) VALUES (?) RETURNING id, name')
            .bind('b'),
        ])
        expect(results[0]?.results).toEqual([])
        expect(results[1]?.results).toHaveLength(1)
        expect(results[1]?.results[0]?.name).toBe('b')
      })
    })
  })
}

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
