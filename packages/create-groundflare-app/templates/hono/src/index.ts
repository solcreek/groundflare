import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB?: D1Database
  CACHE?: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

app.get('/', (c) => {
  return c.json({
    name: '{{name}}',
    status: 'running',
    deploy: 'Works on both Cloudflare Workers and groundflare — zero code changes.',
  })
})

app.get('/health', (c) => c.json({ ok: true }))

// ── D1 example (optional — enable the binding in wrangler.toml) ──

app.get('/api/items', async (c) => {
  if (!c.env.DB) return c.json(needsBinding('DB', 'd1_databases'), 501)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM items ORDER BY created_at DESC LIMIT 50',
  ).all()
  return c.json(results)
})

app.post('/api/items', async (c) => {
  if (!c.env.DB) return c.json(needsBinding('DB', 'd1_databases'), 501)
  const { name } = await c.req.json<{ name: string }>()
  if (!name) return c.json({ error: 'name is required' }, 400)
  const row = await c.env.DB.prepare(
    'INSERT INTO items(name) VALUES (?) RETURNING *',
  )
    .bind(name)
    .first()
  return c.json(row, 201)
})

app.delete('/api/items/:id', async (c) => {
  if (!c.env.DB) return c.json(needsBinding('DB', 'd1_databases'), 501)
  await c.env.DB.prepare('DELETE FROM items WHERE id = ?')
    .bind(c.req.param('id'))
    .run()
  return c.body(null, 204)
})

// ── KV cache example (optional) ──────────────────────────────────

app.get('/api/cache/:key', async (c) => {
  if (!c.env.CACHE) return c.json(needsBinding('CACHE', 'kv_namespaces'), 501)
  const value = await c.env.CACHE.get(c.req.param('key'))
  if (value === null) return c.json({ key: c.req.param('key'), hit: false }, 404)
  return c.json({ key: c.req.param('key'), hit: true, value })
})

app.put('/api/cache/:key', async (c) => {
  if (!c.env.CACHE) return c.json(needsBinding('CACHE', 'kv_namespaces'), 501)
  const body = await c.req.text()
  await c.env.CACHE.put(c.req.param('key'), body)
  return c.json({ key: c.req.param('key'), stored: true })
})

// ── helpers ──────────────────────────────────────────────────────

function needsBinding(name: string, tomlSection: string) {
  return {
    error: `Binding ${name} is not configured.`,
    help: `Uncomment the [[${tomlSection}]] section in wrangler.toml, then redeploy.`,
  }
}

export default app
