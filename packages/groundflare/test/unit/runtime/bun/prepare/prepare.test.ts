import { describe, it, expect } from 'vitest'
import {
  prepareWorkspace,
  type PrepareFs,
} from '../../../../../src/runtime/bun/prepare/index.js'
import type { WranglerConfig } from '../../../../../src/config/schema.js'

function memoryFs(opts: {
  files: Record<string, string>
  wranglerSource: string
  /** Track writes for assertions. */
  writes?: { wrangler: string[] }
}): PrepareFs {
  const writes = opts.writes ?? { wrangler: [] }
  let current = opts.wranglerSource
  return {
    async listSourceFiles() {
      return Object.keys(opts.files).sort()
    },
    async readSource(path) {
      const c = opts.files[path]
      if (c === undefined) throw new Error(`missing: ${path}`)
      return c
    },
    async readWranglerSource() {
      return current
    },
    async writeWranglerSource(content) {
      writes.wrangler.push(content)
      current = content
    },
  }
}

describe('prepareWorkspace — happy path', () => {
  it('flips runtime to "bun" when analyze is clean', async () => {
    const wrangler: WranglerConfig = {
      name: 'demo',
      kv_namespaces: [{ binding: 'CACHE', id: '...' }],
    }
    const wranglerSource = `name = "demo"
[groundflare]
provider = "hetzner"
runtime = "workerd"
`
    const writes = { wrangler: [] as string[] }
    const r = await prepareWorkspace({
      wrangler,
      sourceRoot: 'src',
      wranglerPath: 'wrangler.toml',
      wranglerFormat: 'toml',
      fs: memoryFs({
        files: {
          'src/index.ts':
            'export default { async fetch(_,env){return new Response(await env.CACHE.get("k"))} }',
        },
        wranglerSource,
        writes,
      }),
    })
    expect(r.ok).toBe(true)
    expect(r.actions).toHaveLength(1)
    expect(r.actions[0]?.kind).toBe('runtime-set-bun')
    expect(r.actions[0]?.message).toContain('"workerd"')
    expect(writes.wrangler).toHaveLength(1)
    expect(writes.wrangler[0]).toContain('runtime = "bun"')
  })

  it('reports "runtime-already-bun" without writing when already on the Bun track', async () => {
    const wranglerSource = `[groundflare]
runtime = "bun"
`
    const writes = { wrangler: [] as string[] }
    const r = await prepareWorkspace({
      wrangler: { name: 'demo' },
      sourceRoot: 'src',
      wranglerPath: 'wrangler.toml',
      wranglerFormat: 'toml',
      fs: memoryFs({
        files: { 'src/index.ts': 'export default { fetch() { return new Response() } }' },
        wranglerSource,
        writes,
      }),
    })
    expect(r.ok).toBe(true)
    expect(r.actions[0]?.kind).toBe('runtime-already-bun')
    expect(writes.wrangler).toHaveLength(0)
  })

  it('appends a [groundflare] section when the file has none', async () => {
    const wranglerSource = `name = "demo"\n`
    const writes = { wrangler: [] as string[] }
    const r = await prepareWorkspace({
      wrangler: { name: 'demo' },
      sourceRoot: 'src',
      wranglerPath: 'wrangler.toml',
      wranglerFormat: 'toml',
      fs: memoryFs({
        files: { 'src/index.ts': 'export default { fetch() { return new Response() } }' },
        wranglerSource,
        writes,
      }),
    })
    expect(r.ok).toBe(true)
    expect(r.actions[0]?.kind).toBe('runtime-appended')
    expect(writes.wrangler[0]).toContain('runtime = "bun"')
  })
})

describe('prepareWorkspace — bail conditions', () => {
  it('bails without writing when analyze reports blockers', async () => {
    const wranglerSource = `name = "demo"\n[groundflare]\nruntime = "workerd"\n`
    const writes = { wrangler: [] as string[] }
    const r = await prepareWorkspace({
      wrangler: { name: 'demo' },
      sourceRoot: 'src',
      wranglerPath: 'wrangler.toml',
      wranglerFormat: 'toml',
      fs: memoryFs({
        files: {
          'src/index.ts':
            'export default { fetch() { return new HTMLRewriter().transform(new Response()) } }',
        },
        wranglerSource,
        writes,
      }),
    })
    expect(r.ok).toBe(false)
    expect(r.actions).toEqual([])
    expect(writes.wrangler).toHaveLength(0)
    expect(r.bailReason).toMatch(/blocker/i)
  })

  it('bails when wrangler format is not TOML', async () => {
    const r = await prepareWorkspace({
      wrangler: { name: 'demo' },
      sourceRoot: 'src',
      wranglerPath: 'wrangler.jsonc',
      wranglerFormat: 'jsonc',
      fs: memoryFs({
        files: { 'src/index.ts': 'export default { fetch() { return new Response() } }' },
        wranglerSource: '{}',
      }),
    })
    expect(r.ok).toBe(false)
    expect(r.bailReason).toMatch(/TOML/)
  })

  it('bails with TomlPatchError when the file uses inline-table form', async () => {
    const wranglerSource = `groundflare = { runtime = "workerd" }\n`
    const r = await prepareWorkspace({
      wrangler: { name: 'demo' },
      sourceRoot: 'src',
      wranglerPath: 'wrangler.toml',
      wranglerFormat: 'toml',
      fs: memoryFs({
        files: { 'src/index.ts': 'export default { fetch() { return new Response() } }' },
        wranglerSource,
      }),
    })
    expect(r.ok).toBe(false)
    expect(r.bailReason).toMatch(/inline-table/)
  })
})

describe('prepareWorkspace — dry run', () => {
  it('does not write to disk in dry-run mode', async () => {
    const writes = { wrangler: [] as string[] }
    const r = await prepareWorkspace({
      wrangler: { name: 'demo' },
      sourceRoot: 'src',
      wranglerPath: 'wrangler.toml',
      wranglerFormat: 'toml',
      dryRun: true,
      fs: memoryFs({
        files: { 'src/index.ts': 'export default { fetch() { return new Response() } }' },
        wranglerSource: `[groundflare]\nruntime = "workerd"\n`,
        writes,
      }),
    })
    expect(r.ok).toBe(true)
    expect(r.actions[0]?.kind).toBe('dry-run')
    expect(r.actions[0]?.message).toMatch(/\[dry-run\]/)
    expect(writes.wrangler).toEqual([])
  })
})
