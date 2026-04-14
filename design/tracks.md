# DESIGN: Mirror and Bun — dual-track runtime strategy

> groundflare ships two runtime tracks from the same CLI and same deploy experience. The **Mirror track** runs your Worker unchanged on workerd. The **Bun track** transforms it to a Bun-native app with help from an LLM-assisted migration tool. Same home, two ways to cook.

Status: v0 draft. The Bun track is experimental until v0.5+. Mirror is the default path through at least v1.0.

## Why two tracks

workerd is the correct runtime for bug-for-bug Workers compatibility — but Bun reaches ~3.7× the HTTP throughput of workerd on the same hardware ([benchmarks.md, Stage 2c](benchmarks.md)). A meaningful set of users will prefer raw performance to Workers-API purity, especially with LLM assistance lowering the cost of code migration.

Two tracks under one CLI:

- **Mirror track**: zero code changes, full Workers semantics, moderate performance. Default.
- **Bun track**: Bun-native code, 3-4× throughput, LLM-assisted migration, subset of Workers features. Opt-in.

Both paths share the entire CLI, bootstrap, deploy, observability, backup, and cost-estimate surfaces. Only the runtime and the binding glue differ.

## The boundary: what's shared, what diverges

```
┌─────────────────────────────────────────────────────────────┐
│  Shared (runtime-agnostic)                                   │
│    CLI commands, prompts, ergonomics                         │
│    Provider abstraction (Hetzner, DO, Linode, ...)           │
│    Bootstrap stages 0-9 (provision + harden + observability) │
│    Deploy mechanics (SCP + systemd reload)                   │
│    Secret management                                         │
│    Backup (restic → B2/R2/S3)                                │
│    Observability endpoints (/metrics, /health)               │
│    Cost estimator                                            │
│    Domain + SSL (Caddy)                                      │
├─────────────────────────────────────────────────────────────┤
│  Mirror-specific                                             │
│    workerd binary + capnp config generator                   │
│    Adapter wiring (KV→SQLite, D1→libSQL, R2→S3/passthrough)  │
│    Miniflare as build-time config compiler                   │
│    DO via workerd's native SQLite storage                    │
├─────────────────────────────────────────────────────────────┤
│  Bun-specific                                                │
│    Migration analyzer (what can transform, what can't)       │
│    LLM-assisted code rewriter                                │
│    Bun runtime + Bun.serve supervisor                        │
│    Native replacements (bun:sqlite, ioredis, S3 SDK)         │
│    Source transformations (`env.*` → direct client calls)    │
└─────────────────────────────────────────────────────────────┘
```

The shared layer is the majority of the product. Mirror and Bun are deployment format choices, not separate products.

## CLI

Default flow (Mirror):

```bash
$ cd my-worker/          # has wrangler.toml
$ groundflare up         # provisions + bootstraps + deploys via workerd
```

Bun flow:

```bash
$ groundflare bun analyze
  Analyzing wrangler.toml and src/...
  ✓ Can migrate:
    • fetch handler (1 entry)
    • KV bindings: 2 → bun:sqlite (or ioredis if you prefer)
    • D1 bindings: 1 → bun:sqlite
    • R2 bindings: 1 → AWS S3 SDK (or keep on CF R2 via passthrough)
    • [vars]: 3 values
  ⚠️ Needs review:
    • Durable Objects: 1 class (MyCounter) — no direct Bun equivalent
  ✗ Cannot migrate:
    • HTMLRewriter usage at src/handler.ts:42

$ groundflare bun prepare --branch=bun-migration
  Generates src-bun/ with LLM-suggested transforms
  Opens a review diff

$ git diff main..bun-migration    # review
$ git switch bun-migration
$ groundflare up --bun
```

Explicit opt-in. `--bun` flag never applies without `bun prepare` having been run.

## Compatibility matrix

| Workers feature | Mirror track | Bun track |
|---|---|---|
| `fetch` handler (module worker) | ✅ | ✅ |
| `[vars]` env | ✅ | ✅ (systemd Environment=) |
| Secrets | ✅ | ✅ |
| KV | ✅ (SQLite, WAL) | ✅ (bun:sqlite; ioredis opt-in) |
| R2 | ✅ (passthrough / S3 adapter) | ✅ (AWS SDK / passthrough) |
| D1 | ✅ (libSQL) | ✅ (bun:sqlite) |
| Cache API | ✅ (in-memory) | ⚠️ (manual LRU) |
| Service Bindings (same-host) | ✅ | ⚠️ (direct fn call replacement) |
| Durable Objects | ✅ (workerd native SQLite) | ❌ (no direct equivalent) |
| Cron Triggers | ✅ | ✅ (Bun + node-cron) |
| Queues | planned (SQLite-backed; Redis Streams opt-in) | planned (same) |
| HTMLRewriter | ✅ | ⚠️ (linkedom, semantic ~95%) |
| WebSocketPair + hibernation | ✅ | ⚠️ (Bun WebSocket, different lifecycle) |
| `waitUntil` | ✅ | ⚠️ (fire-and-forget Promise) |
| `caches.default` | ✅ | ⚠️ (drop-in alternative or manual) |
| `compatibility_date` / flags | ✅ | ❌ (Bun has its own feature flags) |
| Workers AI / Vectorize / Browser / Hyperdrive / Email | ❌ (both paths) | ❌ |

**Rule of thumb**: if your Worker is "fetch + KV + D1 + R2", both paths work. If you use Durable Objects, stay on Mirror.

## Runtime-agnostic module boundaries

In the codebase, anything in these directories must work identically regardless of runtime choice:

```
src/
  cli/                   # commands, prompts, error surfaces
  provider/              # Hetzner, DO, Linode, ...
  bootstrap/             # stages 0-9 from design/bootstrap.md
  deploy/                # SCP + systemd reload
  secret/                # keychain + VPS secret vault
  observe/               # /metrics + /health conventions, tail
  backup/                # restic orchestration
  estimate/              # cost analyzer
  config/                # wrangler.toml + [groundflare] parsing
  runtime/
    mod.ts               # Runtime interface
    workerd/             # Mirror track implementation
    bun/                 # Bun track implementation
```

The `Runtime` interface is the only cross-cut:

```ts
// src/runtime/mod.ts
export interface Runtime {
  readonly name: 'workerd' | 'bun'

  // Build-time: turn wrangler.toml + source into a deployable artifact
  build(opts: BuildOpts): Promise<Artifact>

  // systemd unit definition for this runtime
  systemdUnit(opts: SystemdOpts): string

  // Health check endpoint logic (runtime-specific metrics)
  healthCheckImpl(): string

  // Versioning
  version(): Promise<string>
}
```

CLI resolves which `Runtime` to use from `[groundflare] runtime = "workerd" | "bun"` in wrangler.toml, or `--bun` flag, or detection of a `bun-migration` branch.

## Bun-track migration workflow

### `groundflare bun analyze`

Reads `wrangler.toml` + `src/**/*.{ts,js}`. For each file:

1. **Parse AST** (`@babel/parser` or `oxc-parser`)
2. **Find `env.*` access** — classify by binding kind
3. **Find known-problematic APIs** — DO, HTMLRewriter, WebSocketPair, caches.default
4. **Report** in categories: can-transform, review-needed, blocker

Output a JSON analysis + human-readable summary. Exit non-zero if blockers are present.

### `groundflare bun prepare`

Produces a migration diff:

1. Copy source to `src-bun/` (or branch `bun-migration`)
2. For each `env.DB.*` → call LLM with transformation prompt (codemod-as-prompt)
3. For each `env.KV.*` → synthesize `bun:sqlite` get/put/list (or `ioredis` if `[groundflare.bun.bindings.<name>] client = "ioredis"`)
4. For each `env.R2.*` → synthesize S3 SDK calls
5. Generate `server.ts`:
   ```ts
   import handler from './src-bun/index.ts'
   Bun.serve({ port: 8080, fetch: (req) => handler.fetch(req, env) })
   ```
6. Generate `bun.groundflare.config.ts` capturing runtime-specific setup
7. Update `[groundflare] runtime = "bun"` in wrangler.toml

LLM prompt templates live in `src/runtime/bun/codemods/` as `.md` files. Deterministic parts (binding name → client variable) happen in code; creative parts (edge cases) go to the LLM.

### `groundflare bun apply`

Moves `src-bun/*` → `src/*`, commits the transformation, updates wrangler.toml. This is a separate step so reviewers can read the diff first.

### Fallback: manual mode

If LLM-assisted transformation produces something the user doesn't trust, they can:
- Skip `bun prepare` entirely
- Write their own Bun entry point + binding clients
- Add `[groundflare] runtime = "bun"` + `[groundflare.bun] main = "server.ts"`
- Run `groundflare up --bun`

The `bun prepare` tool is a convenience, not a requirement.

## Shared config, differentiated runtime

In `wrangler.toml`:

```toml
# Standard wrangler fields — applicable to Mirror
name = "my-api"
main = "src/index.ts"
compatibility_date = "2026-04-01"

[[d1_databases]]
binding = "DB"
database_name = "app"

# groundflare-specific
[groundflare]
provider = "hetzner"
size = "cx22"
domain = "api.example.com"
runtime = "workerd"         # or "bun" (Bun-track opt-in)

# Bun-specific overrides (only consulted when runtime = "bun")
[groundflare.bun]
main = "server.ts"           # entry point, generated by `bun prepare`
# per-binding client choices if the default isn't right
[groundflare.bun.bindings.DB]
client = "bun:sqlite"
path = "/var/lib/groundflare/d1/app.sqlite"
[groundflare.bun.bindings.CACHE]
client = "bun:sqlite"                        # default; set to "ioredis" to opt into Redis
path = "/var/lib/groundflare/kv/CACHE.sqlite"
```

## Performance expectations

From Stage 1 + 2c on a laptop:

| Target | Mirror (workerd) | Bun track |
|---|---:|---:|
| Throughput (trivial fetch) | ~12-16k rps | ~44k rps |
| mean latency | ~2-4ms | ~0.6-2ms |
| p99 latency | single digit ms | <5ms typical |
| idle recovery (30s) | 1.35ms | untested, expected similar |
| cold start | always-on, 0ms | always-on, 0ms |

Same-VPS numbers will be lower but ratios should hold. Stage 3a confirmation needed.

## Phased roadmap

| Phase | Mirror | Bun track |
|---|---|---|
| **v0.1** | MVP: deploy a worker to Hetzner VPS | — |
| **v0.2-0.3** | Stabilize Mirror: bindings, observability, secrets | — |
| **v0.4** | Mirror production-grade | **Bun-track experimental preview**: `bun analyze` only |
| **v0.5** | Mirror maintenance | **Bun-track alpha**: `bun prepare` for no-DO Workers |
| **v0.6-0.7** | — | Bun handles HTMLRewriter, WebSocket fallbacks |
| **v1.0** | Both tracks stable | DO alternatives (research) |
| **v1.5+** | — | Bun track covers 90% of CF Workers |

**Do not ship the Bun track before Mirror is production-proven.** Runtime diversity before product-market-fit is a well-known trap.

## Risks

| Risk | Mitigation |
|---|---|
| **Nobody actually uses the Bun track** — LLM migration too scary, users stay on Mirror | Ship Mirror first. Only build Bun-track tooling once we see real demand signals (issues, discussions, DMs). |
| **Adapter semantic drift** — Mirror's SQLite KV behaves differently from Bun-track's own SQLite (or ioredis) wrapper | Shared conformance test suite (same tests run against both runtimes) |
| **DO replacement is genuinely hard** — many real Workers rely on DO | Be honest: the Bun track is a subset. Never promise DO migration until we have a credible story. |
| **LLM transformation produces broken code** — subtle semantics wrong | `prepare` generates a diff, user reviews. Never auto-apply. |
| **Two runtimes = two bug surfaces** — support burden doubles | Keep runtime-specific code in clear directories. Shared conformance tests. |

## Branding

- `groundflare` is the product.
- `groundflare up` is the default (Mirror).
- `groundflare up --bun` is the performance path.
- Neither track has a separate marketing name. There are not "two products." The runtime is an implementation choice.

## Open questions

1. **`compatibility_date` on the Bun track.** What do we say when a user's wrangler.toml has `compatibility_date = "2024-01-01"` but they're on Bun? Bun has no equivalent concept. Leaning: **ignore it for the Bun track, warn if the worker uses flags-gated behavior**.
2. **Mixed Mode.** Can a Worker run Mirror in staging but the Bun track in prod? Technically yes (same config, different `--bun` flag). Do we support it officially? Leaning: **yes, document as an intentional pattern**.
3. **Can the Bun track use Miniflare's config parsing?** Yes — it still reads `wrangler.toml` via `unstable_readConfig`. It only diverges at "what runtime executes the resulting artifact."
4. **Auto-detect Bun-track candidacy.** Could `groundflare up` on first run say "this Worker could run on Bun for ~3× throughput; try `groundflare bun analyze`?" Leaning: **yes, opt-in hint after Mirror is working**.
5. **Pricing implication for commercial tier.** If we eventually offer a managed tier, Mirror and Bun could be priced differently (Bun's higher density = lower our cost per customer). Leaning: **same price to user, more margin for us**.
