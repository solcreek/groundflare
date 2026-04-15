import { describe, it, expect } from 'vitest'
import {
  buildBunArtifact,
  isBunWorkspace,
} from '../../../../src/runtime/bun/build.js'
import type { WorkspaceManifest } from '../../../../src/runtime/workspace/types.js'

function manifest(
  over: Partial<WorkspaceManifest['workers'][number]> = {},
  tweak: Partial<WorkspaceManifest> = {},
): WorkspaceManifest {
  return {
    name: 'test-workspace',
    workers: [
      {
        name: 'api',
        domain: 'api.example.com',
        entryPath: 'src/index.ts',
        ...over,
      },
    ],
    ...tweak,
  }
}

describe('buildBunArtifact — validation', () => {
  it('throws when the manifest has no workers', () => {
    expect(() =>
      buildBunArtifact({ name: 'empty', workers: [] }),
    ).toThrow(/at least one worker/)
  })

  it('throws on multi-worker manifests with a Phase-2 migration hint', () => {
    const m: WorkspaceManifest = {
      name: 'mt',
      workers: [
        { name: 'a', entryPath: 'a.js' },
        { name: 'b', entryPath: 'b.js' },
      ],
    }
    expect(() => buildBunArtifact(m)).toThrow(
      /multi-worker workspaces.*not yet supported/,
    )
    expect(() => buildBunArtifact(m)).toThrow(/Phase 2/)
  })
})

describe('buildBunArtifact — defaults', () => {
  it('deployRoot defaults to /var/lib/groundflare', () => {
    const a = buildBunArtifact(manifest())
    expect(a.deployRoot).toBe('/var/lib/groundflare')
    expect(a.entryModulePath).toBe('/var/lib/groundflare/server.ts')
  })

  it('userEntryRelativePath is "user.js" in Phase 1', () => {
    const a = buildBunArtifact(manifest())
    expect(a.userEntryRelativePath).toBe('user.js')
  })

  it('server.ts imports from ./user.js', () => {
    const a = buildBunArtifact(manifest())
    expect(a.serverSource).toContain('import user from "./user.js"')
  })

  it('server.ts listens on 0.0.0.0:8080 by default', () => {
    const a = buildBunArtifact(manifest())
    expect(a.serverSource).toContain('hostname: "0.0.0.0"')
    expect(a.serverSource).toContain('port: 8080')
  })

  it('systemd unit WorkingDirectory matches deployRoot', () => {
    const a = buildBunArtifact(manifest())
    expect(a.systemdUnit).toContain('WorkingDirectory=/var/lib/groundflare')
    expect(a.systemdUnit).toContain(
      'ExecStart=/usr/local/bin/bun run /var/lib/groundflare/server.ts',
    )
  })

  it('systemd unit description embeds the workspace name', () => {
    const a = buildBunArtifact(manifest({}, { name: 'my-stack' }))
    expect(a.systemdUnit).toContain(
      'Description=groundflare Bun runtime for workspace my-stack',
    )
  })
})

describe('buildBunArtifact — overrides', () => {
  it('honours custom deployRoot for entry path, working directory, and state dirs', () => {
    const a = buildBunArtifact(
      manifest({
        kvNamespaces: [{ binding: 'CACHE' }],
      }),
      { deployRoot: '/srv/gf' },
    )
    expect(a.deployRoot).toBe('/srv/gf')
    expect(a.entryModulePath).toBe('/srv/gf/server.ts')
    expect(a.systemdUnit).toContain('WorkingDirectory=/srv/gf')
    expect(a.systemdUnit).toContain(
      'ExecStart=/usr/local/bin/bun run /srv/gf/server.ts',
    )
    expect(a.stateDirs).toContain('/srv/gf')
    expect(a.stateDirs).toContain('/srv/gf/kv')
  })

  it('honours custom listenAddress', () => {
    const a = buildBunArtifact(manifest(), { listenAddress: '127.0.0.1:3001' })
    expect(a.serverSource).toContain('hostname: "127.0.0.1"')
    expect(a.serverSource).toContain('port: 3001')
  })

  it('merges systemd option overrides on top of defaults', () => {
    const a = buildBunArtifact(manifest(), {
      systemd: { memoryMaxPercent: 50, cpuQuotaPercent: 60 },
    })
    expect(a.systemdUnit).toContain('MemoryMax=50%')
    expect(a.systemdUnit).toContain('CPUQuota=60%')
  })
})

describe('buildBunArtifact — binding wiring', () => {
  it('forwards [vars] into the shim', () => {
    const a = buildBunArtifact(
      manifest({ vars: { APP_NAME: 'demo', COUNT: 42 } }),
    )
    expect(a.serverSource).toContain(
      'const VARS = {"APP_NAME":"demo","COUNT":42}',
    )
  })

  it('forwards KV bindings with shard counts', () => {
    const a = buildBunArtifact(
      manifest({
        kvNamespaces: [
          { binding: 'CACHE', shards: 4 },
          { binding: 'SESSIONS' },
        ],
      }),
    )
    expect(a.serverSource).toContain(
      'const KV_BINDINGS = {"CACHE":{"shards":4},"SESSIONS":{"shards":1}}',
    )
  })

  it('forwards D1 bindings', () => {
    const a = buildBunArtifact(
      manifest({
        d1Databases: [{ binding: 'DB', databaseName: 'prod' }],
      }),
    )
    expect(a.serverSource).toContain(
      'const D1_BINDINGS = {"DB":{"databaseName":"prod"}}',
    )
  })

  it('forwards R2 bindings', () => {
    const a = buildBunArtifact(
      manifest({
        r2Buckets: [{ binding: 'ASSETS' }],
      }),
    )
    expect(a.serverSource).toContain(
      'const R2_BINDINGS = {"ASSETS":{"bucketName":"ASSETS"}}',
    )
  })
})

describe('buildBunArtifact — state directories', () => {
  it('includes only deployRoot when the worker has no bindings', () => {
    const a = buildBunArtifact(manifest())
    expect(a.stateDirs).toEqual(['/var/lib/groundflare'])
  })

  it('adds a /d1 directory when D1 bindings are declared', () => {
    const a = buildBunArtifact(
      manifest({
        d1Databases: [{ binding: 'DB', databaseName: 'x' }],
      }),
    )
    expect(a.stateDirs).toContain('/var/lib/groundflare/d1')
  })

  it('adds /kv and /r2 dirs when those bindings are declared', () => {
    const a = buildBunArtifact(
      manifest({
        kvNamespaces: [{ binding: 'CACHE' }],
        r2Buckets: [{ binding: 'ASSETS' }],
      }),
    )
    expect(a.stateDirs).toContain('/var/lib/groundflare/kv')
    expect(a.stateDirs).toContain('/var/lib/groundflare/r2')
  })

  it('state dirs are parent-before-child for stable mkdir ordering', () => {
    const a = buildBunArtifact(
      manifest({
        kvNamespaces: [{ binding: 'CACHE' }],
        d1Databases: [{ binding: 'DB', databaseName: 'x' }],
        r2Buckets: [{ binding: 'ASSETS' }],
      }),
    )
    expect(a.stateDirs[0]).toBe('/var/lib/groundflare')
  })
})

describe('buildBunArtifact — adapter sources', () => {
  it('always ships adapters/kv.ts alongside server.ts', () => {
    const a = buildBunArtifact(manifest())
    expect(a.adapterSources).toHaveProperty('adapters/kv.ts')
    // The file must look like the real adapter, not an empty stub.
    expect(a.adapterSources['adapters/kv.ts']).toContain(
      'export class BunKVAdapter',
    )
    expect(a.adapterSources['adapters/kv.ts']).toContain('from \'bun:sqlite\'')
  })

  it('ships KV adapter even when the worker has no KV bindings', () => {
    // server.ts unconditionally imports it; shipping a dead file is
    // cheaper than forking the shim template around the import.
    const a = buildBunArtifact(manifest())
    expect(a.adapterSources['adapters/kv.ts']).toBeDefined()
  })
})

describe('isBunWorkspace', () => {
  it('returns false when runtime is unset (default = workerd)', () => {
    expect(isBunWorkspace(manifest())).toBe(false)
  })

  it('returns false when runtime = "workerd" explicitly', () => {
    const m: WorkspaceManifest = { ...manifest(), runtime: 'workerd' }
    expect(isBunWorkspace(m)).toBe(false)
  })

  it('returns true when runtime = "bun"', () => {
    const m: WorkspaceManifest = { ...manifest(), runtime: 'bun' }
    expect(isBunWorkspace(m)).toBe(true)
  })
})
