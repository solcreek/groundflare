# DESIGN: Mirror and Remix — dual-track runtime strategy

> groundflare ships two runtime tracks from the same CLI and same deploy experience. **Mirror** runs your Worker unchanged on workerd. **Remix** transforms it to a Bun-native app with help from an LLM-assisted migration tool. Same home, two ways to cook.

Status: v0 draft. Remix track is experimental until v0.5+. Mirror is the default path through at least v1.0.

## Why two tracks

workerd is the correct runtime for bug-for-bug Workers compatibility — but Bun reaches ~3.7× the HTTP throughput of workerd on the same hardware ([benchmarks.md, Stage 2c](benchmarks.md)). A meaningful set of users will prefer raw performance to Workers-API purity, especially with LLM assistance lowering the cost of code migration.

Two tracks under one CLI:

- **Mirror**: zero code changes, full Workers semantics, moderate performance. Default.
- **Remix**: Bun-native code, 3-4× throughput, LLM-assisted migration, subset of Workers features. Opt-in.

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
│    Adapter wiring (KV→Redis, D1→libSQL, R2→S3/passthrough)   │
│    Miniflare as build-time config compiler                   │
│    DO via workerd's native SQLite storage                    │
├─────────────────────────────────────────────────────────────┤
│  Remix-specific                                              │
│    Migration analyzer (what can transform, what can't)       │
│    LLM-assisted code rewriter                                │
│    Bun runtime + Bun.serve supervisor                        │
│    Native replacements (bun:sqlite, ioredis, S3 SDK)         │
│    Source transformations (`env.*` → direct client calls)    │
└─────────────────────────────────────────────────────────────┘
```

The shared layer is the majority of the product. Mirror and Remix are deployment format choices, not separate products.

## CLI

Default flow (Mirror):

```bash
$ cd my-worker/          # has wrangler.toml
$ groundflare up         # provisions + bootstraps + deploys via workerd
```

Remix flow:

```bash
$ groundflare remix analyze
  Analyzing wrangler.toml and src/...
  ✓ Can migrate:
    • fetch handler (1 entry)
    • KV bindings: 2 → ioredis
    • D1 bindings: 1 → bun:sqlite
    • R2 bindings: 1 → AWS S3 SDK (or keep on CF R2 via passthrough)
    • [vars]: 3 values
  ⚠️ Needs review:
    • Durable Objects: 1 class (MyCounter) — no direct Bun equivalent
  ✗ Cannot migrate:
    • HTMLRewriter usage at src/handler.ts:42

$ groundflare remix prepare --branch=remix-migration
  Generates src-remix/ with LLM-suggested transforms
  Opens a review diff

$ git diff main..remix-migration    # review
$ git switch remix-migration
$ groundflare up --remix
```

Explicit opt-in. `--remix` flag never applies without `remix prepare` having been run.

## Compatibility matrix

| Workers feature | Mirror | Remix |
|---|---|---|
| `fetch` handler (module worker) | ✅ | ✅ |
| `[vars]` env | ✅ | ✅ (Docker env) |
| Secrets | ✅ | ✅ |
| KV | ✅ (Redis adapter) | ✅ (direct ioredis) |
| R2 | ✅ (passthrough / S3 adapter) | ✅ (AWS SDK / passthrough) |
| D1 | ✅ (libSQL) | ✅ (bun:sqlite) |
| Cache API | ✅ (in-memory) | ⚠️ (manual LRU) |
| Service Bindings (same-host) | ✅ | ⚠️ (direct fn call replacement) |
| Durable Objects | ✅ (workerd native SQLite) | ❌ (no direct equivalent) |
| Cron Triggers | ✅ | ✅ (Bun + node-cron) |
| Queues | planned (Redis Streams) | planned (same) |
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
    workerd/             # Mirror implementation
    bun/                 # Remix implementation
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

CLI resolves which `Runtime` to use from `[groundflare] runtime = "workerd" | "bun"` in wrangler.toml, or `--remix` flag, or detection of a `remix-migration` branch.

## Remix migration workflow

### `groundflare remix analyze`

Reads `wrangler.toml` + `src/**/*.{ts,js}`. For each file:

1. **Parse AST** (`@babel/parser` or `oxc-parser`)
2. **Find `env.*` access** — classify by binding kind
3. **Find known-problematic APIs** — DO, HTMLRewriter, WebSocketPair, caches.default
4. **Report** in categories: can-transform, review-needed, blocker

Output a JSON analysis + human-readable summary. Exit non-zero if blockers are present.

### `groundflare remix prepare`

Produces a migration diff:

1. Copy source to `src-remix/` (or branch `remix-migration`)
2. For each `env.DB.*` → call LLM with transformation prompt (codemod-as-prompt)
3. For each `env.KV.*` → synthesize `redis.get/set/...`
4. For each `env.R2.*` → synthesize S3 SDK calls
5. Generate `server.ts`:
   ```ts
   import handler from './src-remix/index.ts'
   Bun.serve({ port: 8080, fetch: (req) => handler.fetch(req, env) })
   ```
6. Generate `remix.config.ts` capturing runtime-specific setup
7. Update `[groundflare] runtime = "bun"` in wrangler.toml

LLM prompt template lives in `src/runtime/bun/codemods/` as `.md` files. Deterministic parts (binding name → client variable) happen in code; creative parts (edge cases) go to the LLM.

### `groundflare remix apply`

Moves `src-remix/*` → `src/*`, commits the transformation, updates wrangler.toml. This is a separate step so reviewers can read the diff first.

### Fallback: manual mode

If LLM-assisted transformation produces something the user doesn't trust, they can:
- Skip `remix prepare` entirely
- Write their own Bun entry point + binding clients
- Add `[groundflare] runtime = "bun"` + `[groundflare.main] = "server.ts"`
- Run `groundflare up --remix`

Remix is a convenience, not a requirement.

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
runtime = "workerd"         # or "bun" (Remix opt-in)

# Bun-specific overrides (only consulted when runtime = "bun")
[groundflare.bun]
main = "server.ts"           # Remix entry point, generated by `remix prepare`
# per-binding client choices if the default isn't right
[groundflare.bun.bindings.DB]
client = "bun:sqlite"
path = "/var/lib/groundflare/d1/app.sqlite"
[groundflare.bun.bindings.CACHE]
client = "ioredis"
url = "redis://localhost:6379/0"
```

## Performance expectations

From Stage 1 + 2c on a laptop:

| Target | Mirror (workerd) | Remix (Bun) |
|---|---:|---:|
| Throughput (trivial fetch) | ~12-16k rps | ~44k rps |
| mean latency | ~2-4ms | ~0.6-2ms |
| p99 latency | single digit ms | <5ms typical |
| idle recovery (30s) | 1.35ms | untested, expected similar |
| cold start | always-on, 0ms | always-on, 0ms |

Same-VPS numbers will be lower but ratios should hold. Stage 3a confirmation needed.

## Phased roadmap

| Phase | Mirror | Remix |
|---|---|---|
| **v0.1** | MVP: deploy a worker to Hetzner VPS | — |
| **v0.2-0.3** | Stabilize Mirror: bindings, observability, secrets | — |
| **v0.4** | Mirror production-grade | **Remix experimental preview**: `remix analyze` only |
| **v0.5** | Mirror maintenance | **Remix alpha**: `remix prepare` for no-DO Workers |
| **v0.6-0.7** | — | Remix handles HTMLRewriter, WebSocket fallbacks |
| **v1.0** | Both tracks stable | Remix DO alternatives (research) |
| **v1.5+** | — | Remix covers 90% of CF Workers |

**Do not ship Remix before Mirror is production-proven.** Runtime diversity before product-market-fit is a well-known trap.

## Risks

| Risk | Mitigation |
|---|---|
| **Nobody actually uses Remix** — LLM migration too scary, users stay on Mirror | Ship Mirror first. Only build Remix once we see real demand signals (issues, discussions, DMs). |
| **Adapter semantic drift** — Mirror's KV behaves differently from Remix's ioredis wrapper | Shared conformance test suite (same tests run against both runtimes) |
| **DO replacement is genuinely hard** — many real Workers rely on DO | Be honest: Remix is a subset. Never promise DO migration until we have a credible story. |
| **LLM transformation produces broken code** — subtle semantics wrong | `prepare` generates a diff, user reviews. Never auto-apply. |
| **Two runtimes = two bug surfaces** — support burden doubles | Keep runtime-specific code in clear directories. Shared conformance tests. |

## Branding

- `groundflare` is the product.
- `groundflare up` is the default (Mirror).
- `groundflare up --remix` is the performance path.
- Neither track has a separate marketing name. There are not "two products." The runtime is an implementation choice.

## Open questions

1. **`compatibility_date` under Remix.** What do we say when a user's wrangler.toml has `compatibility_date = "2024-01-01"` but they're on Bun? Bun has no equivalent concept. Leaning: **ignore it for Remix, warn if the worker uses flags-gated behavior**.
2. **Mixed Mode.** Can a Worker run Mirror in staging but Remix in prod? Technically yes (same config, different `--remix` flag). Do we support it officially? Leaning: **yes, document as an intentional pattern**.
3. **Can Remix use Miniflare's config parsing?** Yes — Remix still reads `wrangler.toml` via `unstable_readConfig`. It only diverges at "what runtime executes the resulting artifact."
4. **Auto-detect Remix candidacy.** Could `groundflare up` on first run say "this Worker could run on Bun for ~3× throughput; try `groundflare remix analyze`?" Leaning: **yes, opt-in hint after Mirror is working**.
5. **Pricing implication for commercial tier.** If we eventually offer a managed tier, Mirror and Remix could be priced differently (Bun's higher density = lower our cost per customer). Leaning: **same price to user, more margin for us**.
