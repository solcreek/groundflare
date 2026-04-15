/**
 * Stage 2d benchmark: workerd with real SQLite-backed KV + D1 bindings.
 *
 * The previous benchmarks (Stage 1/2a/2c) all used workers with zero
 * bindings, so they measured pure HTTP dispatch. That was correct for
 * the Miniflare-vs-workerd and workerd-vs-Bun decisions, but it didn't
 * tell us anything about the cost of the KV/D1 adapters users will
 * actually hit in production.
 *
 * This script drives the real workspace → capnp pipeline, boots a
 * workerd against the resulting config, and measures six scenarios
 * through autocannon. State lives in on-disk SQLite files with the
 * standard PRAGMA prelude applied by the adapter.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import autocannon from 'autocannon'
import {
  buildCapnpFromWorkspace,
  type WorkspaceManifest,
} from '../runtime/workspace/index.js'
import { renderCapnpConfig } from '../runtime/workerd/capnp/index.js'
import { pickFreePort, spawnWorkerd, type SpawnedWorkerd } from '../../test/integration/spawn-workerd.js'

const STATE_BASE = 'state'

const DURATION = 10
const WARMUP_MS = 2000

// Realistic micro-SaaS concurrency: many concurrent readers (no SQLite
// contention), few concurrent writers (DO input gate serialises writes;
// typical single-tenant workload sees <20 simultaneous writers).
// The previous 50-conn-everywhere profile generated spurious "errors"
// (client-side timeouts from artificial contention) and is not a useful
// default for characterising the runtime. Stress numbers live in a
// separate scenario, clearly labelled.
const CONNECTIONS_READ = 50
const CONNECTIONS_WRITE = 10
// HN burst: simulates the moment your post hits the front page and a
// short burst of distinct users submit forms / comments / clicks. Each
// request writes to a randomly-keyed KV entry — in the current one-DO-
// per-namespace design, all writes still serialise through the same
// input gate, so this measures how that single DO withstands burst
// pressure. When we add per-key sharding (v0.3+), this same scenario
// will distribute across shards and the numbers should improve.
const CONNECTIONS_BURST = Number(process.env.HN_BURST_CONNS ?? '1000')
const DURATION_BURST = Number(process.env.HN_BURST_SECS ?? '15')

const WORKER_JS = `
  export default {
    async fetch(request, env) {
      const url = new URL(request.url)

      if (url.pathname === '/noop') {
        return new Response('ok')
      }

      if (url.pathname === '/kv-put') {
        const k = 'k-' + Math.random().toString(36).slice(2)
        await env.CACHE.put(k, 'v')
        return new Response(k)
      }

      if (url.pathname === '/kv-get-hot') {
        const v = await env.CACHE.get('hot-key')
        return new Response(v ?? 'miss')
      }

      if (url.pathname === '/kv-get-miss') {
        const v = await env.CACHE.get('does-not-exist-' + Math.random())
        return new Response(v ?? 'miss')
      }

      if (url.pathname === '/d1-select') {
        const { results } = await env.DB.prepare(
          'SELECT name FROM items WHERE id = ?'
        ).bind(1).all()
        return Response.json(results)
      }

      if (url.pathname === '/d1-insert') {
        const id = Math.floor(Math.random() * 1_000_000_000)
        await env.DB.prepare('INSERT INTO logs (ts, msg) VALUES (?, ?)')
          .bind(Date.now(), 'bench').run()
        return new Response(String(id))
      }

      if (url.pathname === '/hn-burst') {
        // Simulate a form submission: unique key per "user" + small payload
        const userId = Math.random().toString(36).slice(2, 12)
        const payload = JSON.stringify({
          at: Date.now(),
          email: userId + '@example.com',
          signup: true,
        })
        await env.CACHE.put('signup:' + userId, payload)
        return new Response('ok')
      }

      return new Response('404', { status: 404 })
    }
  }
`

type Scenario = {
  label: string
  path: string
  connections: number
  prep?: (wd: SpawnedWorkerd, host: string) => Promise<void>
}

const scenarios: Scenario[] = [
  {
    label: 'noop (baseline)',
    path: '/noop',
    connections: CONNECTIONS_READ,
  },
  {
    label: 'KV get (hot)',
    path: '/kv-get-hot',
    connections: CONNECTIONS_READ,
  },
  {
    label: 'KV get (miss)',
    path: '/kv-get-miss',
    connections: CONNECTIONS_READ,
  },
  {
    label: 'KV put (random keys)',
    path: '/kv-put',
    connections: CONNECTIONS_WRITE,
  },
  {
    label: 'D1 SELECT (indexed)',
    path: '/d1-select',
    connections: CONNECTIONS_READ,
  },
  {
    label: 'D1 INSERT',
    path: '/d1-insert',
    connections: CONNECTIONS_WRITE,
  },
  {
    label: 'HN burst (KV put, random keys)',
    path: '/hn-burst',
    connections: CONNECTIONS_BURST,
  },
]

// Prep inline DDL + a dedicated hot-key seeder by injecting extra paths
// into the worker above. Rebuild the module string to include them.
const FULL_WORKER_JS = WORKER_JS.replace(
  "return new Response('404', { status: 404 })",
  `
      if (url.pathname === '/d1-ddl') {
        await env.DB.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
        await env.DB.exec('CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, msg TEXT)')
        await env.DB.prepare('INSERT OR REPLACE INTO items (id, name) VALUES (?, ?)').bind(1, 'alpha').run()
        return new Response('ddl-ok')
      }

      if (url.pathname === '/kv-seed-hot') {
        await env.CACHE.put('hot-key', 'hello')
        return new Response('seeded')
      }

      return new Response('404', { status: 404 })
  `,
)

type Result = {
  label: string
  rps: number
  mean: number
  p50: number
  p99: number
  max: number
  errors: number
  non2xx: number
}

async function hammer(
  baseUrl: string,
  path: string,
  host: string,
  label: string,
  connections: number,
  durationOverride?: number,
): Promise<Result> {
  await sleep(WARMUP_MS)
  const r = await autocannon({
    url: baseUrl + path,
    connections,
    duration: durationOverride ?? DURATION,
    pipelining: 1,
    headers: { host },
  })
  return {
    label,
    rps: r.requests.average,
    mean: r.latency.mean,
    p50: r.latency.p50,
    p99: r.latency.p99,
    max: r.latency.max,
    errors: r.errors,
    non2xx: r.non2xx,
  }
}

// ─── Set up ─────────────────────────────────────────────────────────
const port = await pickFreePort()
const host = 'api.test'
const workerName = 'api'
const dbName = 'bench'

const manifest: WorkspaceManifest = {
  name: 'bench',
  workers: [
    {
      name: workerName,
      domain: host,
      entryPath: 'user.js',
      kvNamespaces: [{ binding: 'CACHE', shards: 4 }],
      d1Databases: [{ binding: 'DB', databaseName: dbName }],
    },
  ],
}

const config = buildCapnpFromWorkspace(manifest, {
  listenAddress: `127.0.0.1:${port}`,
  stateBaseDir: STATE_BASE,
})
const capnp = renderCapnpConfig(config)

console.log('\n🏗  Booting workerd with SQLite-backed KV + D1 bindings...')
console.log(`   port: ${port}\n`)

const wd = await spawnWorkerd({
  port,
  capnp,
  modules: { 'user.js': FULL_WORKER_JS },
  extraDirs: [
    `${STATE_BASE}/${workerName}/CACHE`,
    `${STATE_BASE}/${workerName}/d1/${dbName}`,
  ],
  healthTimeoutMs: 10_000,
})

const baseUrl = `http://127.0.0.1:${port}`
const results: Result[] = []

try {
  // Prep: DDL + seed the hot KV key.
  await wd.sendRequest({ host, path: '/d1-ddl' })
  await wd.sendRequest({ host, path: '/kv-seed-hot' })

  for (const s of scenarios) {
    const duration = s.path === '/hn-burst' ? DURATION_BURST : DURATION
    console.log(
      `🏁 ${s.label} → ${s.path}  [${s.connections} conn, ${duration}s]`,
    )
    if (s.prep) await s.prep(wd, host)
    results.push(
      await hammer(baseUrl, s.path, host, s.label, s.connections, duration),
    )
  }
} finally {
  await wd.stop()
}

// ─── Report ─────────────────────────────────────────────────────────
console.log('\n📊 Results — workerd + on-disk SQLite bindings\n')
const pad = (s: string | number, n: number) => String(s).padStart(n)

console.log(
  `  ${pad('scenario', 24)}  ${pad('rps', 8)}  ${pad('mean', 7)}  ${pad('p50', 7)}  ${pad('p99', 7)}  ${pad('max', 7)}  ${pad('err', 4)}  ${pad('non-2xx', 7)}`,
)
console.log(`  ${'─'.repeat(84)}`)
for (const r of results) {
  console.log(
    `  ${pad(r.label, 24)}  ${pad(r.rps.toFixed(0), 8)}  ${pad(r.mean.toFixed(2), 7)}  ${pad(r.p50.toFixed(2), 7)}  ${pad(r.p99.toFixed(2), 7)}  ${pad(r.max.toFixed(2), 7)}  ${pad(r.errors, 4)}  ${pad(r.non2xx, 7)}`,
  )
}

const baseline = results.find((r) => r.label === 'noop (baseline)')
if (baseline) {
  console.log('\n  Overhead relative to noop baseline:')
  for (const r of results) {
    if (r.label === 'noop (baseline)') continue
    const pct = ((r.mean / baseline.mean - 1) * 100).toFixed(1)
    const rpsRatio = ((r.rps / baseline.rps) * 100).toFixed(1)
    console.log(`    ${pad(r.label, 24)}  +${pad(pct, 6)}% mean latency  /  ${pad(rpsRatio, 5)}% of baseline rps`)
  }
}
