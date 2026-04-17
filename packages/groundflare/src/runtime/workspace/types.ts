/**
 * Workspace manifest — the canonical description of every Worker running
 * on a single VPS. Built by the CLI from each tenant's wrangler.toml and
 * shipped to the VPS where buildCapnpFromWorkspace() turns it into a
 * workerd config.
 *
 * Per design/workspaces.md:
 *   - One workspace == one VPS == one workerd process.
 *   - Each Worker's state lives at /var/lib/groundflare/workers/<name>/.
 *   - Workers without a domain are reachable only via service bindings.
 *   - Worker names must be unique within the workspace; domains too.
 */

export type VarValue = string | number | boolean

export interface WorkspaceManifest {
  readonly name: string
  readonly workers: readonly WorkspaceWorker[]
  readonly defaults?: WorkspaceDefaults

  /**
   * Runtime track for this workspace (see design/tracks.md):
   *   - "workerd": Mirror track — `buildCapnpFromWorkspace()` produces
   *     the capnp config workerd reads. Zero code changes to the user's
   *     Worker; full Cloudflare Workers semantics including Durable
   *     Objects. Default — matches all workspaces written before the
   *     Bun track existed.
   *   - "bun": Bun track — `buildBunArtifact()` produces the server.ts
   *     + systemd unit Bun executes. 10–50× per-binding throughput at
   *     the cost of a one-time LLM-assisted code migration
   *     (`groundflare bun prepare`, Phase 3). Durable Objects not yet
   *     supported on this track.
   *
   * The CLI dispatches to the appropriate build function based on this
   * field; changing it on a populated workspace requires explicit
   * migration (documented per-track).
   */
  readonly runtime?: 'workerd' | 'bun'
}

export interface WorkspaceDefaults {
  readonly compatibilityDate?: string
  readonly compatibilityFlags?: readonly string[]
}

export interface WorkspaceWorker {
  readonly name: string

  /**
   * Primary Host header for router dispatch. If omitted, the Worker is
   * reachable only via service bindings from other Workers.
   */
  readonly domain?: string

  /**
   * Filesystem path passed to capnp's `embed`. Relative to the capnp
   * file's directory on the VPS — typically
   * `workers/<name>/code/current/index.js`.
   */
  readonly entryPath: string

  readonly compatibilityDate?: string
  readonly compatibilityFlags?: readonly string[]

  /** Inline env vars — emitted as text (strings) or json (numbers/booleans). */
  readonly vars?: Record<string, VarValue>

  readonly kvNamespaces?: readonly KvBindingSpec[]
  readonly d1Databases?: readonly D1BindingSpec[]
  readonly r2Buckets?: readonly R2BindingSpec[]
  readonly durableObjects?: readonly DOBindingSpec[]

  /** Cross-tenant service bindings. The `service` must be a worker name in the same workspace. */
  readonly serviceBindings?: readonly ServiceBindingSpec[]

  /**
   * WorkerLoader bindings for dynamic worker loading. Each creates a
   * binding that can compile + run arbitrary Worker code in an isolated
   * V8 isolate at runtime (plugin sandboxing for apps like emdash).
   */
  readonly workerLoaders?: readonly WorkerLoaderSpec[]
}

export interface WorkerLoaderSpec {
  readonly binding: string
  /** Optional cache ID — bindings sharing the same ID share a worker cache. */
  readonly id?: string
}

export interface KvBindingSpec {
  readonly binding: string

  /**
   * Shard count for this binding. Traffic is distributed across N
   * Durable Object instances (same class, different `idFromName` seeds)
   * so write throughput scales linearly with N. See design/kv-sharding.md.
   *
   * Default: 1 (single DO, backwards-compatible). Recommended for
   * HN-burst-resistant bindings: 4. Cannot be changed on a populated
   * binding without explicit migration (v0.3+).
   */
  readonly shards?: number
}

export interface D1BindingSpec {
  readonly binding: string
  readonly databaseName: string
}

export interface R2BindingSpec {
  readonly binding: string
  /** S3 bucket name. Defaults to `binding.toLowerCase()` when omitted. */
  readonly bucketName?: string
  /**
   * Endpoint URL the adapter routes S3 traffic to. Default
   * 'http://127.0.0.1:8333' (the local SeaweedFS sidecar). Override
   * for hybrid deployments (B2, Wasabi, real R2, MinIO, etc.).
   */
  readonly endpoint?: string
  /** AWS region. Default 'us-east-1'. */
  readonly region?: string
  /**
   * SigV4 access key id. When undefined, the adapter sends unsigned
   * requests — only sane for the local anonymous SeaweedFS default.
   * Resolved from a secret store at deploy time.
   */
  readonly accessKeyId?: string
  /** Paired secret access key. Required when accessKeyId is set. */
  readonly secretAccessKey?: string
}

export interface DOBindingSpec {
  readonly binding: string
  readonly className: string
  /** When set, the DO class lives in another Worker's script. Usually unset (same-worker DOs). */
  readonly scriptName?: string
}

export interface ServiceBindingSpec {
  readonly binding: string
  readonly service: string
}
