/**
 * Cloudflare Workers D1 binding API (subset implemented in v0.1).
 *
 * Shape mirrors @cloudflare/workers-types so a Worker calling
 * env.DB.prepare(...) compiles and runs identically regardless of
 * whether the binding resolves to real CF D1, the Mirror-track
 * SQLite adapter (this file's implementation), or the Bun-track
 * bun:sqlite adapter.
 *
 * https://developers.cloudflare.com/d1/build-with-d1/d1-client-api/
 */

/**
 * Metadata returned alongside every D1 result. Matches the CF shape;
 * self-hosted adapters set `served_by` to identify themselves in logs.
 */
export interface D1Meta {
  /** Execution time in milliseconds. */
  duration: number
  /** `sqlite3_last_insert_rowid()` after the statement. 0 for SELECTs. */
  last_row_id: number
  /** `sqlite3_changes()` after the statement. 0 for SELECTs. */
  changes: number
  /** Identifier of the runtime that served the request. */
  served_by: string
  /** Rows returned (SELECT) — self-hosted metric; may be 0 for non-queries. */
  rows_read: number
  /** Rows mutated (INSERT/UPDATE/DELETE). */
  rows_written: number
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  error?: string
  meta: D1Meta
}

export interface D1ExecResult {
  count: number
  duration: number
}

export interface D1PreparedStatement {
  /**
   * Bind positional parameters. Returns a new statement; the original is
   * unchanged so a single prepared statement can be reused with different
   * parameter sets.
   */
  bind(...values: unknown[]): D1PreparedStatement

  /**
   * Execute and return only the first row. If `column` is provided, returns
   * the value of that column instead of the whole row. Resolves to null if
   * there are no rows.
   */
  first<T = unknown>(column?: string): Promise<T | null>

  /**
   * Execute a mutating statement (INSERT/UPDATE/DELETE) and return metadata.
   */
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>

  /**
   * Execute a SELECT and return all rows as objects.
   */
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>

  /**
   * Execute a SELECT and return rows as tuples (arrays), skipping column
   * name mapping. Useful for large result sets or when the caller wants
   * to consume rows positionally.
   */
  raw<T = unknown[]>(): Promise<T[]>
}

export interface D1Adapter {
  prepare(sql: string): D1PreparedStatement
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>
  exec(sql: string): Promise<D1ExecResult>
}
