# hono-api — groundflare reference example

A realistic Worker built with [Hono](https://hono.dev) that exercises
every binding kind groundflare supports today:

| Binding | Used in | Backed by |
|---|---|---|
| `[vars] APP_NAME` | every response | inline value (capnp `text` binding) |
| `env.CACHE` (KV) | `/kv/*`, `/feed` cache | DurableObject + `state.storage` |
| `env.DB` (D1) | `/notes/*` REST API | DurableObject + `state.storage.sql` (SQLite) |

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Hello, includes `APP_NAME` |
| GET | `/health` | `{ status, app, time }` |
| GET | `/kv?prefix=X&limit=N&cursor=...` | List KV keys |
| GET | `/kv/:key` | Read value (404 on miss) |
| PUT | `/kv/:key` | Store body (max 25 MiB; `?ttl=` in seconds) |
| DELETE | `/kv/:key` | Delete |
| GET | `/notes` | List recent notes (max 200) |
| POST | `/notes` | Create note `{ title, body? }` |
| GET | `/notes/:id` | Read one note |
| DELETE | `/notes/:id` | Delete (404 if missing) |
| GET | `/notes/search?q=...` | Parameterized LIKE search |
| GET | `/feed` | KV-cached recent notes feed |

## Running locally with groundflare's harness

The example's primary purpose is to be the test fixture for groundflare's
end-to-end coverage. It's bundled (esbuild) and run inside real workerd
during `npm run test:integration` — see
`test/integration/example-hono-api.test.ts` for the full matrix:

- happy-path CRUD on KV + D1
- edge cases: unicode, empty/oversize values, malformed JSON, validation
- security: SQL-injection-shaped payloads against parameterized queries
- concurrency: 50 parallel writes, 1000 sequential burst
- mixed-binding flow: feed cache eviction + repopulation

## Running on your VPS (when v0.2 deploy lands)

```bash
$ cd examples/hono-api
$ groundflare up      # provision a Hetzner box + deploy this Worker
```

Until the deploy command is implemented, this directory is for
testing + reference only.

## Why Hono?

Hono is the most common framework for CF Workers — small (~12 KB
gzipped), fast, idiomatic Web API. Validating that groundflare hosts a
Hono app unchanged is a good proxy for "any user code works."
