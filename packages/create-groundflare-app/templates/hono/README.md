# {{name}}

A [Hono](https://hono.dev) REST API that runs on **both** [Cloudflare Workers](https://workers.cloudflare.com) and [groundflare](https://www.npmjs.com/package/groundflare) — zero code changes.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/solcreek/groundflare/tree/main/packages/create-groundflare-app/templates/hono)

## Routes

| Method | Path | Binding | Description |
|---|---|---|---|
| GET | `/` | — | Status JSON |
| GET | `/health` | — | Health check |
| GET | `/api/items` | D1 | List items |
| POST | `/api/items` | D1 | Create item (`{ "name": "..." }`) |
| DELETE | `/api/items/:id` | D1 | Delete item |
| GET | `/api/cache/:key` | KV | Read from cache |
| PUT | `/api/cache/:key` | KV | Write to cache (body = value) |

Routes that need a binding return a helpful `501` with setup instructions until the binding is enabled. The app starts and serves `/` + `/health` with zero configuration.

## Deploy to Cloudflare

```bash
npm install
npx wrangler dev          # local dev
npx wrangler deploy       # production
```

To enable D1:
```bash
npx wrangler d1 create {{name}}-db
# paste the database_id into wrangler.toml, uncomment the [[d1_databases]] block
npx wrangler d1 execute {{name}}-db --file=migrations/0001_init.sql
npx wrangler deploy
```

## Deploy to your own VPS (groundflare)

```bash
npm install -g groundflare
groundflare secret set provider.hetzner.token <your-token>
# uncomment the [groundflare] section in wrangler.toml
groundflare up
```

No `database_id` needed — groundflare creates the SQLite file on the VPS automatically.

To switch to the Bun track (~7,000 rps on a $6 VPS):
```bash
groundflare bun analyze   # check compatibility
groundflare bun prepare   # flip runtime to bun
groundflare up
```

## Local development

```bash
npx wrangler dev
```

Uses wrangler's local dev server with hot-reload. groundflare is only the production deploy target.
