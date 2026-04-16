/**
 * Node.js driver binding for the SQLite prelude, using the built-in
 * `node:sqlite` module (stable since Node 24, experimental on Node 22).
 *
 * Used by:
 *   - Tier 1 unit tests (this file's tests)
 *   - Tier 2 conformance tests (opens the adapter-produced SQLite file
 *     after the adapter has written to it, verifies expected rows)
 *   - CLI-side tooling that needs to inspect or migrate SQLite files
 *
 * Production runtime adapters run inside workerd or Bun and use their
 * respective SQLite drivers. They share the same prelude.ts statements
 * but apply them through their own `.exec()` / `.pragma()` equivalents.
 *
 * Compat shim
 * -----------
 * `node:sqlite` ships a smaller surface than better-sqlite3. We expose
 * a tiny compat wrapper so the KV + D1 adapters keep calling the same
 * methods they used under better-sqlite3:
 *
 *   db.prepare(sql)     → Statement with .run / .get / .all / .raw / .iterate
 *   db.exec(sql)        → void
 *   db.pragma(name, …)  → helper; "simple: true" returns the first column
 *   db.transaction(fn)  → returns a function that runs fn inside
 *                         BEGIN / COMMIT / ROLLBACK-on-throw
 *   db.close()          → void
 *
 * No `--experimental-sqlite` flag on Node 22 (the module resolves but
 * emits an ExperimentalWarning once per process; harmless).
 */

import { createRequire } from 'node:module'
import {
  PreludeAssertionError,
  assertPreludeApplied,
  preludeStatements,
  readPreludeState,
  type AssertPreludeOptions,
  type PragmaReader,
  type PreludeState,
  type SqlitePreludeOptions,
} from './prelude.js'

// node:sqlite is a Node 22+ builtin. We load it via createRequire
// rather than a static `import` because Vite's test-time transform
// pipeline has been tripping on the `node:` scheme for this specific
// module (it resolves to bare `sqlite` which doesn't exist in
// node_modules). createRequire is a one-line sidestep that costs
// nothing at runtime.
const nodeRequire = createRequire(import.meta.url)
interface NodeSqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync
}
type DatabaseSync = {
  prepare(sql: string): StatementSync
  exec(sql: string): void
  close(): void
}
type StatementSync = {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): unknown[]
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>
}
// Lazy so the import only triggers when a caller actually opens a DB.
let _DatabaseSync: NodeSqliteModule['DatabaseSync'] | null = null
function getDatabaseSync(): NodeSqliteModule['DatabaseSync'] {
  if (_DatabaseSync === null) {
    const mod = nodeRequire('node:sqlite') as NodeSqliteModule
    _DatabaseSync = mod.DatabaseSync
  }
  return _DatabaseSync
}

/**
 * better-sqlite3-compatible Database interface over node:sqlite.
 * The name `BetterSqlite3Database` is kept for source-level backwards
 * compatibility with the adapter code; it is no longer tied to the
 * better-sqlite3 package.
 */
export interface BetterSqlite3Database {
  prepare(sql: string): Statement
  exec(sql: string): void
  pragma(name: string, opts?: { simple?: boolean }): unknown
  transaction<Args extends unknown[], R>(
    fn: (...args: Args) => R,
  ): (...args: Args) => R
  close(): void
}

export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Record<string, unknown>[]
  /**
   * Returns a raw-mode view of this statement: `.all()` yields arrays
   * of column values in SELECT order instead of objects. Matches
   * better-sqlite3's `.raw()` + `.all()` pattern.
   */
  raw(): { all(...params: unknown[]): unknown[][] }
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>
}

/**
 * Apply the prelude PRAGMAs to an existing connection. Useful when the
 * caller wants control over how the connection was opened.
 */
export function applyPrelude(
  db: BetterSqlite3Database,
  opts: SqlitePreludeOptions = {},
): PreludeState {
  for (const stmt of preludeStatements(opts)) {
    db.exec(stmt)
  }
  return readState(db)
}

/**
 * Open a SQLite file with the standard prelude applied. This is the
 * entrypoint most CLI / test code should use.
 *
 * Pass ':memory:' for an in-memory database; the journal_mode will
 * silently resolve to `memory` (not WAL) and `assertPrelude` must be
 * called with `allowMemoryJournal: true` to accept that.
 */
export function openSqlite(
  path: string,
  opts: SqlitePreludeOptions = {},
): BetterSqlite3Database {
  const Ctor = getDatabaseSync()
  const db = new Ctor(path)
  const wrapped = wrapDatabase(db)
  applyPrelude(wrapped, opts)
  return wrapped
}

/**
 * Read back the current PRAGMA state. Always returns the observed values
 * (not the values you passed in) — important for :memory: DBs where
 * journal_mode silently falls back.
 */
export function readState(db: BetterSqlite3Database): PreludeState {
  const reader: PragmaReader = {
    read: (name) => db.pragma(name, { simple: true }) as string | number | undefined,
  }
  return readPreludeState(reader)
}

/**
 * Assert that the prelude is correctly applied; throws PreludeAssertionError
 * listing every problem if not. Conformance tests call this after any
 * adapter opens a SQLite file.
 */
export function assertPrelude(
  db: BetterSqlite3Database,
  opts: AssertPreludeOptions = {},
): void {
  assertPreludeApplied(readState(db), opts)
}

export { PreludeAssertionError }

// ─── compat shim internals ────────────────────────────────────────

function wrapDatabase(db: DatabaseSync): BetterSqlite3Database {
  return {
    prepare(sql) {
      return wrapStatement(db.prepare(sql))
    },
    exec(sql) {
      db.exec(sql)
    },
    pragma(name, opts) {
      // PRAGMAs without a value read; those with a value assign. We
      // normalise to `PRAGMA <expr>` and decide read vs write by whether
      // the expression contains an `=`.
      const text = `PRAGMA ${name}`
      if (name.includes('=')) {
        db.exec(text)
        return undefined
      }
      // Reads: use prepare().all() to get every column for the full
      // representation; fall back to the first row's first column when
      // `simple: true` is set (matches better-sqlite3's shape).
      const stmt = db.prepare(text)
      const rows = stmt.all() as Array<Record<string, unknown>>
      if (rows.length === 0) return undefined
      if (opts?.simple === true) {
        const firstRow = rows[0]!
        const firstKey = Object.keys(firstRow)[0]
        return firstKey === undefined ? undefined : firstRow[firstKey]
      }
      return rows
    },
    transaction<Args extends unknown[], R>(fn: (...args: Args) => R) {
      // better-sqlite3's transaction wrapper can run nested — we ignore
      // that and support a single outermost BEGIN. The adapters we
      // ship only use the single-level form.
      return (...args: Args): R => {
        db.exec('BEGIN')
        try {
          const result = fn(...args)
          db.exec('COMMIT')
          return result
        } catch (err) {
          try {
            db.exec('ROLLBACK')
          } catch {
            // If ROLLBACK itself fails (e.g. connection already errored)
            // there is nothing useful to do — surface the original error.
          }
          throw err
        }
      }
    },
    close() {
      db.close()
    },
  }
}

function wrapStatement(stmt: StatementSync): Statement {
  return {
    run(...params) {
      const info = stmt.run(...(normaliseBindings(params) as never[]))
      return {
        changes:
          typeof info.changes === 'bigint' ? Number(info.changes) : info.changes,
        lastInsertRowid:
          typeof info.lastInsertRowid === 'bigint'
            ? Number(info.lastInsertRowid)
            : info.lastInsertRowid,
      }
    },
    get(...params) {
      const row = stmt.get(...(normaliseBindings(params) as never[]))
      if (row === undefined || row === null) return undefined
      return row as Record<string, unknown>
    },
    all(...params) {
      return stmt.all(
        ...(normaliseBindings(params) as never[]),
      ) as Record<string, unknown>[]
    },
    raw() {
      return {
        all(...params) {
          const rows = stmt.all(
            ...(normaliseBindings(params) as never[]),
          ) as Array<Record<string, unknown>>
          // Object key insertion order matches SELECT column order for
          // V8 + node:sqlite, so Object.values yields columns in order.
          return rows.map((row) => Object.values(row))
        },
      }
    },
    iterate(...params) {
      return stmt.iterate(
        ...(normaliseBindings(params) as never[]),
      ) as IterableIterator<Record<string, unknown>>
    },
  }
}

/**
 * Node 22's node:sqlite treats some zero-length Uint8Array inputs as
 * NULL when binding to a BLOB column — specifically the ones produced
 * by `TextEncoder.encode('')` or `new Uint8Array(emptyUint8Array)`,
 * while a freshly-constructed `new Uint8Array(0)` is accepted. This
 * looks like a Node/V8 quirk around empty-typed-array backing stores
 * and has not been tracked to a public issue yet.
 *
 * Workaround: swap any zero-length Uint8Array argument for a fresh
 * `new Uint8Array(0)`. Behavioural no-op; avoids a surprising NOT NULL
 * constraint failure for callers that store the empty string / byte
 * buffer in a BLOB column.
 */
function normaliseBindings(params: readonly unknown[]): readonly unknown[] {
  let needsCopy = false
  for (const p of params) {
    if (p instanceof Uint8Array && p.byteLength === 0) {
      needsCopy = true
      break
    }
  }
  if (!needsCopy) return params
  return params.map((p) => {
    if (p instanceof Uint8Array && p.byteLength === 0) return new Uint8Array(0)
    return p
  })
}
