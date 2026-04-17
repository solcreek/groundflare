# groundflare

[![npm version](https://img.shields.io/npm/v/groundflare.svg?color=cb0000)](https://www.npmjs.com/package/groundflare)
[![License](https://img.shields.io/npm/l/groundflare.svg?color=blue)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/groundflare.svg)](https://nodejs.org)
[![CI: groundflare](https://github.com/solcreek/groundflare/actions/workflows/ci-groundflare.yml/badge.svg)](https://github.com/solcreek/groundflare/actions/workflows/ci-groundflare.yml)

> Your Cloudflare Worker, grounded.

Run any Cloudflare Worker on your own hardware. Same code, your machine, no vendor lock-in.

**Status** — v0.5 is the current release. Two runtime tracks from one CLI: **Mirror** (workerd, zero source change, bug-for-bug CF semantics) and **Bun** (`Bun.serve` + `bun:sqlite` KV/D1 + S3-compat R2, 7K–9K rps/binding on a $6 VPS). v0.5 ships self-hosted R2: a SeaweedFS sidecar installs with `groundflare up` and `env.MEDIA.put/get/...` works zero-config — or point any bucket at B2/Wasabi/Tigris/MinIO/real R2 via an `[r2_buckets.groundflare]` block with secret-resolved SigV4 creds. Live-validated on a 1 GB DO droplet; full R2 surface incl. multipart + conditional + range + metadata round-trip, 1002 tests across L1 pure-function / L2 workerd-driven / L3 real-SeaweedFS layers. v0.4 added the DigitalOcean provider, framework support via wrangler-native `[build]` + `[assets]` + `[[routes]] custom_domain`, auto-detected package manager, and the `WorkerLoader` binding for plugin sandboxing — apps like emdash CMS that use CF's "Workers for Platforms" pattern run unmodified. Providers: Hetzner, DigitalOcean, Linode, Vultr. OIDC-published with SLSA provenance.

## Quick start

```bash
# Already have a Cloudflare Worker? See if it can migrate in zero clicks:
cd my-cf-worker
npx groundflare bun analyze
#   ✓ KV binding CACHE → bun:sqlite
#   ✓ D1 binding DB    → bun:sqlite
#   ✓ R2 binding ASSETS → S3-compat passthrough
#   Ready for the Bun track.

# Deploy to your own VPS:
npx groundflare up
#   → provisions (Hetzner / DigitalOcean / Linode / Vultr)
#   → runs cloud-init + installs runtime
#   → bundles your Worker, pushes it, starts workerd/Bun under systemd
#   → Caddy terminates TLS via Let's Encrypt

# Or start from scratch:
npm create groundflare-app@latest my-worker
```

Requires Node.js ≥ 22.

## Two tracks, one CLI

Cloudflare published `workerd` as open source. groundflare takes that recipe and cooks it in any home kitchen — literally the same runtime, or a Bun-native remix for throughput-sensitive menus. See [`design/tracks.md`](design/tracks.md) for the full design.

### Mirror track (default)

Runs `workerd` with your Worker unchanged. Bug-for-bug Cloudflare semantics, including Durable Objects.

- **Zero code changes** to your existing Worker
- Measured throughput: 100–1,000 rps per binding on shared-CPU tiers; ~500 rps predictable on dedicated CPU
- Best for: migrating existing CF Workers, Durable-Object workloads, full Workers-API compatibility

### Bun track (opt-in, v0.2)

Runs `Bun.serve` with Cloudflare-shaped adapters: `bun:sqlite` for KV and D1, S3-compat passthrough to Cloudflare R2. Most Workers migrate with no source changes — `env.DB.prepare(...)`, `env.CACHE.put(...)`, `env.ASSETS.get(...)` all keep working.

- **~7,300–9,900 rps per binding on any $6+ VPS**, zero errors through 1000-concurrent HN burst ([`design/benchmarks.md`](design/benchmarks.md) §Stage 3c)
- Best for: high-throughput or bursty workloads, no Durable-Object dependency
- Opt in via `[groundflare] runtime = "bun"` in `wrangler.toml`

```bash
# Analyse, prepare, deploy
groundflare bun analyze
groundflare bun prepare   # flips runtime = "bun" in wrangler.toml
groundflare up
```

Blockers the analyzer refuses to migrate (stay on Mirror): `HTMLRewriter`, `WebSocketPair`, `class extends DurableObject`, and any DO binding declarations.

## Supported bindings

| Binding | Mirror | Bun | Default adapter |
|---|---|---|---|
| Workers runtime | ✅ v0.1 | ✅ v0.2 | workerd / Bun.serve |
| KV | ✅ v0.1 | ✅ v0.2 | SQLite (WAL, embedded, optional shards=N) |
| D1 | ✅ v0.1 | ✅ v0.2 | node:sqlite / bun:sqlite |
| R2 | ✅ v0.5 | ✅ v0.2 | SeaweedFS sidecar (default) · BYO S3 endpoint (B2/Wasabi/real R2/…) · passthrough (Bun) |
| Durable Objects | ✅ v0.1 | ❌ Mirror-only | workerd native `ctx.storage` |
| Cache API | ✅ v0.1 | ⚠️ v0.3 | workerd native (Mirror) · planned drop-in (Bun) |
| Service Bindings | ✅ v0.1 | ⚠️ v0.4 | same-process dispatch |
| Cron Triggers | ✅ v0.1 | 🚧 v0.3 | systemd `.timer` → `__scheduled` |
| HTMLRewriter | ✅ v0.1 | ⚠️ v0.3 | workerd native · linkedom (Bun) |
| WebSocketPair | ✅ v0.1 | ⚠️ v0.3 | workerd native · Bun WebSocket |
| Queues | 🚧 v0.4 | 🚧 v0.4 | SQLite (default) · Redis Streams (opt-in) |

Legend: ✅ implemented · ⚠️ partial / planned · ❌ not on the Bun track by design · 🚧 in progress

Intentionally unsupported (no local runtime; keep these on Cloudflare or substitute externally):

- **Workers AI** — Ollama, vLLM, OpenRouter, Anthropic API
- **Vectorize** — pgvector, Qdrant
- **Hyperdrive** — direct Postgres connection
- **Browser Rendering** — Browserless
- **Email Workers** — Resend, Postmark

## Cost efficiency

Measured end-to-end on DigitalOcean `sgp1`. Full methodology and per-tier numbers in [`design/benchmarks.md`](design/benchmarks.md).

| VPS tier | Monthly | Mirror rps/binding | Bun rps/binding | Errors @ 1000 conn |
|---|---:|---|---:|---:|
| `s-1vcpu-1gb` shared | **$6** | 100–1,000 (hypervisor variance) | **~7,300** | 0 |
| `s-2vcpu-4gb` shared | $21 | 100–1,000 | ~9,900 | 0 |
| `c-2` dedicated | $84 | ~500 predictable | ~9,000 | 0 |

For context, a typical indie Cloudflare Workers Paid plan with moderate D1/KV usage runs in the $15–$50/mo range before traffic surges hit per-request pricing. `groundflare estimate` reads a Cloudflare billing CSV or pulls usage live and reports projected savings on the target VPS tier — see [`design/cost-estimate.md`](design/cost-estimate.md).

## Why groundflare

Cloudflare Workers are, in our opinion, the best serverless developer experience available. groundflare exists because we're heavy users of that platform and wanted the same DX on our own hardware for specific cases:

- **D1 ceilings** — 10 GB per database, write-throughput bottleneck, stale read replicas
- **Bill unpredictability** — viral moments metered per request
- **Compliance / data residency** — GDPR, HIPAA, air-gap, BYO-cloud mandates
- **Deterministic cost** — a single $6/mo line item instead of metered overage

Cloudflare remains the right answer for global edge reach. groundflare is the right answer when co-located deterministic infrastructure matters more than global distribution — and stays compatible so you can mix and match. Most real users land on a hybrid: static assets + edge caching on Cloudflare, data plane and compute on groundflare.

## Packages in this repo

This is a monorepo. Published packages live under [`packages/`](./packages):

| Package | Path | Purpose |
|---|---|---|
| [`groundflare`](./packages/groundflare) | `packages/groundflare` | The CLI — bootstrap, deploy, analyze, prepare |
| [`create-groundflare-app`](./packages/create-groundflare-app) | `packages/create-groundflare-app` | Project scaffold — `npm create groundflare-app` |
| [`groundflare-estimate`](./packages/estimate) | `packages/estimate` | Standalone cost estimator — `npx groundflare-estimate` |

## Design docs

- [`design/tracks.md`](design/tracks.md) — Mirror vs Bun strategy
- [`design/bootstrap.md`](design/bootstrap.md) — day-0 VPS automation pipeline
- [`design/config.md`](design/config.md) — `wrangler.toml` extension model
- [`design/kv-sharding.md`](design/kv-sharding.md) — per-binding sharding
- [`design/benchmarks.md`](design/benchmarks.md) — measured numbers across VPS tiers
- [`design/sqlite-performance.md`](design/sqlite-performance.md) — write-path reliability targets
- [`design/testing.md`](design/testing.md) — four-tier test pyramid
- [`design/observability.md`](design/observability.md) — metrics, logs, alerts
- [`design/workspaces.md`](design/workspaces.md) — multi-tenant Workers on one VPS

## Contributing

```bash
git clone https://github.com/solcreek/groundflare.git
cd groundflare
npm ci

npm run check       # tsc --noEmit
npm run lint        # eslint
npm test            # vitest (unit + integration + conformance)
npm run test:bun    # bun:test against the bun:sqlite adapters
npm run test:e2e    # Tier-3 Docker e2e (requires Docker)
```

## License

MIT — see [LICENSE](./LICENSE).
