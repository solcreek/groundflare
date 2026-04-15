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

## Reliability targets

These are the numbers groundflare commits to hitting. Benchmarks track against them; regressions block a release.

| Load profile | conn | v0.1 actual | v0.2 target |
|---|---:|---|---|
| Steady state (typical micro-SaaS) | ≤ 20 | p99 < 10 ms, errors = 0 ✅ | p99 < 10 ms, errors = 0 |
| Burst (moderate viral) | 50–100 | p99 80 ms, 0.5 % errors | p99 < 100 ms, errors = 0 |
| **Burst (HN front-page / 1000+ users)** | **1000** | **p99 777 ms, 3 % errors ❌** | **p99 < 300 ms, errors = 0** |
| Extreme (sustained > 1000) | > 1000 | undefined | graceful degradation, errors < 0.01 % |

"1000 concurrent" here means 1000 simultaneous TCP connections each doing back-to-back writes to the same binding — a synthetic worst case. Realistic HN traffic distributes writes across many users / bindings / endpoints; the pure-single-DO number is a floor, not the expected experience.

### What actually reaches the v0.2 target

The initial analysis (a prior revision of this doc) assumed write coalescing alone would lift throughput from ~2.4 k to ~25 k writes / s per DO. **That analysis was wrong** for the production code path.

Empirically (Stage 2d re-run with coalescing added to `src/runtime/kv/sqlite.ts`): HN burst numbers did not improve. Root cause is that the `ctx.storage.put` inside `KV_ADAPTER_DO_SOURCE` is the bottleneck, and the DO input gate serialises concurrent storage ops to a single DO instance. No amount of coalescing at the Node adapter layer reaches the production hot path, and coalescing *inside* the DO would still face the same input-gate serialisation — it can only fire one kvPut RPC at a time.

**Corrected path to the 1000-connection target: sharding (§4)**. Routing a binding's traffic across N independent DOs (each a separate `idFromName`) gives N independent input gates and linear write throughput scaling. Math:

- 1 DO: ~2,400 writes / s ceiling (measured)
- 4 DOs: ~10 k writes / s, comfortable margin for 1000 conn
- 10 DOs: ~24 k writes / s, ample headroom

Sharding is now the **critical v0.2 work item**, promoted from v0.3. Background passive checkpointing (§2) remains a v0.2 item; it flattens tail latency within each shard.

Coalescing (§3) is retained in the codebase as a valid optimisation for the Node-side tooling path (CLI migrate, backup, conformance tests where adapters are exercised directly). It does not contribute to the production reliability target on single bindings but is not harmful either — it is the right pattern if we ever add a non-DO storage backend.

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
