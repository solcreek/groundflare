/**
 * Node.js driver binding for the SQLite prelude, using better-sqlite3.
 *
 * The Node-side is used by:
 *   - Tier 1 unit tests (this file's tests)
 *   - Tier 2 conformance tests (opens the adapter-produced SQLite file
 *     after the adapter has written to it, verifies expected rows)
 *   - CLI-side tooling that needs to inspect or migrate SQLite files
 *     (e.g. `groundflare migrate-kv`, backup helpers)
 *
 * Production runtime adapters run inside workerd or Bun and use their
 * respective SQLite drivers. They share the same prelude.ts statements
 * but apply them through their own `.exec()` / `.pragma()` equivalents.
 */

import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
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

export type { BetterSqlite3Database }

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
  const db = new Database(path)
  applyPrelude(db, opts)
  return db
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
