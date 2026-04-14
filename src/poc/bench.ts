/**
 * Stage 1 benchmark: workerd standalone vs Miniflare programmatic.
 * Measures pure runtime overhead on a trivial worker (no bindings).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import autocannon from 'autocannon'
import { Miniflare } from 'miniflare'

const BENCH_DIR = resolve(import.meta.dirname, '../../examples/bench')
const DURATION = 10        // seconds per run
const CONNECTIONS = 50     // parallel connections
const WARMUP_MS = 2000     // let runtime JIT settle

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
  console.log(`   warmup ${WARMUP_MS}ms...`)
  await sleep(WARMUP_MS)
  console.log(`   running autocannon: ${DURATION}s @ ${CONNECTIONS} conns...`)
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

// ─── Run 1: workerd standalone ───────────────────────────────────────
console.log('\n🏁 Run 1: workerd standalone (port 8080)')

const workerd: ChildProcess = spawn(
  'npx',
  ['workerd', 'serve', 'workerd.capnp'],
  { cwd: BENCH_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
)

let workerdResult: BenchResult
try {
  await waitForPort('http://127.0.0.1:8080/')
  console.log('   workerd ready')
  workerdResult = await hammer('http://127.0.0.1:8080/', 'workerd standalone')
} finally {
  workerd.kill('SIGTERM')
  await sleep(500)
}

// ─── Run 2: Miniflare programmatic ──────────────────────────────────
console.log('\n🏁 Run 2: Miniflare programmatic')

const mf = new Miniflare({
  modules: true,
  scriptPath: resolve(BENCH_DIR, 'worker.js'),
  port: 8787,
  compatibilityDate: '2026-04-01',
})

let miniflareResult: BenchResult
try {
  await mf.ready
  console.log('   Miniflare ready')
  miniflareResult = await hammer('http://127.0.0.1:8787/', 'Miniflare')
} finally {
  await mf.dispose()
}

// ─── Report ─────────────────────────────────────────────────────────
console.log('\n📊 Results\n')
const rows = [workerdResult, miniflareResult]
const pad = (s: string | number, n: number) => String(s).padStart(n)

console.log(
  `  ${pad('runtime', 22)}  ${pad('rps', 9)}  ${pad('mean', 8)}  ${pad('p50', 8)}  ${pad('p99', 8)}  ${pad('max', 8)}  ${pad('err', 5)}  ${pad('non-2xx', 8)}`,
)
console.log(`  ${'─'.repeat(86)}`)
for (const r of rows) {
  console.log(
    `  ${pad(r.name, 22)}  ${pad(r.rps.toFixed(0), 9)}  ${pad(r.latencyMeanMs.toFixed(2), 8)}  ${pad(r.latencyP50Ms.toFixed(2), 8)}  ${pad(r.latencyP99Ms.toFixed(2), 8)}  ${pad(r.latencyMaxMs.toFixed(2), 8)}  ${pad(r.errors, 5)}  ${pad(r.non2xx, 8)}`,
  )
}

const rpsDelta = ((workerdResult.rps / miniflareResult.rps - 1) * 100).toFixed(1)
const latDelta = ((miniflareResult.latencyMeanMs / workerdResult.latencyMeanMs - 1) * 100).toFixed(1)
console.log(`\n  workerd standalone is ${rpsDelta}% faster (rps)`)
console.log(`  Miniflare adds ${latDelta}% latency overhead`)
