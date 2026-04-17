/**
 * Tier 2.5 integration: spawns a real workerd against our generated
 * capnp and exercises the routing contract.
 *
 * This is the first test that validates:
 *   1. Our rendered capnp is syntactically valid workerd input.
 *   2. The Router Worker's inline ES module runs correctly in V8.
 *   3. Host-based dispatch reaches tenant Workers with bindings intact.
 *   4. /__scheduled dispatch reaches the target's scheduled() handler.
 *   5. Unknown hosts get a 404 rather than 500 or connection errors.
 *
 * Known gap: bindings that route through adapter services (KV, D1, R2)
 * aren't exercised yet — those adapter services aren't emitted by
 * buildCapnpFromWorkspace, so workerd would reject the config. Covered
 * by unit tests in the meantime; integration coverage lands when the
 * adapter-service generator does.
 */

import { describe, it, expect } from 'vitest'
import {
  buildCapnpFromWorkspace,
  type WorkspaceManifest,
} from '../../src/runtime/workspace/index.js'
import { renderCapnpConfig } from '../../src/runtime/workerd/capnp/index.js'
import { pickFreePort, spawnWorkerd } from './spawn-workerd.js'

const HEALTH_TIMEOUT_MS = 10_000

async function withWorkspace<T>(
  opts: {
    manifest: WorkspaceManifest
    modules: Record<string, string>
  },
  body: (wd: Awaited<ReturnType<typeof spawnWorkerd>>) => Promise<T>,
): Promise<T> {
  const port = await pickFreePort()
  const config = buildCapnpFromWorkspace(opts.manifest, {
    listenAddress: `127.0.0.1:${port}`,
  })
  const capnp = renderCapnpConfig(config)
  // Disk services in the generated config refer to directories that
  // workerd expects to pre-exist. Walk the config and pre-create any
  // disk path the builder emitted (user DOs, KV/D1 adapters). Without
  // this, workerd exits with `Directory named "X" not found: Y`
  // before serving the first request.
  const extraDirs = config.services
    .filter((s): s is typeof s & { kind: 'disk'; path: string } =>
      s.kind === 'disk' && typeof (s as { path?: string }).path === 'string',
    )
    .map((s) => s.path)
  const wd = await spawnWorkerd({
    port,
    capnp,
    modules: opts.modules,
    extraDirs,
    healthTimeoutMs: HEALTH_TIMEOUT_MS,
  })
  try {
    return await body(wd)
  } catch (err) {
    // Attach workerd's stderr so integration failures surface the root cause
    // rather than just "expected 200 got 500".
    const stderr = wd.stderr()
    if (stderr) {
      const attached = new Error(
        `${err instanceof Error ? err.message : String(err)}\n\n` +
          `workerd stderr:\n${stderr.slice(-2000)}`,
      )
      attached.stack = err instanceof Error ? err.stack : undefined
      throw attached
    }
    throw err
  } finally {
    await wd.stop()
  }
}

describe('integration: single tenant with vars binding', () => {
  it(
    'workerd accepts the config, router dispatches, env.GREETING reaches the handler',
    async () => {
      await withWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'api.js',
                vars: { GREETING: 'hello from api' },
              },
            ],
          },
          modules: {
            'api.js': `
              export default {
                async fetch(request, env) {
                  return new Response(env.GREETING, {
                    headers: { 'x-worker': 'api' },
                  })
                }
              }
            `,
          },
        },
        async (wd) => {
          const res = await wd.sendRequest({ host: 'api.test', path: '/' })
          expect(res.status).toBe(200)
          expect(res.body).toBe('hello from api')
          expect(res.headers['x-worker']).toBe('api')
        },
      )
    },
    30_000,
  )
})

describe('integration: two tenants, Host-based dispatch', () => {
  it(
    'routes each Host header to the correct tenant',
    async () => {
      await withWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'api.js',
                vars: { WHICH: 'api' },
              },
              {
                name: 'admin',
                domain: 'admin.test',
                entryPath: 'admin.js',
                vars: { WHICH: 'admin' },
              },
            ],
          },
          modules: {
            'api.js': `export default { async fetch(req, env) { return new Response(env.WHICH) } }`,
            'admin.js': `export default { async fetch(req, env) { return new Response(env.WHICH) } }`,
          },
        },
        async (wd) => {
          const api = await wd.sendRequest({ host: 'api.test' })
          expect(api.status).toBe(200)
          expect(api.body).toBe('api')

          const admin = await wd.sendRequest({ host: 'admin.test' })
          expect(admin.status).toBe(200)
          expect(admin.body).toBe('admin')

          // Unknown host — router returns 404 from its own logic, not
          // from one of the tenants.
          const missing = await wd.sendRequest({ host: 'nope.test' })
          expect(missing.status).toBe(404)
          expect(missing.body).toContain('no Worker matches host nope.test')
        },
      )
    },
    30_000,
  )

  it(
    'Host is case-insensitive',
    async () => {
      await withWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'api.js',
              },
            ],
          },
          modules: {
            'api.js': `export default { async fetch(req) { return new Response('ok') } }`,
          },
        },
        async (wd) => {
          const res = await wd.sendRequest({ host: 'API.TEST' })
          expect(res.status).toBe(200)
        },
      )
    },
    30_000,
  )
})

describe('integration: service bindings between tenants', () => {
  it(
    'worker A can fetch() worker B through an explicit service binding',
    async () => {
      await withWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'caller',
                domain: 'caller.test',
                entryPath: 'caller.js',
                serviceBindings: [{ binding: 'TARGET', service: 'target' }],
              },
              {
                name: 'target',
                // No domain — reachable only through the binding
                entryPath: 'target.js',
                vars: { TAG: 'from-target' },
              },
            ],
          },
          modules: {
            'caller.js': `
              export default {
                async fetch(req, env) {
                  const inner = await env.TARGET.fetch('http://internal/hello')
                  const body = await inner.text()
                  return new Response('caller got: ' + body)
                }
              }
            `,
            'target.js': `
              export default {
                async fetch(req, env) {
                  return new Response(env.TAG)
                }
              }
            `,
          },
        },
        async (wd) => {
          const res = await wd.sendRequest({ host: 'caller.test' })
          expect(res.status).toBe(200)
          expect(res.body).toBe('caller got: from-target')
        },
      )
    },
    30_000,
  )
})

describe('integration: /__scheduled dispatch', () => {
  it(
    'POST /__scheduled on localhost fires the target tenant\'s scheduled handler',
    async () => {
      await withWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'cron',
                // domain optional for scheduled-only workers
                entryPath: 'cron.js',
              },
              {
                name: 'inspect',
                domain: 'inspect.test',
                entryPath: 'inspect.js',
                serviceBindings: [{ binding: 'CRON', service: 'cron' }],
              },
            ],
          },
          modules: {
            // The cron worker writes the last-seen cron expression into
            // a shared cross-worker signal: we can observe it via the
            // inspect worker. Since we don't have KV/DO yet, we use a
            // mutable module-level variable held by cron's isolate.
            'cron.js': `
              let lastCron = null
              export default {
                async fetch(req, env) {
                  return new Response(JSON.stringify({ lastCron }), {
                    headers: { 'content-type': 'application/json' },
                  })
                },
                async scheduled(event, env, ctx) {
                  lastCron = event.cron
                }
              }
            `,
            // Inspect worker just proxies to cron's fetch() via the service
            // binding so we can read its state without exposing cron publicly.
            'inspect.js': `
              export default {
                async fetch(req, env) {
                  const res = await env.CRON.fetch('http://internal/state')
                  return res
                }
              }
            `,
          },
        },
        async (wd) => {
          // Before scheduling, cron.lastCron === null
          const pre = await wd.sendRequest({ host: 'inspect.test' })
          expect(pre.status).toBe(200)
          expect(JSON.parse(pre.body)).toEqual({ lastCron: null })

          // Fire a scheduled event via the internal HTTP endpoint.
          const dispatch = await wd.sendRequest({
            host: '127.0.0.1',
            method: 'POST',
            path: '/__scheduled?worker=cron&cron=0+*+*+*+*',
          })
          expect(dispatch.status).toBe(200)
          expect(dispatch.body).toBe('ok')

          // Now cron's isolate-level state should reflect the firing.
          const post = await wd.sendRequest({ host: 'inspect.test' })
          expect(post.status).toBe(200)
          expect(JSON.parse(post.body)).toEqual({ lastCron: '0 * * * *' })
        },
      )
    },
    30_000,
  )

  it(
    'rejects /__scheduled reached through a non-localhost Host',
    async () => {
      await withWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'cron',
                domain: 'cron.test',
                entryPath: 'cron.js',
              },
            ],
          },
          modules: {
            'cron.js': `
              export default {
                async fetch(req) { return new Response('fetch reached') },
                async scheduled(e) { /* should NOT be called */ }
              }
            `,
          },
        },
        async (wd) => {
          // cron.test is a real tenant domain but __scheduled is gated
          // on localhost: the router should 404 rather than dispatch
          // to the tenant's fetch handler.
          const res = await wd.sendRequest({
            host: 'cron.test',
            method: 'POST',
            path: '/__scheduled?worker=cron&cron=a',
          })
          expect(res.status).toBe(404)
          expect(res.body).not.toBe('fetch reached')
        },
      )
    },
    30_000,
  )
})

describe('integration: same-worker Durable Object namespace', () => {
  it(
    'env.COUNTER.get(id).fetch() reaches the DO class and ctx.storage persists across requests',
    async () => {
      // Canonical "counter" DO pattern: tenant declares a DO binding
      // COUNTER pointing at class `Counter` defined in its own script.
      // Each request increments `ctx.storage.get('n')` and returns the
      // new value. If the namespace + localDisk storage weren't emitted
      // by buildTenantService, workerd would either refuse to start
      // (unresolved namespace) or the `state.storage.*` calls would be
      // no-ops with `ephemeralLocal` fallback — both failure modes bail
      // well before the `expect(body).toBe('2')` below.
      await withWorkspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'app',
                domain: 'app.test',
                entryPath: 'app.js',
                durableObjects: [
                  { binding: 'COUNTER', className: 'Counter' },
                ],
              },
            ],
          },
          modules: {
            'app.js': `
              export class Counter {
                constructor(state) { this.state = state }
                async fetch() {
                  const cur = (await this.state.storage.get('n')) ?? 0
                  const next = cur + 1
                  await this.state.storage.put('n', next)
                  return new Response(String(next))
                }
              }
              export default {
                async fetch(req, env) {
                  const id = env.COUNTER.idFromName('global')
                  return env.COUNTER.get(id).fetch(req)
                }
              }
            `,
          },
        },
        async (wd) => {
          const first = await wd.sendRequest({ host: 'app.test' })
          expect(first.status).toBe(200)
          expect(first.body).toBe('1')

          const second = await wd.sendRequest({ host: 'app.test' })
          expect(second.status).toBe(200)
          expect(second.body).toBe('2')

          const third = await wd.sendRequest({ host: 'app.test' })
          expect(third.body).toBe('3')

          // Different DO id → independent state. `idFromName('global')`
          // vs `idFromName('other')` must not share storage, proving
          // the namespace is addressed by ID (not a singleton).
          // We hit this via a second route on the same worker:
          // skipped in the minimal test — covered once the test below
          // wires a two-name worker. Here we're gating on the basics.
        },
      )
    },
    30_000,
  )
})
