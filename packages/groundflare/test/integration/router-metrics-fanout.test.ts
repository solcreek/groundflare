/**
 * End-to-end: Router's /__metrics fans out to tenant shims (KV/D1) so a
 * single scrape on the loopback port surfaces both router-level and
 * binding-level series.
 *
 * This test picks the full workspace path — `buildCapnpFromWorkspace`
 * produces the Router capnp, the Router gets the right service bindings
 * + scrape targets, and the tenant shim's /__gf_metrics responds.
 *
 * The R2 adapter fan-out is covered by its own integration harness —
 * spinning up mock S3 in here too would double the test's moving parts
 * without adding Router-side coverage.
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

describe('integration: Router /__metrics fan-out to tenant shims', () => {
  it(
    'scrape surfaces router series + KV + D1 binding series in one response',
    async () => {
      const manifest: WorkspaceManifest = {
        name: 'e2e',
        workers: [
          {
            name: 'api',
            domain: 'api.test',
            entryPath: 'user.js',
            kvNamespaces: [{ binding: 'CACHE' }],
            d1Databases: [{ binding: 'DB', databaseName: 'main' }],
          },
        ],
      }

      const port = await pickFreePort()
      const config = buildCapnpFromWorkspace(manifest, {
        listenAddress: `127.0.0.1:${port}`,
        stateBaseDir: STATE_BASE,
        groundflareVersion: '0.0.0-test',
      })
      const capnp = renderCapnpConfig(config)

      const extraDirs: string[] = []
      for (const w of manifest.workers) {
        for (const d1 of w.d1Databases ?? []) {
          extraDirs.push(`${STATE_BASE}/${w.name}/d1/${d1.databaseName}`)
        }
        for (const kv of w.kvNamespaces ?? []) {
          extraDirs.push(`${STATE_BASE}/${w.name}/${kv.binding}`)
        }
      }

      const wd = await spawnWorkerd({
        port,
        capnp,
        modules: {
          'user.js': `
            export default {
              async fetch(request, env) {
                const url = new URL(request.url)
                if (url.pathname === '/drive') {
                  await env.CACHE.put('k', 'v')
                  await env.CACHE.get('k')
                  await env.DB.exec('CREATE TABLE IF NOT EXISTS t (n INT)')
                  await env.DB.prepare('INSERT INTO t (n) VALUES (?)').bind(1).run()
                  return new Response('ok')
                }
                return new Response('not found', { status: 404 })
              }
            }
          `,
        },
        extraDirs,
        healthTimeoutMs: HEALTH_TIMEOUT_MS,
      })

      try {
        // Drive some tenant traffic — router records request counters,
        // tenant shim records KV + D1 counters.
        const drive = await wd.sendRequest({ host: 'api.test', path: '/drive' })
        expect(drive.status).toBe(200)

        // Hit /__metrics via loopback hostname so the Router's gate accepts it.
        const metrics = await wd.sendRequest({
          host: '127.0.0.1',
          path: '/__metrics',
        })
        expect(metrics.status).toBe(200)

        // Router-level series (from the dispatch that just happened).
        expect(metrics.body).toMatch(
          /groundflare_worker_requests_total\{status_class="2xx",worker="api"\} \d+/,
        )
        // Tenant-shim series concatenated after the Router's own. The
        // `worker` label is emitted by the shim so these lines are
        // attributable without any post-processing.
        expect(metrics.body).toContain(
          'groundflare_binding_kv_ops_total{binding="CACHE",op="put",status="ok",worker="api"} 1',
        )
        expect(metrics.body).toContain(
          'groundflare_binding_kv_ops_total{binding="CACHE",op="get",status="ok",worker="api"} 1',
        )
        expect(metrics.body).toContain(
          'groundflare_binding_d1_ops_total{binding="DB",op="exec",status="ok",worker="api"} 1',
        )
        expect(metrics.body).toContain(
          'groundflare_binding_d1_ops_total{binding="DB",op="run",status="ok",worker="api"} 1',
        )
      } catch (err) {
        const tail = wd.stderr()
        if (tail) {
          const attached = new Error(
            `${err instanceof Error ? err.message : String(err)}\n\n` +
              `workerd stderr (last 2KB):\n${tail.slice(-2000)}`,
          )
          attached.stack = err instanceof Error ? err.stack : undefined
          throw attached
        }
        throw err
      } finally {
        await wd.stop()
      }
    },
    60_000,
  )

  it(
    'workers without shim bindings are skipped (no fan-out to raw user code)',
    async () => {
      const manifest: WorkspaceManifest = {
        name: 'e2e',
        workers: [
          {
            name: 'hello',
            domain: 'hello.test',
            entryPath: 'user.js',
            // No KV / D1 / R2 → no shim → not a scrape target.
          },
        ],
      }

      const port = await pickFreePort()
      const config = buildCapnpFromWorkspace(manifest, {
        listenAddress: `127.0.0.1:${port}`,
        stateBaseDir: STATE_BASE,
      })
      const capnp = renderCapnpConfig(config)

      const wd = await spawnWorkerd({
        port,
        capnp,
        modules: {
          'user.js': `
            export default {
              async fetch(request) {
                // If the Router accidentally fan-outs to us, we'd observe
                // a hit here with hostname="gf-internal". Record that in
                // a response header for the test to inspect on the next
                // external request.
                const url = new URL(request.url)
                if (url.hostname === 'gf-internal') {
                  return new Response('LEAKED', { status: 500 })
                }
                return new Response('ok')
              }
            }
          `,
        },
        healthTimeoutMs: HEALTH_TIMEOUT_MS,
      })

      try {
        const metrics = await wd.sendRequest({
          host: '127.0.0.1',
          path: '/__metrics',
        })
        expect(metrics.status).toBe(200)
        // Router metrics are still present.
        expect(metrics.body).toContain('groundflare_worker_requests_total')
        // No binding-level series — the worker has no bindings.
        expect(metrics.body).not.toContain('groundflare_binding_kv_ops_total')
        expect(metrics.body).not.toContain('groundflare_binding_d1_ops_total')
        // And the tenant did not receive a gf-internal fan-out hit.
        expect(metrics.body).not.toContain('LEAKED')
      } finally {
        await wd.stop()
      }
    },
    60_000,
  )
})
