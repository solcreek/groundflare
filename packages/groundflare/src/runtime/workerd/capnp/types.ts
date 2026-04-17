/**
 * Data model for a workerd capnp configuration.
 *
 * Mirrors the subset of `workerd.capnp` (the upstream schema) that
 * groundflare v0.1 emits. Renderer at src/runtime/workerd/capnp/render.ts
 * serializes this to capnp text; consumers build these objects from
 * wrangler.toml + [groundflare] + workspace.toml (future commit).
 *
 * Shape rules:
 *   - All fields are readonly; the generator never mutates its input.
 *   - Discriminated unions use a `kind` string — exhaustive switches in
 *     the renderer keep the grammar honest.
 *   - Strings stored unescaped; renderer handles quoting.
 *   - `embedPath` values are relative to the capnp file's directory;
 *     workerd resolves them at load time.
 */

// ─── Bindings ──────────────────────────────────────────────────────

export type CapnpBinding =
  | CapnpTextBinding
  | CapnpJsonBinding
  | CapnpDataBinding
  | CapnpServiceBinding
  | CapnpKvNamespaceBinding
  | CapnpD1DatabaseBinding
  | CapnpR2BucketBinding
  | CapnpDurableObjectNamespaceBinding
  | CapnpFromEnvironmentBinding
  | CapnpWorkerLoaderBinding

export interface CapnpTextBinding {
  readonly name: string
  readonly kind: 'text'
  readonly value: string
}

export interface CapnpJsonBinding {
  readonly name: string
  readonly kind: 'json'
  /** Pre-stringified JSON; emitted verbatim wrapped in a string literal. */
  readonly value: string
}

export interface CapnpDataBinding {
  readonly name: string
  readonly kind: 'data'
  readonly value: Uint8Array
}

export interface CapnpServiceBinding {
  readonly name: string
  readonly kind: 'service'
  /** Target service name in the same config. */
  readonly service: string
}

export interface CapnpKvNamespaceBinding {
  readonly name: string
  readonly kind: 'kvNamespace'
  readonly service: string
}

export interface CapnpD1DatabaseBinding {
  readonly name: string
  readonly kind: 'd1Database'
  readonly service: string
}

export interface CapnpR2BucketBinding {
  readonly name: string
  readonly kind: 'r2Bucket'
  readonly service: string
}

export interface CapnpDurableObjectNamespaceBinding {
  readonly name: string
  readonly kind: 'durableObjectNamespace'
  readonly className: string
  /** Cross-worker DO (other service exports the class). Omit for same-worker. */
  readonly serviceName?: string
}

/**
 * `fromEnvironment` reads a secret from a process environment variable
 * at workerd startup. Used for R2 SigV4 credentials so the plaintext
 * never lives in the capnp file on disk — if the VPS image is ever
 * leaked, the config is inert.
 *
 * The full pipeline:
 *
 *   1. wrangler.toml declares the binding with a secret-name pointer,
 *      e.g. `[r2_buckets.groundflare] access_key_id_secret =
 *      "R2_ACCESS_KEY_ID"`.
 *   2. `from-config.ts` lifts those names into the workspace manifest.
 *   3. At deploy time, `run.ts` resolves the actual secret values from
 *      the operator's secret store (FileSecretStore by default) and
 *      writes `KEY=value` lines to `/etc/groundflare/environment`.
 *   4. The workerd systemd unit pulls that file in via
 *      `EnvironmentFile=/etc/groundflare/environment`, so the variable
 *      lands in workerd's process environment.
 *   5. workerd sees `fromEnvironment = "R2_ACCESS_KEY_ID"` in the capnp
 *      and looks up the value in its own env at bind time.
 *   6. The Worker sees `env.R2_ACCESS_KEY_ID` with the value.
 *
 * Rotation: update the secret store, redeploy. `run.ts` rewrites the
 * EnvironmentFile and `systemctl restart groundflare-worker` picks up
 * the new values.
 */
export interface CapnpFromEnvironmentBinding {
  readonly name: string
  readonly kind: 'fromEnvironment'
  /** Process env var name (NOT the secret value) to read at workerd start. */
  readonly envVar: string
}

/**
 * WorkerLoader binding — enables dynamic loading of Workers from code
 * provided at runtime. Each loaded Worker runs in its own V8 isolate
 * with optional resource limits, providing real sandboxing.
 *
 * Capnp: `(name = "loader", workerLoader = ())`
 *   or:  `(name = "loader", workerLoader = (id = "shared"))`
 *
 * See: workerd.capnp @450-464, api/worker-loader.h
 */
export interface CapnpWorkerLoaderBinding {
  readonly name: string
  readonly kind: 'workerLoader'
  /**
   * Optional cache ID. Multiple bindings with the same `id` share a
   * worker cache (same name → same isolate). Omit for isolated cache.
   */
  readonly id?: string
}

// ─── Modules ───────────────────────────────────────────────────────

export type CapnpModuleSource =
  | { readonly kind: 'esModule'; readonly embedPath: string }
  | { readonly kind: 'esModule'; readonly inline: string }
  | { readonly kind: 'commonJsModule'; readonly embedPath: string }
  | { readonly kind: 'text'; readonly embedPath: string }
  | { readonly kind: 'data'; readonly embedPath: string }
  | { readonly kind: 'json'; readonly embedPath: string }

export interface CapnpModule {
  readonly name: string
  readonly source: CapnpModuleSource
}

// ─── Durable Objects ───────────────────────────────────────────────

export interface CapnpDurableObjectNamespaceDecl {
  readonly className: string
  readonly uniqueKey?: string
  readonly enableSql?: boolean
}

// ─── Workers ───────────────────────────────────────────────────────

export interface CapnpWorker {
  readonly modules: readonly CapnpModule[]
  readonly compatibilityDate?: string
  readonly compatibilityFlags?: readonly string[]
  readonly bindings?: readonly CapnpBinding[]
  readonly durableObjectNamespaces?: readonly CapnpDurableObjectNamespaceDecl[]
  /**
   * DO storage backend. `inMemory` is ephemeral (per-process) and useful
   * for tests; `localDisk` refers to a sibling disk service by name (not
   * a direct filesystem path — workerd's kj::Path rejects absolute paths
   * in disk services anyway).
   */
  readonly durableObjectStorage?:
    | { readonly inMemory: true }
    | { readonly localDiskPath: string }
  readonly globalOutbound?: string
}

// ─── Services ──────────────────────────────────────────────────────

export type CapnpService =
  | { readonly name: string; readonly kind: 'worker'; readonly worker: CapnpWorker }
  | {
      readonly name: string
      readonly kind: 'external'
      readonly address: string
      readonly http?: boolean
    }
  | {
      readonly name: string
      readonly kind: 'disk'
      readonly path: string
      readonly writable?: boolean
    }
  | {
      readonly name: string
      readonly kind: 'network'
      /**
       * Hostname allowlist categories for outbound fetches. Defaults to
       * empty (`network = ()`) which matches workerd's permissive default.
       * R2 adapter uses `["public", "private"]` so it can reach both
       * the local SeaweedFS sidecar (private 127.0.0.1) and remote
       * S3-compatible endpoints (public).
       */
      readonly allow?: readonly string[]
    }

// ─── Sockets ───────────────────────────────────────────────────────

export interface CapnpSocket {
  readonly name: string
  readonly address: string
  readonly service: string
  readonly protocol?: 'http' | 'https'
}

// ─── Top-level config ──────────────────────────────────────────────

export interface CapnpWorkerdConfig {
  readonly services: readonly CapnpService[]
  readonly sockets: readonly CapnpSocket[]
}
