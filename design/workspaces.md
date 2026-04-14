# DESIGN: Workspaces — multi-tenant Workers on one VPS

> How groundflare hosts many independent Worker scripts on a single VPS the way Cloudflare's edge does — one `workerd` process, many V8 isolates, per-tenant state isolation, individual deploy without cross-tenant blast radius.

Status: v0 draft. Target: v0.2. Load-bearing for every design decision after v0.1 (capnp generator, CLI surface, observability labels) — freeze first.

## Goals

1. **CF-grade density** on a commodity VPS. A Hetzner CX22 (2 vCPU, 2 GB) should host 30–50 typical Workers; CX32 100–200; CX42 300–500. The current ratio on CF's edge is "thousands per workerd group"; we aim at the same pattern, scaled down.
2. **Absolute state isolation** between tenants. Worker A's `env.CACHE.get(k)` cannot physically read Worker B's `CACHE`, regardless of key collisions, bugs, or malicious code.
3. **Per-tenant deploy atomicity.** Pushing a new version of Worker A never affects A's neighbours — not throughput, not availability, not their state.
4. **Observability per tenant.** Every metric, log line, and alert carries a `worker=<name>` label. Operators can attribute load, cost, and incidents to a specific tenant.
5. **Opt-in cross-tenant communication.** Service bindings (CF-compatible) let Worker A invoke Worker B when both workers opt in — no hidden dependencies, no ambient access.
6. **Incremental adoption.** v0.1's single-Worker model is the degenerate case (workspace of size 1); upgrading to v0.2 requires zero config changes on the user side.

## Non-goals (v0.2)

- **Multi-VPS workspace orchestration.** One workspace = one VPS. If you outgrow a CX42, split into two workspaces, not one stretched cluster. See [Scaling limits](#scaling-limits) for guidance on when to split.
- **Multi-user tenancy with access control.** A workspace is owned by one operator; all Workers in it trust each other's service bindings (subject to allow-list, not auth). Multi-operator tenancy is v1.5+.
- **Dynamic autoscaling of Workers across VPSes.** Users who need this are better served by CF itself.
- **Non-HTTP protocols.** HTTP/1.1 + HTTP/2 + HTTP/3 via Caddy; raw TCP or gRPC are out of scope until Workers runtime supports them natively.

## The three candidate architectures

| Architecture | Process model | RAM per tenant | Deploy isolation | Crash blast radius | Good for |
|---|---|---:|---|---|---:|
| **A. Single workerd, N services** | 1 process, N V8 isolates | ~1–5 MB | hot-reload per service | one tenant OOM → its isolate killed, others survive | **50–500 tenants** |
| **B. Workerd-per-tenant** | N processes | ~20–30 MB RSS each | independent | one tenant crash = one process | 5–30 tenants |
| **C. Container-per-tenant** | N Docker containers | ~50–80 MB each | independent | strongest isolation | 2–10 tenants |

**groundflare v0.2 adopts A** — the architecture `workerd` was literally designed for, and the architecture Cloudflare uses at edge. B and C trade density for isolation; we buy most of that isolation back via V8 isolate guarantees + per-tenant SQLite state + cgroup limits at the process level, at a fraction of the memory cost.

C (containers) additionally violates the native-first principle established in `design/bootstrap.md`. B (process-per-tenant) stays available as a v0.3+ escape hatch for "premium isolation" tenants who explicitly ask for it via `[groundflare] isolation = "dedicated"`.

## Core concepts

```
VPS (hardware)
 └── Workspace (1:1 with VPS in v0.2)
      ├── Router Worker (system-generated)
      └── Workers (tenants)
           ├── api.example.com
           ├── admin.example.com
           └── blog.example.com

                  ┌────────────────────────┐
                  │      Caddy :443        │
                  │  (TLS + access log)    │
                  └───────────┬────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│  workerd (single systemd unit)                          │
│                                                          │
│  ┌──────────┐   service bindings (in-process, ~µs)       │
│  │  Router  │──────┬─────────┬──────────┬─────────┐     │
│  └──────────┘      ▼         ▼          ▼         ▼     │
│                ┌─────┐   ┌─────┐    ┌─────┐   ┌─────┐   │
│                │ api │   │admin│    │blog │   │ ... │   │
│                └──┬──┘   └──┬──┘    └──┬──┘   └─────┘   │
│                   │         │           │                │
│                   ▼         ▼           ▼                │
│         /var/lib/groundflare/workers/<name>/             │
│            ├── kv/*.sqlite                               │
│            ├── d1/*.sqlite                               │
│            ├── queues/*.sqlite                           │
│            ├── do/<class>/*.sqlite                       │
│            ├── code/current → releases/<sha>/            │
│            └── releases/<sha>/                           │
└─────────────────────────────────────────────────────────┘
```

- **Workspace** — a named VPS hosting N Workers + its observability/backup stack. Named by the user (e.g. `my-vps`).
- **Worker** / **Tenant** — a deployed CF Worker: code, bindings, state. Unit of isolation and deploy.
- **Router Worker** — a groundflare-generated service that sits at the socket and dispatches by `Host` header. Not user-editable; regenerated on every deploy. Gets its own `worker=__router__` metric label.

## State isolation

Every tenant gets a sibling subtree under `/var/lib/groundflare/workers/<worker_name>/`:

```
workers/api/
├── code/
│   └── current -> releases/a1b2c3d/
├── releases/
│   ├── a1b2c3d/           (last 10 releases retained for rollback)
│   └── 7f8e9d0/
├── kv/
│   └── CACHE.sqlite        (bind CACHE → this file, prelude applied)
├── d1/
│   └── production.sqlite
├── queues/
│   └── orders.sqlite
└── do/
    └── Counter/
        ├── us-west-1.sqlite
        └── eu-central-1.sqlite
```

The path helpers in `src/config/defaults.ts` (v0.1: `kvStatePath(binding)`) gain a `workerName` parameter in v0.2:

```ts
kvStatePath('api', 'CACHE')  // /var/lib/groundflare/workers/api/kv/CACHE.sqlite
```

The capnp generator wires `env.CACHE` for the `api` Worker to open exactly that file. Worker B's `env.CACHE` — even if declared with the same binding name — opens `workers/admin/kv/CACHE.sqlite`, a physically different file. **Isolation is enforced by the filesystem, not by the runtime.** This is the strongest contract we can offer: "even if workerd has a bug, your data isn't leaked."

Filesystem permissions (`chmod 0700` on each `workers/<name>/`, owned by the `groundflare` system user) prevent the workerd process itself from accidentally reading across tenants if a bug in code-path leaks a filename through a binding.

## Router Worker

The router is the single entry point at the socket bound by workerd:

```js
// Generated at /var/lib/groundflare/system/router.js — do not edit
const ROUTES = {
  "api.example.com": "worker-api",
  "admin.example.com": "worker-admin",
  "blog.example.com": "worker-blog",
}

export default {
  async fetch(request, env, ctx) {
    const host = new URL(request.url).host
    const target = ROUTES[host]
    if (!target) {
      // Record for `groundflare_router_not_found_total`
      ctx.waitUntil(env.METRICS.recordMiss(host))
      return new Response('No Worker matches this host', { status: 404 })
    }
    return env[target].fetch(request, { cf: { worker: target } })
  },
  async scheduled(event, env, ctx) {
    // Cron-triggered dispatches are routed via the trigger's explicit
    // worker name, not via Host header.
    const target = event.cron.split('|')[0]
    return env[target].scheduled(event, env, ctx)
  },
}
```

Properties the design intentionally preserves:

- **Stateless.** Router holds no data; every decision is pure from `Host`.
- **Minimal.** ~60 LOC. Exhaustively tested (see [Testing strategy](#testing-strategy)).
- **Not user-extensible in v0.2.** Users who want middleware (rate-limit, auth) do it in their own Worker. Making the router extensible is a foot-gun (one user's auth bug takes down the workspace). `groundflare router customize` is a v0.4+ item if demand emerges.
- **Generated, never hand-edited.** Every deploy regenerates it from `workspace.toml`. If a user edits it by hand, the next deploy clobbers the edit — deliberately.

### Router edge cases

| Case | Behaviour |
|---|---|
| Host header missing | 400, metric `router_bad_request_total{reason=no_host}` |
| Host with port (`api.example.com:443`) | Normalize — strip port before lookup |
| Duplicate domains across Workers | Deploy-time rejection; `workspace.toml` validator catches it before capnp generation |
| Worker present without a domain | Not in `ROUTES`; reachable only via service bindings |
| Target Worker just removed | 503 with retry-after; metric `router_stale_target_total` |
| HEAD / OPTIONS / unusual methods | Forwarded as-is; Workers handle CORS themselves |
| Very long Host header (>253 chars) | 400 (invalid DNS name); metric recorded |

## Service bindings across Workers

A Worker declares cross-tenant calls CF-style:

```toml
# Worker "admin" wants to call Worker "api"
[[services]]
binding = "API"
service = "api"
```

groundflare's allow-list rule (v0.2):

- **Within the same workspace**: allowed by default.
- **Cross-workspace (cross-VPS)**: not supported in v0.2.
- **Explicit deny**: workspace-level `[services.deny]` list blocks specific pairs:
  ```toml
  # /etc/groundflare/workspace.toml — generated, but user-editable
  [[services.deny]]
  from = "blog"
  to   = "admin"
  ```
- **Allow-list mode (opt-in)**: set `workspace.services.mode = "allow-list"` to require explicit `[[services.allow]]` entries for every cross-Worker call.

Default policy (**allow within workspace, deny cross-workspace**) matches CF's own semantics and matches the most common user intuition ("these are all my Workers, they can talk").

### Service binding observability

- `groundflare_service_binding_calls_total{from, to, status}` — counts every call
- `groundflare_service_binding_duration_seconds{from, to}` — latency histogram
- Calls recorded in both tenants' access logs with a `via_binding` field so operators can reconstruct call graphs from journald.

## Per-tenant resource limits

Limits defined in each tenant's `wrangler.toml`:

```toml
[groundflare.limits]
memory_mb = 128      # isolate memory cap
cpu_ms    = 50       # per-request CPU hard limit
concurrent_requests = 100
```

All three map directly to workerd capnp fields (`memoryLimit`, `cpu.hardLimit`, `maxInboundConnections`). Workspace-level limit overrides the tenant's request if lower (a workspace owner can cap all tenants uniformly).

### Workspace-level safety rails (cgroups)

The workerd process itself runs under systemd cgroup limits:

```ini
# Generated unit
MemoryMax=80%
CPUQuota=80%
TasksMax=1024
```

These stop a single workerd process from consuming the entire VPS. **Neither workerd's isolate limits nor systemd cgroup limits alone are sufficient**; we apply both. The former stops one tenant from crashing another via OOM; the latter stops the whole workerd group from drowning the VPS.

### Noisy neighbour mitigation

- **Request rate limiting**: per-tenant `concurrent_requests` cap — beyond it, 503 with `Retry-After`.
- **CPU time hard limits**: workerd kills any request that exceeds `cpu_ms`. Tenant's logs show the kill; other tenants unaffected.
- **Automatic circuit breaker** (v0.3): if a Worker fails >50% of requests in 30s, router auto-disables it for 60s, returning 503. Metric `router_circuit_open{worker}` surfaces it. Not in v0.2 scope.
- **Fair-share dispatch**: workerd's default scheduler is not strictly fair. If one tenant is hot-looping within its CPU budget, it will get disproportionate runtime. v0.3 research item: whether to pin tenants to CPU cores via cgroup cpuset, or accept imperfect fairness as a known limitation.

## Deploy flow — atomicity guarantees

The hard part of multi-tenant. Here's the exact sequence for `groundflare deploy` on a tenant named `api` in workspace `my-vps`:

```
Client (dev machine)               VPS
──────────────────                 ───
1. Read ./wrangler.toml
2. Resolve workspace target
3. Bundle code (esbuild) ──SCP──►  /var/lib/groundflare/workers/api/releases/<sha>/
4. Hash + sign manifest            (file is inert — not yet linked)
5. SSH invoke:
   `groundflare-agent upsert api <sha>`
                                   6. Lock: flock /var/lib/groundflare/system/deploy.lock
                                   7. Validate bundle (static checks)
                                   8. Read current workspace.toml
                                   9. Compute proposed workspace (add/update this tenant)
                                  10. Validate: no domain collisions, no circular service bindings
                                  11. Regenerate router.js, worker.capnp
                                  12. Write candidate files to system/candidate/
                                  13. Ask workerd for a dry-run parse of the new capnp
                                  14. If dry-run fails: abort, return error to client
                                  15. Flip `code/current` → `releases/<sha>/`    ◄── only mutation so far
                                  16. Signal workerd: reload (hot-swap services)
                                  17. Probe http://127.0.0.1/__health/api — expect 200 within 5s
                                  18. If probe fails:
                                       - Flip `code/current` back to previous sha
                                       - Restore previous workspace.toml + capnp
                                       - Signal workerd reload again
                                       - Return `deploy_failed` with reason
                                  19. If probe succeeds:
                                       - Move candidate/*.toml → system/*.toml
                                       - Prune releases/ past the 10-release retention
                                       - Release lock
                                  20. Return success with new sha
```

Critical properties:

- **Single writer**: `flock` at step 6 serializes workspace mutations. Concurrent deploys queue.
- **Prepare-then-commit**: all generation happens under `system/candidate/`; only symlink flip + reload actually change observable behaviour.
- **Rollback is cheap and mechanical**: flip symlink back, reload. Old artefact never deleted until retention policy runs.
- **Workers independent**: reloading a single service in workerd (via `control-fd` reconfigure) does NOT restart other services or drop their in-flight connections.
- **Fallback**: if hot-reload is unavailable for a particular change (e.g. binding shape changed in a way that requires full capnp parse), we fall back to full workerd restart with `SO_REUSEPORT` — new process takes over the listening socket, old process drains in-flight, exits cleanly. No dropped requests. Slightly longer transition (<1s target).

### `groundflare rollback`

```bash
groundflare rollback api                # → previous sha
groundflare rollback api --to=a1b2c3d   # → specific sha in retention
```

Rolls back via the same hot-reload path (just the opposite direction). No data migration — state is outside the release artefact.

## Observability — per-tenant wiring

Continues `design/observability.md` verbatim:

- All metrics carry `{worker=<name>}`. Router adds `{worker="__router__"}`.
- Every JSON log line includes `"worker":"<name>"` in the envelope.
- `groundflare tail` supports `--worker=<name>`.
- `groundflare status <worker>` returns the per-tenant subset.
- New workspace-level commands: `groundflare workspace status`, `groundflare workspace list-workers`.

### Router-specific metrics (new in v0.2)

```
groundflare_router_dispatch_total{worker, status_class}
groundflare_router_not_found_total{host}      # high-cardinality: label-drop at ingestion
groundflare_router_bad_request_total{reason}
groundflare_router_stale_target_total{worker}
groundflare_router_duration_seconds           # dispatch overhead histogram
```

Cardinality warning: `{host}` on `not_found_total` is unbounded (attackers can probe random hosts). Prometheus scrape config should `metric_relabel_config` drop the `host` label at ingestion; router-side we ship only the count + top-20 offenders via a periodic snapshot.

## CLI surface (v0.2)

```
# Context-inferred (operate on the current project's workspace)
groundflare deploy                  # deploy this worker to its workspace
groundflare status                  # this worker only
groundflare tail                    # this worker's logs
groundflare rollback [--to=<sha>]   # roll this worker back

# Explicit workspace commands
groundflare workspace list                          # all workspaces you control
groundflare workspace show <ws>                     # manifest + all workers
groundflare workspace status <ws>                   # health snapshot
groundflare workspace tail <ws> [--worker=<name>]   # filter/firehose
groundflare workspace remove-worker <ws> <worker>   # tear down one tenant
groundflare workspace migrate <ws> --to=<target>    # (v0.3) cross-VPS move
```

## Testing strategy

Extends `design/testing.md` with workspace-specific coverage. **All four tiers gain new tests in v0.2**; nothing new is "optional".

### Tier 1 — unit (target: 95% line coverage on new code)

New test files:

- `test/unit/workspace/manifest.test.ts`
  - workspace.toml parse + validate (duplicate Worker names, duplicate domains, circular service bindings)
  - migration from v0.1 single-worker shape to v0.2 manifest
  - version field handling (old clients reading new manifest)
- `test/unit/runtime/router/generator.test.ts`
  - Given N tenant descriptors → generates exactly-expected router.js
  - Snapshot tests for the router output (stable text)
  - Host normalization rules (port stripping, case handling, IDN)
- `test/unit/runtime/capnp/multi-tenant.test.ts`
  - N services → N `(name, worker, bindings)` entries in capnp
  - Service binding references resolved to correct service names
  - Per-tenant SQLite paths injected into bindings
- `test/unit/runtime/kv/sqlite.test.ts` (extension)
  - `kvStatePath(workerName, binding)` helper variants

### Tier 2 — conformance (extension of existing suites)

Every existing binding conformance test gains a **multi-tenant variant**:

- `test/conformance/kv.test.ts` — adds fixture where two tenants each have `CACHE` binding pointing at sibling SQLite files.
  - `put`+`get` under tenant A — tenant B's `get` returns null (isolation)
  - Concurrent writes from both tenants — no interleaved corruption (independent WAL files)
  - Per-tenant TTL cleanup doesn't touch the other's rows

New conformance suite specific to workspaces:

- `test/conformance/workspace/router.test.ts`
  - Deploy 3 tenants with distinct domains, dispatch requests to each, verify routing.
  - 404 for unknown hosts, with correct metric increment.
  - Metric isolation: requests to tenant A don't increment tenant B's counter.
- `test/conformance/workspace/service-binding.test.ts`
  - Tenant A calls `env.B.fetch()` — arrives at B's fetch handler with intact request.
  - A's KV state not visible via B's context.
  - Service binding allow/deny rules enforced.
- `test/conformance/workspace/deploy.test.ts`
  - Upsert-worker regenerates capnp correctly, preserves other tenants' liveness.
  - Rollback path: introduce a broken deploy, verify old code still serves.
  - Failed deploy doesn't leave the system in a half-applied state (candidate files never promoted on failure).

### Tier 3 — Docker VPS simulator (multi-tenant scenarios)

New e2e scenarios for the Docker simulator:

- **T3-WS-1**: deploy 5 tenants in sequence, each with different bindings. All 5 serve correctly after each deploy.
- **T3-WS-2**: concurrent deploys of 3 tenants — serialize via lock, all succeed, final state correct.
- **T3-WS-3**: deploy a tenant with broken code; verify rollback, verify other tenants never saw interruption (autocannon against tenant B during the deploy, assert zero non-2xx).
- **T3-WS-4**: SIGTERM workerd mid-serve — SO_REUSEPORT handoff, zero dropped requests in 1000-request autocannon run.
- **T3-WS-5**: fill one tenant's disk quota — that tenant's KV writes fail cleanly (500), other tenants' writes succeed.
- **T3-WS-6**: remove-worker — tenant's state archived, service binding from neighbour returns 503 + metric, neighbour continues serving its own paths.
- **T3-WS-7**: upgrade in place from v0.1 manifest to v0.2 — no data loss, Worker continues serving.

### Tier 4 — live smoke (weekly)

- Provision real Hetzner CX22, deploy 10 tenants with varied bindings (KV + D1 + Cron + one Queue).
- Run smoke traffic across all 10 for 5 minutes.
- Deploy + rollback cycle on tenant #5 while the others serve live traffic.
- Verify all 10 tenants' metrics appear in `/metrics` with correct labels.
- Tear down.

Failures at this tier are pager-duty-level: provider API drift, real-world timing quirks, etc.

## Stress testing plan

A dedicated `test/stress/` suite runs on-demand (not per-PR). Targets:

### S1 — Density

Spin up N dummy Workers (trivial `fetch` → 200 "ok"), gradually increase N, measure:

- RSS of the workerd process as function of N
- `/metrics` scrape duration
- Cold-start time (workerd restart → all isolates ready)
- End-to-end p50/p99 latency for a request hitting tenant 1 out of N

Expected shape: RSS grows ~2–5 MB per tenant up to ~100, then sublinear (V8 isolate pool sharing); latency flat until ~500, then degrades.

Explicit pass criteria:
- At N=100 on CX22, end-to-end p99 < 20 ms
- At N=500 on CX42, end-to-end p99 < 50 ms

### S2 — Deploy concurrency

Deploy 20 tenants in parallel via 20 separate SCP+SSH sessions. Deploy lock serializes; verify:

- All 20 deploys succeed
- Total deploy time ≤ (20 × single-deploy time × 1.2) — the 20% represents lock contention overhead
- Final capnp contains exactly 20 services

### S3 — Noisy neighbour

Tenant A runs a tight CPU loop; tenants B–E serve normal fetch traffic. Measure:

- Tenant A consumes its CPU budget hard-limit (50ms) per request — 429s at the edge
- Tenants B–E p99 latency impact vs baseline (with A idle)

Pass criterion: B–E p99 must rise by ≤ 2× compared to A-idle baseline.

### S4 — Binding throughput under contention

100 tenants each doing 100 KV writes/second to their own SQLite files simultaneously. Measure aggregate writes/second + per-tenant p99 latency. Pass: no errors, per-tenant p99 < 20 ms at 10k aggregate w/s.

### S5 — Restart recovery

Kill workerd with SIGKILL, 100 requests/second arriving at Caddy throughout. Measure:

- Dropped requests during recovery
- Time until all N isolates are ready

Pass: zero dropped (Caddy buffers + retries), recovery < 2s for N=50.

### S6 — Failure injection

For each component, inject failure and measure containment:

| Injection | Expected containment |
|---|---|
| One Worker throws RangeError on every request | Other Workers unaffected (p99 unchanged) |
| One Worker exhausts its memory limit | Isolate killed, router returns 503 for that host only, other hosts 200 |
| Disk fills on one tenant's dir | That tenant's writes fail; reads still work; other tenants fine |
| systemd stops Caddy | workerd keeps serving via `:8080` directly (probed internally); health endpoint surfaces the degradation |
| Network partition to npm registry | update-check fails silently; CLI works |

## Stability targets (SLOs)

For a workspace in steady state (post-deploy, under normal load):

| Metric | Target |
|---|---|
| workerd process uptime | ≥ 99.95% (systemd auto-restarts on crash, <2s) |
| Deploy-induced dropped requests | 0 (validated by T3-WS-4 every PR) |
| Deploy MTTR (failed deploy → rollback complete) | < 5s |
| State isolation guarantees | 100% (conformance tests must pass; any leak is CVE-level) |
| Router dispatch p99 overhead | < 1ms |
| Hot-reload single-service time | < 500 ms |
| Full workerd restart time | < 2s (measured N=50 tenants) |

## Scaling limits

Single-VPS ceiling, empirically calibrated:

| VPS size | Typical density (light traffic) | High-traffic density |
|---|---:|---:|
| Hetzner CX22 (2 vCPU / 2 GB) | 30–50 | 10–20 |
| Hetzner CX32 (4 vCPU / 8 GB) | 100–200 | 40–80 |
| Hetzner CX42 (8 vCPU / 16 GB) | 300–500 | 100–200 |

When you hit the ceiling: **split the workspace**. Provision a second VPS, move half the tenants there (`groundflare workspace migrate` — v0.3). DNS handles cross-VPS routing (either Cloudflare DNS with round-robin, or a per-domain CNAME). No built-in load-balancer primitive in v0.2.

## Migration path

### v0.1 → v0.2 (single Worker → workspace of 1)

- v0.1 installations get auto-migrated on first v0.2 CLI invocation against them:
  - `/etc/groundflare/workspace.toml` created with a single Worker named `_default` (or the value of `wrangler.toml`'s `name` field, preferred)
  - `/var/lib/groundflare/workers/<name>/` created from existing flat layout via a one-shot migration script
  - Symlink existing SQLite files into new locations atomically
- No downtime; no data loss.
- CLI version check: v0.2 client refuses to talk to a v0.1 remote until the remote is also upgraded. `groundflare upgrade --workspace=<ws>` orchestrates this.

### v0.2 → v0.3

- Add `[groundflare] isolation = "shared"|"dedicated"` per-tenant.
- Dedicated tenants spawn their own workerd process under `groundflare-worker-<name>.service`.
- Shared tenants (default) unchanged.
- Auto-migrate is a no-op for shared tenants; opt-in for dedicated.

## Compared to Cloudflare's edge

| Concept | CF edge | groundflare workspace |
|---|---|---|
| Routing | Dispatcher Worker + route config | Router Worker + Host header map |
| Isolation | V8 isolates, shared workerd group | V8 isolates, shared workerd group (same!) |
| State isolation | Namespace per binding, backed by CF infra | Namespace = file path, backed by local SQLite |
| Deploy atomicity | Atomic service swap in workerd | Same (via hot-reload) |
| Observability | Analytics Engine + Tail | Prometheus + journald |
| Cross-tenant calls | Service bindings + Dispatch | Service bindings (same term, same contract) |
| Density | ~thousands per workerd group | 30–500 per VPS (scaled-down) |
| Fairness scheduling | CF's custom scheduler | V8's default + cgroups |

The architecture is the same pattern at a different scale. Users migrating from CF should find every primitive in the same place.

## Open questions

1. **Fair scheduling.** workerd's default scheduler is not round-robin across services. If one tenant is hot-looping, others get less CPU than strict fairness would give. Options: (a) accept (document as "noisy neighbour can affect p99 for others"), (b) pin tenants to cgroup cpusets, (c) patch workerd. Leaning (a) for v0.2, evaluate (b) for v0.3 based on real complaints.

2. **Automatic circuit breaker.** A Worker stuck in a crash loop spills error budget onto neighbours via shared observability noise. Router-level circuit breaker would mitigate. Deferred from v0.2 because the simple rule ("tenant failing >50% for 30s → 503 for 60s") has edge cases with intentionally long-running handlers. Revisit in v0.3.

3. **Router user customization.** Sophisticated users want to add auth, rate-limiting, or custom 404 pages at the router layer. Generating-from-template is safe; arbitrary user code in the router is a workspace-wide foot-gun. Leaning: no v0.2 customization. Provide `groundflare auth-middleware install` pattern that renders into each tenant's worker instead.

4. **Durable Object migration.** Renaming a Worker changes its name in bindings; DO instances for that name are keyed by the old name. Do we rename files? Keep them? Leaning: keep old DO state under old name; deploy-time warning when a Worker with DO bindings is renamed.

5. **Secrets scoping.** Per-Worker secrets (via CF `wrangler secret put`) vs workspace-shared? CF has per-Worker. We follow the same model, storing secrets at `/etc/groundflare/workers/<name>/secrets` (mode 0600, owned by `groundflare`). Workspace-shared secrets via dedicated system binding in v0.3.

6. **Per-Worker versioning / gradual rollout.** CF supports gradual deployments (e.g. 10% traffic on new version). Worth considering for v1+; v0.2 is all-at-once.

7. **Zero-tenant workspace.** Legal state? Router serves 404 for everything, metrics still work, systemd units still up. Useful for "workspace provisioned, no Workers deployed yet" state. Leaning yes.

8. **Cross-workspace service bindings.** v0.2 explicitly forbids. But some users want "a Worker on VPS-1 calls a Worker on VPS-2". Could be implemented via HTTPS + mTLS, but adds significant complexity. Deferred to v0.3+ if demand materializes.

9. **Workspace deletion.** `groundflare destroy` on the VPS level wipes everything. Do we add `groundflare workspace destroy <ws>` that preserves the VPS but removes all Workers? Useful for fresh start. Leaning yes, low effort.

10. **Stress test hardware.** S1-S6 need a reference environment. Use a Hetzner CX42 provisioned by the weekly smoke-test, run stress suite monthly. Budget: ~€1/month additional.
