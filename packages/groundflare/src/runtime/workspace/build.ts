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
import {
  D1_ADAPTER_DO_SOURCE,
  D1_DO_CLASS_NAME,
  generateTenantD1Shim,
} from '../d1/adapter-module.js'
import { TENANT_METRICS_SHIM_SOURCE } from '../metrics/tenant-shim-source.js'
import {
  generateRouterJs,
  routerBindingName,
  type InternalScrapeTarget,
} from './router.js'
import type {
  R2BindingSpec,
  VarValue,
  WorkspaceManifest,
  WorkspaceWorker,
} from './types.js'

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

  /**
   * Pre-bundled R2 adapter Worker source (output of bundleR2Adapter()).
   * Required when any worker has r2Buckets — buildCapnpFromWorkspace
   * stays sync, so the caller bundles once and passes it in. Throws
   * a clear error if R2 bindings exist and this is undefined.
   */
  readonly r2AdapterSource?: string

  /**
   * Default S3 endpoint when an R2 binding has no per-bucket override.
   * Defaults to 'http://127.0.0.1:8333' — the SeaweedFS sidecar
   * groundflare's cloud-init installs.
   */
  readonly defaultR2Endpoint?: string

  /**
   * Version string surfaced on the Router's `/__health` endpoint.
   * Typically the groundflare CLI version. When unset, the router
   * reports `"unknown"`.
   */
  readonly groundflareVersion?: string
}

const DEFAULT_STATE_BASE_DIR = 'do-state'

export function buildCapnpFromWorkspace(
  manifest: WorkspaceManifest,
  opts: BuildOptions = {},
): CapnpWorkerdConfig {
  validateManifest(manifest)

  const stateBase = opts.stateBaseDir ?? DEFAULT_STATE_BASE_DIR
  const services: CapnpService[] = [buildRouterService(manifest, opts)]

  for (const worker of manifest.workers) {
    const { worker: tenant, disk: tenantDisk } = buildTenantService(
      worker,
      manifest,
      stateBase,
    )
    if (tenantDisk !== null) services.push(tenantDisk)
    services.push(tenant)
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
    if (worker.d1Databases && worker.d1Databases.length > 0) {
      for (const d1 of worker.d1Databases) {
        const { worker: adapter, disk } = buildD1AdapterService(
          worker,
          d1.databaseName,
          stateBase,
          manifest,
        )
        if (disk !== null) services.push(disk)
        services.push(adapter)
      }
    }
    if (worker.r2Buckets && worker.r2Buckets.length > 0) {
      if (opts.r2AdapterSource === undefined) {
        throw new Error(
          `Worker "${worker.name}" has r2Buckets but BuildOptions.r2AdapterSource is missing. ` +
            `Call \`await bundleR2Adapter()\` and pass the result.`,
        )
      }
      for (const r2 of worker.r2Buckets) {
        services.push(
          buildR2AdapterService(
            worker,
            r2,
            opts.r2AdapterSource,
            opts.defaultR2Endpoint,
            manifest,
          ),
        )
      }
    }
  }
  // Workspaces with at least one R2 binding need a single shared
  // outbound network service so the adapter Workers can fetch
  // localhost (SeaweedFS sidecar) or remote S3-compatible endpoints.
  if (manifest.workers.some((w) => (w.r2Buckets?.length ?? 0) > 0)) {
    services.push(buildR2OutboundNetworkService())
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

/**
 * Derive the env-binding name the Router uses to reach one R2 adapter
 * service for internal metric scraping. Must be a valid JS identifier,
 * unique across every (worker, binding) pair in the workspace.
 */
function r2AdapterMetricsBinding(worker: string, binding: string): string {
  return (
    'METRICS_R2_' +
    worker.toUpperCase().replace(/-/g, '_') +
    '_' +
    binding.toUpperCase().replace(/-/g, '_')
  )
}

function buildRouterService(
  manifest: WorkspaceManifest,
  opts: BuildOptions,
): CapnpService {
  // Every worker gets a service binding from the router so cron dispatch
  // can reach workers without a domain too. The same binding doubles as
  // the Router's /__metrics fan-out target for tenants with shims.
  const bindings: CapnpBinding[] = manifest.workers.map((w) => ({
    name: routerBindingName(w.name),
    kind: 'service',
    service: tenantServiceName(w.name),
  }))

  // Fan-out list: tenant workers that have a KV or D1 binding (and
  // therefore a shim that responds to /__gf_metrics), plus one entry
  // per R2 adapter service.
  const scrapeTargets: InternalScrapeTarget[] = []
  for (const w of manifest.workers) {
    const hasShim =
      (w.kvNamespaces?.length ?? 0) > 0 ||
      (w.d1Databases?.length ?? 0) > 0
    if (hasShim) {
      scrapeTargets.push({
        bindingName: routerBindingName(w.name),
        label: w.name,
      })
    }
    for (const r2 of w.r2Buckets ?? []) {
      const bindingName = r2AdapterMetricsBinding(w.name, r2.binding)
      bindings.push({
        name: bindingName,
        kind: 'service',
        service: r2AdapterServiceName(w.name, r2.binding),
      })
      scrapeTargets.push({
        bindingName,
        label: `${w.name}:${r2.binding}`,
      })
    }
  }

  const worker: CapnpWorker = {
    modules: [
      {
        name: DEFAULT_ROUTER_MODULE_NAME,
        source: {
          kind: 'esModule',
          inline: generateRouterJs(manifest.workers, {
            version: opts.groundflareVersion,
            scrapeTargets,
          }),
        },
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
  stateBase: string | 'in-memory',
): { worker: CapnpService; disk: CapnpService | null } {
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
        kind: 'durableObjectNamespace',
        className: D1_DO_CLASS_NAME,
        serviceName: d1AdapterServiceName(worker.name, d1.databaseName),
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

  if (worker.workerLoaders) {
    for (const wl of worker.workerLoaders) {
      bindings.push({
        name: wl.binding,
        kind: 'workerLoader',
        ...(wl.id !== undefined ? { id: wl.id } : {}),
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
  const hasD1 = (worker.d1Databases?.length ?? 0) > 0

  const modules: CapnpModule[] = []
  if (hasKv || hasD1) {
    // The shim becomes the Worker's entry; it imports the user's real
    // entry as `./user.js` (exact module name match) and wraps env so each
    // KV/D1 binding looks like CF's API at runtime, even though the
    // underlying capnp uses DurableObject namespace bindings.
    const kvBindings = (worker.kvNamespaces ?? []).map((kv) => ({
      name: kv.binding,
      shards: kv.shards ?? 1,
    }))
    const d1Names = (worker.d1Databases ?? []).map((d1) => d1.binding)
    const shimSource = generateTenantBindingShim({
      kvBindings,
      d1Names,
      workerName: worker.name,
    })
    modules.push({
      name: DEFAULT_TENANT_MODULE_NAME,
      source: { kind: 'esModule', inline: shimSource },
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

  // Same-script user DOs — a binding without `scriptName` means the DO
  // class lives in this very worker. workerd requires the worker to
  // *also* declare the namespace in its `durableObjectNamespaces` list
  // and to configure storage. Without both, the worker fails to start
  // with "binding refers to a namespace but no such namespace is
  // defined by this Worker". Cross-script DOs (scriptName set) skip
  // this path — the class's owner worker handles it.
  const sameScriptDOs = (worker.durableObjects ?? []).filter(
    (d) => d.scriptName === undefined,
  )
  const doClassNames = [...new Set(sameScriptDOs.map((d) => d.className))]

  let doStorage: CapnpWorker['durableObjectStorage']
  let doDiskService: CapnpService | null = null
  let doNamespaces: NonNullable<CapnpWorker['durableObjectNamespaces']> | undefined

  if (doClassNames.length > 0) {
    if (stateBase === 'in-memory') {
      doStorage = { inMemory: true }
    } else {
      const diskServiceName = `${tenantServiceName(worker.name)}-do-disk`
      doDiskService = {
        name: diskServiceName,
        kind: 'disk',
        path: `${stateBase}/${worker.name}/do`,
        writable: true,
      }
      doStorage = { localDiskPath: diskServiceName }
    }
    doNamespaces = doClassNames.map((className) => ({
      className,
      // Derived from worker + class so redeploys keep the same
      // object IDs; regenerating would orphan prior state.
      uniqueKey: `groundflare-do-${worker.name}-${className}`,
    }))
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
    ...(doNamespaces !== undefined
      ? { durableObjectNamespaces: doNamespaces }
      : {}),
    ...(doStorage !== undefined ? { durableObjectStorage: doStorage } : {}),
  }

  return {
    worker: {
      name: tenantServiceName(worker.name),
      kind: 'worker',
      worker: capnpWorker,
    },
    disk: doDiskService,
  }
}

/**
 * Tenant shim for KV + D1 bindings combined. Both wrap a DO binding into
 * a CF API facade; we emit one module that handles either or both rather
 * than two competing entries.
 */
function generateTenantBindingShim(opts: {
  kvBindings: readonly { name: string; shards: number }[]
  d1Names: readonly string[]
  workerName: string
}): string {
  // If only one kind of binding is present, defer to the dedicated shim
  // generator — they each produce a complete entry module.
  if (opts.kvBindings.length > 0 && opts.d1Names.length === 0) {
    return generateTenantKvShim(opts.kvBindings, { workerName: opts.workerName })
  }
  if (opts.d1Names.length > 0 && opts.kvBindings.length === 0) {
    return generateTenantD1Shim(opts.d1Names, { workerName: opts.workerName })
  }
  // Combined shim: import the user module once, wrap env with both
  // facades, forward fetch/scheduled.
  const kvShardsLiteral = JSON.stringify(
    Object.fromEntries(
      opts.kvBindings
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((b) => [b.name, b.shards]),
    ),
  )
  return [
    '// GENERATED by groundflare — combined KV+D1 tenant shim.',
    "import user from './user.js'",
    // Re-export user's named exports so workerd can resolve DO classes
    // declared on the user module. `export *` skips `default`, which
    // the shim owns itself.
    "export * from './user.js'",
    `const GF_WORKER_NAME = ${JSON.stringify(opts.workerName)}`,
    TENANT_METRICS_SHIM_SOURCE,
    `const KV_SHARDS = ${kvShardsLiteral}`,
    `const D1_BINDINGS = new Set(${JSON.stringify([...opts.d1Names].sort())})`,
    `${kvFacadeFunctions()}`,
    `${d1FacadeFunctions()}`,
    'function wrapEnv(env) {',
    '  const out = { ...env }',
    '  for (const name of Object.keys(KV_SHARDS)) {',
    '    const raw = out[name]',
    "    if (raw && typeof raw.idFromName === 'function') out[name] = makeKvFacade(raw, name)",
    '  }',
    '  for (const name of D1_BINDINGS) {',
    '    const raw = out[name]',
    "    if (raw && typeof raw.idFromName === 'function') out[name] = makeD1Facade(raw, name)",
    '  }',
    '  return out',
    '}',
    'export default {',
    '  async fetch(request, env, ctx) {',
    '    const internal = gf_handleInternalMetrics(request)',
    '    if (internal) return internal',
    '    return user.fetch(request, wrapEnv(env), ctx)',
    '  },',
    '  async scheduled(event, env, ctx) {',
    '    if (user.scheduled) return user.scheduled(event, wrapEnv(env), ctx)',
    '  },',
    '}',
  ].join('\n')
}

// Inlined facade source extracted from the dedicated shims so the
// combined shim above can drop them in.
function kvFacadeFunctions(): string {
  // Re-emit the KV facade body (everything between `import` and
  // `wrapEnv`/`export default`) as standalone helpers. Keeping in sync by
  // importing from generateTenantKvShim's body would be brittle; the
  // duplication is small (~50 LOC including sharding) and tests cover both paths.
  return `function fnv1a32(s) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function kvShardName(binding, key) {
  const n = KV_SHARDS[binding] || 1
  if (n === 1) return 'default'
  return 'shard-' + (fnv1a32(key) % n)
}
function decodeValue(bytes, type) {
  if (type === 'arrayBuffer') {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    return copy.buffer
  }
  const decoded = new TextDecoder().decode(bytes)
  if (type === 'json') return JSON.parse(decoded)
  return decoded
}
function normalizeKvType(options) {
  if (options === undefined) return 'text'
  if (typeof options === 'string') return options
  return options.type ?? 'text'
}
function makeKvFacade(doNamespace, binding) {
  const stubFor = (key) => doNamespace.get(doNamespace.idFromName(kvShardName(binding, key)))
  return {
    async get(key, options) {
      return gf_timeKv(binding, 'get', async () => {
        const row = await stubFor(key).kvGet(key)
        if (!row) return null
        return decodeValue(row.value, normalizeKvType(options))
      })
    },
    async getWithMetadata(key, options) {
      return gf_timeKv(binding, 'getWithMetadata', async () => {
        const row = await stubFor(key).kvGetWithMetadata(key)
        if (!row.value) return { value: null, metadata: null }
        return { value: decodeValue(row.value, normalizeKvType(options)), metadata: row.metadata }
      })
    },
    async put(key, value, options) {
      return gf_timeKv(binding, 'put', () => stubFor(key).kvPut(key, value, options))
    },
    async delete(key) {
      return gf_timeKv(binding, 'delete', () => stubFor(key).kvDelete(key))
    },
    async list(options) {
      return gf_timeKv(binding, 'list', async () => {
        const n = KV_SHARDS[binding] || 1
        if (n === 1) return doNamespace.get(doNamespace.idFromName('default')).kvList(options)
        if (options && options.cursor) {
          throw new Error('KV list() pagination across shards not yet supported (Phase 2)')
        }
        const perShard = Math.max(1, (options?.limit ?? 1000))
        const pages = await Promise.all(
          Array.from({ length: n }, (_, i) =>
            doNamespace.get(doNamespace.idFromName('shard-' + i)).kvList({ ...options, limit: perShard }),
          ),
        )
        const merged = []
        for (const page of pages) for (const k of page.keys) merged.push(k)
        merged.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        const capped = merged.slice(0, perShard)
        return { keys: capped, list_complete: capped.length === merged.length }
      })
    },
  }
}`
}

function d1FacadeFunctions(): string {
  return `function makeD1PreparedStatement(binding, stub, sql, args) {
  return {
    bind(...newArgs) { return makeD1PreparedStatement(binding, stub, sql, [...args, ...newArgs]) },
    async first(column) { return gf_timeD1(binding, 'first', () => stub.d1First(sql, args, column)) },
    async run() { return gf_timeD1(binding, 'run', () => stub.d1Run(sql, args)) },
    async all() { return gf_timeD1(binding, 'all', () => stub.d1All(sql, args)) },
    async raw() { return gf_timeD1(binding, 'raw', () => stub.d1Raw(sql, args)) },
    _gfStatement: { sql, args },
  }
}
function makeD1Facade(doNamespace, binding) {
  const stub = () => doNamespace.get(doNamespace.idFromName('default'))
  return {
    prepare(sql) { return makeD1PreparedStatement(binding, stub(), sql, []) },
    async batch(statements) {
      return gf_timeD1(binding, 'batch', () => {
        const payload = statements.map((s) => {
          const inner = s._gfStatement
          if (!inner) throw new TypeError('D1.batch: every entry must be from .prepare()')
          return inner
        })
        return stub().d1Batch(payload)
      })
    },
    async exec(sql) { return gf_timeD1(binding, 'exec', () => stub().d1Exec(sql)) },
  }
}`
}

// ─── KV adapter service ────────────────────────────────────────────

interface AdapterServices {
  readonly worker: CapnpService
  /** Null when using `in-memory` storage (no disk service needed). */
  readonly disk: CapnpService | null
}

type KvAdapterServices = AdapterServices
type D1AdapterServices = AdapterServices

// ─── D1 adapter service ────────────────────────────────────────────

function buildD1AdapterService(
  worker: WorkspaceWorker,
  databaseName: string,
  stateBase: string | 'in-memory',
  manifest: WorkspaceManifest,
): D1AdapterServices {
  const serviceName = d1AdapterServiceName(worker.name, databaseName)

  // SQL DO requires localDisk storage — workerd's inMemory storage uses
  // a non-SQL ActorCache implementation, so `enableSql = true` is silently
  // ignored. Reject in-memory mode loudly instead of producing a config
  // that boots but throws at first SQL exec.
  if (stateBase === 'in-memory') {
    throw new Error(
      `D1 adapter for "${worker.name}/${databaseName}" requires localDisk storage; ` +
        `workerd's inMemory mode does not support SqlStorage. ` +
        `Set BuildOptions.stateBaseDir to a relative directory (e.g. "do-state").`,
    )
  }

  const diskServiceName = `${serviceName}-disk`
  const diskService: CapnpService = {
    name: diskServiceName,
    kind: 'disk',
    path: `${stateBase}/${worker.name}/d1/${databaseName}`,
    writable: true,
  }

  const capnpWorker: CapnpWorker = {
    modules: [
      {
        name: DEFAULT_TENANT_MODULE_NAME,
        source: { kind: 'esModule', inline: D1_ADAPTER_DO_SOURCE },
      },
    ],
    compatibilityDate:
      manifest.defaults?.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    durableObjectNamespaces: [
      {
        className: D1_DO_CLASS_NAME,
        uniqueKey: `groundflare-d1-${worker.name}-${databaseName}`,
        enableSql: true,
      },
    ],
    durableObjectStorage: { localDiskPath: diskServiceName },
  }

  return {
    worker: { name: serviceName, kind: 'worker', worker: capnpWorker },
    disk: diskService,
  }
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

const R2_OUTBOUND_NETWORK_NAME = 'r2-internet'
const DEFAULT_R2_ENDPOINT = 'http://127.0.0.1:8333'

/**
 * Per-(worker, binding) R2 adapter Worker service. Each emits its own
 * service so that the adapter's environment bindings (BUCKET_NAME,
 * S3_ENDPOINT, credentials) can differ per-bucket without polluting
 * a shared service.
 */
function buildR2AdapterService(
  worker: WorkspaceWorker,
  r2: R2BindingSpec,
  adapterSource: string,
  defaultEndpoint: string | undefined,
  manifest: WorkspaceManifest,
): CapnpService {
  const serviceName = r2AdapterServiceName(worker.name, r2.binding)
  const bucketName = r2.bucketName ?? r2.binding.toLowerCase()
  const endpoint = (r2.endpoint ?? defaultEndpoint ?? DEFAULT_R2_ENDPOINT).replace(/\/$/, '')

  const bindings: CapnpBinding[] = [
    { name: 'BUCKET_NAME', kind: 'text', value: bucketName },
    { name: 'S3_ENDPOINT', kind: 'text', value: endpoint },
    // Labels for /__gf_metrics output so aggregated dashboards can
    // tell series from different (worker, binding) pairs apart. The
    // adapter service is already scoped per-pair, so these are
    // constants from the adapter's perspective.
    { name: 'GF_WORKER_NAME', kind: 'text', value: worker.name },
    { name: 'GF_BINDING_NAME', kind: 'text', value: r2.binding },
  ]
  if (r2.region !== undefined) {
    bindings.push({ name: 'S3_REGION', kind: 'text', value: r2.region })
  }
  if (r2.accessKeyId !== undefined && r2.secretAccessKey !== undefined) {
    bindings.push({ name: 'S3_ACCESS_KEY', kind: 'text', value: r2.accessKeyId })
    bindings.push({ name: 'S3_SECRET_KEY', kind: 'text', value: r2.secretAccessKey })
  }

  const capnpWorker: CapnpWorker = {
    modules: [
      {
        name: DEFAULT_TENANT_MODULE_NAME,
        source: { kind: 'esModule', inline: adapterSource },
      },
    ],
    compatibilityDate:
      manifest.defaults?.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: ['nodejs_compat'],
    bindings,
    globalOutbound: R2_OUTBOUND_NETWORK_NAME,
  }
  return { name: serviceName, kind: 'worker', worker: capnpWorker }
}

/**
 * Single shared outbound network service used by every R2 adapter
 * Worker. Allows fetches to local + private + public addresses so the
 * default SeaweedFS sidecar (127.0.0.1) AND remote S3 endpoints both
 * work out-of-the-box.
 */
function buildR2OutboundNetworkService(): CapnpService {
  return {
    name: R2_OUTBOUND_NETWORK_NAME,
    kind: 'network',
    allow: ['public', 'private'],
  }
}
