/**
 * Convert a resolved wrangler config into a WorkspaceWorker entry for
 * the workspace manifest. The tenant-side capnp generator
 * (buildCapnpFromWorkspace) and the deploy pipeline both consume
 * WorkspaceManifests, so this is the single bridge from user-authored
 * wrangler.toml semantics to groundflare's internal shape.
 *
 * Notes on the mapping:
 *   - entryPath is rewritten to the deployed layout
 *     (`workers/<name>/code/current/<main>`), NOT kept as the user's
 *     local filesystem path — the capnp embed paths are resolved on the
 *     VPS, and the deploy flow lays out files under that prefix.
 *   - Scalar vars (string/number/boolean) are passed through; anything
 *     else would need a different binding kind and is rejected.
 *   - Compatibility_date / compatibility_flags flow through unchanged
 *     so downstream capnp generation picks them up.
 */

import type {
  GroundflareSection,
  VarValue as ConfigVarValue,
  WranglerConfig,
} from '../../config/index.js'
import type { WorkspaceWorker, WorkerLoaderSpec } from './types.js'

export interface FromConfigOptions {
  /**
   * Override the entry module filename used in the on-VPS layout.
   * Default: the `main` field from wrangler.toml (converted to a
   * bundle-friendly `index.js` by the deploy step).
   */
  readonly deployedEntryName?: string
}

export function workspaceWorkerFromConfig(
  wrangler: WranglerConfig,
  groundflare: GroundflareSection,
  opts: FromConfigOptions = {},
): WorkspaceWorker {
  const entryName = opts.deployedEntryName ?? 'index.js'
  const worker: Mutable<WorkspaceWorker> = {
    name: wrangler.name,
    entryPath: `workers/${wrangler.name}/code/current/${entryName}`,
  }

  if (groundflare.domain !== undefined) worker.domain = groundflare.domain
  if (wrangler.compatibility_date !== undefined) {
    worker.compatibilityDate = wrangler.compatibility_date
  }
  if (wrangler.compatibility_flags !== undefined) {
    worker.compatibilityFlags = wrangler.compatibility_flags
  }

  if (wrangler.vars !== undefined && Object.keys(wrangler.vars).length > 0) {
    worker.vars = mapVars(wrangler.vars)
  }

  if (wrangler.kv_namespaces && wrangler.kv_namespaces.length > 0) {
    worker.kvNamespaces = wrangler.kv_namespaces.map((kv) => ({ binding: kv.binding }))
  }

  if (wrangler.d1_databases && wrangler.d1_databases.length > 0) {
    worker.d1Databases = wrangler.d1_databases.map((d1) => ({
      binding: d1.binding,
      databaseName: d1.database_name,
    }))
  }

  if (wrangler.r2_buckets && wrangler.r2_buckets.length > 0) {
    worker.r2Buckets = wrangler.r2_buckets.map((r2) => ({ binding: r2.binding }))
  }

  if (
    wrangler.durable_objects?.bindings &&
    wrangler.durable_objects.bindings.length > 0
  ) {
    worker.durableObjects = wrangler.durable_objects.bindings.map((d) => {
      const spec: { binding: string; className: string; scriptName?: string } = {
        binding: d.name,
        className: d.class_name,
      }
      if (d.script_name !== undefined) spec.scriptName = d.script_name
      return spec
    })
  }

  if (wrangler.worker_loaders && wrangler.worker_loaders.length > 0) {
    worker.workerLoaders = wrangler.worker_loaders.map((wl): WorkerLoaderSpec => ({
      binding: wl.binding ?? wl.name ?? 'LOADER',
    }))
  }

  return worker as WorkspaceWorker
}

/**
 * Detect known-unsupported Cloudflare binding types in a wrangler config
 * and return warning strings. Callers should print these but not abort.
 */
export function detectUnsupportedBindings(wrangler: WranglerConfig): string[] {
  const warnings: string[] = []
  const UNSUPPORTED: ReadonlyArray<[keyof WranglerConfig, string]> = [
    ['ai', 'Workers AI — no local runtime; keep this binding on CF'],
    ['vectorize', 'Vectorize — not supported; self-host Qdrant/Weaviate or keep on CF'],
    ['browser', 'Browser Rendering — not supported; use Browserless or similar'],
    ['queues', 'Queues — not yet supported; roadmap v0.5+'],
    ['hyperdrive', 'Hyperdrive — not supported; connect to Postgres directly'],
    ['analytics_engine_datasets', 'Analytics Engine — not supported; use Prometheus/Grafana'],
    ['send_email', 'Email Workers — not supported; use Resend/Postmark'],
  ]
  for (const [key, message] of UNSUPPORTED) {
    if (wrangler[key] !== undefined) {
      warnings.push(`binding "${key}": ${message}`)
    }
  }
  if (wrangler.observability !== undefined) {
    warnings.push('observability: CF-specific telemetry ignored; use groundflare metrics')
  }
  return warnings
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function mapVars(input: Record<string, ConfigVarValue>): Record<string, ConfigVarValue> {
  const out: Record<string, ConfigVarValue> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    } else {
      throw new TypeError(
        `wrangler [vars] key ${JSON.stringify(k)} has unsupported type ` +
          `${typeof v}; only strings, numbers, and booleans are supported`,
      )
    }
  }
  return out
}
