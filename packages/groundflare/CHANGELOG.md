# Changelog

## v0.4.0 — DigitalOcean provider, framework support, WorkerLoader

The headline: **groundflare deploys real-world frameworks now.** Astro
SSR sites with custom build commands and static assets work end-to-end,
verified live on DigitalOcean. emdash CMS's WorkerLoader-based plugin
sandbox runs unmodified on workerd's native dynamic worker loading.

### New: DigitalOcean provider

Second cloud provider after Hetzner. Full lifecycle (auth, regions,
sizes, SSH keys, droplet create/get/list/destroy) verified live with
end-to-end provisioning + deploy on a $6/mo droplet in Singapore.

- `provider = "digitalocean"` in wrangler config
- 17 unit tests covering all API translation + error paths
- IPv4 polling: DO assigns IPs asynchronously (unlike Hetzner) — the
  provision stage now polls `getVPS()` until an IPv4 appears
  (configurable timeout, default 120s)
- `groundflare-estimate` also gained DO as a target with live
  `/v2/sizes` price refresh

### New: framework support (Astro, Next.js, Remix, …)

Adopts wrangler's `[build]` section semantics so any framework that
produces a Worker bundle works with zero groundflare-specific config:

```toml
[build]
command = "astro build"

[assets]
directory = "./dist"
```

Pipeline:
1. Run `[build].command` (or auto-detect from `pnpm-lock.yaml` /
   `yarn.lock` / `bun.lockb` / default `npm`)
2. esbuild re-bundles the multi-file output (e.g. Astro's
   `dist/_worker.js/` with chunks/) into a single ES module
3. SCP the bundle + capnp + Caddyfile + static assets directory
4. Caddy serves matching static files via `file_server`; everything
   else falls through to workerd via `reverse_proxy`

`[assets].directory` is uploaded to
`/var/lib/groundflare/workers/<name>/assets/`, with `_worker.js/`
filtered out (already deployed, would leak source if served).

### New: WorkerLoader binding (CF Workers for Platforms compat)

workerd's open-source `WorkerLoader` API — dynamically compile + run
Workers in isolated V8 isolates at runtime. Apps using this for plugin
sandboxing (emdash, etc.) work without code changes:

```toml
[[worker_loaders]]
binding = "LOADER"
```

- New `workerLoader` capnp binding with optional `id` for shared
  isolate cache pools
- systemd unit gains `--experimental` flag (workerd gates the feature
  behind it)
- Docker e2e: deploys a worker that uses `env.LOADER.get(name, codeCallback)`
  to dynamically load a sub-worker; verifies 200 round-trip
- emdash specifically uses `WorkerLoader.get(name, getCodeCallback)`,
  not the CF-proprietary `DispatchNamespace.get(name)` — confirmed via
  source review. groundflare's binding is the exact API emdash expects.

### New: native wrangler config compatibility

Reads more of the standard wrangler config surface:

- `[[routes]] custom_domain = true` — domain resolution falls back to
  the first custom_domain route when `[groundflare].domain` isn't set
- JSONC parser handles trailing commas (emdash's wrangler.jsonc relies
  on these)
- `worker_loaders` mapped from wrangler config to capnp bindings
- Known-unsupported binding types (`ai`, `vectorize`, `browser`,
  `queues`, `hyperdrive`, `analytics_engine_datasets`, `send_email`)
  detected and warned about — deploy continues with the remaining
  bindings rather than aborting

### Bootstrap robustness (real-world VPS deploy validated)

DigitalOcean live testing surfaced a series of robustness issues, all
fixed:

- cloud-init now installs workerd directly on the VPS by downloading
  the correct architecture (amd64/arm64) from npm registry — replaces
  the previous "scp local binary" approach which failed when operator
  is on macOS-arm64 and target is Linux-amd64
- `package_upgrade: true` removed from cloud-init (saves 3-8 minutes
  on first boot; unattended-upgrades runs in background instead)
- `ssh-authorized-keys` → `ssh_authorized_keys` (deprecation in
  cloud-init v18.3+ caused `degraded done` exit code 2)
- wait-ssh stage retries SSH handshake until cloud-init finishes user
  setup; default timeout extended to 10min for DO-class CPUs
- SSH ping timeout 5s → 30s (handshake is slow under cloud-init load)
- `StrictHostKeyChecking=no` for fresh VPS (host keys may regenerate
  during cloud-init)
- SCP default timeout 30s → 60s; `ensureRemoteDir` 10s → 30s

### Other

- Caddyfile: `persist_config` only emitted as `off` (Caddy's adapter
  rejects `persist_config on` — it was always invalid syntax)
- Caddy unit + state directory paths normalized between bootstrap and
  deploy (was `/var/lib/groundflare/system/worker.capnp` in one place,
  `/var/lib/groundflare/worker.capnp` in another — now consistent)
- systemd EnvironmentFile prefixed with `-` (load-if-exists) so a
  Worker without `[vars]` doesn't crash the service
- ed25519 SSH keypair format fixed: was emitting PKCS#8 PEM which
  modern OpenSSH rejects for ed25519. Now emits OpenSSH's native
  format. Caught by Tier 3 e2e infrastructure.
- Tier 3 Docker e2e: 6 scenarios (smoke, bootstrap, deploy, Bun
  deploy, WorkerLoader, custom domain via routes)
- 824 unit + integration tests pass

## v0.3.0 — drop better-sqlite3, minimum Node 22

**Breaking**: `engines.node` bumps from `>=20` to `>=22`.

Replace the native better-sqlite3 driver with Node 22+'s built-in
`node:sqlite`. Behavioural parity verified by the existing KV + D1
conformance suites (both still pass against the new driver).

Effect:
- No more `prebuild-install` deprecation warning during `npm install`.
- No more `better-sqlite3` native-module rebuild on install — fewer
  macOS Sequoia / Alpine / stale toolchain failures.
- Tarball drops from 232 kB / 381 files to 217 kB / 345 files.

Implementation notes:
- A small compat shim in `src/runtime/sqlite/node.ts` exposes the
  better-sqlite3-shaped `.prepare / .exec / .pragma / .transaction`
  API over `node:sqlite`'s narrower surface. The KV + D1 adapters
  continue to call the same methods without modification.
- `node:sqlite` is experimental on Node 22 (stable on Node 24). The
  bin wrapper silences the one-time `ExperimentalWarning` so CLI
  output stays clean.
- Zero-length `Uint8Array` produced by `TextEncoder.encode('')` binds
  as NULL under Node 22's node:sqlite for BLOB columns. The shim
  normalises those to a fresh `new Uint8Array(0)` which the driver
  accepts. Tracked as a Node-side quirk; revisit on Node 24 LTS.

## v0.2.1 — packaging fix

Fix a packaging bug in v0.2.0 that made `npx groundflare` fail with
`ERR_MODULE_NOT_FOUND` immediately. `esbuild` (used by the deploy
bundler), `better-sqlite3` (Mirror-track KV/D1 driver), and `workerd`
(binary staged onto the VPS by bootstrap stage 5) were all in
`devDependencies` but imported at runtime. Moved to `dependencies`.

No behavioural changes; v0.2.0 is deprecated on npm.

## v0.2.0 — parallel release with the Bun track

v0.2 ships two runtime tracks from the same CLI: the Mirror track
(workerd, zero source changes) and a new Bun track (`Bun.serve` with
Cloudflare-shaped adapters).

### Bun track

- `Bun.serve` tenant shim generator — server.ts emission with baked
  `[vars]`, KV / D1 / R2 binding facades, and deterministic source
  output for stable diffs
- `BunKVAdapter` on top of `bun:sqlite` — same schema and PRAGMA
  prelude as the Node-side `SqliteKVAdapter`, so a SQLite file written
  by one is readable by the other without migration
- `BunD1Adapter` on top of `bun:sqlite` — CF D1 API surface
  (prepare/bind/first/all/run/raw/batch/exec) with atomic `batch()`
  via `db.transaction(...)`
- `BunR2Adapter` via S3-compatible passthrough to Cloudflare R2, with
  a self-contained SigV4 signer (no AWS SDK dep) and an S3
  `ListObjectsV2` XML parser
- Shared conformance spec between `better-sqlite3` (Node) and
  `bun:sqlite` (Bun) for KV and D1 — a behavioural drift fails both
  vitest and bun:test simultaneously
- cloud-init gains an `installBun` option; `runBootstrap` threads
  `runtime: "bun"` from wrangler config so a fresh VPS comes up with
  `/usr/local/bin/bun` ready
- `runDeploy` branches on `manifest.runtime === "bun"` — generates
  the Bun artifact (server.ts + adapters + systemd unit) and stages
  it on the VPS alongside the user bundle
- Tier-3 Docker e2e (`test/e2e/bun-deploy.test.ts`) verifies the full
  provision → Bun install → deploy → health-probe loop

### CLI

- `groundflare bun analyze` — classifies every wrangler binding + src
  feature against the Bun-track compatibility matrix via oxc-parser
  AST walk; emits human or `--json` output; exits 1 on blockers
  (HTMLRewriter, WebSocketPair, `class extends DurableObject`, DO
  bindings)
- `groundflare bun prepare` — runs analyze, then on a clean report
  flips `[groundflare] runtime = "bun"` in wrangler.toml via a
  comment-preserving surgical TOML patcher; `--dry-run` available

### Benchmarks (DigitalOcean, see design/benchmarks.md)

- `$6/mo s-1vcpu-1gb` shared — Bun 7,300 rps per binding, zero
  errors through 1000-concurrent HN burst
- `$21/mo s-2vcpu-4gb` shared — Bun 9,900 rps per binding
- `$84/mo c-2` dedicated — Bun 9,000 rps per binding, Mirror 500 rps
  predictable

### Dependencies

- Added: `oxc-parser ^0.125.0` (Bun track analyzer)
- No removals

### Breaking changes

None — pre-1.0 development; v0.2 is a net additive release.

### Test counts

786 vitest + 81 bun:test + 6 Tier-3 e2e = 873 automated checks.
