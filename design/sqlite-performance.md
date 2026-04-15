# DESIGN: SQLite write-path performance

> How groundflare keeps SQLite-backed bindings (KV, D1, DO, Queues) fast and predictable under write load, and what options exist when a workload outgrows the defaults.

Status: v0 draft. Captures the mitigation menu surfaced by Stage 2d benchmark (see [benchmarks.md](benchmarks.md#stage-2d-workerd--sqlite-backed-kv-and-d1-multi-tenant)).

## Background

groundflare runs KV / D1 / DO / Queues over a shared SQLite substrate (shared prelude in [`src/runtime/sqlite/prelude.ts`](../src/runtime/sqlite/prelude.ts)). Each binding lives in its own SQLite file. Inside workerd, each binding is a Durable Object whose `input gate` already serialises requests to a single actor — so there is no "many writers, one lock" contention at the SQLite layer.

The remaining sources of write-path tail latency are:
- **DO input-gate queuing** under bursty request volume
- **WAL checkpoint pauses** when the write-ahead log passes the auto-checkpoint threshold
- **fsync latency spikes** on the underlying storage

Stage 2d demonstrated this shape: p50 stays at single-digit ms, but p99 reaches tens of ms and max can reach seconds during checkpoint events.

## Non-problem: parallel SQLite writers

It is not useful to add an in-adapter "single writer queue" on top of the DO input gate. The DO already provides single-writer semantics. Adding another queue only delays by an extra hop. The write queue pattern is only worth building **if it also buys coalescing** — see §3 below.

## Load-bearing clarification: two code paths, one SQLite-per-binding story

There are two places SQLite work happens in groundflare, and interventions at each place affect different scenarios:

1. **Inside workerd, as a Durable Object** (`KV_ADAPTER_DO_SOURCE` / `D1_ADAPTER_DO_SOURCE`). This is the production hot path — every `env.CACHE.put()` from a tenant Worker lands here. Storage is workerd's built-in `ctx.storage`, which sits on SQLite but is managed by workerd's runtime. PRAGMAs, checkpoint cadence, and write batching are **governed by workerd**, not by our Node code.

2. **Inside Node, as `SqliteKVAdapter` / `SqliteD1Adapter`** (better-sqlite3). This is the tooling path — CLI commands that read/migrate/back-up files, conformance tests that exercise adapter semantics from Node. PRAGMAs and coalescing implemented in `src/runtime/sqlite/*` only affect this path.

A benchmark against a running workerd (Stage 2d-onwards) measures path 1. A benchmark against `SqliteKVAdapter` directly would measure path 2. The two do not share performance.

**Consequence: coalescing in `src/runtime/kv/sqlite.ts` does not reduce latency in Stage 2d's HN burst.** The fix for the production hot path has to land inside path 1.

## Mitigation menu, in priority order

### 1. WAL checkpoint threshold (v0.1, cheap)

**Change:** raise `PRAGMA wal_autocheckpoint` from the default 1000 pages to 10000.

**Effect:** checkpoints fire 10× less frequently, reducing the probability that any given request hits a checkpoint pause. WAL grows larger (~40 MB instead of ~4 MB per file at 4 KB page size), which is acceptable — WAL size does not affect read performance.

**Cost:** one line added to `prelude.ts`. No behavioural risk: `synchronous = NORMAL` + WAL is still durable through a checkpoint cycle.

**Expected impact:** modest. Improves average case, doesn't eliminate worst case.

### 2. Background passive checkpointing (v0.2)

**Change:** each groundflare-managed SQLite file gets a background fiber or systemd timer that runs `PRAGMA wal_checkpoint(PASSIVE)` every N seconds (proposed: 30s, tunable).

**Effect:** moves checkpoint work off the request-serving path. When auto-checkpoint would otherwise fire mid-request, the WAL has already been mostly flushed by the background task, so the request proceeds quickly.

**Cost:** needs a supervisor. Implementation choice: per-process task inside the DO, or per-VPS systemd timer invoking `sqlite3 <file> "PRAGMA wal_checkpoint(PASSIVE)"`.

**Expected impact:** measurable p99 improvement; the worst-case tail should compress from seconds to tens of milliseconds.

### 3. Write coalescing (v0.2)

**Change:** inside KV/D1 adapter, batch `put`/`exec` calls arriving within a small window (proposed: 5 ms) into a single transaction.

**Effect:** N writes → 1 fsync instead of N fsyncs. WAL grows more slowly; fewer checkpoints triggered; fewer context switches to the OS I/O layer.

**Cost:** non-trivial. Needs:
- A deterministic flush trigger (time-based window and size-based cap)
- Error propagation (one write in the batch fails → how do dependent writes behave?)
- Ordering guarantees: within a batch, writes still need to be applied in submission order so `put(k, v1)` then `put(k, v2)` leaves `v2`
- Adapter-level promise management: each caller's `put` resolves when the batch commit completes

**Constraint:** this is the point where we DO want a queue — a coalescing queue, not a serialization queue. Fits inside the DO implementation, not on top of it.

**Expected impact:** 2–5× write throughput under concurrent bursty load. Biggest single lever.

### 4. Per-key sharding (v0.3+, opt-in)

**Change:** a KV namespace can be configured to shard across N SQLite files. Routing: `shard = hash(key) mod N`.

**Config:**
```toml
[groundflare.bindings.CACHE]
adapter = "sqlite"
shards = 4
```

**Effect:** N independent writer pipelines for uncorrelated keys. Total write throughput scales linearly with N, bounded by disk IOPS.

**Cost:**
- `list(prefix)` must iterate all shards and merge-sort results
- Backup snapshots must capture all shards atomically (use `BEGIN IMMEDIATE` across shards, or coordinated checkpoint)
- Metadata sidecars (for CF KV metadata semantics) must be consistent across reshards
- No clean resharding story: changing N invalidates the hash routing. Opt-in value is chosen at namespace creation; resharding requires explicit migration.

**Expected impact:** N× write throughput in the best case. Useful for log-ingest, rate-limit counters, high-write analytics.

**Verdict:** build this last. The cost of correctness (list merge, backup atomicity, resharding) is high. Users who need it badly can migrate to the Redis Streams adapter first (see §5).

### 5. Redis Streams adapter (already scheduled)

For queues specifically, Redis Streams is available as an opt-in:

```toml
[groundflare.queues.jobs]
adapter = "redis-streams"
```

This adds a `redis-server` systemd unit and uses `XADD` / `XREAD` for message delivery. Blocking-pop semantics mean no polling latency. Suitable for workloads beyond SQLite's comfort zone (> 1 k writes/sec sustained to a single logical queue).

Not a general KV/D1 escape hatch — scoped to queues where pub/sub semantics are the natural fit.

## Implementation priority

Reshuffled after the Stage 2d discovery (see §"Load-bearing clarification" and §"Reliability targets" above).

| # | Change | Version | Work | Impact on production hot path |
|---|---|---|---|---|
| 1 | WAL checkpoint threshold = 10000 in prelude | v0.1 | 5 min | None on production DO path (workerd manages its own PRAGMAs); benefits Node-side tooling |
| 2 | Bench uses realistic concurrency (reads 50, writes 10) | v0.1 | 15 min | Not a fix — makes benchmarks honest |
| 3 | Write coalescing in `SqliteKVAdapter` (Node-side) | v0.1 (landed) | done | Benefits tooling path; does not reach production |
| 4 | **Sharding: route a binding across N DOs** | **v0.2 (critical)** | 1–2 weeks | **Linear write throughput scaling; unblocks 1000-conn SLO** |
| 5 | Background passive checkpointing | v0.2 | 0.5–1 day | Tightens p99 within each shard |
| — | Redis Streams adapter for queues | v0.4 (already in design) | — | Escape hatch for high-volume queues |

## Reliability targets (v0.2 — anchored to measured VPS numbers)

Every number below is measured in [`benchmarks.md` §Stage 3a](benchmarks.md#stage-3a-vps-scale-bench-on-digitalocean-s-2vcpu-4gb-sgp1) and [§Stage 3b](benchmarks.md#stage-3b-vps-scaling-curve-dedicated-vs-shared-cpu-mirror-vs-bun) on real DigitalOcean droplets with kernel tunings from [bootstrap.md](bootstrap.md) applied. Previous revisions of this doc carried predicted numbers from laptop benches and a theoretical "coalescing unlocks 25 k rps" argument. That framing did not survive the measurement.

### Mirror track (workerd)

Per-binding, single-tenant. `shards = 4` on the KV binding. 15-second HN-burst of random-key writes.

| Tier | $/mo | Sustained RPS | Safe burst (errors=0) | Past that |
|---|---:|---:|---|---|
| `s-2vcpu-4gb` **shared** | $21 | **~190** | ≤ ~20 conn p99 < 10 ms | ≥ 100 conn → 0.6 %+ errors |
| `s-4vcpu-8gb` **shared** | $48 | ~115–160 | **not recommended** (noisier than 2 vCPU) | 4 shared cores = more steal exposure |
| **`c-2` dedicated** | $84 | **~500** | ≤ ~50–100 conn | ≥ 500 conn → ~10 %+ errors |

**Bottleneck is single-core CPU.** workerd's tenant dispatch does not parallelise across cores; shards still share one workerd event loop. Dedicated CPU gives 2.5× shared on the same core count because CPU steal (shared hypervisor) costs about half the throughput. Adding shared cores does not compensate.

### Bun track

Same workload, `bun:sqlite` + `Bun.serve`. Identical PRAGMA prelude so SQLite configuration is not the differentiator.

| Tier | $/mo | Sustained RPS | Safe burst (errors=0) |
|---|---:|---:|---|
| Any tier tested ($21–$84) | $21+ | **~9,000** per binding | **≥ 1000 conn, p99 < 300 ms** |

Bun.serve is also single-threaded by default; the ceiling is a single core's worth of Bun dispatch. The absolute number is ~50× Mirror on the same hardware. Above ~9 k rps per binding requires either `reusePort` multi-process Bun (not in v0.2) or moving to an even larger tier.

### What this means for the v0.2 commercial claim

- **Mirror is shipped with ceiling honesty.** "~200 rps per binding on shared 2-vCPU tier, ~500 rps on dedicated 2-vCPU tier. Beyond that, move to Bun track." Not a marketing win but it is a number users can trust.
- **Bun carries the "HN-proof" claim.** 9 k rps per binding with zero errors at 1000 concurrent is the documented baseline for the commercial pitch. A single $5 Hetzner CX22 handles more burst than almost any real micro-SaaS will ever generate.
- **Durable Objects remain Mirror-only.** Bun has no single-node DO shim; workloads that need DO stay on Mirror and accept the lower throughput ceiling until we have a credible DO alternative (no ETA).

### Why previous mitigations do not raise the Mirror ceiling

The earlier "coalescing + background checkpoint lifts Mirror to 25 k rps" analysis conflated the Node-side `SqliteKVAdapter` with the production KV path. The production path runs `KV_ADAPTER_DO_SOURCE` inside workerd and uses `ctx.storage`, not our Node adapter. Empirically on every tier tested, the limit is workerd's single-core dispatch of the tenant Worker, upstream of the KV adapter — sharding provides clean per-shard tail latency improvements but the aggregate throughput does not scale past one CPU core's worth of event-loop work.

What the mitigation menu below still does for Mirror:

- **WAL checkpoint threshold + background passive checkpointing** (§1, §2): smooths p99 within a shard when fsync convoys happen. Visible on tight single-core benches; buried in noise at 1000-conn burst because timeouts dominate.
- **Write coalescing in `SqliteKVAdapter`** (§3): useful for Node-side tooling (CLI migrate, backup). Does not touch the production hot path.
- **Sharding** (§4): measurable p99 improvement (777 ms → 299 ms at 1000 conn on laptop) but does not lift sustained RPS past the single-core ceiling.
- **Redis Streams opt-in for queues** (§5): still the escape hatch for high-volume FIFO workloads.

These remain worth shipping for tail quality and Node-side correctness, but the **real reliability ladder for v0.2 is pick-the-right-track, not stack-more-mitigations**.

## Rejected options (and why)

- **In-adapter "single writer queue" on top of DO**: redundant with DO input gate. Only useful if paired with coalescing (merged into §3).
- **`PRAGMA synchronous = OFF`**: trades durability for throughput. Rejected — a crash loses committed writes. groundflare's contract is durable by default.
- **memory-mapped writes**: Linux mmap + fsync semantics are fragile under surprise power loss. Reads use mmap already (via `PRAGMA mmap_size`); writes stay on the normal WAL path.
- **`journal_mode = MEMORY` / `OFF`**: defeats crash safety entirely.
- **Drop busy_timeout**: `busy_timeout = 5000` is already in the prelude. Dropping it would surface `SQLITE_BUSY` to callers instead of retrying. Not helpful.

## Observability hooks we need

To validate each mitigation, the runtime needs to surface:
- WAL size over time per binding (Prometheus gauge)
- Checkpoint duration and frequency (histogram)
- Write queue depth inside the coalescing window (gauge)
- fsync latency (histogram, sampled)

These metrics live in [observability.md](observability.md) and need to be added to the adapter instrumentation.

## Open questions

1. **Does the DO input gate actually serialize SqlStorage writes as I expect?** Worth a targeted benchmark: 1 writer vs N writers to the same DO — if the DO model works as documented, the throughput should be identical. If there's no serialization, we need the in-adapter write queue after all.
2. **Coalescing window size tuning.** 5 ms is a reasonable default; should it be configurable per binding? Probably yes — some workloads prefer lower latency, others prefer higher throughput.
3. **Sharding key-space hash function.** CRC32 is fast and well-distributed but not cryptographic; hash flooding is possible. Not a security issue for KV (no secrets in keys typically), but worth documenting. xxhash is a fine alternative if measurable benefit.
4. **Background checkpoint cadence.** 30 s is a guess. Should be tied to WAL growth rate measured by the runtime, not a fixed interval.
