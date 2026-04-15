/**
 * Bun-runtime KV adapter — implements the Cloudflare Workers KV surface
 * backed by `bun:sqlite`. Ships as source to the VPS; server.ts (emitted
 * by generateBunShim) imports from this file at deploy time.
 *
 * Behavioural parity targets:
 *   - src/runtime/kv/sqlite.ts (Node-side, better-sqlite3 driver)
 *   - src/runtime/kv/adapter-module.ts KV_ADAPTER_DO_SOURCE (workerd DO)
 * All three must observe the same visible semantics for the same inputs.
 * Conformance suite in test/bun/adapters/kv.test.ts exercises the Bun
 * surface directly against `bun:sqlite`; test/conformance/kv.test.ts
 * exercises the Node surface with vitest; test/integration/kv-binding.*
 * exercises the workerd DO via a real workerd subprocess.
 *
 * Schema + PRAGMA prelude intentionally match the Node-side adapter
 * byte-for-byte — a file written by one adapter must be readable by the
 * other without migration.
 */

import { Database, type Statement } from 'bun:sqlite'

// ─── types (mirror the Cloudflare Workers KV API) ─────────────────

export type KVGetType = 'text' | 'json' | 'arrayBuffer'

export interface KVGetOptions {
  type?: KVGetType
  /** Accepted for parity with CF's edge cache; ignored by this adapter. */
  cacheTtl?: number
}

export interface KVPutOptions {
  expirationTtl?: number
  expiration?: number
  metadata?: unknown
}

export interface KVListOptions {
  prefix?: string
  limit?: number
  cursor?: string
}

export interface KVListKey<M = unknown> {
  name: string
  expiration?: number
  metadata?: M
}

export interface KVListResult<M = unknown> {
  keys: KVListKey<M>[]
  list_complete: boolean
  cursor?: string
}

export interface KVGetWithMetadataResult<V, M> {
  value: V | null
  metadata: M | null
}

export type KVValue = string | ArrayBuffer | ArrayBufferView | Uint8Array

// ─── schema + pragma prelude ──────────────────────────────────────

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

const DEFAULT_LIST_LIMIT = 1000
const MAX_LIST_LIMIT = 1000

// ─── adapter class ────────────────────────────────────────────────

export interface BunKVAdapterOptions {
  /** Injectable clock (returns unix ms). Default Date.now. */
  now?: () => number
}

export class BunKVAdapter {
  private readonly db: Database
  private readonly now: () => number
  private readonly ownsConnection: boolean

  private readonly stmtGet: Statement
  private readonly stmtPut: Statement
  private readonly stmtDelete: Statement
  private readonly stmtCleanup: Statement

  constructor(
    db: Database,
    opts: { now?: () => number; ownsConnection?: boolean } = {},
  ) {
    this.db = db
    this.now = opts.now ?? Date.now
    this.ownsConnection = opts.ownsConnection ?? false

    for (const stmt of PRAGMA_PRELUDE) db.exec(stmt)
    db.exec(SCHEMA)

    this.stmtGet = db.query(
      'SELECT value, metadata, expires_at FROM kv WHERE key = ?',
    )
    this.stmtPut = db.query(
      'INSERT INTO kv(key, value, metadata, expires_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value=excluded.value, ' +
        'metadata=excluded.metadata, expires_at=excluded.expires_at',
    )
    this.stmtDelete = db.query('DELETE FROM kv WHERE key = ?')
    this.stmtCleanup = db.query(
      'DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?',
    )
  }

  /**
   * Open a KV adapter backed by a SQLite file. Creates the file if it
   * does not exist. Pass ":memory:" for an ephemeral test database.
   */
  static open(path: string, opts: BunKVAdapterOptions = {}): BunKVAdapter {
    const db = new Database(path, { create: true })
    return new BunKVAdapter(db, { now: opts.now, ownsConnection: true })
  }

  close(): void {
    if (this.ownsConnection) this.db.close()
  }

  async get(
    key: string,
    options?: KVGetType | KVGetOptions,
  ): Promise<string | ArrayBuffer | unknown | null> {
    const row = this.readRow(key)
    if (!row) return null
    return decode(row.value, normalizeType(options))
  }

  async getWithMetadata<M = unknown>(
    key: string,
    options?: KVGetType | KVGetOptions,
  ): Promise<KVGetWithMetadataResult<unknown, M>> {
    const row = this.readRow(key)
    if (!row) return { value: null, metadata: null }
    return {
      value: decode(row.value, normalizeType(options)),
      metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as M),
    }
  }

  async put(
    key: string,
    value: KVValue,
    options: KVPutOptions = {},
  ): Promise<void> {
    if (
      options.expirationTtl !== undefined &&
      options.expiration !== undefined
    ) {
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

  async list<M = unknown>(
    options: KVListOptions = {},
  ): Promise<KVListResult<M>> {
    const prefix = options.prefix ?? ''
    const limit = clampLimit(options.limit ?? DEFAULT_LIST_LIMIT)
    const cursor = options.cursor
    const nowMs = this.now()

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

    const rows = this.db.query(parts.join(' ')).all(...params) as Array<{
      key: string
      expires_at: number | null
      metadata: string | null
    }>

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    const keys: KVListKey<M>[] = page.map((row) => {
      const k: KVListKey<M> = { name: row.key }
      if (row.expires_at !== null) {
        k.expiration = Math.floor(row.expires_at / 1000)
      }
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

  /** Periodic sweep of expired rows. Cheap: uses the partial index. */
  cleanupExpired(): number {
    const info = this.stmtCleanup.run(this.now())
    return Number(info.changes)
  }

  private readRow(key: string):
    | { value: Uint8Array; metadata: string | null; expires_at: number | null }
    | null {
    const row = this.stmtGet.get(key) as
      | { value: Uint8Array; metadata: string | null; expires_at: number | null }
      | null
    if (!row) return null
    if (row.expires_at !== null && row.expires_at <= this.now()) return null
    return row
  }
}

// ─── helpers (mirrored from src/runtime/kv/sqlite.ts) ─────────────

function normalizeType(options?: KVGetType | KVGetOptions): KVGetType {
  if (options === undefined) return 'text'
  if (typeof options === 'string') return options
  return options.type ?? 'text'
}

function computeExpiresAt(
  options: KVPutOptions,
  now: () => number,
): number | null {
  if (options.expirationTtl !== undefined) {
    if (options.expirationTtl <= 0) {
      throw new RangeError('KV put: expirationTtl must be > 0 seconds')
    }
    return now() + options.expirationTtl * 1000
  }
  if (options.expiration !== undefined) {
    if (options.expiration <= 0) {
      throw new RangeError(
        'KV put: expiration must be a positive unix seconds value',
      )
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
  bytes: Uint8Array,
  type: KVGetType,
): string | ArrayBuffer | unknown {
  switch (type) {
    case 'arrayBuffer': {
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      return copy.buffer
    }
    case 'text':
      return new TextDecoder().decode(bytes)
    case 'json':
      return JSON.parse(new TextDecoder().decode(bytes))
  }
}

function clampLimit(raw: number): number {
  const n = Math.floor(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT
  return Math.min(n, MAX_LIST_LIMIT)
}

/** Smallest string strictly greater than any string starting with prefix. */
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
