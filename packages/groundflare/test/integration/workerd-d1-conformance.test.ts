/**
 * Run the shared D1 conformance spec against real workerd (DO-backed D1).
 *
 * Third leg of the three-track D1 coverage:
 *   - vitest  + node:sqlite  → test/conformance/d1.test.ts
 *   - bun:test + bun:sqlite → test/bun/adapters/d1.test.ts
 *   - vitest  + real workerd → this file
 *
 * Same approach as workerd-kv-conformance.test.ts: a proxy Worker
 * exposes every D1 operation over JSON HTTP. WorkerdD1Proxy wraps
 * that into the D1AdapterLike interface.
 *
 * Skipped:
 *   - BLOB round-trip — workerd's D1 binding returns BLOBs as
 *     ArrayBuffer; JSON serialisation over HTTP loses fidelity
 *     without a per-column type annotation the proxy doesn't have.
 *   - batch "rejects statements from a different adapter" — not
 *     applicable over HTTP (there's only one adapter).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  buildCapnpFromWorkspace,
  type WorkspaceManifest,
} from '../../src/runtime/workspace/index.js'
import { renderCapnpConfig } from '../../src/runtime/workerd/capnp/index.js'
import {
  pickFreePort,
  spawnWorkerd,
  type SpawnedWorkerd,
} from './spawn-workerd.js'

const D1_WORKER_SOURCE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (request.method !== 'POST') {
        return new Response('POST only', { status: 405 })
      }
      const body = await request.json()

      switch (url.pathname) {
        case '/d1/exec': {
          const result = await env.DB.exec(body.sql)
          return Response.json({ count: result.count, duration: result.duration ?? 0 })
        }
        case '/d1/run': {
          const stmt = env.DB.prepare(body.sql)
          const bound = body.params?.length ? stmt.bind(...body.params) : stmt
          const result = await bound.run()
          return Response.json(result)
        }
        case '/d1/all': {
          const stmt = env.DB.prepare(body.sql)
          const bound = body.params?.length ? stmt.bind(...body.params) : stmt
          const result = await bound.all()
          return Response.json(result)
        }
        case '/d1/first': {
          const stmt = env.DB.prepare(body.sql)
          const bound = body.params?.length ? stmt.bind(...body.params) : stmt
          const row = body.column
            ? await bound.first(body.column)
            : await bound.first()
          return Response.json({ row })
        }
        case '/d1/raw': {
          const stmt = env.DB.prepare(body.sql)
          const bound = body.params?.length ? stmt.bind(...body.params) : stmt
          const rows = await bound.raw()
          return Response.json({ rows })
        }
        case '/d1/batch': {
          const stmts = body.statements.map(s => {
            const st = env.DB.prepare(s.sql)
            return s.params?.length ? st.bind(...s.params) : st
          })
          const results = await env.DB.batch(stmts)
          return Response.json(results)
        }
      }
      return new Response('not found', { status: 404 })
    } catch (err) {
      return Response.json(
        { error: err.message ?? String(err) },
        { status: 500 },
      )
    }
  }
}
`

interface D1ProxyResult {
  results: unknown[]
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

class WorkerdD1Proxy {
  constructor(
    private wd: SpawnedWorkerd,
    private host: string,
  ) {}

  prepare(sql: string) {
    return new WorkerdD1Statement(this.wd, this.host, sql, [])
  }

  async batch(
    statements: WorkerdD1Statement[],
  ): Promise<D1ProxyResult[]> {
    const body = {
      statements: statements.map((s) => ({
        sql: s._sql,
        params: s._params,
      })),
    }
    const res = await this.post('/d1/batch', body)
    return res as D1ProxyResult[]
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    return this.post('/d1/exec', { sql }) as Promise<{
      count: number
      duration: number
    }>
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.wd.sendRequest({
      host: this.host,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status !== 200) {
      const parsed = tryJson(res.body)
      throw new Error(
        parsed?.error ?? `workerd ${path} failed: ${res.status} ${res.body}`,
      )
    }
    return JSON.parse(res.body)
  }
}

class WorkerdD1Statement {
  constructor(
    private wd: SpawnedWorkerd,
    private host: string,
    readonly _sql: string,
    readonly _params: unknown[],
  ) {}

  bind(...values: unknown[]): WorkerdD1Statement {
    return new WorkerdD1Statement(this.wd, this.host, this._sql, [
      ...this._params,
      ...values,
    ])
  }

  async first<U = unknown>(column?: string): Promise<U | null> {
    const body: Record<string, unknown> = {
      sql: this._sql,
      params: this._params,
    }
    if (column !== undefined) body.column = column
    const res = await this.post('/d1/first', body)
    const parsed = res as { row: U | null }
    return parsed.row
  }

  async run(): Promise<D1ProxyResult> {
    return this.post('/d1/run', {
      sql: this._sql,
      params: this._params,
    }) as Promise<D1ProxyResult>
  }

  async all(): Promise<D1ProxyResult> {
    return this.post('/d1/all', {
      sql: this._sql,
      params: this._params,
    }) as Promise<D1ProxyResult>
  }

  async raw<U = unknown[]>(): Promise<U[]> {
    const res = (await this.post('/d1/raw', {
      sql: this._sql,
      params: this._params,
    })) as { rows: U[] }
    return res.rows
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.wd.sendRequest({
      host: this.host,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status !== 200) {
      const parsed = tryJson(res.body)
      throw new Error(
        parsed?.error ?? `workerd ${path} failed: ${res.status} ${res.body}`,
      )
    }
    return JSON.parse(res.body)
  }
}

function tryJson(s: string): { error?: string } | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

const MANIFEST: WorkspaceManifest = {
  name: 'd1-conformance',
  workers: [
    {
      name: 'api',
      domain: 'api.test',
      entryPath: 'user.js',
      d1Databases: [{ binding: 'DB', databaseName: 'd1conf' }],
    },
  ],
}

let wd: SpawnedWorkerd | null = null
let d1: WorkerdD1Proxy | null = null

const STATE_BASE = 'do-state'

describe(
  'D1 conformance [workerd (DO-backed)]',
  () => {
    beforeAll(async () => {
      const port = await pickFreePort()
      const config = buildCapnpFromWorkspace(MANIFEST, {
        listenAddress: `127.0.0.1:${port}`,
        stateBaseDir: STATE_BASE,
      })
      const capnp = renderCapnpConfig(config)
      wd = await spawnWorkerd({
        port,
        capnp,
        modules: { 'user.js': D1_WORKER_SOURCE },
        extraDirs: [`${STATE_BASE}/api/d1/d1conf`],
        healthTimeoutMs: 15_000,
      })
      d1 = new WorkerdD1Proxy(wd, 'api.test')

      await d1.exec(
        `CREATE TABLE IF NOT EXISTS users (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL,
           email TEXT UNIQUE,
           age INTEGER
         )`,
      )
    }, 30_000)

    afterAll(async () => {
      if (wd) await wd.stop()
    })

    describe('prepare + bind + first/all/run', () => {
      it('run INSERT returns success + meta with changes', async () => {
        const result = await d1!
          .prepare('INSERT INTO users(name, email) VALUES (?, ?)')
          .bind('alice', 'alice@conformance.test')
          .run()
        expect(result.success).toBe(true)
        expect(result.meta.changes).toBeGreaterThanOrEqual(1)
      })

      it('all() returns rows matching CF shape', async () => {
        await d1!
          .prepare('INSERT INTO users(name, email) VALUES (?, ?)')
          .bind('x-all1', 'x1@c.t')
          .run()
        await d1!
          .prepare('INSERT INTO users(name, email) VALUES (?, ?)')
          .bind('x-all2', 'x2@c.t')
          .run()
        const res = await d1!
          .prepare(
            "SELECT name, email FROM users WHERE email LIKE '%@c.t' ORDER BY name",
          )
          .all()
        expect(res.success).toBe(true)
        expect(res.results.length).toBe(2)
      })

      it('first() returns only the first row', async () => {
        await d1!
          .prepare('INSERT INTO users(name) VALUES (?)')
          .bind('first-test')
          .run()
        const row = await d1!
          .prepare("SELECT name FROM users WHERE name = 'first-test'")
          .first<{ name: string }>()
        expect(row).toEqual({ name: 'first-test' })
      })

      it('first() with column name returns that value', async () => {
        const name = await d1!
          .prepare("SELECT name FROM users WHERE name = 'first-test'")
          .first<string>('name')
        expect(name).toBe('first-test')
      })

      it('first() returns null for no rows', async () => {
        const row = await d1!
          .prepare("SELECT * FROM users WHERE name = 'nobody'")
          .first()
        expect(row).toBe(null)
      })

      it('bind() creates a fresh statement', async () => {
        const ps = d1!.prepare('INSERT INTO users(name) VALUES (?)')
        await ps.bind('bind-a').run()
        await ps.bind('bind-b').run()
        const res = await d1!
          .prepare(
            "SELECT name FROM users WHERE name LIKE 'bind-%' ORDER BY name",
          )
          .all()
        expect(
          (res.results as { name: string }[]).map((r) => r.name),
        ).toEqual(['bind-a', 'bind-b'])
      })
    })

    describe('data types', () => {
      it('NULL is preserved', async () => {
        await d1!
          .prepare('INSERT INTO users(name, age) VALUES (?, ?)')
          .bind('null-test', null)
          .run()
        const row = await d1!
          .prepare("SELECT age FROM users WHERE name = 'null-test'")
          .first<{ age: number | null }>()
        expect(row?.age).toBe(null)
      })

      it('INTEGER round-trips', async () => {
        await d1!
          .prepare('INSERT INTO users(name, age) VALUES (?, ?)')
          .bind('int-test', 42)
          .run()
        const row = await d1!
          .prepare("SELECT age FROM users WHERE name = 'int-test'")
          .first<{ age: number }>()
        expect(row?.age).toBe(42)
      })

      it('TEXT with unicode round-trips', async () => {
        await d1!
          .prepare('INSERT INTO users(name) VALUES (?)')
          .bind('小明')
          .run()
        const row = await d1!
          .prepare("SELECT name FROM users WHERE name = '小明'")
          .first<{ name: string }>()
        expect(row?.name).toBe('小明')
      })
    })

    describe('raw()', () => {
      it('returns arrays instead of objects', async () => {
        await d1!
          .prepare('INSERT INTO users(name, age) VALUES (?, ?)')
          .bind('raw-a', 1)
          .run()
        await d1!
          .prepare('INSERT INTO users(name, age) VALUES (?, ?)')
          .bind('raw-b', 2)
          .run()
        const rows = await d1!
          .prepare(
            "SELECT name, age FROM users WHERE name LIKE 'raw-%' ORDER BY name",
          )
          .raw<[string, number]>()
        expect(rows).toEqual([
          ['raw-a', 1],
          ['raw-b', 2],
        ])
      })
    })

    describe('batch()', () => {
      it('runs statements in order', async () => {
        const results = await d1!.batch([
          d1!.prepare('INSERT INTO users(name) VALUES (?)').bind('batch-a'),
          d1!.prepare('INSERT INTO users(name) VALUES (?)').bind('batch-b'),
          d1!
            .prepare(
              "SELECT COUNT(*) AS n FROM users WHERE name LIKE 'batch-%'",
            ),
        ])
        expect(results.length).toBe(3)
        // CF D1's meta.changes may aggregate across the batch; only
        // assert the SELECT result which is deterministic.
        expect((results[2]?.results[0] as { n: number })?.n).toBe(2)
      })

      it('rolls back on statement failure', async () => {
        await d1!
          .prepare('INSERT INTO users(name) VALUES (?)')
          .bind('pre-batch-fail')
          .run()
        try {
          await d1!.batch([
            d1!
              .prepare('INSERT INTO users(name) VALUES (?)')
              .bind('batch-fail-a'),
            d1!.prepare('INSERT INTO users(name) VALUES (?)').bind(null),
          ])
        } catch {
          // expected
        }
        const row = await d1!
          .prepare(
            "SELECT COUNT(*) AS n FROM users WHERE name = 'batch-fail-a'",
          )
          .first<{ n: number }>()
        expect(row?.n).toBe(0)
      })

      it('empty batch returns empty array', async () => {
        const results = await d1!.batch([])
        expect(results).toEqual([])
      })
    })

    describe('exec()', () => {
      it('runs multi-statement migration', async () => {
        const res = await d1!.exec(
          `CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, label TEXT);
           CREATE INDEX IF NOT EXISTS tags_label ON tags(label);`,
        )
        expect(res.count).toBe(2)
      })

      it('trailing semicolons not counted', async () => {
        const res = await d1!.exec('SELECT 1;;;')
        expect(res.count).toBe(1)
      })
    })

    describe('meta.served_by', () => {
      it('identifies the runtime', async () => {
        const run = await d1!
          .prepare('INSERT INTO users(name) VALUES (?)')
          .bind('served-by')
          .run()
        expect(run.meta.served_by).toBeDefined()
        expect(typeof run.meta.served_by).toBe('string')
      })
    })

    describe('RETURNING clause', () => {
      it('INSERT ... RETURNING delivers rows via all()', async () => {
        const res = await d1!
          .prepare('INSERT INTO users(name) VALUES (?) RETURNING id, name')
          .bind('ret-test')
          .all()
        expect(res.results.length).toBe(1)
        expect((res.results[0] as { name: string })?.name).toBe('ret-test')
      })
    })
  },
  120_000,
)
