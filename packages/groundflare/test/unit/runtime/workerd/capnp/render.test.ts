import { describe, it, expect } from 'vitest'
import {
  formatData,
  quote,
  renderCapnpConfig,
} from '../../../../../src/runtime/workerd/capnp/index.js'
import type {
  CapnpWorker,
  CapnpWorkerdConfig,
} from '../../../../../src/runtime/workerd/capnp/index.js'

describe('quote', () => {
  it('wraps simple strings in double quotes', () => {
    expect(quote('hello')).toBe('"hello"')
  })

  it('escapes backslashes', () => {
    expect(quote('a\\b')).toBe('"a\\\\b"')
  })

  it('escapes embedded double quotes', () => {
    expect(quote('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('escapes control characters: newline, tab, carriage return', () => {
    expect(quote('line1\nline2')).toBe('"line1\\nline2"')
    expect(quote('col1\tcol2')).toBe('"col1\\tcol2"')
    expect(quote('x\rr')).toBe('"x\\rr"')
  })

  it('escapes other control chars as \\xNN', () => {
    expect(quote('\x01\x02')).toBe('"\\x01\\x02"')
  })

  it('passes unicode through unchanged', () => {
    expect(quote('你好')).toBe('"你好"')
    expect(quote('🦀')).toBe('"🦀"')
  })

  it('handles empty strings', () => {
    expect(quote('')).toBe('""')
  })
})

describe('formatData', () => {
  it('emits 0x"<hex>" for a Uint8Array', () => {
    expect(formatData(new Uint8Array([0, 1, 2, 255]))).toBe('0x"000102ff"')
  })

  it('handles empty bytes', () => {
    expect(formatData(new Uint8Array())).toBe('0x""')
  })
})

describe('renderCapnpConfig — minimal', () => {
  it('emits the using header + Workerd.Config constant', () => {
    const config: CapnpWorkerdConfig = { services: [], sockets: [] }
    const out = renderCapnpConfig(config)
    expect(out).toContain('using Workerd = import "/workerd/workerd.capnp";')
    expect(out).toContain('const config :Workerd.Config = (')
    expect(out).toContain('services = []')
    expect(out).toContain('sockets = []')
    expect(out.trimEnd().endsWith(');')).toBe(true)
  })

  it('terminates the config with a semicolon and newline', () => {
    const config: CapnpWorkerdConfig = { services: [], sockets: [] }
    expect(renderCapnpConfig(config)).toMatch(/;\n$/)
  })
})

describe('renderCapnpConfig — single worker + socket', () => {
  const config: CapnpWorkerdConfig = {
    services: [
      {
        name: 'main',
        kind: 'worker',
        worker: {
          modules: [
            { name: 'worker.js', source: { kind: 'esModule', embedPath: 'index.js' } },
          ],
          compatibilityDate: '2026-04-01',
        },
      },
    ],
    sockets: [{ name: 'http', address: '*:8080', service: 'main' }],
  }

  it('matches the expected snapshot', () => {
    expect(renderCapnpConfig(config)).toMatchInlineSnapshot(`
      "using Workerd = import "/workerd/workerd.capnp";

      const config :Workerd.Config = (
        services = [
          (
            name = "main",
            worker = (modules = [(name = "worker.js", esModule = embed "index.js")], compatibilityDate = "2026-04-01")
          )
        ],
        sockets = [(name = "http", address = "*:8080", http = (), service = "main")]
      );
      "
    `)
  })

  it('includes the embed directive for the module', () => {
    expect(renderCapnpConfig(config)).toContain('esModule = embed "index.js"')
  })

  it('emits http socket default when protocol omitted', () => {
    expect(renderCapnpConfig(config)).toContain('http = ()')
  })

  it('emits https socket when protocol=https', () => {
    const https: CapnpWorkerdConfig = {
      ...config,
      sockets: [{ ...config.sockets[0]!, protocol: 'https' }],
    }
    expect(renderCapnpConfig(https)).toContain('https = ()')
  })
})

describe('renderCapnpConfig — bindings', () => {
  function withBindings(bindings: NonNullable<CapnpWorker['bindings']>): string {
    return renderCapnpConfig({
      services: [
        {
          name: 'main',
          kind: 'worker',
          worker: {
            modules: [
              { name: 'worker.js', source: { kind: 'esModule', embedPath: 'index.js' } },
            ],
            bindings,
          },
        },
      ],
      sockets: [],
    })
  }

  it('emits text binding', () => {
    expect(withBindings([{ name: 'GREETING', kind: 'text', value: 'hello' }])).toContain(
      '(name = "GREETING", text = "hello")',
    )
  })

  it('emits json binding with all inner quotes escaped', () => {
    const out = withBindings([{ name: 'CFG', kind: 'json', value: '{"count":42}' }])
    expect(out).toContain('json = "{\\"count\\":42}"')
  })

  it('escapes embedded quotes and backslashes inside json values', () => {
    const out = withBindings([
      { name: 'X', kind: 'json', value: '{"k":"v","msg":"he said \\"hi\\""}' },
    ])
    // Inner `"` escapes to `\"` in capnp; inner `\"` (backslash-quote) escapes to `\\\"`.
    expect(out).toContain('\\"k\\":\\"v\\"')
    expect(out).toContain('he said \\\\\\"hi\\\\\\"')
  })

  it('emits service, kvNamespace, d1Database, r2Bucket as ServiceDesignators', () => {
    const out = withBindings([
      { name: 'SVC', kind: 'service', service: 'other' },
      { name: 'CACHE', kind: 'kvNamespace', service: 'adapter-kv-CACHE' },
      { name: 'DB', kind: 'd1Database', service: 'adapter-d1-DB' },
      { name: 'FILES', kind: 'r2Bucket', service: 'adapter-r2-FILES' },
    ])
    expect(out).toContain('(name = "SVC", service = "other")')
    expect(out).toContain('(name = "CACHE", kvNamespace = "adapter-kv-CACHE")')
    expect(out).toContain('(name = "DB", d1Database = "adapter-d1-DB")')
    expect(out).toContain('(name = "FILES", r2Bucket = "adapter-r2-FILES")')
  })

  it('emits fromEnvironment binding', () => {
    expect(
      withBindings([{ name: 'SECRET', kind: 'fromEnvironment', envVar: 'API_TOKEN' }]),
    ).toContain('(name = "SECRET", fromEnvironment = "API_TOKEN")')
  })

  it('emits data binding as 0x"<hex>"', () => {
    expect(
      withBindings([
        { name: 'PAYLOAD', kind: 'data', value: new Uint8Array([1, 2, 3]) },
      ]),
    ).toContain('(name = "PAYLOAD", data = 0x"010203")')
  })

  it('emits durableObjectNamespace binding with className only', () => {
    const out = withBindings([
      { name: 'COUNTER', kind: 'durableObjectNamespace', className: 'Counter' },
    ])
    expect(out).toContain('name = "COUNTER"')
    expect(out).toContain('durableObjectNamespace = ')
    expect(out).toContain('className = "Counter"')
    expect(out).not.toContain('serviceName')
  })

  it('emits durableObjectNamespace with serviceName for cross-worker DO', () => {
    const out = withBindings([
      {
        name: 'COUNTER',
        kind: 'durableObjectNamespace',
        className: 'Counter',
        serviceName: 'worker-counter',
      },
    ])
    expect(out).toContain('serviceName = "worker-counter"')
  })

  it('emits workerLoader binding without id', () => {
    const out = withBindings([
      { name: 'LOADER', kind: 'workerLoader' },
    ])
    expect(out).toContain('(name = "LOADER", workerLoader = ())')
  })

  it('emits workerLoader binding with shared cache id', () => {
    const out = withBindings([
      { name: 'LOADER', kind: 'workerLoader', id: 'shared' },
    ])
    expect(out).toContain('name = "LOADER"')
    expect(out).toContain('workerLoader = (id = "shared")')
  })

  it('skips the bindings array when empty', () => {
    expect(withBindings([])).not.toContain('bindings = [')
  })
})

describe('renderCapnpConfig — worker optional fields', () => {
  function withWorker(worker: CapnpWorker): string {
    return renderCapnpConfig({
      services: [{ name: 'main', kind: 'worker', worker }],
      sockets: [],
    })
  }

  it('omits compatibilityDate when unspecified', () => {
    expect(
      withWorker({
        modules: [{ name: 'worker.js', source: { kind: 'esModule', embedPath: 'x.js' } }],
      }),
    ).not.toContain('compatibilityDate')
  })

  it('emits compatibilityFlags as a list', () => {
    expect(
      withWorker({
        modules: [{ name: 'worker.js', source: { kind: 'esModule', embedPath: 'x.js' } }],
        compatibilityFlags: ['nodejs_compat', 'streams_enable_constructors'],
      }),
    ).toContain(
      'compatibilityFlags = ["nodejs_compat", "streams_enable_constructors"]',
    )
  })

  it('emits durableObjectNamespaces declarations', () => {
    const out = withWorker({
      modules: [{ name: 'worker.js', source: { kind: 'esModule', embedPath: 'x.js' } }],
      durableObjectNamespaces: [
        { className: 'Counter', enableSql: true },
        { className: 'Room', uniqueKey: 'rooms-v2' },
      ],
    })
    expect(out).toContain('durableObjectNamespaces = [')
    expect(out).toContain('className = "Counter"')
    expect(out).toContain('enableSql = true')
    expect(out).toContain('uniqueKey = "rooms-v2"')
  })

  it('emits durableObjectStorage with localDisk path', () => {
    expect(
      withWorker({
        modules: [{ name: 'worker.js', source: { kind: 'esModule', embedPath: 'x.js' } }],
        durableObjectStorage: { localDiskPath: '/var/lib/groundflare/workers/api/do' },
      }),
    ).toContain('durableObjectStorage = (localDisk = "/var/lib/groundflare/workers/api/do")')
  })

  it('emits globalOutbound service reference', () => {
    expect(
      withWorker({
        modules: [{ name: 'worker.js', source: { kind: 'esModule', embedPath: 'x.js' } }],
        globalOutbound: 'outbound-proxy',
      }),
    ).toContain('globalOutbound = "outbound-proxy"')
  })

  it('emits inline esModule source when provided', () => {
    expect(
      withWorker({
        modules: [
          {
            name: 'worker.js',
            source: {
              kind: 'esModule',
              inline: 'export default { async fetch() { return new Response("ok") } }',
            },
          },
        ],
      }),
    ).toContain('export default')
  })
})

describe('renderCapnpConfig — non-worker services', () => {
  it('emits disk service', () => {
    const out = renderCapnpConfig({
      services: [
        {
          name: 'assets',
          kind: 'disk',
          path: '/var/lib/groundflare/workers/api/assets',
          writable: true,
        },
      ],
      sockets: [],
    })
    expect(out).toContain('(name = "assets", disk = (path = "/var/lib/groundflare/workers/api/assets", writable = true))')
  })

  it('emits external service with http flag', () => {
    const out = renderCapnpConfig({
      services: [{ name: 'origin', kind: 'external', address: 'localhost:9000', http: true }],
      sockets: [],
    })
    expect(out).toContain('(name = "origin", external = (address = "localhost:9000", http = ()))')
  })

  it('emits network service', () => {
    const out = renderCapnpConfig({
      services: [{ name: 'internet', kind: 'network' }],
      sockets: [],
    })
    expect(out).toContain('(name = "internet", network = ())')
  })
})

describe('renderCapnpConfig — multi-tenant (workspace shape)', () => {
  it('emits a router + two tenants with their own bindings', () => {
    const out = renderCapnpConfig({
      services: [
        {
          name: 'router',
          kind: 'worker',
          worker: {
            modules: [
              {
                name: 'worker.js',
                source: { kind: 'esModule', embedPath: 'system/router.js' },
              },
            ],
            compatibilityDate: '2026-04-01',
            bindings: [
              { name: 'WORKER_API', kind: 'service', service: 'worker-api' },
              { name: 'WORKER_ADMIN', kind: 'service', service: 'worker-admin' },
            ],
          },
        },
        {
          name: 'worker-api',
          kind: 'worker',
          worker: {
            modules: [
              {
                name: 'worker.js',
                source: { kind: 'esModule', embedPath: 'workers/api/code/current/index.js' },
              },
            ],
            compatibilityDate: '2026-04-01',
            bindings: [
              { name: 'GREETING', kind: 'text', value: 'hello' },
              { name: 'CACHE', kind: 'kvNamespace', service: 'adapter-kv-api-CACHE' },
            ],
          },
        },
        {
          name: 'worker-admin',
          kind: 'worker',
          worker: {
            modules: [
              {
                name: 'worker.js',
                source: { kind: 'esModule', embedPath: 'workers/admin/code/current/index.js' },
              },
            ],
            compatibilityDate: '2026-04-01',
            bindings: [{ name: 'DB', kind: 'd1Database', service: 'adapter-d1-admin-DB' }],
          },
        },
      ],
      sockets: [{ name: 'http', address: '*:8080', service: 'router' }],
    })

    // Structural assertions — don't snapshot the whole thing; that grows brittle.
    expect(out).toContain('name = "router"')
    expect(out).toContain('name = "worker-api"')
    expect(out).toContain('name = "worker-admin"')
    expect(out).toContain('WORKER_API')
    expect(out).toContain('WORKER_ADMIN')
    expect(out).toContain('kvNamespace = "adapter-kv-api-CACHE"')
    expect(out).toContain('d1Database = "adapter-d1-admin-DB"')
    expect(out).toContain('service = "router"')
    // Each worker lists its own module — no cross-contamination.
    const apiCount = (out.match(/workers\/api\/code\/current\/index\.js/g) ?? []).length
    const adminCount = (out.match(/workers\/admin\/code\/current\/index\.js/g) ?? []).length
    expect(apiCount).toBe(1)
    expect(adminCount).toBe(1)
  })
})

describe('renderCapnpConfig — formatting stability', () => {
  it('is deterministic for the same input', () => {
    const config: CapnpWorkerdConfig = {
      services: [
        {
          name: 'main',
          kind: 'worker',
          worker: {
            modules: [
              { name: 'worker.js', source: { kind: 'esModule', embedPath: 'index.js' } },
            ],
            compatibilityDate: '2026-04-01',
            bindings: [
              { name: 'A', kind: 'text', value: '1' },
              { name: 'B', kind: 'text', value: '2' },
            ],
          },
        },
      ],
      sockets: [{ name: 'http', address: '*:8080', service: 'main' }],
    }
    expect(renderCapnpConfig(config)).toBe(renderCapnpConfig(config))
  })
})
