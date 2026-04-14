# DESIGN: Testing strategy, coverage, and Docker's role

> How we test a product whose side-effect surface spans provider APIs, SSH, systemd, package installs, and multi-runtime Worker execution — without letting CI costs or flakiness spiral.

Status: v0 draft. Defines the test pyramid, coverage targets per subsystem, and the scope of Docker in the dev/CI loop (explicitly not in production).

## The core problem

groundflare is not a pure-logic library. A typical execution path on `groundflare up` touches:

- VPS provider HTTP APIs (Hetzner, DigitalOcean, Linode, ...)
- SSH + OS-level commands (apt, systemctl, ufw, fail2ban)
- Generated systemd units + timers
- `workerd` / `bun` binary spawn + HTTP liveness
- Real SQLite files with specific PRAGMA state
- Caddy reverse proxy with Let's Encrypt
- Rolling deploy (kill old, start new, verify, rollback on fail)

Applying a "just write unit tests" playbook to this surface produces a green suite that proves nothing. We need layered coverage where each layer catches a different class of regression.

## The four-tier pyramid

```
                  ┌────────────────────────┐
                  │  4. Live smoke tests    │  weekly / pre-release
                  │     Real Hetzner CX22   │  catches provider API drift
                  └────────────────────────┘
              ┌──────────────────────────────┐
              │  3. E2E (Docker VPS simulator) │  per-PR, ~3 min
              │     ubuntu:24.04 + systemd    │  catches bootstrap regressions
              └──────────────────────────────┘
         ┌────────────────────────────────────────┐
         │  2. Integration / conformance suite     │  per-commit, ~30 sec
         │     Spawn real workerd + real SQLite   │  catches adapter semantic bugs
         └────────────────────────────────────────┘
    ┌────────────────────────────────────────────────┐
    │  1. Unit tests                                  │  per-save, ~5 sec
    │     Pure logic: config parser, SigV4, cron conv │  catches logic bugs fast
    └────────────────────────────────────────────────┘
```

Each tier catches a different kind of bug. Shipping without all four means certain regressions will slip to production.

---

## Tier 1 — Unit tests

**Scope:** Pure logic, no I/O, no spawning, no network. Run in under 5 seconds on watch mode so devs get feedback before they finish thinking.

**High-priority targets (enforce 90%+ line coverage):**

- `src/config/**` — wrangler.toml / wrangler.jsonc parsing; `[groundflare]` table handling; 3-layer resolution (defaults → file → CLI flags → env); env-based overrides.
- `src/runtime/*/capnp.ts` — wrangler config → workerd capnp config translation. Snapshot tests for N representative wrangler.toml inputs.
- `src/provider/*/pricing.ts` — monthly cost math for cost-estimate.
- `src/util/sigv4.ts` — AWS SigV4 signing. AWS publishes [official test vectors](https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html); correctness is a solved problem, use them.
- `src/util/cron.ts` — Cron expression → systemd `OnCalendar=` conversion. Edge cases matter: `0 */5 * * *` (every 5th hour) vs `*/5 * * * *` (every 5 minutes).
- `src/runtime/bun/codemods/*` — Deterministic transformations for bun-track migration (binding name → client variable). LLM-driven creative parts are out of scope for unit tests (handled at Tier 2 or by diff review).

**Tool:** `vitest` (mature, fast watch mode, good ESM support). Bun's built-in test runner is ~2× faster but ecosystem (matchers, reporters, coverage) is thinner; re-evaluate for v0.5+.

**Anti-pattern to avoid:** Mocking things that are easy to run for real. SQLite `:memory:` is sub-millisecond; don't mock it. workerd binary starts in ~100 ms; don't mock it either. Mocking hides the bugs that matter.

---

## Tier 2 — Integration / conformance suite ⭐

**This is the load-bearing layer for the Mirror + Bun dual-track strategy.** Without it, adapter semantics drift between runtimes and users hit subtle bugs where the same Worker behaves differently under Mirror vs Bun.

### Core idea: one test, N adapters

Each binding has a single conformance file that runs against every adapter implementation:

```
test/conformance/
├── kv.test.ts          # runs against Mirror/SQLite, Bun/bun:sqlite, and optionally real CF KV (oracle)
├── d1.test.ts          # runs against Mirror/libSQL, Bun/bun:sqlite, real CF D1
├── queue.test.ts       # runs against Mirror/SQLite, Bun/SQLite
├── r2.test.ts          # runs against Mirror/SeaweedFS, Bun/Bun.s3, passthrough-to-CF
├── do.test.ts          # Mirror only (Bun track doesn't support DO)
└── cron.test.ts        # systemd timer dispatch → worker.scheduled()
```

The test body is written once; a harness parameterizes over adapter implementations:

```ts
// test/conformance/kv.test.ts
describe.each(kvAdapters)('KV conformance: %s', (adapter) => {
  let kv: KVNamespace

  beforeEach(async () => { kv = await adapter.create() })
  afterEach(async () => { await adapter.destroy(kv) })

  test('put then get returns exact bytes', async () => {
    await kv.put('k', new Uint8Array([1, 2, 3]))
    const got = await kv.get('k', 'arrayBuffer')
    expect(new Uint8Array(got!)).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('list({prefix}) returns only matching keys, lexicographically sorted', async () => {
    await kv.put('a:1', 'x'); await kv.put('a:2', 'y'); await kv.put('b:1', 'z')
    const { keys } = await kv.list({ prefix: 'a:' })
    expect(keys.map(k => k.name)).toEqual(['a:1', 'a:2'])
  })

  test('expirationTtl evicts after TTL', async () => {
    await kv.put('k', 'v', { expirationTtl: 1 })
    await sleep(1500)
    expect(await kv.get('k')).toBe(null)
  })

  test('metadata round-trips as-is', async () => {
    await kv.put('k', 'v', { metadata: { author: 'alice', tags: [1, 2] } })
    const { metadata } = await kv.getWithMetadata('k')
    expect(metadata).toEqual({ author: 'alice', tags: [1, 2] })
  })

  test('value up to 25 MiB works', async () => {
    const big = new Uint8Array(25 * 1024 * 1024)
    await kv.put('big', big)
    expect((await kv.get('big', 'arrayBuffer'))!.byteLength).toBe(big.byteLength)
  })

  test('getWithMetadata returns both value and metadata', async () => { ... })
})
```

Any test that fails on one adapter but passes on another is a bug in the failing adapter. This is how we prevent "worked in dev, broke in prod because we were actually on Bun track."

### Conformance suite also covers

- **SQLite PRAGMA prelude enforcement.** After any subsystem opens a SQLite file, probe `PRAGMA journal_mode;` / `PRAGMA busy_timeout;` / `PRAGMA synchronous;` and assert WAL / 5000 / NORMAL. This guarantees no adapter ever "forgets" the prelude — a single missing PRAGMA would cripple concurrent throughput in production.
- **Generated capnp boots workerd.** Take the capnp output of `src/runtime/workerd/capnp.ts`, spawn `workerd serve` on an ephemeral port, curl `/health` and `/debug`, expect 200. Covers the "our capnp generator drifts from workerd schema" class of bug.
- **Queue consumer loop semantics.** Produce 10 messages, fail 3 in the consumer (throw), verify: successful 7 are deleted, failed 3 get `visible_at += backoff` with attempts bumped, messages that hit `max_attempts` move to `_dlq` sibling table. Verify backoff formula (`min(2^attempts, 300) * 1000`).
- **Cron timer dispatch.** Fake the systemd timer with a direct `curl` invocation; verify the runtime dispatches to `worker.scheduled(event, env, ctx)` with the matching cron expression in `event.cron`.
- **R2 adapter wire compatibility.** Mirror's SigV4-signed fetch path and Bun's `Bun.s3` path should produce byte-identical S3 requests for the same API call. Snapshot the raw HTTP bytes (with stable timestamps) and diff.

### Tools

- `vitest` for the runner
- Spawn helpers for `workerd` / `bun` in the test harness (open ephemeral port, process lifecycle)
- `miniflare` (already a dev dep) as fallback / comparison for the Mirror adapter
- Real SQLite (`better-sqlite3` for Node-side assertions, `bun:sqlite` for Bun-side)
- Ephemeral SeaweedFS instance for R2 tests (`weed server` on `127.0.0.1`, discarded per test suite)

---

## Tier 3 — Docker as a VPS simulator

**Docker's role in groundflare is explicit: CI VPS simulator only. Not production. Not end-user onboarding.**

### Three roles Docker could play — only one is right

| Role | Verdict | Reason |
|---|---|---|
| (a) Production runtime wrapped in Docker | ❌ Rejected | Already decided in [`bootstrap.md`](bootstrap.md). Adds ~80-100 MB RAM daemon overhead for zero problem solved. workerd is a single-binary native service. |
| (b) CI VPS simulator (Tier 3 here) | ✅ **Strongly recommended** | The use case Docker is actually good at — ephemeral, configurable, reproducible Linux targets for testing bootstrap flow. |
| (c) End-user "try it locally" via Docker | ❌ Skip for v0.1 | Docker-in-Docker on macOS is fragile; UX negative. Users who want a local test should point groundflare at a spare VPS or a Multipass VM. Revisit in v1.5+ if demand emerges. |

### The VPS simulator

```dockerfile
# test/fixtures/fake-vps/Dockerfile
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y \
    systemd systemd-sysv openssh-server sudo curl jq iptables
COPY fake-vps-authorized-keys /root/.ssh/authorized_keys
RUN systemctl enable ssh
# systemd as PID 1
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
```

Run with `--privileged` + `-v /sys/fs/cgroup:/sys/fs/cgroup:ro`. Ugly in 2026 but works, and CI runners (GitHub Actions on Linux) support it natively.

### E2E scenarios (must all pass per PR)

- `groundflare up --provider=local-docker --vps-id=fake-vps-1` runs the full 10-stage pipeline against the container and exits 0.
- Resulting state: `systemctl list-units | grep groundflare-` shows worker + cron timers; `curl http://localhost:8080/health` from inside returns 200; UFW rules show 22/80/443 only; `fail2ban-client status` reports active; `/etc/groundflare/config.toml` exists and matches expected.
- Deploy a sample Worker with KV + D1 bindings, hit endpoints, assert round-trip.
- Rolling deploy: change source, run `groundflare deploy`, verify no requests are dropped during the swap (run autocannon in parallel).
- **Upgrade path:** check out `main@previous-release`, provision the container, then check out current `HEAD`, re-run `groundflare up`, verify no data loss and all services still healthy.
- **Failure injection:** kill workerd mid-deploy; verify rollback restores previous artifact; Caddy returns 502 briefly then recovers.
- **Cron flow:** deploy worker with `[triggers] crons = ["* * * * *"]`, wait 90 seconds, verify `__scheduled` dispatched and the worker's `scheduled()` handler ran (observable via journald).

### Dev loop on macOS

For contributors on macOS, Docker-running-systemd needs either Colima or OrbStack. OrbStack has native cgroup2 handling that makes systemd-in-container work with zero config. Document OrbStack as the recommended dev setup in CONTRIBUTING.md.

### Tools

- `dockerode` for programmatic container control, OR `@testcontainers/typescript` for a higher-level abstraction (handles cleanup, wait-for-ready). `testcontainers` is nicer but adds a dep; start with raw `dockerode` for v0.1 and switch if pain emerges.

---

## Tier 4 — Live smoke tests

**Purpose:** Catch drift between our mocks / fixtures and the real world — specifically, provider API changes and SSL/DNS-level regressions that Docker simulation can't see.

- **Cadence:** Weekly cron job + manually before every release tag.
- **What runs:** Full `groundflare up` against a real Hetzner CX22, then full teardown. ~10-15 minute end-to-end.
- **Cost:** Hetzner CX22 is €0.006/hr × ~0.25 hr × weekly ≈ €0.4/month. Negligible.
- **What it catches:** Hetzner API endpoint changes; cloud-init behavior drift on new Ubuntu LTS point releases; actual Let's Encrypt flows under rate limits; systemd-cgroup-v2 edge cases that containers fake away.
- **Failure response:** Slack page to `@ops`. These failures are rare but almost always urgent.

Add additional smoke runs as we expand:
- Per supported provider (DigitalOcean, Linode, Vultr, Contabo) — monthly rather than weekly, cost stays under €5/month total.
- Per runtime track (Mirror, Bun once it ships) — weekly each.
- Per experimental backend (rustfs once on roadmap) — weekly, flagged separately so alpha breakage doesn't block release.

---

## Coverage targets (per-directory, not global)

A single global coverage % is misleading for this codebase — the directories have very different testability profiles.

| Directory | Line coverage target | Measured via |
|---|---|---|
| `src/config/**` | 95% | Tier 1 unit |
| `src/util/**` (sigv4, cron, hash, ...) | 95% | Tier 1 unit |
| `src/runtime/**` (adapters, capnp, supervisor) | 90% | Tier 2 conformance + unit |
| `src/cli/**` | 80% | Tier 1 unit + Tier 3 e2e |
| `src/provider/**` | 70% | Tier 1 with HTTP fixtures (`nock`/`msw`) |
| `src/bootstrap/**` | **not via line coverage** | Tier 3 scenario-pass rate |

**Why bootstrap doesn't use line coverage:** It's ~90% orchestration of external commands (ssh, apt, systemctl). Line-covered doesn't mean correct — it just means the line ran. Replace the metric with **"defined E2E scenarios passing / total defined scenarios"** and require 100% (few scenarios, all green).

Enforce per-directory thresholds via `vitest.config.ts` coverage config, fail CI on regression. Don't let the global number be the gate.

---

## Phased rollout

Don't try to build all four tiers on day one. Invest in Tier 1 + Tier 2 early; defer Tier 3 until bootstrap stabilizes.

| Phase | Tied to version | What ships |
|---|---|---|
| 1 | **v0.1** | Tier 1 unit tests (full coverage enforced) + basic Tier 2 conformance for KV + D1. CI runs unit + lint + conformance. |
| 2 | v0.2 | Tier 2 conformance extended to DO, Queues, R2, Cron. Multi-runtime matrix (Mirror × Bun where applicable). |
| 3 | v0.3 | Tier 3 Docker VPS simulator in CI. Bootstrap scenarios defined and gated. |
| 4 | Pre-v1.0 | Tier 4 weekly live smoke tests against Hetzner + at least one other provider. |

Each phase's tests must stay green on main before the next phase can start — i.e., don't bolt on Tier 3 while Tier 2 is flaky; stabilize first.

---

## Anti-patterns (specific to this project)

### Don't mock SQLite

This codebase's reliability hinges on SQLite details: WAL mode behavior, `busy_timeout` under contention, PRAGMA prelude ordering, WAL checkpoint timing, `VACUUM INTO` for backups. Every one of these is invisible to a mock. Tests that matter must open real SQLite (`:memory:` for speed, or temp files when WAL semantics matter).

### Don't mock workerd

workerd starts in ~100 ms and serves HTTP on any port. Spawning it for real in tests is cheaper than building and maintaining a mock runtime. The bug classes that mocks hide (capnp schema drift, binding dispatch semantics, scheduled() dispatch) are exactly the ones that will hurt in production.

### Don't conflate "integration test" with "e2e test"

They're different tiers with different costs. Tier 2 spawns workerd + SQLite in-process — seconds. Tier 3 stands up a Docker container with systemd + sshd — minutes. Mixing them makes the fast suite slow and the slow suite flaky.

### Don't hide randomness

Tests involving cron, TTL, or timestamps must use a controlled clock (inject a `now()` function, advance it manually). Real `Date.now()` in tests produces intermittent failures that erode trust in the suite. This is especially important for cron expression tests — `*/5 * * * *` means something different at :00 vs :04.

### Don't over-mock provider APIs

`nock`/`msw` are great, but mocks drift from reality. The mitigation: all provider HTTP fixtures ship with a `refresh-fixtures` script that replays them against the real API (with a throwaway account) and updates the snapshot. Run quarterly or when Tier 4 starts flagging API drift.

---

## Tool summary

| Purpose | Tool |
|---|---|
| Unit runner | `vitest` |
| Integration runner | `vitest` (same config, different directory) |
| HTTP mocking | `nock` or `msw` (pick one; leaning `msw`) |
| Docker orchestration | `dockerode` (v0.1), maybe `testcontainers` later |
| Workerd / Bun spawning | custom helper in `test/helpers/spawn.ts` |
| Perf regression | `autocannon` (already in use) |
| Coverage | `vitest --coverage` (v8 or istanbul) |
| CI | GitHub Actions (Linux runners for Tier 3) |

---

## Open questions

1. **Bun test runner vs vitest for conformance.** Bun test is faster and handles bun:sqlite natively. But vitest can orchestrate both Mirror (Node-land) and Bun runs from one config. Leaning: **stay on vitest for v0.1-v0.3; reassess at v0.4 when Bun track ships**.
2. **Real CF Workers as an oracle in Tier 2.** Very tempting — run the same conformance suite against a real account to prove Mirror/Bun match CF exactly. Problems: requires a CF account, real KV namespace cleanup, rate limits, and test flakiness from CF edge variability. Leaning: **opt-in, not default. Run before each minor release, not per-PR.**
3. **Property-based testing for binding semantics.** fast-check for KV / D1 might find edge cases (weird UTF-8 keys, TTL at boundary, metadata with deeply nested JSON). Cheap to add once Tier 2 is solid. Leaning: **v0.2+ experiment, keep on the nice-to-have list**.
4. **How to test upgrade safety across major versions.** Tier 3's upgrade scenario covers adjacent versions, but `v0.1 → v1.0` upgrade after multiple schema changes is harder. Maybe a dedicated "version ladder" e2e suite that walks every tagged release. **Defer to v0.5+**.
5. **Multi-node test harness.** v1 explicitly doesn't support multi-node. If we ever do (v2+), Tier 3 needs docker-compose networks. Defer entirely until the scope changes.
