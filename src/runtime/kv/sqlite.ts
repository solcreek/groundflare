/**
 * SQLite-backed KV adapter — the default Mirror-track KV implementation.
 *
 * Schema + rationale in design/config.md#kv-key-value:
 *   - `key` is the primary key (indexed range scans for prefix lists)
 *   - `value` is BLOB so we can store raw bytes up to 25 MiB
 *   - `metadata` is JSON text, sidecar to the value (like CF KV metadata)
 *   - `expires_at` is unix ms, partial-indexed for fast cleanup
 *
 * TTL policy: values older than `expires_at` are filtered on read and
 * swept by a periodic `cleanupExpired()` call that the runtime supervisor
 * fires every ~60 s. Callers can invoke `cleanupExpired()` directly in
 * tests to avoid depending on the sweeper timing.
 */

import type { Statement } from 'better-sqlite3'
import type { BetterSqlite3Database } from '../sqlite/node.js'
import { openSqlite } from '../sqlite/node.js'
import type { SqlitePreludeOptions } from '../sqlite/prelude.js'
import {
  normalizeGetOptions,
  type KVAdapter,
  type KVGetOptions,
  type KVGetType,
  type KVGetWithMetadataResult,
  type KVListKey,
  type KVListOptions,
  type KVListResult,
  type KVPutOptions,
  type KVValue,
} from './types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       BLOB NOT NULL,
  metadata    TEXT,
  expires_at  INTEGER
);

CREATE INDEX IF NOT EXISTS kv_expires
  ON kv(expires_at)
  WHERE expires_at IS NOT NULL;
`

const DEFAULT_LIST_LIMIT = 1000
const MAX_LIST_LIMIT = 1000

export interface SqliteKVAdapterOptions extends SqlitePreludeOptions {
  /**
   * Injectable clock for deterministic tests. Returns unix milliseconds.
   * Defaults to `Date.now`.
   */
  now?: () => number
}

export class SqliteKVAdapter implements KVAdapter {
  private readonly db: BetterSqlite3Database
  private readonly now: () => number
  private readonly ownsConnection: boolean

  private readonly stmtGet: Statement
  private readonly stmtPut: Statement
  private readonly stmtDelete: Statement
  private readonly stmtCleanup: Statement

  constructor(db: BetterSqlite3Database, opts: { now?: () => number; ownsConnection?: boolean } = {}) {
    this.db = db
    this.now = opts.now ?? Date.now
    this.ownsConnection = opts.ownsConnection ?? false
    db.exec(SCHEMA)

    this.stmtGet = db.prepare(
      'SELECT value, metadata, expires_at FROM kv WHERE key = ?',
    )
    this.stmtPut = db.prepare(
      'INSERT INTO kv(key, value, metadata, expires_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value=excluded.value, ' +
        'metadata=excluded.metadata, expires_at=excluded.expires_at',
    )
    this.stmtDelete = db.prepare('DELETE FROM kv WHERE key = ?')
    this.stmtCleanup = db.prepare(
      'DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?',
    )
  }

  /**
   * Open a new SQLite-backed KV adapter against the given file path.
   * The returned adapter owns the connection and closes it on `close()`.
   * Pass `:memory:` for test-only in-memory stores.
   */
  static open(path: string, opts: SqliteKVAdapterOptions = {}): SqliteKVAdapter {
    const db = openSqlite(path, opts)
    return new SqliteKVAdapter(db, { now: opts.now, ownsConnection: true })
  }

  close(): void {
    if (this.ownsConnection) this.db.close()
  }

  async get(key: string, options?: KVGetType | KVGetOptions): Promise<unknown> {
    const row = this.readRow(key)
    if (!row) return null
    return decode(row.value, normalizeGetOptions(options).type)
  }

  async getWithMetadata<M = unknown>(
    key: string,
    options?: KVGetType | KVGetOptions,
  ): Promise<KVGetWithMetadataResult<unknown, M>> {
    const row = this.readRow(key)
    if (!row) return { value: null, metadata: null }
    return {
      value: decode(row.value, normalizeGetOptions(options).type),
      metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as M),
    }
  }

  async put(key: string, value: KVValue, options: KVPutOptions = {}): Promise<void> {
    if (options.expirationTtl !== undefined && options.expiration !== undefined) {
      throw new TypeError(
        'KV put: provide either expirationTtl or expiration, not both',
      )
    }

    const expiresAt = computeExpiresAt(options, this.now)
    const bytes = toBytes(value)
    const metadata =
      options.metadata === undefined ? null : JSON.stringify(options.metadata)

    this.stmtPut.run(key, bytes, metadata, expiresAt)
  }

  async delete(key: string): Promise<void> {
    this.stmtDelete.run(key)
  }

  async list<M = unknown>(options: KVListOptions = {}): Promise<KVListResult<M>> {
    const prefix = options.prefix ?? ''
    const limit = clampLimit(options.limit ?? DEFAULT_LIST_LIMIT)
    const cursor = options.cursor
    const nowMs = this.now()

    // Fetch one extra row beyond `limit` to detect whether there's more
    // data; we don't return the sentinel to the caller.
    const parts: string[] = [
      'SELECT key, expires_at, metadata FROM kv WHERE',
      '(expires_at IS NULL OR expires_at > ?)',
    ]
    const params: unknown[] = [nowMs]

    if (cursor) {
      parts.push('AND key > ?')
      params.push(decodeCursor(cursor))
    }

    if (prefix) {
      const upper = upperBoundFor(prefix)
      if (upper === null) {
        parts.push('AND key >= ?')
        params.push(prefix)
      } else {
        parts.push('AND key >= ? AND key < ?')
        params.push(prefix, upper)
      }
    }

    parts.push('ORDER BY key LIMIT ?')
    params.push(limit + 1)

    const rows = this.db.prepare(parts.join(' ')).all(...params) as Array<{
      key: string
      expires_at: number | null
      metadata: string | null
    }>

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    const keys: KVListKey<M>[] = page.map((row) => {
      const k: KVListKey<M> = { name: row.key }
      if (row.expires_at !== null) k.expiration = Math.floor(row.expires_at / 1000)
      if (row.metadata !== null) k.metadata = JSON.parse(row.metadata) as M
      return k
    })

    const result: KVListResult<M> = {
      keys,
      list_complete: !hasMore,
    }
    if (hasMore) result.cursor = encodeCursor(page[page.length - 1]!.key)
    return result
  }

  /**
   * Sweep expired rows. Safe to call concurrently with reads (WAL) and
   * cheap thanks to the partial index on `expires_at`. Intended to run
   * from a periodic task in the runtime supervisor.
   */
  cleanupExpired(): number {
    const info = this.stmtCleanup.run(this.now())
    return Number(info.changes)
  }

  private readRow(key: string):
    | { value: Buffer | Uint8Array; metadata: string | null; expires_at: number | null }
    | null {
    const row = this.stmtGet.get(key) as
      | { value: Buffer | Uint8Array; metadata: string | null; expires_at: number | null }
      | undefined
    if (!row) return null
    if (row.expires_at !== null && row.expires_at <= this.now()) return null
    return row
  }
}

// ─── internals ─────────────────────────────────────────────────────

function computeExpiresAt(options: KVPutOptions, now: () => number): number | null {
  if (options.expirationTtl !== undefined) {
    if (options.expirationTtl <= 0) {
      throw new RangeError('KV put: expirationTtl must be > 0 seconds')
    }
    return now() + options.expirationTtl * 1000
  }
  if (options.expiration !== undefined) {
    if (options.expiration <= 0) {
      throw new RangeError('KV put: expiration must be a positive unix seconds value')
    }
    return options.expiration * 1000
  }
  return null
}

function toBytes(value: KVValue): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new TypeError('KV put: unsupported value type')
}

function decode(
  bytes: Buffer | Uint8Array,
  type: KVGetType,
): string | ArrayBuffer | unknown {
  switch (type) {
    case 'arrayBuffer':
      return copyToArrayBuffer(bytes)
    case 'text':
      return new TextDecoder().decode(bytes)
    case 'json':
      return JSON.parse(new TextDecoder().decode(bytes))
  }
}

function copyToArrayBuffer(view: Buffer | Uint8Array): ArrayBuffer {
  // Buffer might be a view over a shared pool — always return a freshly
  // owned ArrayBuffer so the caller can mutate / transfer safely.
  const copy = new Uint8Array(view.byteLength)
  copy.set(view)
  return copy.buffer
}

function clampLimit(raw: number): number {
  const n = Math.floor(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT
  return Math.min(n, MAX_LIST_LIMIT)
}

/**
 * Return the smallest string strictly greater than every string starting
 * with `prefix`. Used as the exclusive upper bound for indexed range scans.
 *
 * Returns `null` when no such string exists — e.g. a prefix that's purely
 * the maximum codepoint U+10FFFF. In that case the caller falls back to an
 * unbounded-upper scan (acceptable; vanishingly rare in practice).
 */
export function upperBoundFor(prefix: string): string | null {
  if (prefix.length === 0) return null
  const lastIdx = prefix.length - 1
  const lastCode = prefix.codePointAt(lastIdx) ?? 0
  if (lastCode >= 0x10ffff) return null
  return prefix.slice(0, lastIdx) + String.fromCodePoint(lastCode + 1)
}

function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf-8').toString('base64url')
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf-8')
}
