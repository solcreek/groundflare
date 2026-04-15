import { describe, it, expect } from 'vitest'
import {
  ManifestError,
  ROUTER_SERVICE_NAME,
  buildCapnpFromWorkspace,
  d1AdapterServiceName,
  kvAdapterServiceName,
  r2AdapterServiceName,
  tenantServiceName,
} from '../../../../src/runtime/workspace/index.js'
import type {
  WorkspaceManifest,
  WorkspaceWorker,
} from '../../../../src/runtime/workspace/index.js'
import type { CapnpService, CapnpWorker } from '../../../../src/runtime/workerd/capnp/index.js'

function worker(
  name: string,
  opts: Partial<WorkspaceWorker> = {},
): WorkspaceWorker {
  return {
    name,
    entryPath: `workers/${name}/code/current/index.js`,
    ...opts,
  }
}

function manifest(workers: WorkspaceWorker[]): WorkspaceManifest {
  return { name: 'test', workers }
}

function findService(config: { services: readonly CapnpService[] }, name: string): CapnpService {
  const service = config.services.find((s) => s.name === name)
  if (!service) throw new Error(`Service not found in config: ${name}`)
  return service
}

function workerOf(service: CapnpService): CapnpWorker {
  if (service.kind !== 'worker') throw new Error(`Not a worker service: ${service.name}`)
  return service.worker
}

describe('buildCapnpFromWorkspace — shape', () => {
  it('emits a router service + one service per worker', () => {
    const config = buildCapnpFromWorkspace(manifest([worker('api', { domain: 'api.test' }), worker('admin', { domain: 'admin.test' })]))
    const names = config.services.map((s) => s.name).sort()
    expect(names).toEqual(['router', 'worker-admin', 'worker-api'])
  })

  it('binds the http socket to the router service', () => {
    const config = buildCapnpFromWorkspace(manifest([worker('a', { domain: 'a.test' })]))
    expect(config.sockets).toHaveLength(1)
    expect(config.sockets[0]?.service).toBe(ROUTER_SERVICE_NAME)
    expect(config.sockets[0]?.address).toBe('*:8080')
  })

  it('respects the listenAddress option', () => {
    const config = buildCapnpFromWorkspace(
      manifest([worker('a', { domain: 'a.test' })]),
      { listenAddress: '127.0.0.1:7777' },
    )
    expect(config.sockets[0]?.address).toBe('127.0.0.1:7777')
  })

  it('emits a valid config for an empty workspace (router only)', () => {
    const config = buildCapnpFromWorkspace(manifest([]))
    expect(config.services).toHaveLength(1)
    expect(config.services[0]?.name).toBe(ROUTER_SERVICE_NAME)
    expect(config.sockets[0]?.service).toBe(ROUTER_SERVICE_NAME)
  })
})

describe('buildCapnpFromWorkspace — router service', () => {
  it('inlines the router JS directly as the module source', () => {
    const config = buildCapnpFromWorkspace(manifest([worker('api', { domain: 'api.test' })]))
    const router = workerOf(findService(config, ROUTER_SERVICE_NAME))
    const mod = router.modules[0]!
    expect(mod.name).toBe('router')
    expect(mod.source.kind).toBe('esModule')
    if ('inline' in mod.source) {
      expect(mod.source.inline).toContain('GENERATED')
      expect(mod.source.inline).toContain('"api.test": "WORKER_API"')
    } else {
      expect.fail('Router module source should be inline')
    }
  })

  it('binds the router to every tenant (even no-domain ones, for cron dispatch)', () => {
    const config = buildCapnpFromWorkspace(
      manifest([
        worker('public', { domain: 'public.test' }),
        worker('internal'), // no domain
      ]),
    )
    const router = workerOf(findService(config, ROUTER_SERVICE_NAME))
    const names = router.bindings?.map((b) => b.name).sort() ?? []
    expect(names).toEqual(['WORKER_INTERNAL', 'WORKER_PUBLIC'])
  })

  it('applies workspace default compatibilityDate to the router', () => {
    const config = buildCapnpFromWorkspace({
      name: 'test',
      workers: [worker('a', { domain: 'a.test' })],
      defaults: { compatibilityDate: '2025-09-01' },
    })
    const router = workerOf(findService(config, ROUTER_SERVICE_NAME))
    expect(router.compatibilityDate).toBe('2025-09-01')
  })
})

describe('buildCapnpFromWorkspace — tenant service', () => {
  it('references entryPath via embed', () => {
    const config = buildCapnpFromWorkspace(manifest([worker('api')]))
    const tenant = workerOf(findService(config, tenantServiceName('api')))
    const mod = tenant.modules[0]!
    expect(mod.source.kind).toBe('esModule')
    if ('embedPath' in mod.source) {
      expect(mod.source.embedPath).toBe('workers/api/code/current/index.js')
    } else {
      expect.fail('Tenant module source should be an embed path')
    }
  })

  it('falls back to workspace defaults, then hard-coded fallback, for compatibilityDate', () => {
    const config = buildCapnpFromWorkspace({
      name: 'test',
      workers: [
        worker('a'), // no override
        worker('b', { compatibilityDate: '2026-06-01' }),
      ],
      defaults: { compatibilityDate: '2026-01-01' },
    })
    expect(workerOf(findService(config, tenantServiceName('a'))).compatibilityDate).toBe(
      '2026-01-01',
    )
    expect(workerOf(findService(config, tenantServiceName('b'))).compatibilityDate).toBe(
      '2026-06-01',
    )
  })

  it('omits bindings field when the worker has none', () => {
    const config = buildCapnpFromWorkspace(manifest([worker('a')]))
    expect(workerOf(findService(config, tenantServiceName('a'))).bindings).toBeUndefined()
  })
})

describe('buildCapnpFromWorkspace — variable bindings', () => {
  it('string vars become text bindings', () => {
    const config = buildCapnpFromWorkspace(
      manifest([worker('a', { vars: { GREETING: 'hello' } })]),
    )
    const tenant = workerOf(findService(config, tenantServiceName('a')))
    expect(tenant.bindings).toContainEqual({ name: 'GREETING', kind: 'text', value: 'hello' })
  })

  it('number vars become json bindings', () => {
    const config = buildCapnpFromWorkspace(
      manifest([worker('a', { vars: { COUNT: 42 } })]),
    )
    const tenant = workerOf(findService(config, tenantServiceName('a')))
    expect(tenant.bindings).toContainEqual({ name: 'COUNT', kind: 'json', value: '42' })
  })

  it('boolean vars become json bindings', () => {
    const config = buildCapnpFromWorkspace(
      manifest([worker('a', { vars: { ENABLED: true } })]),
    )
    const tenant = workerOf(findService(config, tenantServiceName('a')))
    expect(tenant.bindings).toContainEqual({ name: 'ENABLED', kind: 'json', value: 'true' })
  })
})

describe('buildCapnpFromWorkspace — binding mappings', () => {
  it('maps KV bindings to DO namespace bindings (the tenant shim wraps them as CF KV)', () => {
    const config = buildCapnpFromWorkspace(
      manifest([
        worker('api', {
          kvNamespaces: [{ binding: 'CACHE' }, { binding: 'SESSIONS' }],
        }),
      ]),
    )
    const tenant = workerOf(findService(config, tenantServiceName('api')))
    expect(tenant.bindings).toContainEqual({
      name: 'CACHE',
      kind: 'durableObjectNamespace',
      className: 'KvStore',
      serviceName: kvAdapterServiceName('api', 'CACHE'),
    })
    expect(tenant.bindings).toContainEqual({
      name: 'SESSIONS',
      kind: 'durableObjectNamespace',
      className: 'KvStore',
      serviceName: kvAdapterServiceName('api', 'SESSIONS'),
    })
  })

  it('emits a KvStore adapter service per KV binding', () => {
    const config = buildCapnpFromWorkspace(
      manifest([
        worker('api', {
          kvNamespaces: [{ binding: 'CACHE' }, { binding: 'SESSIONS' }],
        }),
      ]),
    )
    expect(config.services.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        kvAdapterServiceName('api', 'CACHE'),
        kvAdapterServiceName('api', 'SESSIONS'),
      ]),
    )
  })

  it('maps D1 bindings to canonical d1AdapterServiceName keyed by database_name', () => {
    const config = buildCapnpFromWorkspace(
      manifest([
        worker('api', {
          d1Databases: [{ binding: 'DB', databaseName: 'production' }],
        }),
      ]),
    )
    const tenant = workerOf(findService(config, tenantServiceName('api')))
    expect(tenant.bindings).toContainEqual({
      name: 'DB',
      kind: 'd1Database',
      service: d1AdapterServiceName('api', 'production'),
    })
  })

  it('maps R2 bindings to canonical r2AdapterServiceName', () => {
    const config = buildCapnpFromWorkspace(
      manifest([worker('api', { r2Buckets: [{ binding: 'ASSETS' }] })]),
    )
    const tenant = workerOf(findService(config, tenantServiceName('api')))
    expect(tenant.bindings).toContainEqual({
      name: 'ASSETS',
      kind: 'r2Bucket',
      service: r2AdapterServiceName('api', 'ASSETS'),
    })
  })

  it('maps service bindings to the target tenant service name', () => {
    const config = buildCapnpFromWorkspace(
      manifest([
        worker('api'),
        worker('admin', { serviceBindings: [{ binding: 'API', service: 'api' }] }),
      ]),
    )
    const tenant = workerOf(findService(config, tenantServiceName('admin')))
    expect(tenant.bindings).toContainEqual({
      name: 'API',
      kind: 'service',
      service: tenantServiceName('api'),
    })
  })

  it('maps DO bindings with same-worker classes (no serviceName)', () => {
    const config = buildCapnpFromWorkspace(
      manifest([
        worker('stateful', {
          durableObjects: [{ binding: 'COUNTER', className: 'Counter' }],
        }),
      ]),
    )
    const tenant = workerOf(findService(config, tenantServiceName('stateful')))
    expect(tenant.bindings).toContainEqual({
      name: 'COUNTER',
      kind: 'durableObjectNamespace',
      className: 'Counter',
    })
  })

  it('maps DO bindings with cross-worker scriptName', () => {
    const config = buildCapnpFromWorkspace(
      manifest([
        worker('counters'),
        worker('reader', {
          durableObjects: [
            { binding: 'COUNTERS', className: 'Counter', scriptName: 'counters' },
          ],
        }),
      ]),
    )
    const tenant = workerOf(findService(config, tenantServiceName('reader')))
    expect(tenant.bindings).toContainEqual({
      name: 'COUNTERS',
      kind: 'durableObjectNamespace',
      className: 'Counter',
      serviceName: tenantServiceName('counters'),
    })
  })
})

describe('buildCapnpFromWorkspace — validation', () => {
  it('rejects duplicate worker names', () => {
    expect(() => buildCapnpFromWorkspace(manifest([worker('api'), worker('api')]))).toThrow(
      ManifestError,
    )
  })

  it('rejects duplicate domains (case-insensitive)', () => {
    expect(() =>
      buildCapnpFromWorkspace(
        manifest([worker('a', { domain: 'api.test' }), worker('b', { domain: 'API.TEST' })]),
      ),
    ).toThrow(/Duplicate domain/)
  })

  it('rejects worker names that do not match the identifier pattern', () => {
    expect(() => buildCapnpFromWorkspace(manifest([worker('Api')]))).toThrow(
      /Invalid worker name/,
    )
    expect(() => buildCapnpFromWorkspace(manifest([worker('1api')]))).toThrow(
      /Invalid worker name/,
    )
    expect(() => buildCapnpFromWorkspace(manifest([worker('api_name')]))).toThrow(
      /Invalid worker name/,
    )
    expect(() => buildCapnpFromWorkspace(manifest([worker('a'.repeat(41))]))).toThrow(
      /Invalid worker name/,
    )
  })

  it('rejects service bindings to unknown workers', () => {
    expect(() =>
      buildCapnpFromWorkspace(
        manifest([
          worker('api', {
            serviceBindings: [{ binding: 'OTHER', service: 'ghost' }],
          }),
        ]),
      ),
    ).toThrow(/unknown worker "ghost"/)
  })

  it('accepts multiple workers with no domains (service-binding-only)', () => {
    const config = buildCapnpFromWorkspace(
      manifest([worker('a'), worker('b'), worker('c')]),
    )
    expect(config.services.length).toBe(4) // router + 3 tenants
  })
})
