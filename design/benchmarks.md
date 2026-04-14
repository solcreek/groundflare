# Benchmarks & Architectural Decisions

> Empirical data that shapes the v0.1 runtime architecture. Updated as new benchmarks run.

Status: v0 — Stage 1 complete.

## TL;DR

Stage 1 measures a trivial Worker (no bindings) under 50 parallel connections. workerd standalone delivers 4.5× the throughput of Miniflare's programmatic runtime, with a tighter latency distribution. Based on these numbers, v0.1 ships workerd as the production runtime with systemd management; Miniflare is retained only as a build-time config compiler.

```
workerd standalone:  16,280 rps │ mean 2.66ms │ p50 3ms  │ p99 6ms
Miniflare (proxy):    3,614 rps │ mean 13.3ms │ p50 1ms  │ p99 71ms
```

## Why this benchmark matters

Two credible v0.1 architectures existed:

| Architecture | Pro | Con |
|---|---|---|
| **Miniflare in container** | Simpler — one Node process, proven dev stack | Extra Node runtime, HTTP proxy hop to child workerd |
| **workerd standalone** | Direct binary, smallest footprint | Need our own capnp config generation |

Stage 1 measures which one we should commit to.

## Stage 1: trivial worker (no bindings)

### Setup

- **Machine:** MacBook, Apple Silicon, multi-core
- **Tool:** [autocannon](https://github.com/mcollina/autocannon) v8, 10 seconds per run, 50 parallel connections, pipelining 1
- **Warmup:** 2 seconds before each measurement window (JIT settle)
- **Worker:** returns `new Response('ok')` — zero bindings, zero logic
- **Script:** [`src/poc/bench.ts`](../src/poc/bench.ts)

### Results

| Runtime | RPS | mean latency | p50 | p99 | max | errors |
|---|---:|---:|---:|---:|---:|---:|
| **workerd standalone** | **16,280** | **2.66ms** | 3ms | **6ms** | 130ms | 0 |
| Miniflare (programmatic) | 3,614 | 13.30ms | 1ms | 71ms | 112ms | 0 |

### Interpretation

1. **Throughput: 4.5× higher on workerd standalone.**
2. **Latency distribution: workerd is much tighter.** mean ≈ p50 ≈ p99 (2.66 / 3 / 6). Miniflare is **bimodal** — p50=1ms but mean=13ms means most requests are fast but some stall badly (Node event loop contention under load).
3. **No errors, no non-2xx either side** — both correct.
4. **workerd p99 = 6ms** is notable. For an untuned HTTP server on a laptop, that's very close to wire-speed minus TCP overhead.

### Why workerd is this much faster

- **No Node proxy layer.** Miniflare's architecture: Node process → spawns workerd subprocess → proxies HTTP over a unix socket. Each request crosses language boundaries twice.
- **Smaller memory footprint.** Node + Miniflare bundle ~80 MB RSS; workerd ~20 MB RSS.
- **Native event loop.** workerd uses Cap'n Proto RPC + kj's async I/O, tuned for request/response semantics. Node's `http` module is general-purpose.
- **No module graph re-resolution.** Miniflare re-walks the bundle at proxy-time; workerd loads once at boot.

### What this does NOT show

- Bindings overhead (KV/D1 calls). Real Workers are rarely bindings-free.
- Cold start from deployed-from-zero. See Stage 2.
- VPS-scale constraints. A $5 VPS with 2 vCPU will look different — probably worse for both, with Miniflare degrading more since it's more CPU-heavy.
- Comparison against real CF Workers edge. See Stage 3.

## Architectural decision: v0.1 ships workerd native

Accepted for v0.1 based on Stage 1:

1. **Runtime binary:** workerd (from `npm i workerd`, ~35 MB compressed)
2. **Process supervision:** systemd (native, already on Ubuntu 24.04)
3. **Miniflare role:** build-time only — used to compile wrangler.toml → workerd capnp config, discarded at deploy
4. **No Docker in hot path** — see [Native vs Docker debate (§below)](#native-vs-docker)
5. **No Node runtime on the VPS** for serving requests — just workerd binary + Linux

### Trade-offs accepted

- We must generate workerd capnp config ourselves (or wrap `miniflare.serializeConfig`). Stage 2 PoC.
- Updating workerd version means shipping a new binary to the VPS (non-issue with versioned releases dir + symlink swap).
- Harder to use a "single image ships anywhere" mental model — but we never needed that; one-provider / one-VPS is v1 promise.

### Trade-offs rejected

- Bundling Miniflare in a container "for dev/prod parity": rejected. Prod parity is achieved by **using the same workerd binary locally and remotely**, not by shipping a Node harness.
- Docker image distribution: rejected. See below.

## Native vs Docker

Docker adds roughly **80-100 MB RAM daemon overhead**, complicates debugging (another layer), and solves no problem workerd has. workerd is a single statically-linked binary designed to run natively — the same way Cloudflare's production edge runs it.

Exceptions (Docker still useful):
- User-supplied sidecars (custom cron containers, self-hosted Grafana). Available via `groundflare sidecar add` in v1.5+.

Not using Docker means [`design/bootstrap.md`](bootstrap.md) Stage 6 simplifies to: download workerd binary, install Redis + Caddy via apt, write systemd units.

## Cold start implications (not yet benchmarked)

Because workerd runs as a long-lived systemd service:
- **No isolate eviction** (single-tenant, always loaded)
- **V8 JIT tiers** warm up once and stay hot
- **Durable Object first-touch** is 0ms (all in local SQLite)
- **Idle-recovery** (first request after 1h idle) should be sub-millisecond

Stage 2a will measure this specifically.

## Planned future stages

| Stage | What it measures | Purpose |
|---|---|---|
| **Stage 2a: Idle recovery** | Latency of first request after N-minute idle | Validates structural cold-start advantage over CF |
| **Stage 2b: With bindings** | Same worker with KV (Redis) + D1 (libSQL) bindings | Real-world numbers for README claims |
| **Stage 3a: VPS-scale** | Same benchmark on a Hetzner CX22 | Prove the $5 VPS can handle the load we claim |
| **Stage 3b: vs CF Workers** | Same worker deployed to CF, benchmarked from same region | Honest competitive comparison |
| **Stage 4: Pathological** | Long-running queries, large responses, burst traffic | Characterize failure modes |

Each stage ships with reproducible scripts in `src/poc/` and raw results archived.

## How to re-run

```bash
npm run poc:bench
```

Raw output goes to stdout. Environment variables:
- `BENCH_DURATION=30` — seconds per run (default 10)
- `BENCH_CONNECTIONS=100` — parallel connections (default 50)
- `BENCH_PORT_WORKERD=8080`
- `BENCH_PORT_MINIFLARE=8787`

## Caveat

**All benchmark numbers are laptop-class.** On a real $5 VPS with 2 vCPU, expect lower absolute numbers but similar ratios. Stage 3a will confirm.
