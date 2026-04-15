/**
 * Build a Bun-track deployment artifact from a WorkspaceManifest.
 *
 * Peer of `buildCapnpFromWorkspace()` in src/runtime/workspace/build.ts —
 * takes the same manifest shape, produces the files + systemd unit the
 * deploy flow writes to the VPS when runtime == "bun".
 *
 * Phase 1 scope: single-worker workspaces. Multi-worker Bun (Router-
 * shaped dispatch on Bun.serve) lands in Phase 2 alongside the real
 * `bun:sqlite` adapters — the data-plane and routing-plane both change
 * at that point, so we don't speculate on the shape here. If the
 * manifest has > 1 worker, this function throws; the caller should
 * surface it as a configuration error with a migration hint.
 */

import { BUN_KV_ADAPTER_SOURCE } from './adapters/sources.js'
import { generateBunShim, type BunKvBinding } from './shim.js'
import { generateBunSystemdUnit, type BunUnitOptions } from './systemd.js'
import type { WorkspaceManifest, WorkspaceWorker } from '../workspace/types.js'

export interface BuildBunOptions {
  /**
   * Directory Bun runs from on the VPS. systemd unit's WorkingDirectory
   * and the entry module path are composed from this root. Default
   * `/var/lib/groundflare`.
   */
  readonly deployRoot?: string

  /**
   * Listen address for Bun.serve — `host:port`. Default `0.0.0.0:8080`,
   * matching the Caddy reverse-proxy target in the workerd track so
   * the rest of the stack (Caddy, systemd naming, journald identifier)
   * is identical between tracks.
   */
  readonly listenAddress?: string

  /**
   * Override / extend the systemd unit options. Anything passed here
   * is spread over the defaults `buildBunArtifact` picks from the
   * manifest — lets the caller tighten MemoryMax/CPUQuota per VPS
   * tier without re-implementing unit composition.
   */
  readonly systemd?: Partial<BunUnitOptions>
}

export interface BunArtifact {
  /**
   * Content of server.ts — the Bun.serve entry the systemd unit runs.
   * Caller writes this to `${deployRoot}/server.ts`.
   */
  readonly serverSource: string

  /**
   * Relative path (inside deployRoot) where the caller must place the
   * user's Worker entry module. server.ts imports from `./user.js`,
   * so this is always `"user.js"` for Phase 1. Exposed as a field so
   * Phase 2 can change the layout (e.g. to `workers/<name>/user.js`
   * for multi-tenant) without breaking callers that read it.
   */
  readonly userEntryRelativePath: string

  /**
   * Additional source files the generated server.ts imports from,
   * keyed by path relative to `deployRoot`. Callers write each
   * entry's value to `${deployRoot}/${key}`. As of Phase 2b this
   * contains the KV adapter (`adapters/kv.ts`); D1 (Phase 2c) and
   * R2 (Phase 2d) get added here as they land.
   */
  readonly adapterSources: Record<string, string>

  /**
   * systemd unit content, ready to write to
   * /etc/systemd/system/groundflare-worker.service.
   */
  readonly systemdUnit: string

  /**
   * Directories that must exist on disk before Bun.serve starts.
   * Caller mkdir -p's each of them. Ordered from shallowest first
   * (parent-before-child) — relevant only for exotic filesystems
   * but it makes the output stable.
   */
  readonly stateDirs: readonly string[]

  /**
   * Resolved deployRoot + entry module path — useful for the caller's
   * deploy logging and for cross-checks in tests.
   */
  readonly deployRoot: string
  readonly entryModulePath: string
}

const DEFAULT_DEPLOY_ROOT = '/var/lib/groundflare'
const DEFAULT_LISTEN_ADDRESS = '0.0.0.0:8080'

export function buildBunArtifact(
  manifest: WorkspaceManifest,
  opts: BuildBunOptions = {},
): BunArtifact {
  if (!manifest.workers || manifest.workers.length === 0) {
    throw new Error(
      'buildBunArtifact: manifest has no workers — at least one worker is required',
    )
  }
  if (manifest.workers.length > 1) {
    throw new Error(
      'buildBunArtifact: multi-worker workspaces are not yet supported on the Bun track. ' +
        'Phase 2 (task #19) adds a Router-style dispatch for Bun; until then, either split into ' +
        'separate single-worker workspaces or use the workerd (Mirror) track.',
    )
  }
  const worker = manifest.workers[0]!

  const deployRoot = opts.deployRoot ?? DEFAULT_DEPLOY_ROOT
  const userEntryRelativePath = 'user.js'
  const entryModulePath = `${deployRoot}/server.ts`

  // Translate the worker's vars to the shim's vars signature (string-only
  // values are typed on the manifest as string|number|boolean; the shim
  // JSON-encodes them, so we pass them through as-is).
  const vars = worker.vars
    ? (worker.vars as Record<string, string | number | boolean>)
    : undefined

  const kvNamespaces: readonly BunKvBinding[] = (worker.kvNamespaces ?? []).map(
    (b) => ({ binding: b.binding, shards: b.shards ?? 1 }),
  )

  const serverSource = generateBunShim({
    entryModule: `./${userEntryRelativePath}`,
    listenAddress: opts.listenAddress ?? DEFAULT_LISTEN_ADDRESS,
    stateBaseDir: deployRoot,
    vars,
    kvNamespaces,
    d1Databases: worker.d1Databases,
    r2Buckets: worker.r2Buckets,
  })

  const adapterSources: Record<string, string> = {}
  // Always ship the KV adapter source — server.ts unconditionally
  // imports it, whether or not this particular worker declared a KV
  // binding. Paying for ~8 KB of source on every Bun deployment is
  // cheaper than conditionally branching the shim around the import.
  adapterSources['adapters/kv.ts'] = BUN_KV_ADAPTER_SOURCE

  const systemdUnit = generateBunSystemdUnit({
    entryPath: entryModulePath,
    workingDirectory: deployRoot,
    description: `groundflare Bun runtime for workspace ${manifest.name}`,
    ...opts.systemd,
  })

  const stateDirs: string[] = [deployRoot]
  if ((worker.d1Databases?.length ?? 0) > 0) stateDirs.push(`${deployRoot}/d1`)
  if ((worker.kvNamespaces?.length ?? 0) > 0) stateDirs.push(`${deployRoot}/kv`)
  if ((worker.r2Buckets?.length ?? 0) > 0) stateDirs.push(`${deployRoot}/r2`)

  return {
    serverSource,
    userEntryRelativePath,
    adapterSources,
    systemdUnit,
    stateDirs,
    deployRoot,
    entryModulePath,
  }
}

/**
 * Small helper: does this manifest target the Bun track? Encapsulates
 * the default ("workerd" when unset) so callers don't guess it. The CLI
 * uses this to dispatch between buildCapnpFromWorkspace (Mirror) and
 * buildBunArtifact (Bun).
 */
export function isBunWorkspace(manifest: WorkspaceManifest): boolean {
  return manifest.runtime === 'bun'
}

// Type re-exports so `src/runtime/bun/index.ts` re-exports from one place.
export type { WorkspaceWorker } from '../workspace/types.js'
