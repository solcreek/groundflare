/**
 * KV microbenchmark — bun:sqlite track.
 *
 * Same operations as kv-node.bench.ts but against BunKVAdapter.
 * Runs under `bun run bench/kv-bun.bench.ts` (NOT vitest — the file
 * imports from bun:sqlite which vitest can't resolve).
 *
 * Quick local run:
 *   cd packages/groundflare && bun run bench/kv-bun.bench.ts
 *
 * Output is plain text: op name + ops/sec + mean latency.
 */

import { BunKVAdapter } from '../src/runtime/bun/adapters/kv.ts'

const WARMUP = 100
const ITERATIONS = 5000

interface BenchResult {
  name: string
  opsPerSec: number
  meanUs: number
}

function measure(name: string, fn: () => void): BenchResult {
  for (let i = 0; i < WARMUP; i++) fn()
  const start = Bun.nanoseconds()
  for (let i = 0; i < ITERATIONS; i++) fn()
  const elapsed = Bun.nanoseconds() - start
  const meanNs = elapsed / ITERATIONS
  return {
    name,
    opsPerSec: Math.round(1e9 / meanNs),
    meanUs: Math.round(meanNs / 1000),
  }
}

async function measureAsync(
  name: string,
  fn: () => Promise<void>,
): Promise<BenchResult> {
  for (let i = 0; i < WARMUP; i++) await fn()
  const start = Bun.nanoseconds()
  for (let i = 0; i < ITERATIONS; i++) await fn()
  const elapsed = Bun.nanoseconds() - start
  const meanNs = elapsed / ITERATIONS
  return {
    name,
    opsPerSec: Math.round(1e9 / meanNs),
    meanUs: Math.round(meanNs / 1000),
  }
}

async function main() {
  const adapter = BunKVAdapter.open(':memory:')
  const results: BenchResult[] = []

  // Seed read data
  for (let i = 0; i < 1000; i++) {
    await adapter.put(`read-${String(i).padStart(4, '0')}`, `value-${i}`)
  }
  await adapter.put('meta-key', 'v', {
    metadata: { tags: ['a', 'b'], count: 42 },
  })

  // Write ops
  let putIdx = 0
  results.push(
    await measureAsync('put (text)', async () => {
      await adapter.put(`bench-put-${putIdx++}`, 'hello world')
    }),
  )

  let putMetaIdx = 0
  results.push(
    await measureAsync('put with metadata', async () => {
      await adapter.put(`bench-meta-${putMetaIdx++}`, 'value', {
        metadata: { owner: 'alice', tag: putMetaIdx },
      })
    }),
  )

  const bin = new Uint8Array(1024)
  let putBinIdx = 0
  results.push(
    await measureAsync('put (1 KB binary)', async () => {
      await adapter.put(`bench-bin-${putBinIdx++}`, bin)
    }),
  )

  // Read ops
  let getIdx = 0
  results.push(
    await measureAsync('get (text, hit)', async () => {
      await adapter.get(
        `read-${String(getIdx++ % 1000).padStart(4, '0')}`,
      )
    }),
  )

  results.push(
    await measureAsync('get (miss)', async () => {
      await adapter.get('nonexistent')
    }),
  )

  results.push(
    await measureAsync('getWithMetadata', async () => {
      await adapter.getWithMetadata('meta-key')
    }),
  )

  results.push(
    await measureAsync('list (prefix, limit=50)', async () => {
      await adapter.list({ prefix: 'read-', limit: 50 })
    }),
  )

  // Delete
  for (let i = 0; i < 10000; i++) {
    await adapter.put(`del-${i}`, 'x')
  }
  let delIdx = 0
  results.push(
    await measureAsync('delete', async () => {
      await adapter.delete(`del-${delIdx++}`)
    }),
  )

  adapter.close()

  // Print results
  console.log('\nKV bun:sqlite microbenchmark')
  console.log('─'.repeat(55))
  console.log(
    'Operation'.padEnd(25) +
      'ops/sec'.padStart(12) +
      'mean (µs)'.padStart(12),
  )
  console.log('─'.repeat(55))
  for (const r of results) {
    console.log(
      r.name.padEnd(25) +
        r.opsPerSec.toLocaleString().padStart(12) +
        r.meanUs.toLocaleString().padStart(12),
    )
  }
  console.log('')
}

main()
