/**
 * Bun-runtime D1 adapter — implements the Cloudflare Workers D1
 * surface backed by `bun:sqlite`. Ships as source to the VPS;
 * server.ts imports from this file at deploy time.
 *
 * Behavioural parity with src/runtime/d1/sqlite.ts (Node / better-
 * sqlite3 driver): same result-shape, same error text, same
 * batch-is-atomic semantics. A SQLite file written by one adapter
 * must be readable by the other without migration. Schema is
 * user-controlled (D1 doesn't impose one); only the PRAGMA prelude
 * is our concern and it matches byte-for-byte.
 *
 * Sync-inside-async note: bun:sqlite is synchronous (same as better-
 * sqlite3). We wrap terminals in Promises to match the CF D1 contract;
 * await-ing them never yields the event loop, but callers treating
 * them as async works fine.
 */

import { Database, type Statement } from 'bun:sqlite'

// ─── result shapes (mirror CF D1) ─────────────────────────────────

export interface D1Meta {
  duration: number
  last_row_id: number
  changes: number
  served_by: string
  rows_read: number
  rows_written: number
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[]
  success: true
  meta: D1Meta
}

export interface D1ExecResult {
  count: number
  duration: number
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<U = unknown>(column?: string): Promise<U | null>
  run<U = Record<string, unknown>>(): Promise<D1Result<U>>
  all<U = Record<string, unknown>>(): Promise<D1Result<U>>
  raw<U = unknown[]>(): Promise<U[]>
}

export interface D1Adapter {
  prepare(sql: string): D1PreparedStatement
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>
  exec(sql: string): Promise<D1ExecResult>
}

// ─── schema + pragmas ──────────────────────────────────────────────

const PRAGMA_PRELUDE: readonly string[] = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA wal_autocheckpoint = 10000',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA cache_size = -64000',
  'PRAGMA mmap_size = 268435456',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA foreign_keys = ON',
]

const SERVED_BY = 'groundflare-sqlite'

// ─── adapter class ────────────────────────────────────────────────

export interface BunD1AdapterOptions {
  /** Injectable clock for deterministic test timings. Default Date.now. */
  now?: () => number
}

export class BunD1Adapter implements D1Adapter {
  private readonly db: Database
  private readonly now: () => number
  private readonly ownsConnection: boolean
  private readonly stmtCache = new Map<string, Statement>()

  constructor(
    db: Database,
    opts: { now?: () => number; ownsConnection?: boolean } = {},
  ) {
    this.db = db
    this.now = opts.now ?? Date.now
    this.ownsConnection = opts.ownsConnection ?? false

    for (const stmt of PRAGMA_PRELUDE) db.exec(stmt)
  }

  static open(path: string, opts: BunD1AdapterOptions = {}): BunD1Adapter {
    const db = new Database(path, { create: true })
    return new BunD1Adapter(db, { now: opts.now, ownsConnection: true })
  }

  close(): void {
    if (this.ownsConnection) this.db.close()
  }

  prepare(sql: string): D1PreparedStatement {
    return new BunPreparedStatement(this, sql, [])
  }

  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    if (statements.length === 0) return []

    for (const s of statements) {
      if (!(s instanceof BunPreparedStatement) || s.adapter !== this) {
        throw new TypeError(
          'D1.batch: every entry must come from the same adapter instance',
        )
      }
    }

    const results: D1Result<T>[] = []

    // bun:sqlite exposes the same `db.transaction(fn)` helper as
    // better-sqlite3 — returns a function whose body runs inside
    // BEGIN ... COMMIT with automatic rollback on throw.
    const run = this.db.transaction(() => {
      for (const s of statements as BunPreparedStatement<T>[]) {
        results.push(s.executeSync())
      }
    })

    try {
      run()
    } catch (err) {
      throw new Error(`D1.batch failed: ${errMessage(err)}`)
    }

    return results
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const start = this.now()
    this.db.exec(sql)
    const duration = this.now() - start
    return { count: countStatements(sql), duration }
  }

  // ─── internal accessors for the prepared-statement helper ─────────
  /** @internal */ _nowMs(): number {
    return this.now()
  }

  /** @internal */ _prepareCached(sql: string): Statement {
    let stmt = this.stmtCache.get(sql)
    if (!stmt) {
      stmt = this.db.query(sql)
      this.stmtCache.set(sql, stmt)
    }
    return stmt
  }
}

class BunPreparedStatement<T = Record<string, unknown>>
  implements D1PreparedStatement
{
  constructor(
    /** @internal — readable by the owning adapter for batch ownership checks */
    readonly adapter: BunD1Adapter,
    private readonly sql: string,
    private readonly args: readonly unknown[],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new BunPreparedStatement(this.adapter, this.sql, [
      ...this.args,
      ...values,
    ])
  }

  async first<U = unknown>(column?: string): Promise<U | null> {
    const stmt = this.adapter._prepareCached(this.sql)
    const row = stmt.get(...(this.args as unknown[])) as
      | Record<string, unknown>
      | null
    if (!row) return null
    if (column !== undefined) return (row[column] ?? null) as U | null
    return row as unknown as U
  }

  async run<U = Record<string, unknown>>(): Promise<D1Result<U>> {
    return this.runSync() as unknown as D1Result<U>
  }

  async all<U = Record<string, unknown>>(): Promise<D1Result<U>> {
    return this.allSync() as unknown as D1Result<U>
  }

  async raw<U = unknown[]>(): Promise<U[]> {
    // bun:sqlite's Statement has .values(...) which returns rows as
    // positional arrays — the analogue of better-sqlite3's .raw().all().
    const stmt = this.adapter._prepareCached(this.sql) as Statement & {
      values(...args: unknown[]): U[]
    }
    return stmt.values(...(this.args as unknown[]))
  }

  // ─── sync helpers used by batch() ────────────────────────────────
  /** @internal */ executeSync(): D1Result<T> {
    const leading = this.sql.trimStart().slice(0, 6).toUpperCase()
    if (
      leading.startsWith('SELECT') ||
      leading.startsWith('WITH ') ||
      leading.startsWith('PRAGMA')
    ) {
      return this.allSync() as D1Result<T>
    }
    // INSERT/UPDATE/DELETE ... RETURNING also collects rows.
    if (/\bRETURNING\b/i.test(this.sql)) {
      return this.allSync() as D1Result<T>
    }
    return this.runSync() as D1Result<T>
  }

  /** @internal */ runSync<U = Record<string, unknown>>(): D1Result<U> {
    const start = this.adapter._nowMs()
    const stmt = this.adapter._prepareCached(this.sql)
    const info = stmt.run(...(this.args as unknown[]))
    const duration = this.adapter._nowMs() - start
    return {
      results: [],
      success: true,
      meta: {
        duration,
        last_row_id: Number(info.lastInsertRowid),
        changes: Number(info.changes),
        served_by: SERVED_BY,
        rows_read: 0,
        rows_written: Number(info.changes),
      },
    }
  }

  /** @internal */ allSync<U = Record<string, unknown>>(): D1Result<U> {
    const start = this.adapter._nowMs()
    const stmt = this.adapter._prepareCached(this.sql)
    const rows = stmt.all(...(this.args as unknown[])) as U[]
    const duration = this.adapter._nowMs() - start
    return {
      results: rows,
      success: true,
      meta: {
        duration,
        last_row_id: 0,
        changes: 0,
        served_by: SERVED_BY,
        rows_read: rows.length,
        rows_written: 0,
      },
    }
  }
}

// ─── internals ─────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Count semicolon-separated non-empty statements. Mirrors the Node helper. */
export function countStatements(sql: string): number {
  let count = 0
  for (const seg of sql.split(';')) {
    if (seg.trim().length > 0) count++
  }
  return count
}
