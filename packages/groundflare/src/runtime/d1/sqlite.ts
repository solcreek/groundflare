/**
 * SQLite-backed D1 adapter — the default Mirror-track D1 implementation.
 *
 * better-sqlite3 exposes a synchronous Statement API; we wrap terminal
 * methods in Promises to match CF's async contract. Because the driver
 * is sync, `batch()` is wrapped in a `db.transaction(...)` so failures
 * roll back atomically — matching CF D1's batch semantics.
 *
 * Paths live under /var/lib/groundflare/workers/<worker>/d1/<db>.sqlite
 * (see design/workspaces.md for the state layout); the adapter only
 * knows about a single file.
 */

import type { Statement } from 'better-sqlite3'
import type { BetterSqlite3Database } from '../sqlite/node.js'
import { openSqlite } from '../sqlite/node.js'
import type { SqlitePreludeOptions } from '../sqlite/prelude.js'
import type {
  D1Adapter,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
} from './types.js'

const SERVED_BY = 'groundflare-sqlite'

export interface SqliteD1AdapterOptions extends SqlitePreludeOptions {
  /** Injectable clock for deterministic test timings. */
  now?: () => number
}

export class SqliteD1Adapter implements D1Adapter {
  private readonly db: BetterSqlite3Database
  private readonly now: () => number
  private readonly ownsConnection: boolean
  private readonly stmtCache = new Map<string, Statement>()

  constructor(
    db: BetterSqlite3Database,
    opts: { now?: () => number; ownsConnection?: boolean } = {},
  ) {
    this.db = db
    this.now = opts.now ?? Date.now
    this.ownsConnection = opts.ownsConnection ?? false
  }

  static open(path: string, opts: SqliteD1AdapterOptions = {}): SqliteD1Adapter {
    const db = openSqlite(path, opts)
    return new SqliteD1Adapter(db, { now: opts.now, ownsConnection: true })
  }

  close(): void {
    if (this.ownsConnection) this.db.close()
  }

  prepare(sql: string): D1PreparedStatement {
    return new SqlitePreparedStatement(this, sql, [])
  }

  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    if (statements.length === 0) return []

    for (const s of statements) {
      if (!(s instanceof SqlitePreparedStatement) || s.adapter !== this) {
        throw new TypeError(
          'D1.batch: every entry must come from the same adapter instance',
        )
      }
    }

    const results: D1Result<T>[] = []

    // Wrap in a transaction for atomic rollback on failure.
    const run = this.db.transaction(() => {
      for (const s of statements as SqlitePreparedStatement<T>[]) {
        results.push(s.executeSync())
      }
    })

    try {
      run()
    } catch (err) {
      // Re-throw as the same type CF produces — a generic Error with a
      // descriptive message. Applications can parse `.message` if needed.
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
      stmt = this.db.prepare(sql)
      this.stmtCache.set(sql, stmt)
    }
    return stmt
  }
}

class SqlitePreparedStatement<T = Record<string, unknown>>
  implements D1PreparedStatement
{
  constructor(
    /** @internal — readable by the owning adapter for batch ownership checks */
    readonly adapter: SqliteD1Adapter,
    private readonly sql: string,
    private readonly args: readonly unknown[],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqlitePreparedStatement(this.adapter, this.sql, [...this.args, ...values])
  }

  async first<U = unknown>(column?: string): Promise<U | null> {
    const stmt = this.adapter._prepareCached(this.sql)
    const row = stmt.get(...this.args) as Record<string, unknown> | undefined
    if (!row) return null
    if (column !== undefined) {
      return ((row[column] ?? null) as U | null)
    }
    return row as unknown as U
  }

  async run<U = Record<string, unknown>>(): Promise<D1Result<U>> {
    return this.runSync() as unknown as D1Result<U>
  }

  async all<U = Record<string, unknown>>(): Promise<D1Result<U>> {
    return this.allSync() as unknown as D1Result<U>
  }

  async raw<U = unknown[]>(): Promise<U[]> {
    const stmt = this.adapter._prepareCached(this.sql).raw()
    return stmt.all(...this.args) as U[]
  }

  // ─── sync helpers used by batch() ────────────────────────────────
  /** @internal */ executeSync(): D1Result<T> {
    // Decide between run() and all() by inspecting the SQL's leading verb;
    // SELECT / WITH / PRAGMA / RETURNING go through all(), everything else
    // through run(). Good enough for typical D1 use.
    const leading = this.sql.trimStart().slice(0, 6).toUpperCase()
    if (leading.startsWith('SELECT') || leading.startsWith('WITH ') || leading.startsWith('PRAGMA')) {
      return this.allSync() as D1Result<T>
    }
    // INSERT/UPDATE/DELETE ... RETURNING also needs to collect rows.
    if (/\bRETURNING\b/i.test(this.sql)) {
      return this.allSync() as D1Result<T>
    }
    return this.runSync() as D1Result<T>
  }

  /** @internal */ runSync<U = Record<string, unknown>>(): D1Result<U> {
    const start = this.adapter._nowMs()
    const stmt = this.adapter._prepareCached(this.sql)
    const info = stmt.run(...this.args)
    const duration = this.adapter._nowMs() - start
    return {
      results: [],
      success: true,
      meta: {
        duration,
        last_row_id: Number(info.lastInsertRowid),
        changes: info.changes,
        served_by: SERVED_BY,
        rows_read: 0,
        rows_written: info.changes,
      },
    }
  }

  /** @internal */ allSync<U = Record<string, unknown>>(): D1Result<U> {
    const start = this.adapter._nowMs()
    const stmt = this.adapter._prepareCached(this.sql)
    const rows = stmt.all(...this.args) as U[]
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

/**
 * Count the number of statements in a semicolon-separated SQL string,
 * ignoring empty trailing segments. Used by `exec()` for its `count`
 * metadata. Not a full SQL parser — string literals with semicolons
 * would be miscounted, but that's rare in migration scripts.
 */
export function countStatements(sql: string): number {
  let count = 0
  for (const seg of sql.split(';')) {
    if (seg.trim().length > 0) count++
  }
  return count
}
