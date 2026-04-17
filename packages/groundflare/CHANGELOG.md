# Changelog

## v0.5.0 — Self-host R2 end-to-end

The headline: **R2 bindings work on self-hosted boxes with zero config.**
A fresh `groundflare up` provisions a VPS that ships with a SeaweedFS
sidecar installed and running; any subsequent deploy that declares
`[[r2_buckets]]` hooks up automatically — `env.MEDIA.put(...)`,
`env.MEDIA.get(...)`, and the rest of the R2 surface hit the sidecar
with no operator intervention. Live-validated on a $6/mo DigitalOcean
1 GB droplet: PUT/GET/HEAD/LIST/DELETE all round-trip, httpMetadata +
customMetadata preserved, total RAM footprint (workerd + Caddy + weed)
well under 500 MB.

Also supports hybrid + BYO-S3 modes: point a bucket at Backblaze B2,
Wasabi, Tigris, real R2, MinIO, or anything else S3-compatible via a
tiny `[r2_buckets.groundflare]` override resolved at deploy time from
credentials in `groundflare secret set`.

### New: R2 ↔ S3 adapter Worker

groundflare's workerd config now emits one adapter Worker service per
R2 binding. The adapter translates workerd's internal R2 wire protocol
into S3 REST calls and back; user code is completely unaware:

```jsonc
// Default — local SeaweedFS sidecar, anonymous mode
"r2_buckets": [
  { "binding": "MEDIA", "bucket_name": "uploads" }
]

// Hybrid — point at B2 / Wasabi / real R2 / anywhere S3-compatible
"r2_buckets": [
  {
    "binding": "MEDIA",
    "bucket_name": "my-bucket",
    "groundflare": {
      "endpoint": "https://s3.us-west-002.backblazeb2.com",
      "region": "us-west-002",
      "access_key_id_secret": "B2_KEY_ID",
      "secret_access_key_secret": "B2_APP_KEY"
    }
  }
]
```

All 9 R2 operations supported: `head` / `get` / `put` / `delete` /
`list` + `createMultipartUpload` / `uploadPart` /
`completeMultipartUpload` / `abortMultipartUpload`. R2HttpFields,
customFields, conditional headers (etagMatches / etagDoesNotMatch /
uploadedBefore / uploadedAfter), range requests, storage class, AWS
error-code → R2 v4-code mapping — all round-trip. Streaming PUT /
uploadPart through the adapter without buffering (verified with 1 MB
+ 5 MB payloads in tests).

### New: SeaweedFS sidecar

Workerd-track bootstraps now install SeaweedFS v4.20 (+ ~30 MB binary
download, ~50 MB idle RAM). A `groundflare-r2.service` systemd unit
runs it on 127.0.0.1:8333 with `Before=groundflare-worker.service` so
workerd's first start always sees the sidecar ready. Weed's default
volume server port (8080) collided with workerd's listen port; the
unit explicitly pins `master.port=9333 volume.port=8088
filer.port=8888` to prevent that regression from surfacing again.
Bun-track bootstraps skip weed (Bun adapter still talks to external S3
directly; see Deferred below).

`deploy` detects R2 bindings and:

- Runs esbuild once per deploy to produce the adapter Worker bundle;
  embeds it in the generated capnp via `inline`.
- Resolves `*_secret` references from `FileSecretStore`
  (~/.config/groundflare/secrets.json) and injects plaintext values as
  adapter env bindings. Mixed-presence credentials rejected at
  config-read time.
- Idempotently pre-creates each bucket on the local sidecar (weed's
  anonymous mode refuses AccessDenied on first-PUT-to-missing-bucket).

### Testing

1002 tests across three tiers:

- **L1** (`test/unit/runtime/workerd/r2/`, 126 tests): pure-function
  codec + mapping coverage. Wire-protocol edge cases (malformed JSON,
  body shorter than declared, streaming PUT chunk straddling metadata/
  payload boundary, forward-compat unknown op methods); conditional
  discriminator forms; AWS → R2 error code precedence; list XML quirks.
- **L2** (`test/integration/r2-adapter/`, 27 tests): real workerd
  binary driving the real adapter Worker against a Node `http.Server`
  mocking S3. Catches wire bugs no pure-function test can — specifically
  the GET-header / PUT-body-prefix asymmetry that cost two hours during
  the PoC. Covers full multipart sequence, large-object streaming,
  every S3 error-code mapping, Unicode keys.
- **L3** (`test/e2e/r2/`, 14 tests): real workerd + real adapter + real
  SeaweedFS. Downloads + caches the weed binary for the current
  platform (`.cache/weed-4.20-<arch>`), verifies actual disk
  persistence, round-trips 5 MB objects, exercises full multipart
  upload end-to-end.

### Bug fixes

- `atomicInstall`'s `groundflareOwnedDirs` now includes per-binding D1
  and KV state dirs. workerd's localDisk services refuse to start if
  their path is missing; the fix adds them to the same mkdir script
  that sets up worker bundle dirs. Originally discovered during the
  v0.4 emdash live validation.

### Deferred to v0.6

- The existing Bun R2 adapter still hits CF R2 passthrough, not the
  local SeaweedFS sidecar. Matching the workerd-track defaults requires
  reshaping the Bun deploy pipeline and shared S3 client helpers —
  tracked with the rest of the Bun parity gap (DO, WorkerLoader, Cache
  API).
- SigV4 payload signing for streaming PUTs uses `UNSIGNED-PAYLOAD`; the
  headers are still authenticated so the wire remains tamper-evident,
  but a future revision will add chunked signing for operators who
  need end-to-end payload integrity over untrusted paths.

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
