/**
 * Realistic Hono-based example Worker for groundflare.
 *
 * Exercises every binding kind groundflare supports today:
 *   - vars  (APP_NAME)
 *   - KV    (env.CACHE)
 *   - D1    (env.DB)
 *
 * Tested end-to-end against real workerd in
 * test/integration/example-hono-api.test.ts.
 *
 * To deploy on a groundflare VPS:
 *   $ cd examples/hono-api
 *   $ groundflare up        # provisions + deploys
 */

import { Hono } from 'hono'

interface Env {
  APP_NAME: string
  CACHE: KVNamespace
  DB: D1Database
}

const app = new Hono<{ Bindings: Env }>()

// ─── Health / meta ─────────────────────────────────────────────────

app.get('/', (c) => c.text(`hello from ${c.env.APP_NAME}`))

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    app: c.env.APP_NAME,
    time: new Date().toISOString(),
  }),
)

// ─── KV-backed routes ──────────────────────────────────────────────

app.get('/kv', async (c) => {
  const prefix = c.req.query('prefix') ?? ''
  const limitParam = c.req.query('limit')
  const cursor = c.req.query('cursor')
  const limit = limitParam ? Number(limitParam) : undefined
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    return c.json({ error: 'limit must be a positive integer' }, 400)
  }
  const result = await c.env.CACHE.list({ prefix, limit, cursor })
  return c.json({
    keys: result.keys.map((k) => k.name),
    list_complete: result.list_complete,
    cursor: result.cursor ?? null,
  })
})

app.get('/kv/:key', async (c) => {
  const value = await c.env.CACHE.get(c.req.param('key'))
  if (value === null) return c.notFound()
  return c.text(value)
})

app.put('/kv/:key', async (c) => {
  const body = await c.req.text()
  if (body.length === 0) return c.json({ error: 'empty body' }, 400)
  if (body.length > 25 * 1024 * 1024) {
    return c.json({ error: 'value exceeds 25 MiB' }, 413)
  }
  const ttl = c.req.query('ttl')
  const opts: KVNamespacePutOptions = {}
  if (ttl) {
    const n = Number(ttl)
    if (!Number.isFinite(n) || n < 1) {
      return c.json({ error: 'ttl must be a positive integer (seconds)' }, 400)
    }
    opts.expirationTtl = n
  }
  await c.env.CACHE.put(c.req.param('key'), body, opts)
  return c.json({ ok: true, bytes: body.length })
})

app.delete('/kv/:key', async (c) => {
  await c.env.CACHE.delete(c.req.param('key'))
  return c.json({ ok: true })
})

// ─── D1-backed Notes API ───────────────────────────────────────────

// Lazy schema bootstrap. In production you'd run this from a migration
// script at deploy time; for the demo we keep it inline so the example is
// self-contained and idempotent.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_created_at ON notes(created_at);
`

let schemaInitialized = false
async function ensureSchema(env: Env): Promise<void> {
  if (schemaInitialized) return
  await env.DB.exec(SCHEMA)
  schemaInitialized = true
}

interface Note {
  id: number
  title: string
  body: string
  created_at: number
}

app.get('/notes', async (c) => {
  await ensureSchema(c.env)
  const result = await c.env.DB.prepare(
    'SELECT id, title, body, created_at FROM notes ORDER BY id DESC LIMIT 200',
  ).all<Note>()
  return c.json({ notes: result.results, count: result.results.length })
})

app.post('/notes', async (c) => {
  await ensureSchema(c.env)
  let payload: { title?: string; body?: string }
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  if (!payload.title || typeof payload.title !== 'string') {
    return c.json({ error: 'title is required and must be a string' }, 400)
  }
  if (payload.title.length > 200) {
    return c.json({ error: 'title cannot exceed 200 chars' }, 400)
  }
  const body = typeof payload.body === 'string' ? payload.body : ''
  const created = Date.now()
  const result = await c.env.DB
    .prepare('INSERT INTO notes(title, body, created_at) VALUES (?, ?, ?)')
    .bind(payload.title, body, created)
    .run()
  return c.json({
    id: result.meta.last_row_id,
    title: payload.title,
    body,
    created_at: created,
  }, 201)
})

// Order matters: more specific routes (`/notes/search`) must be declared
// before the parameterised catch-all (`/notes/:id`), otherwise Hono treats
// "search" as an :id value.
app.get('/notes/search', async (c) => {
  await ensureSchema(c.env)
  const q = c.req.query('q') ?? ''
  if (q.length === 0) {
    return c.json({ error: 'query parameter q is required' }, 400)
  }
  // Parameterized LIKE — workerd's SqliteActorCache safely binds and
  // escapes; the test suite verifies "'; DROP TABLE" doesn't execute.
  const pattern = `%${q}%`
  const result = await c.env.DB
    .prepare(
      'SELECT id, title, body, created_at FROM notes ' +
        'WHERE title LIKE ? OR body LIKE ? ORDER BY id DESC LIMIT 50',
    )
    .bind(pattern, pattern)
    .all<Note>()
  return c.json({ notes: result.results, count: result.results.length, q })
})

app.get('/notes/:id', async (c) => {
  await ensureSchema(c.env)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: 'id must be a positive integer' }, 400)
  }
  const note = await c.env.DB
    .prepare('SELECT id, title, body, created_at FROM notes WHERE id = ?')
    .bind(id)
    .first<Note>()
  if (!note) return c.notFound()
  return c.json(note)
})

app.delete('/notes/:id', async (c) => {
  await ensureSchema(c.env)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: 'id must be a positive integer' }, 400)
  }
  const result = await c.env.DB
    .prepare('DELETE FROM notes WHERE id = ?')
    .bind(id)
    .run()
  if (result.meta.changes === 0) return c.notFound()
  return c.json({ ok: true })
})

// ─── Combined endpoint to demo cross-binding flow ──────────────────

// Cache the most-recent notes feed in KV so subsequent reads avoid D1.
app.get('/feed', async (c) => {
  await ensureSchema(c.env)
  const cached = await c.env.CACHE.get('feed:recent')
  if (cached !== null) {
    return c.json({ source: 'cache', notes: JSON.parse(cached) })
  }
  const result = await c.env.DB.prepare(
    'SELECT id, title FROM notes ORDER BY id DESC LIMIT 10',
  ).all<{ id: number; title: string }>()
  await c.env.CACHE.put('feed:recent', JSON.stringify(result.results), {
    expirationTtl: 60,
  })
  return c.json({ source: 'origin', notes: result.results })
})

// 404 fallback
app.notFound((c) => c.json({ error: 'not found' }, 404))

// Error handler (don't leak stack traces in prod)
app.onError((err, c) => {
  console.error('hono-api error', err)
  return c.json({ error: 'internal server error' }, 500)
})

export default app
