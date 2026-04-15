/**
 * End-to-end: tenant Worker uses env.CACHE.get/put/list through the
 * real workerd runtime. Validates the full KV stack:
 *   user code → tenant shim → DO namespace binding → KvStore (SqlStorage).
 */

import { describe, it, expect } from 'vitest'
import {
  buildCapnpFromWorkspace,
  type WorkspaceManifest,
} from '../../src/runtime/workspace/index.js'
import { renderCapnpConfig } from '../../src/runtime/workerd/capnp/index.js'
import { pickFreePort, spawnWorkerd } from './spawn-workerd.js'

const HEALTH_TIMEOUT_MS = 10_000

async function withKvWorkspace<T>(
  opts: {
    manifest: WorkspaceManifest
    modules: Record<string, string>
  },
  body: (wd: Awaited<ReturnType<typeof spawnWorkerd>>) => Promise<T>,
): Promise<T> {
  const port = await pickFreePort()

  // Integration tests use in-memory DO storage: process-lifetime only,
  // but that matches each test's scope (the workerd process lives just
  // for the duration of one test). The on-disk path is exercised by a
  // separate test below.
  const config = buildCapnpFromWorkspace(opts.manifest, {
    listenAddress: `127.0.0.1:${port}`,
    stateBaseDir: 'in-memory',
  })
  const capnp = renderCapnpConfig(config)

  const wd = await spawnWorkerd({
    port,
    capnp,
    modules: opts.modules,
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

describe('integration: KV binding round-trip through real workerd', () => {
  it(
    'put then get returns the same value',
    async () => {
      await withKvWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'user.js',
                kvNamespaces: [{ binding: 'CACHE' }],
              },
            ],
          },
          modules: {
            'user.js': `
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
                  return new Response('not found', { status: 404 })
                }
              }
            `,
          },
        },
        async (wd) => {
          const put = await wd.sendRequest({
            host: 'api.test',
            method: 'POST',
            path: '/put?k=greeting&v=hello',
          })
          expect(put.status).toBe(200)
          expect(put.body).toBe('stored')

          const get = await wd.sendRequest({
            host: 'api.test',
            path: '/get?k=greeting',
          })
          expect(get.status).toBe(200)
          expect(get.body).toBe('hello')

          const miss = await wd.sendRequest({
            host: 'api.test',
            path: '/get?k=absent',
          })
          expect(miss.status).toBe(200)
          expect(miss.body).toBe('MISS')
        },
      )
    },
    60_000,
  )

  it(
    'list returns only matching prefix keys in lexicographic order',
    async () => {
      await withKvWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'user.js',
                kvNamespaces: [{ binding: 'CACHE' }],
              },
            ],
          },
          modules: {
            'user.js': `
              export default {
                async fetch(request, env) {
                  const url = new URL(request.url)
                  if (url.pathname === '/seed') {
                    await env.CACHE.put('user:alice', 'a')
                    await env.CACHE.put('user:bob', 'b')
                    await env.CACHE.put('post:1', 'p')
                    return new Response('seeded')
                  }
                  if (url.pathname === '/list') {
                    const prefix = url.searchParams.get('prefix') ?? ''
                    const { keys } = await env.CACHE.list({ prefix })
                    return new Response(JSON.stringify(keys.map(k => k.name)))
                  }
                  return new Response('404', { status: 404 })
                }
              }
            `,
          },
        },
        async (wd) => {
          await wd.sendRequest({ host: 'api.test', path: '/seed' })

          const userList = await wd.sendRequest({
            host: 'api.test',
            path: '/list?prefix=user%3A',
          })
          expect(JSON.parse(userList.body)).toEqual(['user:alice', 'user:bob'])

          const postList = await wd.sendRequest({
            host: 'api.test',
            path: '/list?prefix=post%3A',
          })
          expect(JSON.parse(postList.body)).toEqual(['post:1'])

          const everything = await wd.sendRequest({
            host: 'api.test',
            path: '/list?prefix=',
          })
          expect(JSON.parse(everything.body)).toEqual([
            'post:1',
            'user:alice',
            'user:bob',
          ])
        },
      )
    },
    60_000,
  )

  it(
    'delete removes the key, subsequent get returns null',
    async () => {
      await withKvWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'user.js',
                kvNamespaces: [{ binding: 'CACHE' }],
              },
            ],
          },
          modules: {
            'user.js': `
              export default {
                async fetch(request, env) {
                  const url = new URL(request.url)
                  if (url.pathname === '/put') {
                    await env.CACHE.put('k', 'v')
                    return new Response('ok')
                  }
                  if (url.pathname === '/del') {
                    await env.CACHE.delete('k')
                    return new Response('ok')
                  }
                  if (url.pathname === '/has') {
                    const v = await env.CACHE.get('k')
                    return new Response(v === null ? 'missing' : 'present:' + v)
                  }
                  return new Response('404', { status: 404 })
                }
              }
            `,
          },
        },
        async (wd) => {
          await wd.sendRequest({ host: 'api.test', path: '/put' })
          const has = await wd.sendRequest({ host: 'api.test', path: '/has' })
          expect(has.body).toBe('present:v')

          await wd.sendRequest({ host: 'api.test', path: '/del' })
          const miss = await wd.sendRequest({ host: 'api.test', path: '/has' })
          expect(miss.body).toBe('missing')
        },
      )
    },
    60_000,
  )

  it(
    'metadata round-trips via getWithMetadata',
    async () => {
      await withKvWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'user.js',
                kvNamespaces: [{ binding: 'CACHE' }],
              },
            ],
          },
          modules: {
            'user.js': `
              export default {
                async fetch(request, env) {
                  const url = new URL(request.url)
                  if (url.pathname === '/put') {
                    await env.CACHE.put('k', 'v', {
                      metadata: { owner: 'alice', tags: [1, 2] }
                    })
                    return new Response('ok')
                  }
                  if (url.pathname === '/meta') {
                    const { value, metadata } = await env.CACHE.getWithMetadata('k')
                    return new Response(JSON.stringify({ value, metadata }))
                  }
                  return new Response('404', { status: 404 })
                }
              }
            `,
          },
        },
        async (wd) => {
          await wd.sendRequest({ host: 'api.test', path: '/put' })
          const meta = await wd.sendRequest({ host: 'api.test', path: '/meta' })
          expect(JSON.parse(meta.body)).toEqual({
            value: 'v',
            metadata: { owner: 'alice', tags: [1, 2] },
          })
        },
      )
    },
    60_000,
  )
})
