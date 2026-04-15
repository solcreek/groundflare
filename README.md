# groundflare

[![npm version](https://img.shields.io/npm/v/groundflare.svg?color=cb0000)](https://www.npmjs.com/package/groundflare)
[![License](https://img.shields.io/npm/l/groundflare.svg?color=blue)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/groundflare.svg)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/solcreek/groundflare?style=flat)](https://github.com/solcreek/groundflare)

> Your Cloudflare Worker, grounded.

Run any Cloudflare Worker on your own hardware. Same code, your machine, no vendor lock-in.

**Status** — v0.1 Mirror track is feature-complete in-tree and passes an end-to-end Docker e2e suite; the npm release is imminent. v0.2 parallel release with the Bun track is in progress.

## Quick start

```bash
# Once v0.1 is published:
npm install -g groundflare
cd my-worker-project/          # any wrangler.toml project
groundflare up                 # provision a VPS + deploy, one command

# Today (early access from source):
git clone https://github.com/solcreek/groundflare.git
cd groundflare && npm install && npm link
```

Requires Node.js ≥ 20.

## Two tracks, one CLI

Cloudflare published `workerd` as open source. groundflare takes that recipe and cooks it in any home kitchen — literally the same runtime, or a Bun-native remix for throughput-sensitive menus. See [`design/tracks.md`](design/tracks.md) for the full design.

### Mirror track (default)

Runs `workerd` with your Worker unchanged. Bug-for-bug Cloudflare semantics, including Durable Objects.

- **Zero code changes** to your existing Worker
- Measured throughput: 100–1000 rps per binding on shared-CPU tiers; ~500 rps predictable on dedicated CPU
- Best for: migrating existing CF Workers, Durable-Object workloads, full Workers-API compatibility

### Bun track (opt-in, v0.2)

Runs `Bun.serve` with LLM-assisted one-time migration of bindings to Bun-native equivalents (bun:sqlite, ioredis, S3 SDK).

- **~7,300–9,900 rps per binding on any $6+ VPS**, zero errors through 1000-concurrent HN burst ([`design/benchmarks.md`](design/benchmarks.md) §Stage 3c)
- Best for: high-throughput or bursty workloads, no Durable-Object dependency
- Opt in via `[groundflare] runtime = "bun"` in `wrangler.toml`; `groundflare bun prepare` drives the migration

## Supported bindings

Status refers to the version where each binding is promoted from "works" to "v0.2 reliability SLO covered".

| Binding | Mirror | Bun | Default adapter |
|---|---|---|---|
| Workers runtime | ✅ v0.1 | ✅ v0.2 | workerd / Bun.serve |
| KV | ✅ v0.1 | ✅ v0.2 | SQLite (WAL, embedded, optional shards=N) |
| D1 | ✅ v0.1 | ✅ v0.2 | libSQL / SQLite |
| R2 | ✅ v0.1 | ✅ v0.2 | passthrough to Cloudflare R2 (default) · SeaweedFS (self-host) |
| Durable Objects | ✅ v0.1 | ❌ Mirror-only | workerd native `ctx.storage` |
| Cache API | ✅ v0.1 | ⚠️ v0.3 | in-memory |
| Service Bindings | ✅ v0.1 | ⚠️ v0.4 | same-process dispatch |
| Cron Triggers | ✅ v0.1 | ✅ v0.2 | systemd `.timer` → `__scheduled` |
| HTMLRewriter | ✅ v0.1 | ⚠️ v0.3 | workerd native · linkedom (Bun) |
| WebSocketPair | ✅ v0.1 | ⚠️ v0.3 | workerd native · Bun WebSocket |
| Queues | 🚧 v0.4 | 🚧 v0.4 | SQLite (default) · Redis Streams (opt-in) |

Legend: ✅ implemented · ⚠️ partial / planned version · ❌ not on the Bun track by design · 🚧 in progress

Intentionally unsupported (no local runtime; keep these bindings on Cloudflare or substitute an external service):

- **Workers AI** — use Ollama, vLLM, OpenRouter, or the Anthropic API
- **Vectorize** — use pgvector, Qdrant, or similar
- **Hyperdrive** — use a direct Postgres connection
- **Browser Rendering** — use Browserless
- **Email Workers** — use Resend or Postmark

## Cost efficiency

Measured end-to-end on DigitalOcean `sgp1` with kernel tunings from [`design/bootstrap.md`](design/bootstrap.md) applied. Full methodology and per-tier numbers in [`design/benchmarks.md`](design/benchmarks.md).

| VPS tier | Monthly | Mirror rps/binding | Bun rps/binding | Errors @ 1000 conn |
|---|---:|---|---:|---:|
| `s-1vcpu-1gb` shared | **$6** | 100–1,000 (hypervisor variance) | **~7,300** | 0 |
| `s-2vcpu-4gb` shared | $21 | 100–1,000 | ~9,900 | 0 |
| `c-2` dedicated | $84 | ~500 predictable | ~9,000 | 0 |

For context, a typical indie Cloudflare Workers Paid plan with moderate D1/KV usage runs in the $15–$50/mo range before traffic surges hit per-request pricing. `groundflare estimate` (v0.2) reads a Cloudflare billing CSV or pulls usage live and reports projected savings on the target VPS tier — see [`design/cost-estimate.md`](design/cost-estimate.md).

**A note on shared-tier variance**: the 100–1,000 rps range for Mirror on shared-CPU droplets reflects hypervisor-neighbour luck, not tier difference. Dedicated-CPU tiers remove the variance; the Bun track barely notices it at all.

## Why groundflare

Cloudflare Workers are, in our opinion, the best serverless developer experience available. groundflare exists because we're heavy users of that platform and wanted the same developer experience on our own hardware for specific cases:

- **D1 ceilings** — 10 GB per database cap, write-throughput bottleneck, stale read replicas
- **Bill unpredictability** — viral moments surprised by per-request metering
- **Compliance / data residency** — GDPR, HIPAA, government air-gap, BYO-cloud mandates
- **Deterministic cost** — a single $6/mo line item instead of metered overage

Cloudflare remains the right answer for global edge reach and the rest of its platform. groundflare is the right answer when co-located deterministic infrastructure matters more than global distribution — and it stays compatible so you can mix and match. Most real users land on a hybrid: static assets and edge caching on Cloudflare, data plane and compute on groundflare.

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

## License

MIT
