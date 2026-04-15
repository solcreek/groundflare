/**
 * Cloudflare Workers KV binding API (subset implemented in v0.1).
 *
 * Mirrors the shape in @cloudflare/workers-types so a Worker calling
 * env.MY_KV.get(...) behaves identically regardless of whether the
 * binding resolves to real CF KV (edge), the workerd-side SQLite
 * adapter (Mirror track), or the Bun-side bun:sqlite adapter
 * (Bun track).
 *
 * Stream values and the `cacheTtl` CF edge cache are out of scope
 * for v0.1. Large values up to 25 MiB are supported.
 */

export type KVGetType = 'text' | 'json' | 'arrayBuffer'

export interface KVGetOptions {
  type?: KVGetType
  /**
   * CF edge cache hint (seconds). Accepted for API parity but ignored
   * by local adapters — there is no multi-POP cache to warm.
   */
  cacheTtl?: number
}

export interface KVPutOptions {
  /**
   * Seconds from now until the key expires. Mutually exclusive with
   * `expiration`. CF requires a minimum of 60s; local adapters
   * accept smaller values for testing convenience.
   */
  expirationTtl?: number

  /**
   * Absolute unix timestamp (seconds) at which the key should expire.
   * Mutually exclusive with `expirationTtl`.
   */
  expiration?: number

  /**
   * Arbitrary JSON-serializable metadata stored alongside the value.
   * Returned intact via `getWithMetadata()` and in `list()` results.
   */
  metadata?: unknown
}

export interface KVListOptions {
  /** Only keys starting with this prefix are returned. */
  prefix?: string

  /** Maximum keys per page. CF default 1000, we follow suit. */
  limit?: number

  /** Opaque pagination cursor from a previous list() call. */
  cursor?: string
}

export interface KVListKey<M = unknown> {
  name: string
  /** Unix seconds if the key has a TTL; absent otherwise. */
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

/**
 * The stable interface all KV adapter implementations satisfy. The
 * conformance suite in test/conformance/kv.test.ts runs against any
 * object matching this type, so Mirror/Bun/test adapters stay in lock-step.
 */
export interface KVAdapter {
  get(key: string, options?: KVGetType | KVGetOptions): Promise<string | ArrayBuffer | unknown | null>

  getWithMetadata<M = unknown>(
    key: string,
    options?: KVGetType | KVGetOptions,
  ): Promise<KVGetWithMetadataResult<string | ArrayBuffer | unknown, M>>

  put(key: string, value: KVValue, options?: KVPutOptions): Promise<void>

  delete(key: string): Promise<void>

  list<M = unknown>(options?: KVListOptions): Promise<KVListResult<M>>
}

// ─── internal helper types (not exposed via index) ─────────────────

export interface NormalizedGetOptions {
  type: KVGetType
}

export function normalizeGetOptions(
  options?: KVGetType | KVGetOptions,
): NormalizedGetOptions {
  if (options === undefined) return { type: 'text' }
  if (typeof options === 'string') return { type: options }
  return { type: options.type ?? 'text' }
}
