/**
 * Transform a workspace manifest into a workerd capnp configuration.
 *
 * Design notes:
 *   - Output is pure: no filesystem reads, no mutation of inputs.
 *   - Validation happens first (duplicate names, invalid identifiers).
 *   - Adapter services for KV/D1/R2 are NOT emitted yet — bindings
 *     reference canonical service designators (`adapter-kv-<worker>-<binding>`
 *     etc.), but those services themselves land in a future commit when
 *     we have real KV/D1/R2 adapter Worker implementations to embed.
 *     Until then, the generated capnp is syntactically valid but
 *     references missing services; workerd will refuse to load it.
 *     This is an accepted gap — see design/workspaces.md §Testing for
 *     the Tier 2 conformance phase that ends it.
 */

import type {
  CapnpBinding,
  CapnpModule,
  CapnpService,
  CapnpWorker,
  CapnpWorkerdConfig,
} from '../workerd/capnp/index.js'
import {
  KV_ADAPTER_DO_SOURCE,
  KV_DO_CLASS_NAME,
  generateTenantKvShim,
} from '../kv/adapter-module.js'
import { generateRouterJs, routerBindingName } from './router.js'
import type { VarValue, WorkspaceManifest, WorkspaceWorker } from './types.js'

export const ROUTER_SERVICE_NAME = 'router'

const DEFAULT_COMPATIBILITY_DATE = '2026-04-01'
const DEFAULT_LISTEN_ADDRESS = '*:8080'
const DEFAULT_ROUTER_MODULE_NAME = 'router'
const DEFAULT_TENANT_MODULE_NAME = 'worker'

// Worker name validation — mirrors the rules in design/workspaces.md:
// lowercase alphanumerics + hyphen, must start with a letter, max 40 chars.
const WORKER_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/

export interface BuildOptions {
  /** Socket bind address. Default `*:8080`. */
  readonly listenAddress?: string

  /**
   * DO storage mode:
   *   - string (default `"do-state"`): relative directory name from the
   *     capnp config file; each tenant-binding gets a sibling disk service
   *     pointing at `<stateBaseDir>/<worker>/<binding>`. workerd's
   *     kj::Path parser rejects absolute paths here, so it's intentionally
   *     relative. The deploy flow places capnp at
   *     `/var/lib/groundflare/worker.capnp` and state under
   *     `/var/lib/groundflare/<stateBaseDir>/...`.
   *   - `"in-memory"`: ephemeral DO storage (process-lifetime). Useful
   *     for tests or for workspaces that intentionally don't persist.
   */
  readonly stateBaseDir?: string | 'in-memory'
}

const DEFAULT_STATE_BASE_DIR = 'do-state'

export function buildCapnpFromWorkspace(
  manifest: WorkspaceManifest,
  opts: BuildOptions = {},
): CapnpWorkerdConfig {
  validateManifest(manifest)

  const stateBase = opts.stateBaseDir ?? DEFAULT_STATE_BASE_DIR
  const services: CapnpService[] = [buildRouterService(manifest)]

  for (const worker of manifest.workers) {
    services.push(buildTenantService(worker, manifest))
    // KV adapter services — one per (worker, binding) pair — are emitted
    // alongside the tenant so workerd can resolve the DO namespace
    // referenced in the tenant's binding list. Each adapter also needs a
    // sibling `disk` service because workerd's durableObjectStorage config
    // refers to a disk service *by name*, not a direct filesystem path.
    if (worker.kvNamespaces && worker.kvNamespaces.length > 0) {
      for (const kv of worker.kvNamespaces) {
        const { worker: adapter, disk } = buildKvAdapterService(
          worker,
          kv.binding,
          stateBase,
          manifest,
        )
        if (disk !== null) services.push(disk)
        services.push(adapter)
      }
    }
  }

  return {
    services,
    sockets: [
      {
        name: 'http',
        address: opts.listenAddress ?? DEFAULT_LISTEN_ADDRESS,
        service: ROUTER_SERVICE_NAME,
      },
    ],
  }
}

// ─── Router service ────────────────────────────────────────────────

function buildRouterService(manifest: WorkspaceManifest): CapnpService {
  // Every worker gets a service binding from the router so cron dispatch
  // can reach workers without a domain too.
  const bindings: CapnpBinding[] = manifest.workers.map((w) => ({
    name: routerBindingName(w.name),
    kind: 'service',
    service: tenantServiceName(w.name),
  }))

  const worker: CapnpWorker = {
    modules: [
      {
        name: DEFAULT_ROUTER_MODULE_NAME,
        source: { kind: 'esModule', inline: generateRouterJs(manifest.workers) },
      },
    ],
    compatibilityDate:
      manifest.defaults?.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: manifest.defaults?.compatibilityFlags,
    bindings: bindings.length > 0 ? bindings : undefined,
  }

  return { name: ROUTER_SERVICE_NAME, kind: 'worker', worker }
}

// ─── Tenant service ────────────────────────────────────────────────

function buildTenantService(
  worker: WorkspaceWorker,
  manifest: WorkspaceManifest,
): CapnpService {
  const bindings: CapnpBinding[] = []

  if (worker.vars) {
    for (const [name, value] of Object.entries(worker.vars)) {
      bindings.push(varToBinding(name, value))
    }
  }

  if (worker.serviceBindings) {
    for (const sb of worker.serviceBindings) {
      bindings.push({
        name: sb.binding,
        kind: 'service',
        service: tenantServiceName(sb.service),
      })
    }
  }

  // KV bindings land as DO namespace bindings under the hood. The tenant
  // shim (below) translates them back into CF KV API surface at runtime.
  if (worker.kvNamespaces) {
    for (const kv of worker.kvNamespaces) {
      bindings.push({
        name: kv.binding,
        kind: 'durableObjectNamespace',
        className: KV_DO_CLASS_NAME,
        serviceName: kvAdapterServiceName(worker.name, kv.binding),
      })
    }
  }

  if (worker.d1Databases) {
    for (const d1 of worker.d1Databases) {
      bindings.push({
        name: d1.binding,
        kind: 'd1Database',
        service: d1AdapterServiceName(worker.name, d1.databaseName),
      })
    }
  }

  if (worker.r2Buckets) {
    for (const r2 of worker.r2Buckets) {
      bindings.push({
        name: r2.binding,
        kind: 'r2Bucket',
        service: r2AdapterServiceName(worker.name, r2.binding),
      })
    }
  }

  if (worker.durableObjects) {
    for (const doBinding of worker.durableObjects) {
      const serviceName =
        doBinding.scriptName !== undefined
          ? tenantServiceName(doBinding.scriptName)
          : undefined
      bindings.push({
        name: doBinding.binding,
        kind: 'durableObjectNamespace',
        className: doBinding.className,
        ...(serviceName !== undefined ? { serviceName } : {}),
      })
    }
  }

  const hasKv = (worker.kvNamespaces?.length ?? 0) > 0

  const modules: CapnpModule[] = []
  if (hasKv) {
    // The shim becomes the Worker's entry; it imports the user's real
    // entry as `./user.js` (exact module name match) and wraps env to
    // expose the CF KV API.
    const kvBindingNames = worker.kvNamespaces!.map((kv) => kv.binding)
    modules.push({
      name: DEFAULT_TENANT_MODULE_NAME,
      source: { kind: 'esModule', inline: generateTenantKvShim(kvBindingNames) },
    })
    modules.push({
      name: './user.js',
      source: { kind: 'esModule', embedPath: worker.entryPath },
    })
  } else {
    modules.push({
      name: DEFAULT_TENANT_MODULE_NAME,
      source: { kind: 'esModule', embedPath: worker.entryPath },
    })
  }

  const capnpWorker: CapnpWorker = {
    modules,
    compatibilityDate:
      worker.compatibilityDate ??
      manifest.defaults?.compatibilityDate ??
      DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags:
      worker.compatibilityFlags ?? manifest.defaults?.compatibilityFlags,
    bindings: bindings.length > 0 ? bindings : undefined,
  }

  return {
    name: tenantServiceName(worker.name),
    kind: 'worker',
    worker: capnpWorker,
  }
}

// ─── KV adapter service ────────────────────────────────────────────

interface KvAdapterServices {
  readonly worker: CapnpService
  /** Null when using `in-memory` storage (no disk service needed). */
  readonly disk: CapnpService | null
}

function buildKvAdapterService(
  worker: WorkspaceWorker,
  bindingName: string,
  stateBase: string | 'in-memory',
  manifest: WorkspaceManifest,
): KvAdapterServices {
  const serviceName = kvAdapterServiceName(worker.name, bindingName)

  let storage: CapnpWorker['durableObjectStorage']
  let diskService: CapnpService | null = null

  if (stateBase === 'in-memory') {
    storage = { inMemory: true }
  } else {
    // Path must be relative to the capnp file (workerd's kj::Path
    // rejects absolute paths in disk services).
    const diskServiceName = `${serviceName}-disk`
    diskService = {
      name: diskServiceName,
      kind: 'disk',
      path: `${stateBase}/${worker.name}/${bindingName}`,
      writable: true,
    }
    storage = { localDiskPath: diskServiceName }
  }

  const capnpWorker: CapnpWorker = {
    modules: [
      {
        name: DEFAULT_TENANT_MODULE_NAME,
        source: { kind: 'esModule', inline: KV_ADAPTER_DO_SOURCE },
      },
    ],
    compatibilityDate:
      manifest.defaults?.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    // DurableObjectNamespace requires `uniqueKey` OR `ephemeralLocal` —
    // without one of them, workerd assumes ephemeralLocal which excludes
    // `state.storage` entirely. Derive the key deterministically so redeploys
    // don't invalidate existing object IDs.
    durableObjectNamespaces: [
      {
        className: KV_DO_CLASS_NAME,
        uniqueKey: `groundflare-kv-${worker.name}-${bindingName}`,
      },
    ],
    durableObjectStorage: storage,
  }

  return {
    worker: {
      name: serviceName,
      kind: 'worker',
      worker: capnpWorker,
    },
    disk: diskService,
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function varToBinding(name: string, value: VarValue): CapnpBinding {
  if (typeof value === 'string') return { name, kind: 'text', value }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { name, kind: 'json', value: JSON.stringify(value) }
  }
  throw new TypeError(`Unsupported var type for ${name}: ${typeof value}`)
}

function validateManifest(manifest: WorkspaceManifest): void {
  const names = new Set<string>()
  const domains = new Set<string>()
  const serviceBindingTargets: Array<{ from: string; to: string }> = []

  for (const w of manifest.workers) {
    if (!WORKER_NAME_RE.test(w.name)) {
      throw new ManifestError(
        `Invalid worker name "${w.name}": must match /${WORKER_NAME_RE.source}/ (lowercase letters/digits/hyphens, start with a letter, ≤ 40 chars).`,
      )
    }

    if (names.has(w.name)) {
      throw new ManifestError(`Duplicate worker name in workspace: "${w.name}"`)
    }
    names.add(w.name)

    if (w.domain !== undefined) {
      const normalized = w.domain.toLowerCase()
      if (domains.has(normalized)) {
        throw new ManifestError(`Duplicate domain in workspace: "${w.domain}"`)
      }
      domains.add(normalized)
    }

    if (w.serviceBindings) {
      for (const sb of w.serviceBindings) {
        serviceBindingTargets.push({ from: w.name, to: sb.service })
      }
    }
  }

  for (const { from, to } of serviceBindingTargets) {
    if (!names.has(to)) {
      throw new ManifestError(
        `Worker "${from}" has a service binding to unknown worker "${to}".`,
      )
    }
  }
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

// ─── Service naming conventions ────────────────────────────────────
// Single source of truth — consumers of the generated capnp
// (the KV/D1/R2 adapter service generators, tests, etc.) import
// these instead of duplicating the string pattern.

export function tenantServiceName(workerName: string): string {
  return `worker-${workerName}`
}

export function kvAdapterServiceName(worker: string, binding: string): string {
  return `adapter-kv-${worker}-${binding}`
}

export function d1AdapterServiceName(worker: string, databaseName: string): string {
  return `adapter-d1-${worker}-${databaseName}`
}

export function r2AdapterServiceName(worker: string, binding: string): string {
  return `adapter-r2-${worker}-${binding}`
}
