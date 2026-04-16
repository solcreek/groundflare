/**
 * KV microbenchmark — node:sqlite track.
 *
 * Measures ops/sec for the core KV surface (put, get, list, delete,
 * getWithMetadata) on the Node-side SqliteKVAdapter backed by
 * node:sqlite. Results are the CLI-host baseline; Bun-track and
 * workerd baselines are in separate files.
 *
 * Run: `npm run bench -w groundflare`
 */

import { bench, describe, beforeAll, afterAll } from 'vitest'
import { SqliteKVAdapter, IMMEDIATE } from '../src/runtime/kv/index.js'

let adapter: SqliteKVAdapter

beforeAll(() => {
  // IMMEDIATE coalescer bypasses the 5ms batch window so each op
  // commits synchronously — matching bun:sqlite's adapter shape and
  // giving a fair driver-level comparison.
  adapter = SqliteKVAdapter.open(':memory:', { coalescer: IMMEDIATE })
})

afterAll(() => {
  adapter.close()
})

describe('KV node:sqlite — write ops', () => {
  let putIdx = 0
  bench('put (text value)', async () => {
    await adapter.put(`bench-put-${putIdx++}`, 'hello world')
  })

  let putMetaIdx = 0
  bench('put with metadata', async () => {
    await adapter.put(`bench-meta-${putMetaIdx++}`, 'value', {
      metadata: { owner: 'alice', tag: putMetaIdx },
    })
  })

  let putBinIdx = 0
  const binPayload = new Uint8Array(1024)
  bench('put (1 KB binary)', async () => {
    await adapter.put(`bench-bin-${putBinIdx++}`, binPayload)
  })
})

describe('KV node:sqlite — read ops', () => {
  beforeAll(async () => {
    for (let i = 0; i < 1000; i++) {
      await adapter.put(`read-${String(i).padStart(4, '0')}`, `value-${i}`)
    }
    await adapter.put('meta-key', 'v', {
      metadata: { tags: ['a', 'b'], count: 42 },
    })
  })

  let getIdx = 0
  bench('get (text, existing key)', async () => {
    await adapter.get(`read-${String(getIdx++ % 1000).padStart(4, '0')}`)
  })

  bench('get (missing key)', async () => {
    await adapter.get('nonexistent-key')
  })

  bench('getWithMetadata', async () => {
    await adapter.getWithMetadata('meta-key')
  })

  bench('list (prefix, limit=50)', async () => {
    await adapter.list({ prefix: 'read-', limit: 50 })
  })

  bench('list (all, no prefix)', async () => {
    await adapter.list({ limit: 100 })
  })
})

describe('KV node:sqlite — delete', () => {
  let delIdx = 0
  beforeAll(async () => {
    for (let i = 0; i < 10000; i++) {
      await adapter.put(`del-${i}`, 'x')
    }
  })

  bench('delete (existing key)', async () => {
    await adapter.delete(`del-${delIdx++}`)
  })
})
