/**
 * Stage 2a benchmark: idle-recovery latency.
 * Measures whether first-request-after-idle matches warm-path latency.
 *
 * The hypothesis: always-on processes (workerd standalone) have no
 * idle penalty because nothing is evicted. Runtimes with proxy layers
 * or Node event loops may show a delta.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Miniflare } from 'miniflare'

const BENCH_DIR = resolve(import.meta.dirname, '../../examples/bench')
const WARMUP_REQUESTS = 5
const WARM_SAMPLES = 20
const IDLE_TRIALS = 5
const IDLE_SECONDS = 30

async function measure(url: string): Promise<number> {
  const t0 = performance.now()
  const res = await fetch(url)
  await res.text()
  return performance.now() - t0
}

async function waitForPort(url: string, timeoutMs = 10_000): Promise<void> {
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

type Stats = {
  n: number
  min: number
  mean: number
  p50: number
  p99: number
  max: number
}

function summary(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b)
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))]!
  return {
    n: s.length,
    min: s[0]!,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: p(0.5),
    p99: p(0.99),
    max: s[s.length - 1]!,
  }
}

async function runScenario(label: string, url: string) {
  console.log(`   warmup ${WARMUP_REQUESTS} requests...`)
  for (let i = 0; i < WARMUP_REQUESTS; i++) await measure(url)

  console.log(`   warm baseline: ${WARM_SAMPLES} back-to-back...`)
  const warm: number[] = []
  for (let i = 0; i < WARM_SAMPLES; i++) warm.push(await measure(url))

  console.log(`   idle recovery: ${IDLE_TRIALS} × (wait ${IDLE_SECONDS}s, measure)`)
  const idle: number[] = []
  for (let i = 0; i < IDLE_TRIALS; i++) {
    process.stdout.write(`     trial ${i + 1}/${IDLE_TRIALS}: idle ${IDLE_SECONDS}s... `)
    await sleep(IDLE_SECONDS * 1000)
    const t = await measure(url)
    console.log(`${t.toFixed(2)}ms`)
    idle.push(t)
  }

  return { label, warm: summary(warm), idle: summary(idle) }
}

// ─── Run 1: workerd standalone ───────────────────────────────────────
console.log('\n🏁 workerd standalone (port 8080)')

const workerd: ChildProcess = spawn(
  'npx',
  ['workerd', 'serve', 'workerd.capnp'],
  { cwd: BENCH_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
)

let workerdResult: Awaited<ReturnType<typeof runScenario>>
try {
  await waitForPort('http://127.0.0.1:8080/')
  console.log('   workerd ready')
  workerdResult = await runScenario('workerd standalone', 'http://127.0.0.1:8080/')
} finally {
  workerd.kill('SIGTERM')
  await sleep(500)
  if (!workerd.killed) workerd.kill('SIGKILL')
}

// ─── Run 2: Miniflare ───────────────────────────────────────────────
console.log('\n🏁 Miniflare programmatic (port 8787)')

const mf = new Miniflare({
  modules: true,
  scriptPath: resolve(BENCH_DIR, 'worker.js'),
  port: 8787,
  compatibilityDate: '2026-04-01',
})

let miniflareResult: Awaited<ReturnType<typeof runScenario>>
try {
  await mf.ready
  console.log('   Miniflare ready')
  miniflareResult = await runScenario('Miniflare', 'http://127.0.0.1:8787/')
} finally {
  await mf.dispose()
}

// ─── Report ─────────────────────────────────────────────────────────
console.log('\n📊 Results\n')
const fmt = (s: Stats) =>
  `n=${s.n.toString().padStart(2)} │ min ${s.min.toFixed(2).padStart(6)}ms │ mean ${s.mean.toFixed(2).padStart(6)}ms │ p50 ${s.p50.toFixed(2).padStart(6)}ms │ p99 ${s.p99.toFixed(2).padStart(6)}ms │ max ${s.max.toFixed(2).padStart(6)}ms`

for (const r of [workerdResult, miniflareResult]) {
  const delta = ((r.idle.mean / r.warm.mean - 1) * 100)
  console.log(`  ${r.label}`)
  console.log(`    warm:  ${fmt(r.warm)}`)
  console.log(`    idle:  ${fmt(r.idle)}`)
  console.log(`    idle vs warm mean: ${delta > 0 ? '+' : ''}${delta.toFixed(1)}%\n`)
}
