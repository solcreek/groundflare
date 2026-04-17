// Types describing the user-visible config surface: everything
// expressed in wrangler.toml + [groundflare] extensions. Kept as
// plain data interfaces so they can be consumed from both runtime
// code (adapters, capnp generator) and CLI commands.

export type ProviderName = 'hetzner' | 'digitalocean' | 'linode' | 'vultr'

export type RuntimeKind = 'workerd' | 'bun'

export type VarValue = string | number | boolean

export interface WranglerD1Database {
  binding: string
  database_name: string
  database_id?: string
}

export interface WranglerKVNamespace {
  binding: string
  id: string
}

export interface WranglerR2Bucket {
  binding: string
  bucket_name: string
  /**
   * groundflare-specific R2 backend override. Native CF deploys ignore
   * this block; on a self-hosted VPS it picks the S3-compatible backend
   * the adapter routes to.
   *
   * Default (no `groundflare` block): the local SeaweedFS sidecar at
   * http://127.0.0.1:8333 in anonymous mode.
   *
   * With overrides: the adapter signs every request with SigV4 using
   * credentials resolved from the named secrets. Common targets:
   *   - Backblaze B2 (s3.<region>.backblazeb2.com)
   *   - Wasabi (s3.<region>.wasabisys.com)
   *   - real Cloudflare R2 (<account>.r2.cloudflarestorage.com)
   *   - any other S3-compatible store
   *
   * Both `access_key_id_secret` and `secret_access_key_secret` must be
   * set together — config validation rejects mixed presence.
   */
  groundflare?: {
    /** Endpoint URL with no trailing slash. */
    endpoint?: string
    /** AWS region. Default 'us-east-1' (SeaweedFS-compatible). */
    region?: string
    /** Name of the secret in `groundflare secret put` holding the access key id. */
    access_key_id_secret?: string
    /** Name of the secret holding the secret access key. */
    secret_access_key_secret?: string
  }
}

export interface WranglerDOBinding {
  name: string
  class_name: string
  script_name?: string
}

export interface WranglerDurableObjects {
  bindings?: WranglerDOBinding[]
}

export interface WranglerMigration {
  tag: string
  new_sqlite_classes?: string[]
  new_classes?: string[]
  renamed_classes?: { from: string; to: string }[]
  deleted_classes?: string[]
}

export interface WranglerTriggers {
  crons?: string[]
}

export interface WranglerRoute {
  /** Domain or path pattern, e.g. "shop.example.com" or "example.com/*". */
  pattern: string
  /** When true, this is a Custom Domain (all paths → Worker). */
  custom_domain?: boolean
  /** Zone ID (only for zone-scoped routes, ignored by groundflare). */
  zone_id?: string
  /** Zone name (only for zone-scoped routes, ignored by groundflare). */
  zone_name?: string
}

export interface WranglerWorkerLoader {
  binding: string
  /** emdash calls this field `name` in its config; we accept both. */
  name?: string
}

export interface WranglerBuild {
  /** Shell command to run before deploying. Same semantics as wrangler's
   *  `[build].command`: runs in sh on Linux/macOS, cmd on Windows.
   *  When set, groundflare executes this instead of its own esbuild
   *  bundler and reads the built output from `main`. */
  command?: string
  /** Working directory for the build command. Default: wrangler config dir. */
  cwd?: string
  /** Directory to watch for changes during `groundflare dev` (future). */
  watch_dir?: string | string[]
}

export interface WranglerAssets {
  /** Directory containing static files to serve alongside the Worker. */
  directory?: string
  /** Binding name exposed to the Worker as env.ASSETS. */
  binding?: string
}

export interface WranglerConfig {
  name: string
  main?: string
  compatibility_date?: string
  compatibility_flags?: string[]
  /**
   * Routes including Custom Domains. groundflare reads entries where
   * `custom_domain: true` and uses their `pattern` as the tenant's
   * domain — same semantics as `[groundflare].domain` but using
   * wrangler's native syntax so existing configs work unchanged.
   *
   * Accepts both array-of-objects (`[[routes]]`) and string shorthand.
   */
  routes?: Array<WranglerRoute | string>
  build?: WranglerBuild
  assets?: WranglerAssets
  vars?: Record<string, VarValue>
  d1_databases?: WranglerD1Database[]
  kv_namespaces?: WranglerKVNamespace[]
  r2_buckets?: WranglerR2Bucket[]
  durable_objects?: WranglerDurableObjects
  worker_loaders?: WranglerWorkerLoader[]
  migrations?: WranglerMigration[]
  triggers?: WranglerTriggers
  /** Observability config (CF-specific, ignored by groundflare). */
  observability?: unknown
  /** Catch-all for known-unsupported binding sections. */
  ai?: unknown
  vectorize?: unknown
  browser?: unknown
  queues?: unknown
  hyperdrive?: unknown
  analytics_engine_datasets?: unknown
  send_email?: unknown
}

// ─── Groundflare extensions ────────────────────────────────────────

export type KVAdapter = 'sqlite' | 'redis' | 'memory'
export type D1Adapter = 'libsql' | 'sqlite' | 'postgres'
export type R2Adapter = 'passthrough' | 's3'
export type R2Backend = 'seaweedfs' | 'rustfs' | 'aws-s3' | 'b2' | 'custom'
export type QueueAdapter = 'sqlite' | 'redis-streams'

export interface GroundflareBindingConfig {
  adapter?: KVAdapter | D1Adapter | R2Adapter
  backend?: R2Backend
  path?: string
  url?: string
  endpoint?: string
}

export interface GroundflareRuntimeLimits {
  memory_mb?: number
  cpu_pct?: number
}

export interface GroundflareObservabilityAlerts {
  email?: string
  webhook?: string
}

export interface GroundflareObservability {
  metrics?: 'prometheus' | 'none'
  logs?: 'json' | 'text'
  alerts?: GroundflareObservabilityAlerts
}

export interface GroundflareSection {
  provider?: ProviderName
  region?: string
  size?: string
  domain?: string
  email?: string
  backup?: string
  runtime?: RuntimeKind
  bindings?: Record<string, GroundflareBindingConfig>
  limits?: GroundflareRuntimeLimits
  observability?: GroundflareObservability
  env?: Record<string, Omit<GroundflareSection, 'env'>>
}

// ─── Config file I/O ───────────────────────────────────────────────

export type ConfigFormat = 'toml' | 'jsonc' | 'json'

export interface ConfigSource {
  file: string
  format: ConfigFormat
}

export interface ReadConfigResult {
  wrangler: WranglerConfig
  groundflare: GroundflareSection
  source: ConfigSource
}
