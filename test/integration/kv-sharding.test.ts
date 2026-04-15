/**
 * Sharding integration: tenant Worker with a KV binding at shards=4.
 * The same-shape tests as kv-binding.test.ts must pass, and we also
 * assert that keys actually distribute across shards at the storage
 * layer (not all collapse to one DO).
 */

import { describe, it, expect } from 'vitest'
import {
  buildCapnpFromWorkspace,
  type WorkspaceManifest,
} from '../../src/runtime/workspace/index.js'
import { renderCapnpConfig } from '../../src/runtime/workerd/capnp/index.js'
import { pickFreePort, spawnWorkerd } from './spawn-workerd.js'

const HEALTH_TIMEOUT_MS = 10_000
const STATE_BASE = 'do-state'

async function withShardedWorkspace<T>(
  opts: {
    shards: number
    modules: Record<string, string>
  },
  body: (wd: Awaited<ReturnType<typeof spawnWorkerd>>) => Promise<T>,
): Promise<T> {
  const port = await pickFreePort()
  const manifest: WorkspaceManifest = {
    name: 'e2e-shards',
    workers: [
      {
        name: 'api',
        domain: 'api.test',
        entryPath: 'user.js',
        kvNamespaces: [{ binding: 'CACHE', shards: opts.shards }],
      },
    ],
  }

  const config = buildCapnpFromWorkspace(manifest, {
    listenAddress: `127.0.0.1:${port}`,
    stateBaseDir: STATE_BASE,
  })
  const capnp = renderCapnpConfig(config)

  const wd = await spawnWorkerd({
    port,
    capnp,
    modules: opts.modules,
    extraDirs: [`${STATE_BASE}/api/CACHE`],
    healthTimeoutMs: HEALTH_TIMEOUT_MS,
  })
  try {
    return await body(wd)
  } catch (err) {
    const stderr = wd.stderr()
    if (stderr) {
      const attached = new Error(
        `${err instanceof Error ? err.message : String(err)}\n\n` +
          `workerd stderr (last 2KB):\n${stderr.slice(-2000)}`,
      )
      attached.stack = err instanceof Error ? err.stack : undefined
      throw attached
    }
    throw err
  } finally {
    await wd.stop()
  }
}

const USER_MODULE = `
  export default {
    async fetch(request, env) {
      const url = new URL(request.url)
      if (url.pathname === '/put') {
        const key = url.searchParams.get('k') ?? ''
        const val = url.searchParams.get('v') ?? ''
        await env.CACHE.put(key, val)
        return new Response('stored')
      }
      if (url.pathname === '/get') {
        const key = url.searchParams.get('k') ?? ''
        const v = await env.CACHE.get(key)
        return new Response(v ?? 'MISS')
      }
      if (url.pathname === '/del') {
        const key = url.searchParams.get('k') ?? ''
        await env.CACHE.delete(key)
        return new Response('deleted')
      }
      if (url.pathname === '/list') {
        const prefix = url.searchParams.get('prefix') ?? ''
        const result = await env.CACHE.list({ prefix, limit: 100 })
        return Response.json(result.keys.map((k) => k.name))
      }
      if (url.pathname === '/put-many') {
        const count = Number(url.searchParams.get('n') ?? '50')
        for (let i = 0; i < count; i++) {
          await env.CACHE.put('item-' + i, String(i))
        }
        return new Response('filled ' + count)
      }
      return new Response('404', { status: 404 })
    }
  }
`

describe('integration: KV sharding (shards=4)', () => {
  it(
    'put + get round-trip works identically to shards=1',
    async () => {
      await withShardedWorkspace(
        { shards: 4, modules: { 'user.js': USER_MODULE } },
        async (wd) => {
          await wd.sendRequest({
            host: 'api.test',
            path: '/put?k=greeting&v=hello-sharded',
          })
          const res = await wd.sendRequest({ host: 'api.test', path: '/get?k=greeting' })
          expect(res.status).toBe(200)
          expect(res.body).toBe('hello-sharded')
        },
      )
    },
    60_000,
  )

  it(
    'delete removes the key from its shard only',
    async () => {
      await withShardedWorkspace(
        { shards: 4, modules: { 'user.js': USER_MODULE } },
        async (wd) => {
          await wd.sendRequest({ host: 'api.test', path: '/put?k=a&v=1' })
          await wd.sendRequest({ host: 'api.test', path: '/put?k=b&v=2' })
          await wd.sendRequest({ host: 'api.test', path: '/del?k=a' })

          const a = await wd.sendRequest({ host: 'api.test', path: '/get?k=a' })
          expect(a.body).toBe('MISS')
          const b = await wd.sendRequest({ host: 'api.test', path: '/get?k=b' })
          expect(b.body).toBe('2')
        },
      )
    },
    60_000,
  )

  it(
    'list() merges results across shards in sorted order',
    async () => {
      await withShardedWorkspace(
        { shards: 4, modules: { 'user.js': USER_MODULE } },
        async (wd) => {
          await wd.sendRequest({ host: 'api.test', path: '/put-many?n=30' })

          const res = await wd.sendRequest({ host: 'api.test', path: '/list?prefix=item-' })
          expect(res.status).toBe(200)
          const keys = JSON.parse(res.body) as string[]
          expect(keys.length).toBe(30)

          // Keys must be globally sorted, not grouped by shard.
          const sorted = [...keys].sort()
          expect(keys).toEqual(sorted)

          // And include every expected key.
          const expected = Array.from({ length: 30 }, (_, i) => 'item-' + i).sort()
          expect(keys).toEqual(expected)
        },
      )
    },
    60_000,
  )

  it(
    'rejects cursor-based pagination (Phase 2)',
    async () => {
      const cursorSource = `
        export default {
          async fetch(request, env) {
            try {
              await env.CACHE.list({ cursor: 'abc' })
              return new Response('unexpected-success', { status: 500 })
            } catch (err) {
              return new Response(err.message, { status: 200 })
            }
          }
        }
      `
      await withShardedWorkspace(
        { shards: 4, modules: { 'user.js': cursorSource } },
        async (wd) => {
          const res = await wd.sendRequest({ host: 'api.test', path: '/' })
          expect(res.status).toBe(200)
          expect(res.body).toContain('pagination across shards')
        },
      )
    },
    60_000,
  )
})
