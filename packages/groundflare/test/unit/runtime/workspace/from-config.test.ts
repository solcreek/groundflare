import { describe, it, expect } from 'vitest'
import { detectUnsupportedBindings, workspaceWorkerFromConfig } from '../../../../src/runtime/workspace/index.js'
import type { GroundflareSection, WranglerConfig } from '../../../../src/config/index.js'

function minimalWrangler(overrides: Partial<WranglerConfig> = {}): WranglerConfig {
  return {
    name: 'api',
    main: 'src/index.ts',
    ...overrides,
  }
}

describe('workspaceWorkerFromConfig', () => {
  it('maps basic fields and rewrites entryPath to the on-VPS layout', () => {
    const w = workspaceWorkerFromConfig(minimalWrangler(), {})
    expect(w.name).toBe('api')
    expect(w.entryPath).toBe('workers/api/code/current/index.js')
    expect(w.domain).toBeUndefined()
    expect(w.vars).toBeUndefined()
  })

  it('passes through the domain from [groundflare]', () => {
    const w = workspaceWorkerFromConfig(minimalWrangler(), {
      domain: 'api.example.com',
    })
    expect(w.domain).toBe('api.example.com')
  })

  it('reads domain from routes with custom_domain: true', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        routes: [
          { pattern: 'shop.example.com', custom_domain: true },
        ],
      }),
      {},
    )
    expect(w.domain).toBe('shop.example.com')
  })

  it('[groundflare].domain takes precedence over routes', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        routes: [
          { pattern: 'shop.example.com', custom_domain: true },
        ],
      }),
      { domain: 'override.example.com' },
    )
    expect(w.domain).toBe('override.example.com')
  })

  it('ignores routes without custom_domain: true', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        routes: [
          { pattern: 'example.com/*' },
          'other.example.com/*',
        ],
      }),
      {},
    )
    expect(w.domain).toBeUndefined()
  })

  it('picks the first custom_domain route when multiple exist', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        routes: [
          { pattern: 'first.example.com', custom_domain: true },
          { pattern: 'second.example.com', custom_domain: true },
        ],
      }),
      {},
    )
    expect(w.domain).toBe('first.example.com')
  })

  it('passes through compatibility_date + flags', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        compatibility_date: '2026-04-01',
        compatibility_flags: ['nodejs_compat'],
      }),
      {},
    )
    expect(w.compatibilityDate).toBe('2026-04-01')
    expect(w.compatibilityFlags).toEqual(['nodejs_compat'])
  })

  it('maps [vars] to the manifest vars shape (string/number/boolean)', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        vars: { GREETING: 'hello', COUNT: 42, ENABLED: true },
      }),
      {},
    )
    expect(w.vars).toEqual({ GREETING: 'hello', COUNT: 42, ENABLED: true })
  })

  it('omits vars when [vars] is empty', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({ vars: {} }),
      {},
    )
    expect(w.vars).toBeUndefined()
  })

  it('rejects non-scalar var values', () => {
    expect(() =>
      workspaceWorkerFromConfig(
        minimalWrangler({
          vars: { NESTED: ({ a: 1 } as unknown) as string },
        }),
        {},
      ),
    ).toThrow(/NESTED.*unsupported type/)
  })

  it('maps KV namespaces to WorkspaceWorker.kvNamespaces', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        kv_namespaces: [
          { binding: 'CACHE', id: 'kv-1' },
          { binding: 'SESSIONS', id: 'kv-2' },
        ],
      }),
      {},
    )
    expect(w.kvNamespaces).toEqual([{ binding: 'CACHE' }, { binding: 'SESSIONS' }])
  })

  it('maps D1 databases keyed by database_name', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        d1_databases: [
          { binding: 'DB', database_name: 'production', database_id: 'd1-1' },
        ],
      }),
      {},
    )
    expect(w.d1Databases).toEqual([{ binding: 'DB', databaseName: 'production' }])
  })

  it('maps R2 buckets', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        r2_buckets: [{ binding: 'ASSETS', bucket_name: 'my-assets' }],
      }),
      {},
    )
    expect(w.r2Buckets).toEqual([{ binding: 'ASSETS' }])
  })

  it('maps Durable Objects with and without scriptName', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        durable_objects: {
          bindings: [
            { name: 'COUNTER', class_name: 'Counter' },
            { name: 'OTHER', class_name: 'Other', script_name: 'counters' },
          ],
        },
      }),
      {},
    )
    expect(w.durableObjects).toEqual([
      { binding: 'COUNTER', className: 'Counter' },
      { binding: 'OTHER', className: 'Other', scriptName: 'counters' },
    ])
  })

  it('deployedEntryName override changes the file name in entryPath', () => {
    const w = workspaceWorkerFromConfig(minimalWrangler(), {}, {
      deployedEntryName: 'bundle.mjs',
    })
    expect(w.entryPath).toBe('workers/api/code/current/bundle.mjs')
  })

  it('maps worker_loaders to workerLoaders', () => {
    const w = workspaceWorkerFromConfig(
      minimalWrangler({
        worker_loaders: [{ binding: 'LOADER' }],
      }),
      {},
    )
    expect(w.workerLoaders).toEqual([{ binding: 'LOADER' }])
  })

  it('omits workerLoaders when none configured', () => {
    const w = workspaceWorkerFromConfig(minimalWrangler(), {})
    expect(w.workerLoaders).toBeUndefined()
  })

  it('omits binding arrays when the config has none', () => {
    const w = workspaceWorkerFromConfig(minimalWrangler(), {} as GroundflareSection)
    expect(w.kvNamespaces).toBeUndefined()
    expect(w.d1Databases).toBeUndefined()
    expect(w.r2Buckets).toBeUndefined()
    expect(w.durableObjects).toBeUndefined()
  })
})

describe('detectUnsupportedBindings', () => {
  it('returns empty for a clean config', () => {
    expect(detectUnsupportedBindings(minimalWrangler())).toEqual([])
  })

  it('warns about ai binding', () => {
    const warnings = detectUnsupportedBindings(minimalWrangler({ ai: { binding: 'AI' } }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/Workers AI/)
  })

  it('warns about multiple unsupported bindings', () => {
    const warnings = detectUnsupportedBindings(
      minimalWrangler({ ai: {}, vectorize: {}, queues: {} }),
    )
    expect(warnings).toHaveLength(3)
  })

  it('warns about observability config', () => {
    const warnings = detectUnsupportedBindings(
      minimalWrangler({ observability: { enabled: true } }),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/observability/)
  })

  it('does not warn about supported bindings', () => {
    const warnings = detectUnsupportedBindings(
      minimalWrangler({
        d1_databases: [{ binding: 'DB', database_name: 'main' }],
        worker_loaders: [{ binding: 'LOADER' }],
      }),
    )
    expect(warnings).toEqual([])
  })
})
