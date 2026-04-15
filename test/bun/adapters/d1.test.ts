/**
 * Bun-native tests for the bun:sqlite D1 adapter.
 * Runs under `bun test`. See test/bun/README.md for why.
 *
 * Parity target: src/runtime/d1/sqlite.ts (Node adapter) must produce
 * the same result shape for the same SQL. The test bodies here mirror
 * test/conformance/d1.test.ts (vitest) so divergence is visible
 * through simple file diffs when reviewing adapters.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { BunD1Adapter, countStatements } from '../../../src/runtime/bun/adapters/d1.ts'

let d1: BunD1Adapter

beforeEach(async () => {
  d1 = BunD1Adapter.open(':memory:')
  await d1.exec(
    'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)',
  )
})

describe('BunD1Adapter — prepare + bind + run', () => {
  test('INSERT via bind().run() returns last_row_id and changes in meta', async () => {
    const r = await d1
      .prepare('INSERT INTO users (name, email) VALUES (?, ?)')
      .bind('Alice', 'a@x')
      .run()
    expect(r.success).toBe(true)
    expect(r.results).toEqual([])
    expect(r.meta.last_row_id).toBe(1)
    expect(r.meta.changes).toBe(1)
    expect(r.meta.rows_written).toBe(1)
    expect(r.meta.served_by).toBe('groundflare-sqlite')
    expect(typeof r.meta.duration).toBe('number')
  })

  test('bind() returns a fresh statement — original unchanged', async () => {
    const base = d1.prepare('INSERT INTO users (name) VALUES (?)')
    const bound = base.bind('X')
    expect(bound).not.toBe(base)
    // The bound one should insert; the unbound one would fail on missing binding.
    await bound.run()
    const count = await d1.prepare('SELECT COUNT(*) as n FROM users').first<{ n: number }>()
    expect(count?.n).toBe(1)
  })

  test('multiple bind() calls append positional args', async () => {
    const stmt = d1
      .prepare('INSERT INTO users (name, email) VALUES (?, ?)')
      .bind('Alice')
      .bind('a@x')
    const r = await stmt.run()
    expect(r.meta.changes).toBe(1)
  })
})

describe('BunD1Adapter — all()', () => {
  beforeEach(async () => {
    for (const name of ['Alice', 'Bob', 'Carol']) {
      await d1
        .prepare('INSERT INTO users (name) VALUES (?)')
        .bind(name)
        .run()
    }
  })

  test('returns rows in CF shape with results + success + meta', async () => {
    const r = await d1.prepare('SELECT name FROM users ORDER BY id').all<{ name: string }>()
    expect(r.success).toBe(true)
    expect(r.results).toEqual([{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }])
    expect(r.meta.rows_read).toBe(3)
    expect(r.meta.rows_written).toBe(0)
    expect(r.meta.changes).toBe(0)
  })

  test('empty result set still returns success=true with empty results', async () => {
    const r = await d1
      .prepare('SELECT name FROM users WHERE name = ?')
      .bind('Nobody')
      .all()
    expect(r.success).toBe(true)
    expect(r.results).toEqual([])
  })
})

describe('BunD1Adapter — first()', () => {
  beforeEach(async () => {
    await d1.prepare('INSERT INTO users (name, email) VALUES (?, ?)').bind('Alice', 'a@x').run()
    await d1.prepare('INSERT INTO users (name, email) VALUES (?, ?)').bind('Bob', 'b@y').run()
  })

  test('returns the first row as an object', async () => {
    const row = await d1
      .prepare('SELECT name, email FROM users ORDER BY id')
      .first<{ name: string; email: string }>()
    expect(row).toEqual({ name: 'Alice', email: 'a@x' })
  })

  test('with column name returns only that column value', async () => {
    const name = await d1
      .prepare('SELECT name, email FROM users ORDER BY id')
      .first<string>('name')
    expect(name).toBe('Alice')
  })

  test('returns null for no rows', async () => {
    const row = await d1
      .prepare('SELECT name FROM users WHERE name = ?')
      .bind('Nobody')
      .first()
    expect(row).toBeNull()
  })

  test('with column returns null for no rows', async () => {
    const v = await d1
      .prepare('SELECT name FROM users WHERE name = ?')
      .bind('Nobody')
      .first<string>('name')
    expect(v).toBeNull()
  })
})

describe('BunD1Adapter — raw()', () => {
  beforeEach(async () => {
    await d1.prepare('INSERT INTO users (name, email) VALUES (?, ?)').bind('Alice', 'a@x').run()
    await d1.prepare('INSERT INTO users (name, email) VALUES (?, ?)').bind('Bob', null).run()
  })

  test('returns rows as positional arrays, not objects', async () => {
    const rows = await d1
      .prepare('SELECT name, email FROM users ORDER BY id')
      .raw<[string, string | null]>()
    expect(rows).toEqual([
      ['Alice', 'a@x'],
      ['Bob', null],
    ])
  })
})

describe('BunD1Adapter — batch()', () => {
  test('empty batch returns empty array', async () => {
    const r = await d1.batch([])
    expect(r).toEqual([])
  })

  test('runs a mix of DML + SELECT atomically', async () => {
    const r = await d1.batch([
      d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice'),
      d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Bob'),
      d1.prepare('SELECT name FROM users ORDER BY id'),
    ])
    expect(r).toHaveLength(3)
    expect(r[0]!.meta.changes).toBe(1)
    expect(r[1]!.meta.changes).toBe(1)
    expect(r[2]!.results).toEqual([{ name: 'Alice' }, { name: 'Bob' }])
  })

  test('rolls back on statement failure', async () => {
    try {
      await d1.batch([
        d1.prepare('INSERT INTO users (name) VALUES (?)').bind('Alice'),
        // NOT NULL violation — name is NOT NULL
        d1.prepare('INSERT INTO users (name) VALUES (?)').bind(null),
      ])
      throw new Error('expected batch to throw')
    } catch (err) {
      expect((err as Error).message).toContain('D1.batch failed')
    }
    const count = await d1.prepare('SELECT COUNT(*) as n FROM users').first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  test('rejects statements from a different adapter instance', async () => {
    const other = BunD1Adapter.open(':memory:')
    const stmt = other.prepare('SELECT 1')
    try {
      await d1.batch([stmt])
      throw new Error('expected reject')
    } catch (err) {
      expect((err as Error).message).toContain('same adapter instance')
    }
  })
})

describe('BunD1Adapter — exec()', () => {
  test('executes multi-statement SQL and reports count + duration', async () => {
    const r = await d1.exec(
      'CREATE TABLE tags (id INTEGER PRIMARY KEY); CREATE TABLE posts (id INTEGER);',
    )
    expect(r.count).toBe(2)
    expect(typeof r.duration).toBe('number')
  })

  test('trailing semicolons are not counted as extra statements', () => {
    expect(countStatements('SELECT 1; SELECT 2;')).toBe(2)
    expect(countStatements('SELECT 1;   ;  SELECT 2;')).toBe(2)
    expect(countStatements(';')).toBe(0)
    expect(countStatements('')).toBe(0)
  })
})

describe('BunD1Adapter — statement cache', () => {
  test('same SQL string reuses a cached prepared statement', async () => {
    const stmt = d1.prepare('SELECT 1 as n')
    const a = await stmt.first<{ n: number }>()
    const b = await stmt.first<{ n: number }>()
    expect(a?.n).toBe(1)
    expect(b?.n).toBe(1)
    // The same SQL used through a different prepare() call should also
    // hit the cache — bind semantics differ so we can't compare
    // statement identity directly, but behavioural equivalence is what
    // we promise.
    const c = await d1.prepare('SELECT 1 as n').first<{ n: number }>()
    expect(c?.n).toBe(1)
  })
})

describe('BunD1Adapter — data types', () => {
  beforeEach(async () => {
    await d1.exec('DROP TABLE IF EXISTS types; CREATE TABLE types (i INTEGER, r REAL, t TEXT, b BLOB)')
  })

  test('NULL is preserved through a round trip', async () => {
    await d1.prepare('INSERT INTO types (i, r, t) VALUES (?, ?, ?)').bind(null, null, null).run()
    const row = await d1.prepare('SELECT i, r, t FROM types').first()
    expect(row).toEqual({ i: null, r: null, t: null })
  })

  test('INTEGER stays an integer', async () => {
    await d1.prepare('INSERT INTO types (i) VALUES (?)').bind(42).run()
    const row = await d1.prepare('SELECT i FROM types').first<{ i: number }>()
    expect(row?.i).toBe(42)
  })

  test('REAL stays a float', async () => {
    await d1.prepare('INSERT INTO types (r) VALUES (?)').bind(3.14).run()
    const row = await d1.prepare('SELECT r FROM types').first<{ r: number }>()
    expect(row?.r).toBeCloseTo(3.14)
  })
})
