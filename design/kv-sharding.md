# DESIGN: KV binding sharding

> Distribute a single KV binding's traffic across N Durable Object instances, so write throughput scales linearly with N. Unlocks the 1000-connection HN-burst reliability target defined in [sqlite-performance.md](sqlite-performance.md#reliability-targets).

Status: v0 draft. Phase 1 (single-key ops) lands in v0.2 alpha; Phase 2 (sharded `list()`) follows.

## Background

A groundflare KV binding (`env.CACHE`) is backed by a DurableObject namespace. The facade in `KV_ADAPTER_DO_SOURCE` currently routes every operation to `namespace.idFromName('default')` — a single DO instance per binding. That single DO's storage ops serialise through workerd's input gate, capping write throughput at ~2,400 writes/sec regardless of how much concurrency arrives at the HTTP edge.

Sharding breaks that cap by spreading keys across N DO instances (same class, different `idFromName` seeds). Each shard has its own input gate, its own `ctx.storage`, its own WAL. Aggregate write throughput is N × single-shard throughput, up to disk / CPU limits of the host.

## Scope

**In scope:**
- A `shards` config field on KV bindings; integer ≥ 1; default 1
- Hash-based routing of single-key operations (`get`, `put`, `delete`, `getWithMetadata`) in the tenant shim
- Sharded `list()` via cross-shard k-way merge
- Conformance test parametrisation across `shards ∈ {1, 4}`

**Out of scope:**
- **Resharding** (changing `shards` on a populated binding). The shard count is fixed at binding creation; changing it requires explicit migration (v0.3+).
- **Dynamic resharding** (per-key rebalancing based on load). Keeps the design predictable.
- **Shard count > 64**. The hash function and merge algorithm work for any N, but operational sanity (1 SQLite file per shard, 1 DO instance per shard) means large N has diminishing returns vs. cost.

## Routing

### Key → shard

```
shard_id(key) = hash(key) mod N
shard_name(binding, shard_id) = shard_id === 0 && N === 1
                              ? 'default'
                              : `shard-${shard_id}`
```

Backward compatibility: when `shards = 1`, the shard name is `'default'`, bit-identical to the pre-sharding routing. Existing bindings keep working without any migration.

### Hash function

FNV-1a 32-bit. Reasons:
- Small: ~10 lines of JS, no dependency
- Fast: one multiply + one xor per char, no lookup tables
- Good distribution for the expected key shapes (prefixed strings like `signup:<id>`, `user:<uuid>`)
- Deterministic and platform-agnostic — same hash on Node, workerd, Bun, browsers

```js
function fnv1a32(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
```

Non-goals: cryptographic strength, hash-flooding resistance. Keys are not adversarial in our context; the input is the application's own key shape, not untrusted data.

## Adapter-side DO (no change required)

The `KvStore` class in `KV_ADAPTER_DO_SOURCE` is already shape-agnostic — each DO instance has its own `ctx.storage` and its own key space. Running N instances of the same class with different `idFromName` seeds gives N fully independent KV stores. The DO code does not need to know about sharding.

One implication: `list()` on a single DO returns only that DO's keys. To list across the whole logical binding, the facade must merge results from all N DOs (see §List).

## Facade changes

`generateTenantKvShim` currently emits a per-binding facade that closes over a `doNamespace` and routes through a `stub()` returning the single DO. After sharding:

```js
function makeFacade(doNamespace, shards) {
  const stubFor = (key) => {
    const name = shards === 1 ? 'default' : `shard-${fnv1a32(key) % shards}`
    return doNamespace.get(doNamespace.idFromName(name))
  }
  return {
    async get(key, options) { ... stubFor(key).kvGet(key) ... },
    async put(key, value, options) { return stubFor(key).kvPut(key, value, options) },
    async delete(key) { return stubFor(key).kvDelete(key) },
    async getWithMetadata(key, options) { ... stubFor(key).kvGetWithMetadataV2(key) ... },
    async list(options) { return listAcrossShards(doNamespace, shards, options) },
  }
}
```

The per-call hash cost is < 1 µs for realistic key sizes. Negligible vs. the DO RPC cost.

## List semantics

### The problem

`list({ prefix, limit, cursor })` must return keys in lexicographic order, paginated. With N shards, each shard sees only its own subset of keys; the global order requires a merge.

### Algorithm

**First page** (`cursor === undefined`):
1. Call `kvList({ prefix, limit })` on each of N shards in parallel. Each returns up to `limit` keys in sorted order, with per-shard `cursor` and `list_complete`.
2. K-way merge: maintain a min-heap of (shard_idx, shard_iter), pick N results with lowest key globally until `limit` keys gathered or all shards exhausted.
3. Emit the `limit` keys.
4. If more results remain (any shard not exhausted, or this shard's last-returned key is not its last available), encode the per-shard cursors into one composite cursor.

**Subsequent pages** (`cursor` provided):
1. Decode the composite cursor into per-shard `startAfter` keys (or "shard exhausted" markers).
2. Call each non-exhausted shard with its cursor.
3. Merge and emit as above.

### Composite cursor encoding

```
cursor = base64url(JSON.stringify({
  v: 1,                               // version tag for future cursor format changes
  s: [<string | null>, ...]           // one element per shard: cursor string, or null if exhausted
}))
```

Total cursor size for N = 4 and 200-char keys: < 1 KB base64. Well within any reasonable URL/header limit.

### Ordering invariant

The k-way merge guarantees global lexicographic order. Proof: at each step, we emit the lowest key across all shard-front positions. Since each shard returns keys in sorted order, the minimum of the fronts is the global minimum of all not-yet-emitted keys.

### Consistency

`list()` on a single shard is consistent with that shard's storage. Across shards, there is no coordination — a put to shard 1 and a put to shard 2 are independent events, and a list() may see one but not the other if they are concurrent. This matches Cloudflare KV's own "eventual consistency" semantics and is acceptable.

## Configuration

```toml
[groundflare.bindings.CACHE]
shards = 4
```

Default: `shards = 1` (unchanged behavior).

Validation at config-load time:
- Must be positive integer
- Recommended range: 1–16 (document range; anything larger is allowed but likely overkill for a single VPS)
- Cannot be changed on a populated binding without explicit migration (v0.3+)

## Workspace builder

`buildKvAdapterService` currently emits one DO binding per KV namespace. After sharding, each namespace still gets one binding (pointing at one DO class + one service), but the shim receives the shard count. Each named DO instance (`'default'`, `'shard-0'`, `'shard-1'`, ...) is created on-demand by workerd when first touched — no static declaration of N instances is required.

One new consideration: the disk service path for the DO class. Currently `<stateBaseDir>/<worker>/<binding>/`; workerd stores per-DO state as subdirectories keyed by DO ID. Sharding adds N such subdirectories per binding; no structural change needed, just more files on disk.

## Conformance

Parameterise `test/conformance/kv.test.ts` with `shards ∈ {1, 4}`. Every existing test runs twice, once per configuration, verifying identical behavior.

New tests specifically for sharding:
- Distribution check: 100 puts with random keys land across shards in roughly even proportion (hash quality smoke test)
- Cross-shard list: puts spanning all N shards return in correct global order
- Cursor: paginated list across shards resumes correctly from cursor

## Performance expectations

Back-of-envelope, keeping the ~2,400 writes/sec per-DO figure from [Stage 2d](benchmarks.md#stage-2d-workerd--sqlite-backed-kv-and-d1-multi-tenant):

| shards | Sustained write ceiling (single binding) | HN burst (1000 conn) expected outcome |
|---:|---:|---|
| 1 | ~2,400/s | 3% errors (measured) |
| 2 | ~4,800/s | likely < 0.5% errors |
| 4 | ~9,600/s | errors = 0, p99 < 100 ms (target) |
| 8 | ~19,200/s | errors = 0, p99 < 50 ms |

`shards = 4` is the proposed v0.2 default sweet spot: clears the 1000-conn SLO with headroom, four files per binding is still manageable for backup and observation.

## Rollout plan

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | Config field, hash routing, single-key ops, conformance param, `list()` behaves correctly but not paginated across shards | next |
| **Phase 2** | Sharded `list()` with composite cursor + k-way merge | after Phase 1 |
| **Phase 3** | Benchmark run with `shards = 4` validating 1000-conn SLO; promote `shards = 4` as recommended default in docs | after Phase 2 |

## Open questions

1. **Default value: 1 or 4?** Keeping default = 1 is safest for backwards compatibility and for users with light write load (`shards = 4` means 4× the SQLite files to manage). Defaulting to 4 trades that for out-of-the-box HN safety. Leaning: **default 1, recommend 4 in docs**.
2. **Is FNV-1a good enough?** For known key shapes (prefixed strings), yes. If users are adversarial (user-controlled keys designed to land on one shard), FNV is not collision-resistant. Documented behaviour: not designed to withstand adversarial input; if you need uniform distribution under attack, hash the key yourself before passing.
3. **Resharding path for v0.3+.** Offline, SQL-level export-import from old-shard-count files to new. Needs a CLI command. Not in scope for v0.2.
4. **Shared-shard read optimisation.** A `list()` with no prefix reads every shard; most realistic `list(prefix)` calls have a prefix that hits all shards equally anyway. Not optimising per-shard-skip for prefix-aware hashing because it breaks the clean round-robin distribution.
