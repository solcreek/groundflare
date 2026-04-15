# Changelog

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
