# Design Specs

Internal design documents for groundflare. These are working specs that define product scope, architecture, and behavior before implementation.

| Document | What it defines |
|---|---|
| [bootstrap.md](bootstrap.md) | Day-0 automation: provisioning + hardening + observability stack the user never has to touch |
| [config.md](config.md) | How `wrangler.toml` becomes a deployable groundflare config; 3-layer resolution model |
| [cost-estimate.md](cost-estimate.md) | The `groundflare estimate` CLI: read CF usage, output savings vs Hetzner |
| [provider.md](provider.md) | ADR + interface for VPS provider abstraction (Hetzner, DigitalOcean, ...); why not Pulumi |
| [benchmarks.md](benchmarks.md) | Runtime benchmarks + architectural decisions; why workerd standalone over Miniflare, why no Docker |
| [tracks.md](tracks.md) | Dual-track runtime strategy: Mirror (workerd, zero changes) + Bun track (LLM-assisted migration, 3-4× throughput) |
| [testing.md](testing.md) | Test pyramid (unit / conformance / Docker-VPS / live smoke), coverage targets per subsystem, Docker's role (CI simulator only, not production) |

## Conventions

- Each spec ends with an **Open questions** section — don't resolve in the doc, resolve in PR discussion or RFC issue
- Specs are versioned by `Status:` line at the top (`v0 draft` → `v1 stable` → `superseded by ...`)
- Once a spec ships, it stays as historical record; don't delete
- Favor **concrete examples over abstract schemas** — three progressive examples beats one perfect type definition
