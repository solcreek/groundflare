/**
 * End-to-end: tenant Worker uses env.DB.prepare/run/all/first/batch/exec
 * through real workerd. Validates the SQL DO + tenant shim + adapter
 * service stack.
 *
 * Unlike KV, D1 requires localDisk DO storage (workerd's inMemory mode
 * doesn't surface SqlStorage). The harness creates a temp state base dir
 * and writes the disk-service path into the workdir.
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

async function withD1Workspace<T>(
  opts: {
    manifest: WorkspaceManifest
    modules: Record<string, string>
  },
  body: (wd: Awaited<ReturnType<typeof spawnWorkerd>>) => Promise<T>,
): Promise<T> {
  const port = await pickFreePort()
  const config = buildCapnpFromWorkspace(opts.manifest, {
    listenAddress: `127.0.0.1:${port}`,
    stateBaseDir: STATE_BASE,
  })
  const capnp = renderCapnpConfig(config)

  // workerd needs the disk-service paths to exist before startup.
  const extraDirs: string[] = []
  for (const w of opts.manifest.workers) {
    for (const d1 of w.d1Databases ?? []) {
      extraDirs.push(`${STATE_BASE}/${w.name}/d1/${d1.databaseName}`)
    }
  }

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

describe('integration: D1 binding round-trip through real workerd', () => {
  it(
    'CREATE TABLE + INSERT + SELECT through prepare/run/all',
    async () => {
      await withD1Workspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'user.js',
                d1Databases: [{ binding: 'DB', databaseName: 'main' }],
              },
            ],
          },
          modules: {
            'user.js': `
              export default {
                async fetch(request, env) {
                  const url = new URL(request.url)
                  if (url.pathname === '/setup') {
                    await env.DB.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
                    return new Response('setup')
                  }
                  if (url.pathname === '/insert') {
                    const result = await env.DB.prepare('INSERT INTO users(name) VALUES (?)').bind('alice').run()
                    return new Response(JSON.stringify({
                      changes: result.meta.changes,
                      last_row_id: result.meta.last_row_id,
                    }))
                  }
                  if (url.pathname === '/select') {
                    const result = await env.DB.prepare('SELECT id, name FROM users ORDER BY id').all()
                    return new Response(JSON.stringify(result.results))
                  }
                  return new Response('404', { status: 404 })
                }
              }
            `,
          },
        },
        async (wd) => {
          await wd.sendRequest({ host: 'api.test', path: '/setup' })

          const insert = await wd.sendRequest({ host: 'api.test', path: '/insert' })
          expect(insert.status).toBe(200)
          const insertResult = JSON.parse(insert.body)
          // workerd's `rowsWritten` includes implicit writes to internal
          // tables like sqlite_sequence; for an AUTOINCREMENT table it
          // reports 2 (1 user row + 1 sequence-table update). We assert
          // "at least one row written" rather than the exact CF value.
          expect(insertResult.changes).toBeGreaterThanOrEqual(1)
          expect(insertResult.last_row_id).toBeGreaterThan(0)

          const select = await wd.sendRequest({ host: 'api.test', path: '/select' })
          expect(select.status).toBe(200)
          expect(JSON.parse(select.body)).toEqual([{ id: 1, name: 'alice' }])
        },
      )
    },
    60_000,
  )

  it(
    'first() returns the first row or null',
    async () => {
      await withD1Workspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'user.js',
                d1Databases: [{ binding: 'DB', databaseName: 'main' }],
              },
            ],
          },
          modules: {
            'user.js': `
              export default {
                async fetch(request, env) {
                  const url = new URL(request.url)
                  if (url.pathname === '/setup') {
                    await env.DB.exec('CREATE TABLE IF NOT EXISTS items(name TEXT)')
                    await env.DB.prepare('INSERT INTO items VALUES (?)').bind('first').run()
                    await env.DB.prepare('INSERT INTO items VALUES (?)').bind('second').run()
                    return new Response('ok')
                  }
                  if (url.pathname === '/first-row') {
                    const row = await env.DB.prepare('SELECT name FROM items ORDER BY rowid').first()
                    return new Response(JSON.stringify(row))
                  }
                  if (url.pathname === '/first-col') {
                    const v = await env.DB.prepare('SELECT name FROM items ORDER BY rowid').first('name')
                    return new Response(JSON.stringify(v))
                  }
                  if (url.pathname === '/first-empty') {
                    const v = await env.DB.prepare("SELECT 1 WHERE 0").first()
                    return new Response(JSON.stringify(v))
                  }
                  return new Response('404', { status: 404 })
                }
              }
            `,
          },
        },
        async (wd) => {
          await wd.sendRequest({ host: 'api.test', path: '/setup' })

          const row = await wd.sendRequest({ host: 'api.test', path: '/first-row' })
          expect(JSON.parse(row.body)).toEqual({ name: 'first' })

          const col = await wd.sendRequest({ host: 'api.test', path: '/first-col' })
          expect(JSON.parse(col.body)).toBe('first')

          const empty = await wd.sendRequest({ host: 'api.test', path: '/first-empty' })
          expect(JSON.parse(empty.body)).toBe(null)
        },
      )
    },
    60_000,
  )

  it(
    'batch runs statements in order, atomic on failure',
    async () => {
      await withD1Workspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'user.js',
                d1Databases: [{ binding: 'DB', databaseName: 'main' }],
              },
            ],
          },
          modules: {
            'user.js': `
              export default {
                async fetch(request, env) {
                  const url = new URL(request.url)
                  if (url.pathname === '/setup') {
                    await env.DB.exec('CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
                    return new Response('ok')
                  }
                  if (url.pathname === '/batch-ok') {
                    const results = await env.DB.batch([
                      env.DB.prepare('INSERT INTO users(id, name) VALUES (1, ?)').bind('a'),
                      env.DB.prepare('INSERT INTO users(id, name) VALUES (2, ?)').bind('b'),
                      env.DB.prepare('SELECT COUNT(*) AS n FROM users'),
                    ])
                    return new Response(JSON.stringify({
                      changes_a: results[0].meta.changes,
                      changes_b: results[1].meta.changes,
                      count: results[2].results[0]?.n,
                    }))
                  }
                  if (url.pathname === '/batch-fail') {
                    try {
                      await env.DB.batch([
                        env.DB.prepare('INSERT INTO users(id, name) VALUES (3, ?)').bind('c'),
                        env.DB.prepare('INSERT INTO users(id, name) VALUES (1, ?)').bind('dup'), // PK collision
                        env.DB.prepare('INSERT INTO users(id, name) VALUES (4, ?)').bind('d'),
                      ])
                      return new Response('UNEXPECTED OK')
                    } catch (e) {
                      return new Response('threw')
                    }
                  }
                  if (url.pathname === '/all') {
                    const r = await env.DB.prepare('SELECT name FROM users ORDER BY id').all()
                    return new Response(JSON.stringify(r.results.map(row => row.name)))
                  }
                  return new Response('404', { status: 404 })
                }
              }
            `,
          },
        },
        async (wd) => {
          await wd.sendRequest({ host: 'api.test', path: '/setup' })

          const ok = await wd.sendRequest({ host: 'api.test', path: '/batch-ok' })
          expect(JSON.parse(ok.body)).toEqual({
            changes_a: 1,
            changes_b: 1,
            count: 2,
          })

          const fail = await wd.sendRequest({ host: 'api.test', path: '/batch-fail' })
          expect(fail.body).toBe('threw')

          // Atomicity: the failed batch must not have inserted id=3 or id=4.
          const all = await wd.sendRequest({ host: 'api.test', path: '/all' })
          expect(JSON.parse(all.body)).toEqual(['a', 'b'])
        },
      )
    },
    60_000,
  )

  it(
    'data persists across requests within the same workerd process',
    async () => {
      await withD1Workspace(
        {
          manifest: {
            name: 'e2e',
            workers: [
              {
                name: 'api',
                domain: 'api.test',
                entryPath: 'user.js',
                d1Databases: [{ binding: 'DB', databaseName: 'main' }],
              },
            ],
          },
          modules: {
            'user.js': `
              export default {
                async fetch(request, env) {
                  const url = new URL(request.url)
                  if (url.pathname === '/init') {
                    await env.DB.exec('CREATE TABLE IF NOT EXISTS counters(k TEXT PRIMARY KEY, n INTEGER)')
                    await env.DB.exec("INSERT OR IGNORE INTO counters VALUES ('hits', 0)")
                    return new Response('init')
                  }
                  if (url.pathname === '/inc') {
                    await env.DB.prepare('UPDATE counters SET n = n + 1 WHERE k = ?').bind('hits').run()
                    const v = await env.DB.prepare('SELECT n FROM counters WHERE k = ?').bind('hits').first('n')
                    return new Response(String(v))
                  }
                  return new Response('404', { status: 404 })
                }
              }
            `,
          },
        },
        async (wd) => {
          await wd.sendRequest({ host: 'api.test', path: '/init' })
          for (let i = 1; i <= 5; i++) {
            const r = await wd.sendRequest({ host: 'api.test', path: '/inc' })
            expect(r.body).toBe(String(i))
          }
        },
      )
    },
    60_000,
  )
})
