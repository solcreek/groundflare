/**
 * Bun-track HN-burst bench — matches the workerd /hn-burst scenario
 * (random key, small JSON payload, on-disk SQLite) so numbers are
 * directly comparable with the workerd numbers produced by
 * src/poc/bench-bindings.ts.
 *
 * Concurrency is driven by HN_BURST_CONNS (default 1000) so the same
 * shell loop that sweeps the workerd path can drive Bun too.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import autocannon from 'autocannon'

const BENCH_DIR = resolve(import.meta.dirname, '../../examples/bench')
const CONNECTIONS = Number(process.env.HN_BURST_CONNS ?? '1000')
const DURATION = Number(process.env.HN_BURST_SECS ?? '15')
const WARMUP_MS = 2000
const PORT = Number(process.env.BUN_PORT ?? '8093')

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

const url = `http://127.0.0.1:${PORT}/hn-burst`
console.log(`\n🏁 Bun.serve + bun:sqlite (HN burst) → ${url}  [${CONNECTIONS} conn, ${DURATION}s]`)

const proc: ChildProcess = spawn('bun', ['run', 'bun-sqlite-burst.ts'], {
  cwd: BENCH_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BUN_PORT: String(PORT) },
})

try {
  await waitForPort(`http://127.0.0.1:${PORT}/`)
  await sleep(WARMUP_MS)
  const r = await autocannon({
    url,
    connections: CONNECTIONS,
    duration: DURATION,
    pipelining: 1,
  })
  const pad = (s: string | number, n: number) => String(s).padStart(n)
  console.log('\n📊 Result')
  console.log(
    `  ${pad('runtime', 30)}  ${pad('rps', 8)}  ${pad('mean', 8)}  ${pad('p50', 7)}  ${pad('p99', 8)}  ${pad('max', 8)}  ${pad('err', 5)}`,
  )
  console.log(`  ${'─'.repeat(84)}`)
  console.log(
    `  ${pad('Bun.serve + bun:sqlite (burst)', 30)}  ${pad(r.requests.average.toFixed(0), 8)}  ${pad(r.latency.mean.toFixed(2), 8)}  ${pad(r.latency.p50.toFixed(2), 7)}  ${pad(r.latency.p99.toFixed(2), 8)}  ${pad(r.latency.max.toFixed(2), 8)}  ${pad(r.errors, 5)}`,
  )
} finally {
  proc.kill('SIGTERM')
  await sleep(500)
  if (!proc.killed) proc.kill('SIGKILL')
}
