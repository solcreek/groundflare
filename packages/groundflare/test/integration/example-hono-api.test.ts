/**
 * End-to-end tests for examples/hono-api running inside real workerd.
 *
 * Bundles the example with esbuild on demand, builds the workspace
 * config (KV + D1 bindings), spawns workerd against a temp work dir,
 * and exercises:
 *
 *   1. Happy-path CRUD on /kv and /notes
 *   2. Edge cases — unicode, large bodies, missing fields, malformed JSON
 *   3. Security — parameterized LIKE doesn't execute injected SQL
 *   4. Concurrency — 50 parallel writes succeed without errors
 *   5. Burst — sequential bulk inserts
 *   6. Mixed-binding flow — /feed populates KV from D1 then serves cache
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { build as esbuild } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  buildCapnpFromWorkspace,
  type WorkspaceManifest,
} from '../../src/runtime/workspace/index.js'
import { renderCapnpConfig } from '../../src/runtime/workerd/capnp/index.js'
import { pickFreePort, spawnWorkerd, type SpawnedWorkerd } from './spawn-workerd.js'

const STATE_BASE = 'do-state'
const HEALTH_TIMEOUT_MS = 15_000

const EXAMPLE_ROOT = resolve(
  fileURLToPath(new URL('../../examples/hono-api', import.meta.url)),
)

let bundle: string | null = null
let wd: SpawnedWorkerd | null = null

async function bundleHonoExample(): Promise<string> {
  const result = await esbuild({
    entryPoints: [resolve(EXAMPLE_ROOT, 'src/index.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    write: false,
    sourcemap: false,
    minify: false,
    external: ['cloudflare:workers'],
  })
  return result.outputFiles[0]!.text
}

beforeAll(async () => {
  bundle = await bundleHonoExample()

  const manifest: WorkspaceManifest = {
    name: 'hono-api-e2e',
    workers: [
      {
        name: 'hono',
        domain: 'hono.test',
        entryPath: 'user.js',
        vars: { APP_NAME: 'groundflare-hono-demo' },
        kvNamespaces: [{ binding: 'CACHE' }],
        d1Databases: [{ binding: 'DB', databaseName: 'notes' }],
      },
    ],
  }

  const port = await pickFreePort()
  const config = buildCapnpFromWorkspace(manifest, {
    listenAddress: `127.0.0.1:${port}`,
    stateBaseDir: STATE_BASE,
  })
  const capnp = renderCapnpConfig(config)

  wd = await spawnWorkerd({
    port,
    capnp,
    modules: { 'user.js': bundle },
    extraDirs: [
      `${STATE_BASE}/hono/CACHE`,
      `${STATE_BASE}/hono/d1/notes`,
    ],
    healthTimeoutMs: HEALTH_TIMEOUT_MS,
  })
}, 60_000)

afterAll(async () => {
  if (wd) await wd.stop()
})

function ws(): SpawnedWorkerd {
  if (!wd) throw new Error('workerd not started')
  return wd
}

// ─── Smoke / health ────────────────────────────────────────────────

describe('hono-api: health + meta', () => {
  it('GET / returns the app name from vars binding', async () => {
    const res = await ws().sendRequest({ host: 'hono.test', path: '/' })
    expect(res.status).toBe(200)
    expect(res.body).toBe('hello from groundflare-hono-demo')
  })

  it('GET /health returns structured JSON', async () => {
    const res = await ws().sendRequest({ host: 'hono.test', path: '/health' })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ok')
    expect(body.app).toBe('groundflare-hono-demo')
    expect(typeof body.time).toBe('string')
    expect(Date.parse(body.time)).not.toBeNaN()
  })

  it('GET /unknown returns 404 with JSON error envelope', async () => {
    const res = await ws().sendRequest({ host: 'hono.test', path: '/nope' })
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'not found' })
  })
})

// ─── KV CRUD ───────────────────────────────────────────────────────

describe('hono-api: KV CRUD', () => {
  it('PUT then GET round-trips a value', async () => {
    const put = await ws().sendRequest({
      host: 'hono.test',
      method: 'PUT',
      path: '/kv/greeting',
      body: 'hello world',
    })
    expect(put.status).toBe(200)
    expect(JSON.parse(put.body)).toEqual({ ok: true, bytes: 11 })

    const get = await ws().sendRequest({ host: 'hono.test', path: '/kv/greeting' })
    expect(get.status).toBe(200)
    expect(get.body).toBe('hello world')
  })

  it('GET on a missing key returns 404', async () => {
    const res = await ws().sendRequest({ host: 'hono.test', path: '/kv/nope-' + Date.now() })
    expect(res.status).toBe(404)
  })

  it('DELETE removes the value', async () => {
    await ws().sendRequest({
      host: 'hono.test',
      method: 'PUT',
      path: '/kv/temp',
      body: 'x',
    })
    const del = await ws().sendRequest({
      host: 'hono.test',
      method: 'DELETE',
      path: '/kv/temp',
    })
    expect(del.status).toBe(200)
    const after = await ws().sendRequest({ host: 'hono.test', path: '/kv/temp' })
    expect(after.status).toBe(404)
  })

  it('PUT with empty body returns 400', async () => {
    const res = await ws().sendRequest({
      host: 'hono.test',
      method: 'PUT',
      path: '/kv/blank',
      body: '',
    })
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/empty/)
  })

  it('PUT with invalid TTL returns 400', async () => {
    const res = await ws().sendRequest({
      host: 'hono.test',
      method: 'PUT',
      path: '/kv/x?ttl=-5',
      body: 'v',
    })
    expect(res.status).toBe(400)
  })

  it('GET /kv?prefix= filters lexicographically', async () => {
    // Seed a deterministic set under the namespace `t-list:`
    await ws().sendRequest({ host: 'hono.test', method: 'PUT', path: '/kv/t-list:a', body: '1' })
    await ws().sendRequest({ host: 'hono.test', method: 'PUT', path: '/kv/t-list:b', body: '2' })
    await ws().sendRequest({ host: 'hono.test', method: 'PUT', path: '/kv/other', body: 'x' })
    const res = await ws().sendRequest({
      host: 'hono.test',
      path: '/kv?prefix=t-list%3A',
    })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.keys).toEqual(['t-list:a', 't-list:b'])
  })

  it('GET /kv?limit=invalid returns 400', async () => {
    const res = await ws().sendRequest({
      host: 'hono.test',
      path: '/kv?limit=abc',
    })
    expect(res.status).toBe(400)
  })
})

// ─── KV edge cases ─────────────────────────────────────────────────

describe('hono-api: KV edge cases', () => {
  it('handles unicode keys + values', async () => {
    await ws().sendRequest({
      host: 'hono.test',
      method: 'PUT',
      path: '/kv/' + encodeURIComponent('鍵-key-🔑'),
      body: '值-value-✨',
    })
    const res = await ws().sendRequest({
      host: 'hono.test',
      path: '/kv/' + encodeURIComponent('鍵-key-🔑'),
    })
    expect(res.body).toBe('值-value-✨')
  })

  it('handles a 256 KiB value (under the 25 MiB ceiling)', async () => {
    // 256 KiB is large enough to exercise streaming in workerd but small
    // enough to keep this test under a second.
    const big = 'x'.repeat(256 * 1024)
    const put = await ws().sendRequest({
      host: 'hono.test',
      method: 'PUT',
      path: '/kv/big',
      body: big,
    })
    expect(put.status).toBe(200)
    const get = await ws().sendRequest({ host: 'hono.test', path: '/kv/big' })
    expect(get.body.length).toBe(big.length)
    expect(get.body[0]).toBe('x')
    expect(get.body[get.body.length - 1]).toBe('x')
  })

  it('handles binary-shaped (mixed UTF-8) values without corruption', async () => {
    // Use base64 to keep the body 7-bit-clean while round-tripping arbitrary bytes.
    const original = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80])
    const encoded = original.toString('base64')
    await ws().sendRequest({
      host: 'hono.test',
      method: 'PUT',
      path: '/kv/binary-base64',
      body: encoded,
    })
    const got = await ws().sendRequest({
      host: 'hono.test',
      path: '/kv/binary-base64',
    })
    expect(got.body).toBe(encoded)
  })

  it('rejects values larger than 25 MiB with 413', async () => {
    // We don't actually send a 25 MiB body in tests (slow); instead we
    // construct a body just over the limit. Hono parses request body, then
    // the handler sees its length and rejects.
    const tooBig = 'a'.repeat(25 * 1024 * 1024 + 1)
    const res = await ws().sendRequest({
      host: 'hono.test',
      method: 'PUT',
      path: '/kv/oversize',
      body: tooBig,
    })
    expect(res.status).toBe(413)
  }, 30_000)
})

// ─── D1 / Notes API ────────────────────────────────────────────────

describe('hono-api: D1 Notes CRUD', () => {
  it('POST /notes creates a note and returns its id', async () => {
    const res = await ws().sendRequest({
      host: 'hono.test',
      method: 'POST',
      path: '/notes',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'first', body: 'hello' }),
    })
    expect(res.status).toBe(201)
    const note = JSON.parse(res.body)
    expect(typeof note.id).toBe('number')
    expect(note.id).toBeGreaterThan(0)
    expect(note.title).toBe('first')
    expect(note.body).toBe('hello')
    expect(typeof note.created_at).toBe('number')
  })

  it('GET /notes/:id returns the created note', async () => {
    const created = await ws().sendRequest({
      host: 'hono.test',
      method: 'POST',
      path: '/notes',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'fetch-me', body: '...' }),
    })
    const id = JSON.parse(created.body).id
    const res = await ws().sendRequest({
      host: 'hono.test',
      path: `/notes/${id}`,
    })
    expect(res.status).toBe(200)
    const note = JSON.parse(res.body)
    expect(note.title).toBe('fetch-me')
    expect(note.id).toBe(id)
  })

  it('GET /notes returns recent notes (most-recent-first)', async () => {
    const res = await ws().sendRequest({ host: 'hono.test', path: '/notes' })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(Array.isArray(body.notes)).toBe(true)
    expect(body.count).toBe(body.notes.length)
    if (body.notes.length >= 2) {
      // ORDER BY id DESC — newer notes have larger id
      expect(body.notes[0].id).toBeGreaterThan(body.notes[1].id)
    }
  })

  it('DELETE /notes/:id removes the row, subsequent GET returns 404', async () => {
    const created = await ws().sendRequest({
      host: 'hono.test',
      method: 'POST',
      path: '/notes',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'to-delete' }),
    })
    const id = JSON.parse(created.body).id

    const del = await ws().sendRequest({
      host: 'hono.test',
      method: 'DELETE',
      path: `/notes/${id}`,
    })
    expect(del.status).toBe(200)

    const after = await ws().sendRequest({ host: 'hono.test', path: `/notes/${id}` })
    expect(after.status).toBe(404)
  })

  it('DELETE /notes/:id on missing id returns 404', async () => {
    const res = await ws().sendRequest({
      host: 'hono.test',
      method: 'DELETE',
      path: '/notes/9999999',
    })
    expect(res.status).toBe(404)
  })
})

// ─── D1 validation + edge cases ────────────────────────────────────

describe('hono-api: D1 validation', () => {
  it('POST /notes without title returns 400', async () => {
    const res = await ws().sendRequest({
      host: 'hono.test',
      method: 'POST',
      path: '/notes',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'no title' }),
    })
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/title/i)
  })

  it('POST /notes with non-string title returns 400', async () => {
    const res = await ws().sendRequest({
      host: 'hono.test',
      method: 'POST',
      path: '/notes',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 12345 }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /notes with title >200 chars returns 400', async () => {
    const res = await ws().sendRequest({
      host: 'hono.test',
      method: 'POST',
      path: '/notes',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a'.repeat(201) }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /notes with malformed JSON returns 400', async () => {
    const res = await ws().sendRequest({
      host: 'hono.test',
      method: 'POST',
      path: '/notes',
      headers: { 'content-type': 'application/json' },
      body: '{not-valid-json',
    })
    expect(res.status).toBe(400)
  })

  it('GET /notes/:id with non-numeric id returns 400', async () => {
    const res = await ws().sendRequest({
      host: 'hono.test',
      path: '/notes/abc',
    })
    expect(res.status).toBe(400)
  })
})

// ─── Security: SQL injection through parameterized LIKE ────────────

describe('hono-api: SQL injection resistance', () => {
  it('search with payload "; DROP TABLE notes; --" does NOT drop the table', async () => {
    // Insert a sentinel that should survive any injection attempt.
    await ws().sendRequest({
      host: 'hono.test',
      method: 'POST',
      path: '/notes',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'sentinel-do-not-delete' }),
    })

    const malicious = `'; DROP TABLE notes; --`
    const search = await ws().sendRequest({
      host: 'hono.test',
      path: '/notes/search?q=' + encodeURIComponent(malicious),
    })
    expect(search.status).toBe(200) // succeeds, just no matches

    // The table still exists and the sentinel is still findable.
    const sentinel = await ws().sendRequest({
      host: 'hono.test',
      path: '/notes/search?q=' + encodeURIComponent('sentinel'),
    })
    expect(sentinel.status).toBe(200)
    const body = JSON.parse(sentinel.body)
    expect(body.notes.length).toBeGreaterThan(0)
  })

  it('search bound through parameters cannot break out of the LIKE pattern', async () => {
    // Insert a row whose title contains characters that look semantically
    // significant in SQL (single quotes, semicolons). A parameterised
    // query treats them as data — the row stays intact and is searchable
    // by its literal contents.
    await ws().sendRequest({
      host: 'hono.test',
      method: 'POST',
      path: '/notes',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: "Bobby'); DROP TABLE notes; --" }),
    })
    const res = await ws().sendRequest({
      host: 'hono.test',
      path: '/notes/search?q=' + encodeURIComponent('Bobby'),
    })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.notes.length).toBeGreaterThanOrEqual(1)
    // The "scary" title round-trips intact because parameter binding is
    // safe end-to-end.
    expect(
      body.notes.some((n: { title: string }) => n.title.includes('DROP TABLE')),
    ).toBe(true)
  })
})

// ─── Concurrency / stress (light) ──────────────────────────────────

describe('hono-api: concurrency', () => {
  it('50 parallel KV writes all succeed', async () => {
    const writes = Array.from({ length: 50 }, (_, i) =>
      ws().sendRequest({
        host: 'hono.test',
        method: 'PUT',
        path: `/kv/parallel-${i}`,
        body: `value-${i}`,
      }),
    )
    const results = await Promise.all(writes)
    for (const r of results) expect(r.status).toBe(200)
    // Verify a sample
    const probe = await ws().sendRequest({ host: 'hono.test', path: '/kv/parallel-25' })
    expect(probe.body).toBe('value-25')
  }, 30_000)

  it('30 parallel D1 inserts succeed and the count reflects them', async () => {
    const before = JSON.parse(
      (await ws().sendRequest({ host: 'hono.test', path: '/notes' })).body,
    ).count
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        ws().sendRequest({
          host: 'hono.test',
          method: 'POST',
          path: '/notes',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: `parallel-note-${i}`, body: 'b' }),
        }),
      ),
    )
    const after = JSON.parse(
      (await ws().sendRequest({ host: 'hono.test', path: '/notes' })).body,
    ).count
    expect(after - before).toBe(30)
  }, 30_000)
})

describe('hono-api: stress (sequential bulk)', () => {
  it('200 sequential KV puts complete in reasonable time', async () => {
    const start = Date.now()
    for (let i = 0; i < 200; i++) {
      const r = await ws().sendRequest({
        host: 'hono.test',
        method: 'PUT',
        path: `/kv/bulk-${i}`,
        body: `v-${i}`,
      })
      expect(r.status).toBe(200)
    }
    const elapsed = Date.now() - start
    // Ballpark guard — even slow CI shouldn't take >30s for 200 puts.
    expect(elapsed).toBeLessThan(30_000)
  }, 60_000)
})

// ─── Mixed binding flow ────────────────────────────────────────────

describe('hono-api: cross-binding flow (/feed: D1 → KV cache)', () => {
  it('first call hits the origin (D1), second call hits the cache (KV)', async () => {
    // Bust any leftover cache from prior tests.
    await ws().sendRequest({
      host: 'hono.test',
      method: 'DELETE',
      path: '/kv/feed%3Arecent',
    })

    const cold = await ws().sendRequest({ host: 'hono.test', path: '/feed' })
    expect(cold.status).toBe(200)
    expect(JSON.parse(cold.body).source).toBe('origin')

    const warm = await ws().sendRequest({ host: 'hono.test', path: '/feed' })
    expect(warm.status).toBe(200)
    expect(JSON.parse(warm.body).source).toBe('cache')
  })
})
