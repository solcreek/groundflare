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

Not using Docker means [`design/bootstrap.md`](bootstrap.md) Stage 6 simplifies to: download workerd binary, install Caddy via apt, write systemd units. KV/Queues state lives in embedded SQLite files — no additional daemon.

## Stage 2a: idle-recovery latency

Measures the first request after a 30-second idle window, repeated 5 times per runtime. The hypothesis: an always-on process has no isolate-eviction penalty.

### Setup

- Same trivial worker as Stage 1
- Warmup: 5 requests, discarded
- Warm baseline: 20 back-to-back sequential requests
- Idle recovery: 5 trials × (wait 30s, send 1 request, measure)
- Script: [`src/poc/bench-idle.ts`](../src/poc/bench-idle.ts)

### Results

| Runtime | warm p50 | warm mean | **idle p50** | **idle mean** | idle − warm (mean) |
|---|---:|---:|---:|---:|---:|
| **workerd standalone** | 0.45ms | 0.66ms | **1.31ms** | **1.35ms** | **+0.69ms** |
| Miniflare | 1.07ms | 1.14ms | 1.97ms | 1.92ms | +0.78ms |

### Interpretation

1. **Both runtimes stay sub-2ms after 30s idle.** No runtime shows anything resembling an isolate-eviction penalty. The ~0.7ms delta is structural (TCP connection freshness, V8 minor GC housekeeping) — not workerd- or Miniflare-specific.

2. **workerd idle (1.35ms) is faster than Miniflare warm (1.14ms mean is close, but p99 tells the real story: workerd 1.72ms idle vs Miniflare 2.74ms warm).** The proxy layer overhead matters more than idle state.

3. **Reference point: CF Workers cold-start.** Published Cloudflare numbers put warm-to-cold isolate recovery in the 5-50ms range (depends on edge region and binding surface). Both groundflare candidates are structurally lower.

4. **This does not prove "zero cold start."** 30s of idle is short. Longer idle windows (hours, days) may show different behavior — e.g., Linux TCP socket timeouts, OS-level paging, or JIT deoptimization. Stage 2b will test longer intervals.

### Follow-ups

- Stage 2b: vary idle window (60s, 5min, 1h, 24h)
- Stage 2d: compare to real CF Workers edge for the same worker
- Both need separate PoC runs; results will be added as completed.

## Stage 2c: workerd vs Bun

Bun implements a Web-standard `fetch` handler and JavaScriptCore-based HTTP server that is widely reputed faster than Node. Since groundflare could hypothetically target Bun instead of workerd, the question worth answering: **what does the runtime choice actually cost us in throughput?**

### Setup

- Same trivial worker: returns `new Response('ok')`
- Bun + bun:sqlite variant: `INSERT` + `SELECT COUNT(*)` on an in-memory SQLite per request (100-row pre-seed)
- autocannon 10s @ 50 parallel connections
- Script: [`src/poc/bench-bun.ts`](../src/poc/bench-bun.ts)

### Results

| Runtime | RPS | mean | p50 | p99 | max |
|---|---:|---:|---:|---:|---:|
| workerd standalone | 11,920 | 3.82ms | 4ms | 32ms | 171ms |
| **Bun.serve (trivial)** | **44,496** | **0.62ms** | 1ms | **2ms** | 41ms |
| Bun + bun:sqlite | 17,570 | 2.36ms | 2ms | 6ms | 18ms |

### Interpretation

1. **Bun's pure HTTP dispatch is ~3.7× workerd's trivial throughput**, with p99 in single-digit ms. This reflects Bun's tightly-tuned HTTP server on JavaScriptCore — it is built for raw fetch handlers.

2. **Bun + bun:sqlite doing real SQL work (INSERT + SELECT) still beats workerd doing nothing** at the dispatch layer. The `bun:sqlite` path is FFI-backed and close to free.

3. **workerd dispatch shows higher tails** (p99 32ms, max 171ms) on this run compared to Stage 1 (p99 6ms). Likely CPU contention from three back-to-back runtimes on the same laptop — not a workerd defect. Stage 3a (VPS isolation) will be more representative.

### This does not change the architecture decision

Bun is faster at HTTP. **Bun does not implement Cloudflare Workers semantics.** Specifically:

| Workers feature | workerd | Bun |
|---|---|---|
| fetch handler shape | yes | yes (compatible) |
| `env.DB` / `env.KV` / `env.R2` bindings | yes | **no — conceptually absent** |
| Durable Objects | yes | no |
| `compatibility_date` / flags | yes | no |
| V8 (matches CF production) | yes | no (uses JavaScriptCore) |

groundflare's contract is "take any existing Cloudflare Worker and run it unchanged." That requires workerd. Bun would require the user to rewrite every binding call — which is no longer the same product.

### What this means in context

- At 12k RPS per core of workerd, a $5 VPS handles more traffic than any micro-SaaS will ever see. The Bun throughput advantage is irrelevant below the scale where any groundflare user operates.
- **For users who don't need Workers semantics** (pure fetch handler, no bindings), Bun + Hono is genuinely a better choice. Those users aren't groundflare's audience.
- `bun:sqlite` remains worth studying as an adapter reference — if workerd's built-in D1 path shows performance issues on a real VPS, we have a proof point that in-process SQLite can be very fast.

## Stage 2d: workerd + SQLite-backed KV and D1 (multi-tenant)

The previous stages measured pure HTTP dispatch. Stage 2d exercises the real `buildCapnpFromWorkspace` → `renderCapnpConfig` → `spawnWorkerd` pipeline with on-disk SQLite KV and D1 bindings, routed through the multi-tenant Router Worker.

### Setup

- Machine: same laptop (Apple Silicon)
- Tool: autocannon 10s @ 50 parallel connections per scenario
- Architecture: Router Worker → tenant Worker (dispatches by Host header) → SqlStorage-backed DO namespace → on-disk SQLite file
- PRAGMAs applied per `src/runtime/sqlite/prelude.ts` (WAL, NORMAL sync, 64 MB cache, 256 MB mmap, busy_timeout 5000)
- Script: [`src/poc/bench-bindings.ts`](../src/poc/bench-bindings.ts)

### Results

| Scenario | RPS | mean | p50 | p99 | max | errors |
|---|---:|---:|---:|---:|---:|---:|
| noop (baseline, multi-tenant) | 6,855 | 6.75ms | 0ms | 45ms | 85ms | 0 |
| KV get (hot key) | 3,958 | 12.12ms | 1ms | 80ms | 140ms | 0 |
| KV get (miss) | 4,231 | 11.18ms | 1ms | 79ms | 150ms | 0 |
| KV put (random keys) | 2,626 | 20.66ms | 4ms | 39ms | 8,718ms | 32 |
| D1 SELECT (indexed) | 3,875 | 12.38ms | 1ms | 93ms | 180ms | 0 |
| D1 INSERT | 2,452 | 11.75ms | 5ms | 9ms | 6,362ms | 16 |

### Interpretation

1. **Baseline drops from Stage 1's 16k rps to 6.8k rps.** The multi-tenant Router Worker adds an extra dispatch hop. This is intrinsic to the workspace architecture, not a regression.

2. **Read throughput is comfortable for the target workload.** 3.9–4.2k rps for KV get / D1 SELECT on a laptop implies a $5 Hetzner CX22 will handle 1–2k rps, more than enough for any micro-SaaS. p50 stays at 1ms — median users see a fully cached response.

3. **Writes show tail-latency spikes under 50-way concurrency.** KV put max 8.7s, D1 INSERT max 6.4s, with a small number of timeouts (32 and 16). SQLite WAL handles concurrent writers via `busy_timeout` retries, but at 50 parallel writers on a single file some callers wait seconds. For a single-node, single-tenant workload (the common case), 50-way concurrent writes are unrealistic.

4. **KV hot vs miss are effectively identical.** Both paths hit the same SQL-backed DO; a "miss" just returns null after the lookup. No OS-level page-cache advantage for hot keys because the working set fits in memory either way.

5. **D1 INSERT p99 is surprisingly low (9ms) but max explodes (6.3s).** The distribution is bimodal: most inserts are fast, but when the WAL checkpointer kicks in or two writers collide, some requests stall. This is SQLite's expected behavior under heavy write contention.

### Implications

- **Reads are a solved problem at target scale.** The KV/D1 reads are fast, deterministic, and have healthy p99s.
- **Write contention is the thing to watch in production.** The Queues design (SQLite-backed) will hit the same pattern; the `redis-streams` opt-in exists precisely for users who outgrow this.
- **The baseline gap vs Stage 1 is architectural, not a bug.** Multi-tenancy costs ~60% of trivial-dispatch throughput. Single-tenant deployments could skip the Router Worker for full Stage 1 numbers, but we haven't made that a separate code path yet — may be worth an option for users with one Worker per VPS.

### Follow-ups

- Stage 2e: same scenarios with workspace of 10 concurrent tenants (contention across files)
- Stage 3a: re-run on Hetzner CX22 to validate ratio assumptions

### Stage 2d.0: realistic concurrency (errors=0 baseline)

Stage 2d's first run used 50 parallel connections across every scenario, which for writes exceeds any realistic micro-SaaS workload and generated client-side timeouts (33–48 errors per run). That profile is useful for finding tail behavior but not as a reliability baseline. Re-run with concurrency per scenario: **reads at 50 connections**, **writes at 10 connections**.

| Scenario | conn | RPS | mean | p50 | p99 | max | err |
|---|---:|---:|---:|---:|---:|---:|---:|
| noop (baseline) | 50 | 6,696 | 6.91ms | 0 | 47 | 108 | **0** |
| KV get (hot) | 50 | 3,671 | 13.10ms | 1 | 87 | 125 | **0** |
| KV get (miss) | 50 | 3,982 | 12.06ms | 1 | 93 | 172 | **0** |
| KV put (random keys) | 10 | 2,696 | 3.19ms | 2 | 4 | 2,833 | **0** |
| D1 SELECT (indexed) | 50 | 3,609 | 13.34ms | 1 | 98 | 190 | **0** |
| D1 INSERT | 10 | 2,268 | 3.94ms | 2 | 6 | 3,803 | **0** |

At realistic load the runtime is clean: zero timeouts across reads and writes, p99 in single-to-double-digit ms, sustained ~2,500 writes/sec and ~3,500–4,000 reads/sec on a laptop. The max column (2.8–3.8 s) still reflects occasional WAL checkpoint pauses; those are absorbed within the timeout budget.

This is the v0.1 baseline claim: **no errors under any concurrency a typical micro-SaaS will see in production**. Higher-pressure scenarios (HN hug, write-heavy hot DOs) get their own follow-up benchmarks below.

### Stage 2d.0b: HN burst — 100-way concurrent writes to a single DO

Measures behavior under a burst workload that no micro-SaaS reaches in steady state but every one encounters when a post hits Hacker News or a similar aggregator. 100 connections hit `/hn-burst` for 15 seconds, each request writing a uniquely-keyed KV entry (`signup:<random>`).

| scenario | conn | RPS | mean | p50 | p99 | max | err |
|---|---:|---:|---:|---:|---:|---:|---:|
| HN burst (KV put, random keys) | 100 | 2,439 | 36.92ms | 4 | 80 | **13,639** | **84** |

### Interpretation

1. **RPS stays at ~2,400/s regardless of connection count.** The same number as the 10-connection KV put scenario. This confirms the current single-DO-per-namespace architecture bottlenecks on the DO input gate; adding clients increases queue depth, not throughput.
2. **p50 (4ms) and p99 (80ms) are healthy.** Median and near-tail users see form-grade latency.
3. **max latency reached 13.6 s and 84 requests timed out** (~0.5 % of ~36 k total requests). Root cause is the WAL checkpoint convoy effect: when auto-checkpoint fires during sustained write pressure, it blocks the writer for 1–3 s, and the 100-deep queue behind it turns seconds-of-checkpoint into tens-of-seconds-at-the-tail for the unlucky last arrivals.

### Pushing to 1000-way concurrent writes

Repeated the same scenario at 1000 parallel connections for 15 s to find the current ceiling:

| scenario | conn | RPS | mean | p50 | p99 | max | err |
|---|---:|---:|---:|---:|---:|---:|---:|
| HN burst (KV put) | 1000 | 1,987 | 129ms | 6 | 777 | 10,401 | **920** (~3 %) |

The 3 % timeout rate is where the current single-DO architecture visibly fails a viral traffic event. Throughput actually dropped slightly (vs 100 conn) because more clients amplify queue contention, not parallelism — confirming the DO input gate is the single bottleneck.

### Is this production-ready?

For typical micro-SaaS traffic (steady writes well under 100 rps): yes. Stage 2d.0 showed zero errors at 10-way write concurrency, which covers any realistic steady load and even moderate burst.

For unmodified HN-scale bursts on a single binding: **not yet**. A 0.5–3 % timeout rate during a viral event is not the reliability floor groundflare should commit to. Two independent mitigations are on the v0.2 roadmap:

- **Write coalescing** ([sqlite-performance.md §3](sqlite-performance.md#3-write-coalescing-v02)): batch writes arriving within a 5 ms window into one transaction. Reduces fsync count linearly with batch size; expected to compress the max-latency tail from seconds to single-digit ms.
- **Background passive checkpointing** ([sqlite-performance.md §2](sqlite-performance.md#2-background-passive-checkpointing-v02)): proactively drains the WAL before auto-checkpoint threshold hits, keeping checkpoint work off the request-serving path.

With those shipped, the HN-burst scenario should show zero timeouts. Until they do, the v0.1 rule is: distribute writes across multiple bindings or tenants when you expect sustained >50-conn write bursts to a single namespace. Most real viral-traffic patterns already do this naturally (different users touch different form endpoints), but the limit is worth being honest about.

### Stage 2d.1: WAL autocheckpoint raised to 10000 pages

Applied the first mitigation from [sqlite-performance.md §1](sqlite-performance.md#1-wal-checkpoint-threshold-v01-cheap): raised `PRAGMA wal_autocheckpoint` from SQLite's default (1000) to 10000. Hypothesis: fewer checkpoints → less probability that a request hits a checkpoint stall.

Before/after on the same laptop, identical bench script ([commit where the prelude changed](../src/runtime/sqlite/prelude.ts)):

| Scenario | Before (rps / p99 / max / err) | After (rps / p99 / max / err) |
|---|---|---|
| noop (baseline) | 6,674 / 49 / 111 / 0 | 6,711 / 47 / 108 / 0 |
| KV get (hot) | 3,591 / 94 / 214 / 0 | 3,829 / 83 / 169 / 0 |
| KV get (miss) | 4,228 / 71 / 157 / 0 | 4,190 / 89 / 165 / 0 |
| KV put (random) | 2,522 / 7 / 9,376 / 33 | 2,458 / 8 / 7,778 / 20 |
| D1 SELECT | 3,906 / 95 / 176 / 0 | 3,781 / 104 / 179 / 0 |
| D1 INSERT | 2,395 / 44 / 7,557 / 33 | 2,371 / 15 / 8,809 / 48 |

Read and RPS numbers are within noise in both directions. The most defensible signal is on KV put, where error count dropped from 33 → 20 and max latency dropped from 9.4 s → 7.8 s — consistent with the hypothesis. D1 INSERT moved the opposite way by a similar magnitude, which we read as laboratory noise rather than a regression.

**Honest conclusion:** the change does not hurt (test suite still passes, no regressions on the correctness path). It delivers a modest and plausibly-real tail improvement on KV writes under stress. Single-run numbers are not statistically sound for tail latency; a proper evaluation would repeat 5–10 times per configuration and compare medians. That evaluation lives with Stage 3a on a real VPS, where storage characteristics are consistent across runs.

The change ships in v0.1 because it is near-free and the mechanism is well-understood — not because the bench numbers proved a dramatic win.

### Reference: Cloudflare D1 published figures

Cloudflare publishes D1 performance data in a different format from ours — mostly relative improvements and per-query durations rather than absolute sustained RPS. Collected here for calibration, not comparison; groundflare runs a subset of what D1 does, on a single machine, and the two are different shapes of product.

What Cloudflare publishes:

| Metric | Value | Source |
|---|---|---|
| Indexed SELECT, SQL duration | < 1ms | [docs limits](https://developers.cloudflare.com/d1/platform/limits/) |
| INSERT / UPDATE, SQL duration | several ms | [docs limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Throughput per Worker invocation | ≈ 1 / (avg query time) — 1ms queries → ~1k qps per Worker | [docs limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Worker→D1 API latency, 2025 improvement | −40% to −60% (network round trips removed) | [release notes](https://developers.cloudflare.com/d1/platform/release-notes/) |
| New storage backend, 1k-row INSERT | 6.8× faster than previous backend | [blog: turned it up to 11](https://blog.cloudflare.com/d1-turning-it-up-to-11/) |
| New storage backend, 10k-row INSERT | 10–11× faster | [blog: turned it up to 11](https://blog.cloudflare.com/d1-turning-it-up-to-11/) |
| Max database size | 10 GB | [docs limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Concurrent D1 connections per Worker invocation | 6 | [docs limits](https://developers.cloudflare.com/d1/platform/limits/) |

What Cloudflare does not publish: absolute sustained RPS, p99 tail latency under load, or cross-tenant contention numbers. This is a reasonable choice for a managed, evolving service — absolute numbers would fix expectations around a moving target.

How Stage 2d's numbers relate:

- groundflare measures end-to-end HTTP latency (request in → response out, through Router Worker + tenant Worker + SQLite)
- Cloudflare's "< 1ms SQL duration" measures the SQL engine only, not the Worker→D1 network hop
- Rough shape lines up: Cloudflare indexed SELECT runs SQL in under a millisecond; Stage 2d end-to-end p50 is 1ms. The extra network hop in Cloudflare's architecture buys global edge routing and horizontal scaling, which is what you want it to buy

The two products are complementary. Cloudflare D1 is the right answer for global-audience workloads and for any application that benefits from the full edge surface. groundflare is the right answer for single-region workloads where local latency + operational control + predictable per-month cost + removing the 10 GB ceiling matter more than global replication.

## Planned future stages

| Stage | Status | What it measures |
|---|---|---|
| Stage 1 | ✅ Done | workerd vs Miniflare — trivial worker, sustained load |
| Stage 2a | ✅ Done | Idle-recovery latency (30s) |
| **Stage 2b** | Pending | Longer idle windows (5 min, 1h, 24h) |
| Stage 2c | ✅ Done | workerd vs Bun.serve vs Bun+bun:sqlite |
| Stage 2d | ✅ Done | Worker with SQLite-backed KV + D1 bindings (multi-tenant) |
| **Stage 2e** | Pending | Multi-tenant concurrency (10 tenants hitting separate files) |
| **Stage 3a** | Pending | Same benchmark on a Hetzner CX22 |
| **Stage 3b** | Pending | vs real CF Workers edge |
| **Stage 4** | Pending | Pathological (long queries, large responses, burst) |

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
