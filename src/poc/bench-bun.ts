/**
 * Stage 2c benchmark: workerd vs Bun runtimes.
 *
 * Three runs on the same machine, same autocannon settings:
 *  1. workerd standalone (trivial response, no bindings)
 *  2. Bun.serve          (trivial response, no bindings)
 *  3. Bun.serve + bun:sqlite (SELECT COUNT query per request)
 *
 * The first two are apples-to-apples HTTP dispatch throughput.
 * The third shows Bun's SQLite pathway — included as a data point
 * for what a bun-native D1 adapter would cost (not a direct workerd
 * comparison until task #8 enables workerd D1 bindings via capnp).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import autocannon from 'autocannon'

const BENCH_DIR = resolve(import.meta.dirname, '../../examples/bench')
const DURATION = 10
const CONNECTIONS = 50
const WARMUP_MS = 2000

type BenchResult = {
  name: string
  rps: number
  latencyMeanMs: number
  latencyP50Ms: number
  latencyP99Ms: number
  latencyMaxMs: number
  errors: number
  non2xx: number
}

async function hammer(url: string, label: string): Promise<BenchResult> {
  await sleep(WARMUP_MS)
  const result = await autocannon({
    url,
    connections: CONNECTIONS,
    duration: DURATION,
    pipelining: 1,
  })
  return {
    name: label,
    rps: result.requests.average,
    latencyMeanMs: result.latency.mean,
    latencyP50Ms: result.latency.p50,
    latencyP99Ms: result.latency.p99,
    latencyMaxMs: result.latency.max,
    errors: result.errors,
    non2xx: result.non2xx,
  }
}

async function waitForPort(url: string, timeoutMs = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error(`server at ${url} did not become ready`)
}

type Scenario = {
  label: string
  url: string
  spawn: () => ChildProcess
}

const scenarios: Scenario[] = [
  {
    label: 'workerd standalone',
    url: 'http://127.0.0.1:8080/',
    spawn: () =>
      spawn('npx', ['workerd', 'serve', 'workerd.capnp'], {
        cwd: BENCH_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
  },
  {
    label: 'Bun.serve (trivial)',
    url: 'http://127.0.0.1:8091/',
    spawn: () =>
      spawn('bun', ['run', 'bun-hello.ts'], {
        cwd: BENCH_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BUN_PORT: '8091' },
      }),
  },
  {
    label: 'Bun.serve + bun:sqlite',
    url: 'http://127.0.0.1:8092/',
    spawn: () =>
      spawn('bun', ['run', 'bun-sqlite.ts'], {
        cwd: BENCH_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BUN_PORT: '8092' },
      }),
  },
]

const results: BenchResult[] = []

for (const s of scenarios) {
  console.log(`\n🏁 ${s.label} → ${s.url}`)
  const proc = s.spawn()
  try {
    await waitForPort(s.url)
    console.log(`   ready, running autocannon for ${DURATION}s @ ${CONNECTIONS} conns...`)
    results.push(await hammer(s.url, s.label))
  } finally {
    proc.kill('SIGTERM')
    await sleep(500)
  }
}

// ─── Report ─────────────────────────────────────────────────────────
console.log('\n📊 Results\n')
const pad = (s: string | number, n: number) => String(s).padStart(n)

console.log(
  `  ${pad('runtime', 26)}  ${pad('rps', 9)}  ${pad('mean', 8)}  ${pad('p50', 8)}  ${pad('p99', 8)}  ${pad('max', 8)}  ${pad('err', 5)}  ${pad('non-2xx', 8)}`,
)
console.log(`  ${'─'.repeat(90)}`)
for (const r of results) {
  console.log(
    `  ${pad(r.name, 26)}  ${pad(r.rps.toFixed(0), 9)}  ${pad(r.latencyMeanMs.toFixed(2), 8)}  ${pad(r.latencyP50Ms.toFixed(2), 8)}  ${pad(r.latencyP99Ms.toFixed(2), 8)}  ${pad(r.latencyMaxMs.toFixed(2), 8)}  ${pad(r.errors, 5)}  ${pad(r.non2xx, 8)}`,
  )
}

const [workerd, bunHello, bunSqlite] = results
if (workerd && bunHello) {
  const delta = ((bunHello.rps / workerd.rps - 1) * 100).toFixed(1)
  console.log(`\n  Bun.serve vs workerd (trivial): ${delta > '0' ? '+' : ''}${delta}% rps`)
}
if (workerd && bunSqlite) {
  const delta = ((bunSqlite.rps / workerd.rps - 1) * 100).toFixed(1)
  console.log(`  Bun+bun:sqlite vs workerd (trivial): ${delta > '0' ? '+' : ''}${delta}% rps`)
  console.log(`  ↑ note: Bun does SQL work, workerd doesn\'t — not a like-for-like.`)
  console.log(`    Direct workerd+D1 comparison requires task #8 (workerd capnp D1 binding).`)
}
