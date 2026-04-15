/**
 * Shared D1 conformance spec — runs against every adapter implementation
 * under both test runners (vitest for Node / better-sqlite3, bun:test for
 * Bun / bun:sqlite).
 *
 * Companion to ./kv-spec.ts. The two adapters must produce the same
 * D1Result shape for the same SQL; drift fails both runners at once.
 */

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta: {
    duration: number
    last_row_id: number
    changes: number
    served_by: string
    rows_read: number
    rows_written: number
  }
}

export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike
  first<U = unknown>(column?: string): Promise<U | null>
  run<U = Record<string, unknown>>(): Promise<D1ResultLike<U>>
  all<U = Record<string, unknown>>(): Promise<D1ResultLike<U>>
  raw<U = unknown[]>(): Promise<U[]>
}

export interface D1AdapterLike {
  prepare(sql: string): D1PreparedLike
  batch<T = Record<string, unknown>>(
    statements: D1PreparedLike[],
  ): Promise<D1ResultLike<T>[]>
  exec(sql: string): Promise<{ count: number; duration: number }>
}

export interface D1Fixture {
  name: string
  create(now?: () => number): Promise<{
    adapter: D1AdapterLike
    teardown: () => Promise<void>
  }>
}

export interface D1TestDeps {
  describe: (name: string, fn: () => void) => void
  test: (name: string, fn: () => void | Promise<void>) => void
  expect: (value: unknown) => {
    toBe(v: unknown): void
    toEqual(v: unknown): void
    toMatch(v: RegExp | string): void
    toBeGreaterThan?(v: number): void
    toBeCloseTo?(v: number): void
    toBeNull?(): void
    toHaveLength?(n: number): void
    rejects: {
      toThrow(v?: RegExp | string): Promise<void>
    }
    [k: string]: unknown
  }
  beforeEach: (fn: () => void | Promise<void>) => void
  afterEach: (fn: () => void | Promise<void>) => void
}

/**
 * Schema used by the shared spec. Kept inside this module so callers
 * don't have to repeat it — and so divergence between runners is
 * impossible by construction.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  age INTEGER,
  bio BLOB
)`

export function runD1ConformanceSuite(
  deps: D1TestDeps,
  fixture: D1Fixture,
): void {
  const { describe, test, expect, beforeEach, afterEach } = deps

  describe(`D1 conformance [${fixture.name}]`, () => {
    let adapter: D1AdapterLike
    let teardown: () => Promise<void>
    let currentTime = 0

    beforeEach(async () => {
      currentTime = 1_700_000_000_000
      const created = await fixture.create(() => currentTime)
      adapter = created.adapter
      teardown = created.teardown
      await adapter.exec(SCHEMA)
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
        expect(result.meta.last_row_id > 0).toBe(true)
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
        await adapter
          .prepare('INSERT INTO users(name) VALUES (?)')
          .bind('alice')
          .run()
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
          await adapter
            .prepare('SELECT name FROM users')
            .first<string>('name'),
        ).toBe(null)
      })

      test('bind() creates a fresh statement (original unchanged)', async () => {
        const ps = adapter.prepare('INSERT INTO users(name) VALUES (?)')
        await ps.bind('alice').run()
        await ps.bind('bob').run()
        const res = await adapter
          .prepare('SELECT name FROM users ORDER BY name')
          .all()
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
        const row = await adapter
          .prepare('SELECT name, email FROM users')
          .first<{ name: string; email: string }>()
        expect(row).toEqual({ name: 'alice', email: 'alice@example.com' })
      })
    })

    describe('data types', () => {
      test('NULL is preserved', async () => {
        await adapter
          .prepare('INSERT INTO users(name, age) VALUES (?, ?)')
          .bind('x', null)
          .run()
        const row = await adapter
          .prepare('SELECT age FROM users')
          .first<{ age: number | null }>()
        expect(row?.age).toBe(null)
      })

      test('INTEGER round-trips', async () => {
        await adapter
          .prepare('INSERT INTO users(name, age) VALUES (?, ?)')
          .bind('x', 42)
          .run()
        const row = await adapter
          .prepare('SELECT age FROM users')
          .first<{ age: number }>()
        expect(row?.age).toBe(42)
      })

      test('TEXT with unicode round-trips', async () => {
        await adapter
          .prepare('INSERT INTO users(name) VALUES (?)')
          .bind('小明')
          .run()
        const row = await adapter
          .prepare('SELECT name FROM users')
          .first<{ name: string }>()
        expect(row?.name).toBe('小明')
      })

      test('BLOB round-trips', async () => {
        // Use plain Uint8Array so the test is driver-agnostic: both
        // better-sqlite3 and bun:sqlite accept it as a BLOB bind, and
        // both return a Buffer-or-Uint8Array on read (both honour
        // Array.from).
        const bytes = new Uint8Array([0, 1, 2, 3, 255])
        await adapter
          .prepare('INSERT INTO users(name, bio) VALUES (?, ?)')
          .bind('x', bytes)
          .run()
        const row = await adapter
          .prepare('SELECT bio FROM users')
          .first<{ bio: Uint8Array | Buffer }>()
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
        expect(results.length).toBe(3)
        expect(results[0]?.meta.changes).toBe(1)
        expect(results[1]?.meta.changes).toBe(1)
        expect((results[2]?.results[0] as { n: number })?.n).toBe(2)
      })

      test('rolls back all statements if one fails', async () => {
        await adapter
          .prepare('INSERT INTO users(name) VALUES (?)')
          .bind('pre')
          .run()
        await expect(
          adapter.batch([
            adapter.prepare('INSERT INTO users(name) VALUES (?)').bind('a'),
            // NOT NULL violation — name is NOT NULL
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
        const { adapter: other, teardown: otherTeardown } =
          await fixture.create()
        try {
          const ps = other.prepare('SELECT 1')
          await expect(adapter.batch([ps])).rejects.toThrow(
            /same adapter instance/,
          )
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
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='tags'",
          )
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
        const run = await adapter
          .prepare('INSERT INTO users(name) VALUES (?)')
          .bind('x')
          .run()
        expect(run.meta.served_by).toMatch(/groundflare/)
        const all = await adapter.prepare('SELECT * FROM users').all()
        expect(all.meta.served_by).toMatch(/groundflare/)
      })
    })

    describe('RETURNING clause', () => {
      test('INSERT ... RETURNING delivers rows via all()', async () => {
        const res = await adapter
          .prepare('INSERT INTO users(name) VALUES (?) RETURNING id, name')
          .bind('alice')
          .all<{ id: number; name: string }>()
        expect(res.results.length).toBe(1)
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
        expect(results[1]?.results.length).toBe(1)
        expect(results[1]?.results[0]?.name).toBe('b')
      })
    })
  })
}
