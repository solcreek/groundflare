# DESIGN: `groundflare` Configuration

> How groundflare reads, extends, and translates `wrangler.toml` — without forcing users to learn a new format.

Status: v0 draft. Defines the file schema, the resolution order, and the translation rules from every Cloudflare binding to its self-hosted equivalent.

## Design principles

1. **`wrangler.toml` is the source of truth for the Worker.** groundflare reads it as-is. We do not fork the format, we do not require renaming, we do not duplicate.
2. **Self-hosting concerns are additive.** Anything CF doesn't know about (VPS provider, backup destination, adapter choice) goes in a `[groundflare]` section of `wrangler.toml` OR a sidecar `groundflare.config.ts`.
3. **TypeScript escape hatch.** TOML is fine for static config; `groundflare.config.ts` is for users who need env-conditional logic, type safety, or computed values.
4. **Smart defaults.** A bare wrangler.toml with no `[groundflare]` section deploys with sensible defaults. Configuration is for overrides, not requirements.
5. **`wrangler.jsonc` is equally supported.** Modern CF projects use jsonc; we mirror.

## The 3-layer resolution model

```
┌─────────────────────────────────────────────────┐
│  Layer 1 (mandatory)                            │
│  wrangler.toml | wrangler.jsonc | wrangler.json │
│  → Worker definition CF understands             │
└─────────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────┐
│  Layer 2 (optional, simple cases)               │
│  [groundflare] table inside wrangler.toml       │
│  → VPS, provider, adapter choices               │
└─────────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────┐
│  Layer 3 (optional, advanced cases)             │
│  groundflare.config.ts | groundflare.config.js  │
│  → Env-conditional, computed, typed config      │
└─────────────────────────────────────────────────┘
```

**Resolution order** (later overrides earlier):
1. Smart defaults
2. `wrangler.toml` fields
3. `[groundflare]` table in wrangler.toml
4. `groundflare.config.ts` if present
5. CLI flags (`--vps-size`, `--region`, etc.)
6. Environment variables (`GROUNDFLARE_*`)

Final resolved config is dumped to `.groundflare/resolved-config.json` for debugging.

## Layer 2 schema: `[groundflare]` table

Living example, all keys optional:

```toml
# wrangler.toml — standard CF Worker config
name = "my-api"
main = "src/index.ts"
compatibility_date = "2026-04-01"

[vars]
PUBLIC_API_KEY = "abc123"

[[d1_databases]]
binding = "DB"
database_name = "production"
database_id = "uuid-here-from-cf"

[[kv_namespaces]]
binding = "CACHE"
id = "namespace-uuid-from-cf"

[[r2_buckets]]
binding = "ASSETS"
bucket_name = "my-app-assets"

# ─── groundflare extensions start here ─────────────────────────────

[groundflare]
provider = "hetzner"           # hetzner | digitalocean | linode | vultr | contabo
region   = "hel1"              # provider-specific code, or "auto"
size     = "cx22"              # provider-specific tier, or "auto"
domain   = "api.example.com"   # or omit for *.groundflare.app subdomain
email    = "you@example.com"   # for Let's Encrypt + alert delivery
backup   = "b2:my-bucket"      # b2:name | r2:name | s3://url | none

# Per-binding adapter overrides (smart defaults if omitted)
[groundflare.bindings.DB]
adapter = "libsql"             # libsql (default) | sqlite | postgres
url     = "file:///var/lib/groundflare/d1/production.sqlite"
                               # default: file:///var/lib/groundflare/d1/<database_name>.sqlite

[groundflare.bindings.CACHE]
adapter = "sqlite"             # sqlite (default) | redis | memory
path    = "/var/lib/groundflare/kv/CACHE.sqlite"  # default: per-binding sqlite file

[groundflare.bindings.ASSETS]
adapter = "passthrough"        # passthrough (keep on CF R2) | s3 | minio
                               # passthrough = use real CF R2, free egress
                               # default for R2 = passthrough (don't move what works)

# Resource limits (applied to the systemd unit)
[groundflare.runtime]
memory_mb = 512                # default: 50% of VPS RAM
cpu_pct   = 80                 # default: 80% of VPS cores

# Observability
[groundflare.observability]
metrics = "prometheus"         # prometheus (default) | none
logs    = "json"               # json (default) | text
[groundflare.observability.alerts]
email   = "ops@example.com"
webhook = "https://hooks.slack.com/services/..."

# Per-environment overrides (matches wrangler's [env.production] convention)
[groundflare.env.staging]
size   = "cx22"
domain = "staging-api.example.com"

[groundflare.env.production]
size   = "cx32"
backup = "r2:prod-backups"
[groundflare.env.production.bindings.DB]
adapter = "postgres"           # different DB tier in prod
url     = "postgres://prod-host/db"
```

## Layer 3 schema: `groundflare.config.ts`

For when TOML can't express what you need (env-driven values, computed config, typed access).

```ts
// groundflare.config.ts
import { defineConfig } from 'groundflare/config'

export default defineConfig({
  // Same shape as [groundflare] table, but full TS power
  provider: 'hetzner',
  region:   process.env.REGION ?? 'hel1',
  size:     process.env.NODE_ENV === 'production' ? 'cx42' : 'cx22',
  domain:   `${process.env.SUBDOMAIN}.example.com`,
  email:    'you@example.com',
  backup:   `b2:backups-${process.env.NODE_ENV}`,

  bindings: {
    DB: {
      adapter: 'libsql',
      url:     process.env.LIBSQL_URL ?? 'file:///var/lib/groundflare/d1/db.sqlite',
    },
    ASSETS: {
      adapter: 'passthrough',  // keep on CF R2
    },
  },

  observability: {
    alerts: {
      email:   'ops@example.com',
      webhook: process.env.SLACK_WEBHOOK,
    },
  },
})
```

`defineConfig` is a no-op identity function with type signatures — gives autocomplete + type-checking with zero runtime cost.

## Translation table: wrangler.toml → groundflare behavior

This is the contract. Every supported wrangler field has a defined mapping.

| wrangler field | groundflare behavior |
|---|---|
| `name` | systemd unit name + default domain prefix (`<name>.groundflare.app`) |
| `main` | Entry point passed to workerd |
| `compatibility_date` | Selects matching workerd binary version |
| `compatibility_flags` | Passed as `--compatibility-flag` to workerd |
| `[vars]` | Injected into the systemd unit via `Environment=` / `EnvironmentFile=` |
| `[[d1_databases]]` | Adapter resolution (default: libSQL local file at `/var/lib/groundflare/d1/<database_name>.sqlite`) |
| `[[kv_namespaces]]` | Adapter resolution (default: SQLite file at `/var/lib/groundflare/kv/<binding>.sqlite`, WAL-enabled) |
| `[[r2_buckets]]` | Adapter resolution (default: **passthrough to CF R2** — see rationale below) |
| `[[durable_objects.bindings]]` | workerd native, state persisted to `/var/lib/groundflare/do/<class>/` |
| `[[migrations]]` | Applied to workerd DO state directory on startup |
| `[[services]]` | Multi-Worker dispatch — **v1.5+**, currently unsupported |
| `[[queues.producers]]` / `[[queues.consumers]]` | Adapter resolution (default: SQLite-backed queue at `/var/lib/groundflare/queues/<name>.sqlite`; Redis Streams opt-in) — **v0.4+** |
| `[assets]` | Static assets served directly by Caddy (bypasses Worker for static paths) |
| `[triggers] crons` | One systemd `.timer` + `.service` pair per cron expression; timer fires `POST http://127.0.0.1:8080/__scheduled` which runtime dispatches to the Worker's `scheduled()` handler. `Persistent=true` catches up missed triggers after downtime. |
| `routes` | **Ignored** — groundflare uses `[groundflare] domain` |
| `workers_dev` | **Ignored** — `*.groundflare.app` is the default subdomain |
| `[ai]` (Workers AI) | **Unsupported** — flagged at config-load time with migration suggestion |
| `[[vectorize]]` | **Unsupported** — flagged |
| `[[hyperdrive]]` | **Unsupported** — flagged with "use direct PG connection" suggestion |
| `[browser]` (Browser Rendering) | **Unsupported** — flagged with "use Browserless" suggestion |
| `[send_email]` (Email Workers) | **Unsupported** — flagged |
| `[observability] enabled = true` | Maps to groundflare's `[groundflare.observability] metrics = "prometheus"` |
| `[placement]` | Ignored (no global edge in self-host) |
| `[limits] cpu_ms` | Enforced by workerd; documented but rarely needed |

## Per-binding adapter resolution

For each binding type, groundflare picks a default unless overridden.

### D1 (database)

| Adapter | When to use | URL format |
|---|---|---|
| `libsql` (default) | Single-node, local file, fastest | `file:///var/lib/groundflare/d1/<db>.sqlite` or remote `libsql://host:8080/?authToken=...` |
| `sqlite` | Same as libsql but no Turso protocol | `file:///path` |
| `postgres` | Bigger workloads, real PG features | `postgres://user:pass@host:5432/db` |

**Default behavior:** create a `/var/lib/groundflare/d1/<database_name>.sqlite` file on first deploy. groundflare-runtime opens with the [standard SQLite PRAGMAs](#standard-sqlite-pragmas), applies `migrations/*.sql` if present.

#### Standard SQLite PRAGMAs

Every SQLite-backed subsystem (D1, KV, DO, Queues) opens its database file with the same prelude, applied exactly once per connection:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;       -- 5s wait instead of SQLITE_BUSY
PRAGMA cache_size = -64000;        -- 64 MB page cache
PRAGMA mmap_size = 268435456;      -- 256 MB mmap for reads
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;
```

These are load-bearing for the "集中 SQLite" architecture: without WAL + `busy_timeout`, concurrent workerd request handlers would serialize through EXCLUSIVE locks and bottleneck at single-connection rollback-journal throughput (~100–500 writes/s). With WAL + NORMAL on NVMe, the same stack handles 10k+ writes/s per SQLite file without reader starvation. Implemented as a single `src/runtime/sqlite/prelude.ts` that every adapter imports.

### KV (key-value)

| Adapter | When to use |
|---|---|
| `sqlite` (default) | Embedded SQLite file per binding. Zero daemons, best fit for CF KV semantics (prefix `list()`, metadata, TTL are all native columns). |
| `redis` | Opt-in for users who already run Redis for other reasons. Same API; uses hash + ZSET for TTL. |
| `memory` | Dev/testing, lost on restart. |

**Default behavior:** create `/var/lib/groundflare/kv/<binding_name>.sqlite` on first deploy. Opened with the [standard SQLite PRAGMAs](#standard-sqlite-pragmas). Schema:

```sql
CREATE TABLE kv (
  key         TEXT PRIMARY KEY,
  value       BLOB NOT NULL,
  metadata    TEXT,           -- JSON, CF KV metadata sidecar
  expires_at  INTEGER          -- unix ms, NULL = no TTL
);
CREATE INDEX kv_expires ON kv(expires_at) WHERE expires_at IS NOT NULL;
```

Background task every 60s: `DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < unixepoch('subsec') * 1000`. Prefix `list()` uses `WHERE key >= :prefix AND key < :prefix_upper` (indexed range scan, not `LIKE`).

### Queues

| Adapter | When to use |
|---|---|
| `sqlite` (default) | Embedded SQLite. Handles typical micro-SaaS queue traffic (low-thousands msg/s) with ~100ms polling latency. |
| `redis-streams` | Opt-in for high-throughput, real blocking-pop semantics. Requires `redis-server`. |

**Default behavior (v0.4+):** per-queue SQLite file at `/var/lib/groundflare/queues/<queue_name>.sqlite`, consumer poller runs inside the runtime supervisor, batch size + visibility timeout match CF Queues defaults (10 msg / 30s).

Schema (see [`design/bootstrap.md`](bootstrap.md) for the consumer loop):

```sql
CREATE TABLE queue_messages (
  id           INTEGER PRIMARY KEY,
  payload      BLOB NOT NULL,
  visible_at   INTEGER NOT NULL,   -- unix ms; consumer picks WHERE visible_at <= now
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at   INTEGER NOT NULL
);
CREATE INDEX queue_visible ON queue_messages(visible_at);
```

DLQ = sibling table `queue_messages_dlq`. Backoff = `visible_at = now + min(2^attempts, 300) * 1000`.

### Cron Triggers

No adapter choice. Each `[triggers] crons = ["..."]` entry generates a dedicated systemd `.timer` + `.service` pair at bootstrap. Timer fires → `.service` runs `curl -X POST http://127.0.0.1:8080/__scheduled -H 'X-Cron: <expr>'` → runtime dispatches to the Worker's `scheduled(event, env, ctx)` handler with the matching cron expression.

Properties:
- **Persistent** (`Persistent=true`): missed triggers during downtime fire on next boot
- **Observable**: `systemctl list-timers` + `journalctl -u groundflare-cron-*.service`
- **Zero daemon**: OS scheduler does the work

### R2 (object storage)

| Adapter | When to use |
|---|---|
| `passthrough` (default) | **Recommended** — keep using real CF R2, free egress, no migration needed |
| `s3` | AWS S3 or compatible (uses standard S3 SDK) |
| `minio` | Self-hosted MinIO (single-binary, systemd unit) |
| `garage` | Self-hosted Garage (CRDT-based, distributed) |

**Why passthrough is the default:** R2 is the one CF service that's almost always cheaper to keep, especially because R2 egress is free even when accessed from a non-CF Worker. Migration off R2 only makes sense for compliance, not cost.

### Durable Objects

No adapter choice — workerd native, SQLite-backed storage on disk at `/var/lib/groundflare/do/<class>/<id>.sqlite`. Single-node only.

### Cache API

In-memory inside the workerd process. Flushed on restart. Adapter for shared cache is **out of scope for v1**.

### Service Bindings

Local-only in v1: bound services must run in the same workerd process. Multi-process service mesh in v1.5+.

## Smart defaults — full list

What happens with a bare wrangler.toml and no `[groundflare]` section:

| Resource | Default |
|---|---|
| Provider | Prompt user (no silent default — billing implication) |
| Region | Geo-detect from user's IP, prompt to confirm |
| Size | Cheapest tier that fits estimated workload (or `cx22` if unknown) |
| Domain | `<worker-name>-<6-char-hash>.groundflare.app` |
| Email | Read from `git config user.email` |
| Backup | Prompt (no silent default — data loss implication) |
| D1 adapter | libSQL local file |
| KV adapter | SQLite file per binding (WAL-enabled) |
| Queue adapter | SQLite file per queue (v0.4+) |
| Cron runner | systemd timers, one per cron expression |
| R2 adapter | **Passthrough** (keep on CF R2) |
| Runtime memory | 50% of VPS RAM |
| Runtime CPU | 80% of VPS cores |
| Observability | Prometheus enabled, JSON logs |
| Alerts | None until user configures |

**Two values intentionally have no silent default**: provider (billing) and backup (data loss). Both must be answered explicitly.

## Environments

Inherits wrangler's `[env.<name>]` convention:

```toml
# wrangler.toml — top-level config
name = "my-api"
main = "src/index.ts"

[env.staging]
name = "my-api-staging"

[env.production]
name = "my-api-prod"

# groundflare extensions per environment
[groundflare]
provider = "hetzner"
size = "cx22"

[groundflare.env.staging]
domain = "staging.example.com"

[groundflare.env.production]
size = "cx32"
domain = "api.example.com"
backup = "r2:prod-backups"
```

CLI: `groundflare deploy --env production` (matches `wrangler deploy --env production`).

## Secrets vs vars

Same model as wrangler:

| Type | Storage | Access in code | CLI |
|---|---|---|---|
| **vars** | `[vars]` table in wrangler.toml (plaintext, in git) | `env.MY_VAR` | declared in toml |
| **secrets** | `/etc/groundflare/secrets/<name>` (mode 0600, age-encrypted) | `env.MY_SECRET` | `groundflare secret put MY_SECRET` |

`groundflare secret put` writes to keychain locally + pushes encrypted to VPS over SSH. Never written to disk in plaintext on either side.

`groundflare secret pull-from-cf` migrates: reads from CF via API, encrypts, writes to VPS. One-time migration helper.

## Validation

Config is validated at three points:

1. **Parse time** — TOML/JSONC syntax, schema correctness (using zod schema, exported as `groundflare/config-schema`)
2. **Pre-deploy** — `groundflare doctor` runs:
   - All bindings have valid adapters
   - All adapter URLs are reachable
   - No unsupported wrangler fields used silently
   - `compatibility_date` is parseable + workerd version exists
3. **Post-deploy** — health check verifies runtime can resolve all bindings

Errors are explicit:

```
✗ wrangler.toml uses [ai] binding (line 23)
  ↳ Workers AI is not available in self-host (no local runtime)
  ↳ Suggested: keep [ai] binding on CF and proxy from groundflare:
      [groundflare.bindings.AI]
      adapter = "passthrough"
      cf_account = "<account-id>"
      cf_token = "$CF_API_TOKEN"
  ↳ Or: use external inference (Ollama, vLLM, OpenRouter, Anthropic API)
  ↳ See: https://groundflare.dev/docs/migrating/workers-ai
```

## Three progressive examples

### Example 1: Zero config

```toml
# wrangler.toml — minimal Worker
name = "hello-world"
main = "src/index.ts"
compatibility_date = "2026-04-01"
```

`groundflare up` →
- Prompts for: provider, backup destination, email
- All else defaulted
- Deploy in 3 minutes

### Example 2: Typical micro-SaaS

```toml
name = "my-api"
main = "src/index.ts"
compatibility_date = "2026-04-01"

[vars]
APP_URL = "https://api.example.com"

[[d1_databases]]
binding = "DB"
database_name = "app"

[[kv_namespaces]]
binding = "CACHE"
id = "kv-id-from-cf"

[[r2_buckets]]
binding = "ASSETS"
bucket_name = "my-app-assets"

[groundflare]
provider = "hetzner"
size = "cx22"
domain = "api.example.com"
email = "you@example.com"
backup = "b2:my-backups"
```

`groundflare up` → fully deterministic, no prompts.

### Example 3: Multi-env, typed, env-driven

```toml
# wrangler.toml unchanged
```

```ts
// groundflare.config.ts
import { defineConfig } from 'groundflare/config'

const env = process.env.GROUNDFLARE_ENV ?? 'staging'

export default defineConfig({
  provider: 'hetzner',
  region:   env === 'production' ? 'fsn1' : 'hel1',
  size:     env === 'production' ? 'cx42' : 'cx22',
  domain:   env === 'production' ? 'api.example.com' : `${env}.example.com`,
  email:    'you@example.com',
  backup:   `b2:backups-${env}`,

  bindings: {
    DB: env === 'production'
      ? { adapter: 'postgres', url: process.env.DATABASE_URL! }
      : { adapter: 'libsql' },
    ASSETS: { adapter: 'passthrough' },
  },

  observability: {
    alerts: {
      email:   'ops@example.com',
      webhook: process.env.SLACK_WEBHOOK,
    },
  },
})
```

`GROUNDFLARE_ENV=production groundflare deploy` → uses prod values.

## Migration from existing tools

| From | To groundflare |
|---|---|
| Pure wrangler (CF only) | Add `[groundflare]` section, run `groundflare up` |
| Kamal (general) | Manual; document mapping table |
| Coolify (general) | Manual; document mapping table |

## Open questions

1. **Should `[groundflare]` live in `wrangler.toml` or always be a sidecar?** Leaning: support both, prefer same-file for Layer 2 simplicity (one file is better than two when nothing else justifies it).
2. **`groundflare.config.ts` needs Node loader.** Use `tsx` / `jiti` at CLI runtime. Cost: extra dep. Worth it for TS-first audience.
3. **Schema validation library.** Zod is JS-canonical; cost is bundle size for the CLI. Acceptable.
4. **Should `[groundflare]` table tolerate unknown keys?** Strict mode catches typos; loose mode is forward-compatible. Leaning: **strict by default, `--allow-unknown-config` flag for advanced users**.
5. **What about wrangler's `--config` flag (alternative paths)?** Mirror it: `groundflare --config path/to/wrangler.toml`.
6. **Hot-reload on config change during dev?** Out of scope for v1 (groundflare is deploy tool, not dev tool).
