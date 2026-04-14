# DESIGN: Provider Abstraction

> How groundflare talks to VPS providers (Hetzner, DigitalOcean, Linode, ...) without leaking provider-specific concepts into the rest of the codebase.

Status: v0 draft.

## ADR: Why not Pulumi / Terraform / OpenTofu

We considered using an existing IaC tool to abstract VPS providers. Decision: **build our own thin Provider interface** instead.

### Reasoning

| Concern | IaC tool (Pulumi/Terraform) | Our Provider interface |
|---|---|---|
| State backend | Requires Pulumi Cloud / S3 / explicit local file mgmt | Single JSON file at `~/.config/groundflare/state.json` |
| Install footprint | +100 MB CLI binary + hundreds of MB SDK | +50 KB of TypeScript |
| Multi-process model | Engine subprocess + RPC (hard to embed in CLI) | Direct `fetch()` calls |
| End-user friction | Sign up for state backend | Zero |
| Provider abstraction depth | Auto-generated from underlying TF providers — shallow, leaky | Hand-designed, tailored to groundflare's exact needs |
| Type safety | ✓ via codegen | ✓ via OpenAPI codegen |
| Lock-in to upstream tool | Coupled to Pulumi's release cadence + their TF provider versions | We control the abstraction |
| Best for | Multi-resource, team-shared infra | Solo dev with 1-2 VPS — exactly groundflare's audience |

When to revisit: if groundflare v2+ targets multi-VPS deployments, complex networking (VPC/LB), or team-shared state — Pulumi's state mgmt becomes worth it. v1 doesn't need it.

## The interface

```ts
// src/provider/types.ts

export type ProviderName =
  | 'hetzner'
  | 'digitalocean'
  | 'linode'
  | 'vultr'
  | 'contabo'

export interface Provider {
  readonly name: ProviderName
  readonly displayName: string

  // ─── Authentication ─────────────────────────────────────────────
  authenticate(token: string): Promise<Account>

  // ─── Discovery (used by `groundflare estimate`, `up`) ───────────
  listSizes(region?: string): Promise<Size[]>
  listRegions(): Promise<Region[]>
  listImages?(): Promise<Image[]>            // optional, defaults to Ubuntu LTS

  // ─── SSH key management ─────────────────────────────────────────
  uploadSSHKey(opts: SSHKeyOpts): Promise<SSHKey>
  listSSHKeys(): Promise<SSHKey[]>
  deleteSSHKey(id: string): Promise<void>

  // ─── VPS lifecycle ──────────────────────────────────────────────
  createVPS(opts: ProvisionOpts): Promise<VPS>
  getVPS(id: string): Promise<VPS | null>
  listVPS(): Promise<VPS[]>
  destroyVPS(id: string): Promise<void>

  // ─── Optional features ──────────────────────────────────────────
  resizeVPS?(id: string, newSize: string): Promise<VPS>
  rebootVPS?(id: string): Promise<void>

  // ─── Pricing (read from cached prices.json by default) ──────────
  estimateMonthlyCost(opts: { size: string, region: string }): number
}
```

The interface intentionally excludes:
- DNS management (Caddy + wildcard cert handles `*.groundflare.app`; user manages own DNS for custom domains)
- Block storage / volumes (single-disk VPS in v1; volumes in v1.5)
- Load balancers (single-node in v1)
- Private networking / VPC (out of scope; if user needs it, they go to k8s)
- Provider-side backups / snapshots (we use restic for portability across providers)

## Domain types

```ts
export interface Account {
  id: string
  name: string
  email?: string
  meta: Record<string, unknown>          // provider-specific extras
}

export interface Size {
  id: string                              // 'cx22' | 's-1vcpu-2gb' | ...
  vcpu: number
  ramGB: number
  diskGB: number
  trafficTB: number                       // included monthly traffic
  pricing: { hourly: number, monthly: number }   // USD
  availability: string[]                  // region ids where this size exists
  arch: 'x86_64' | 'arm64'
}

export interface Region {
  id: string                              // 'hel1' | 'nyc3' | ...
  name: string                            // 'Helsinki' | 'New York 3'
  country: string                         // ISO 3166-1 alpha-2
  continent: 'EU' | 'NA' | 'AS' | 'OC' | 'SA' | 'AF'
  city?: string
}

export interface Image {
  id: string                              // 'ubuntu-24.04' | provider-specific
  name: string
  os: string
  arch: 'x86_64' | 'arm64'
}

export interface SSHKey {
  id: string                              // provider-assigned
  name: string
  fingerprint: string                     // SHA256 hex
  publicKey: string
}

export interface SSHKeyOpts {
  name: string
  publicKey: string
}

export interface ProvisionOpts {
  name: string
  size: string                            // size.id
  region: string                          // region.id
  image?: string                          // default: 'ubuntu-24.04'
  sshKeyId: string
  cloudInit?: string                      // raw cloud-config YAML
  labels?: Record<string, string>         // for cross-checking; we always add 'groundflare:managed'='true'
}

export interface VPS {
  id: string                              // provider-assigned
  name: string
  size: string
  region: string
  ipv4: string
  ipv6?: string
  status: 'provisioning' | 'running' | 'stopped' | 'error'
  createdAt: string                       // ISO 8601
  pricing: { hourly: number, monthly: number }
  meta: Record<string, unknown>
}
```

All types live in `src/provider/types.ts` — single source of truth, re-exported via `groundflare/provider`.

## Per-provider implementation

```
src/provider/
  ├─ types.ts                      # shared interface + types
  ├─ index.ts                      # registry: getProvider(name)
  ├─ errors.ts                     # ProviderError, AuthError, RateLimitError, ...
  ├─ hetzner/
  │  ├─ index.ts                   # implements Provider
  │  ├─ openapi-types.ts           # generated, do not edit
  │  └─ openapi.json               # pinned spec, refreshed quarterly
  ├─ digitalocean/
  │  ├─ index.ts
  │  ├─ openapi-types.ts
  │  └─ openapi.json
  ├─ linode/...
  └─ vultr/...
```

Each provider implementation is **100% self-contained** — no shared HTTP client, no shared state. Just `fetch` + types.

### Skeleton (Hetzner example)

```ts
// src/provider/hetzner/index.ts
import type { Provider, Account, ProvisionOpts, VPS, Size, Region, SSHKey, SSHKeyOpts } from '../types'
import type { paths } from './openapi-types'
import { ProviderError, AuthError, NotFoundError } from '../errors'

const API_BASE = 'https://api.hetzner.cloud/v1'

export class HetznerProvider implements Provider {
  readonly name = 'hetzner' as const
  readonly displayName = 'Hetzner Cloud'

  constructor(private token: string) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    })
    if (res.status === 401) throw new AuthError('hetzner', 'invalid token')
    if (res.status === 404) throw new NotFoundError('hetzner', path)
    if (!res.ok) {
      const body = await res.text()
      throw new ProviderError('hetzner', `${res.status}: ${body}`, { status: res.status })
    }
    return res.json() as Promise<T>
  }

  async authenticate(token: string): Promise<Account> {
    const tmp = new HetznerProvider(token)
    type R = paths['/projects']['get']['responses']['200']['content']['application/json']
    const { projects } = await tmp.req<R>('/projects')
    if (projects.length === 0) throw new AuthError('hetzner', 'no projects accessible')
    return { id: String(projects[0].id), name: projects[0].name, meta: { projects } }
  }

  async createVPS(opts: ProvisionOpts): Promise<VPS> {
    type R = paths['/servers']['post']['responses']['201']['content']['application/json']
    const { server } = await this.req<R>('/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name,
        server_type: opts.size,
        location: opts.region,
        image: opts.image ?? 'ubuntu-24.04',
        ssh_keys: [Number(opts.sshKeyId)],
        user_data: opts.cloudInit,
        labels: { 'groundflare:managed': 'true', ...opts.labels },
      }),
    })
    return this.toVPS(server)
  }

  async getVPS(id: string): Promise<VPS | null> {
    try {
      const { server } = await this.req<{ server: any }>(`/servers/${id}`)
      return this.toVPS(server)
    } catch (e) {
      if (e instanceof NotFoundError) return null
      throw e
    }
  }

  async destroyVPS(id: string): Promise<void> {
    await this.req(`/servers/${id}`, { method: 'DELETE' })
  }

  async uploadSSHKey(opts: SSHKeyOpts): Promise<SSHKey> {
    const { ssh_key } = await this.req<{ ssh_key: any }>('/ssh_keys', {
      method: 'POST',
      body: JSON.stringify({ name: opts.name, public_key: opts.publicKey }),
    })
    return { id: String(ssh_key.id), name: ssh_key.name, fingerprint: ssh_key.fingerprint, publicKey: ssh_key.public_key }
  }

  // ... listSizes, listRegions, etc.

  estimateMonthlyCost(opts: { size: string, region: string }): number {
    return PRICES.hetzner[opts.size]?.monthly ?? 0
  }

  private toVPS(server: any): VPS { /* ... shape mapping ... */ }
}
```

Total per provider: **~200-400 lines** including types, error mapping, and pricing. Comparable to writing a Pulumi resource by hand, **without** the runtime cost.

## Provider registry

```ts
// src/provider/index.ts
import { HetznerProvider } from './hetzner'
import { DigitalOceanProvider } from './digitalocean'
import { LinodeProvider } from './linode'
import { VultrProvider } from './vultr'
import { ContaboProvider } from './contabo'

const REGISTRY = {
  hetzner:      HetznerProvider,
  digitalocean: DigitalOceanProvider,
  linode:       LinodeProvider,
  vultr:        VultrProvider,
  contabo:      ContaboProvider,
} as const

export function getProvider(name: ProviderName, token: string): Provider {
  const C = REGISTRY[name]
  if (!C) throw new Error(`unknown provider: ${name}`)
  return new C(token)
}

export const SUPPORTED_PROVIDERS = Object.keys(REGISTRY) as ProviderName[]
```

CLI commands resolve provider via this registry:

```ts
const provider = getProvider(config.provider, await getToken(config.provider))
```

## Type generation from OpenAPI

Each provider exposes an OpenAPI spec. We generate TS types once, commit them, update quarterly.

```bash
# Hetzner
npx openapi-typescript https://docs.hetzner.cloud/spec.json \
  -o src/provider/hetzner/openapi-types.ts

# DigitalOcean
npx openapi-typescript https://api-engineering.nyc3.cdn.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml \
  -o src/provider/digitalocean/openapi-types.ts
```

CI job (`refresh-openapi.yml`) runs quarterly + on demand. PR review enforces no breaking-change merges without bumping major version.

## Local state

```ts
// ~/.config/groundflare/state.json
export interface LocalState {
  schemaVersion: 1
  defaultProvider?: ProviderName

  // VPS we manage, keyed by user-given name
  vps: Record<string, ManagedVPS>

  // SSH keys we generated/uploaded
  sshKeys: Record<string, ManagedSSHKey>

  // Auth tokens — actual values in OS keychain, this is just metadata
  accounts: Record<ProviderName, AccountRef>
}

export interface ManagedVPS {
  name: string                          // user-friendly, also used as VPS hostname
  provider: ProviderName
  providerId: string                    // provider's internal ID
  size: string
  region: string
  ipv4: string
  ipv6?: string
  createdAt: string
  bootstrapState: 'pending' | 'partial' | 'complete' | 'failed'
  bootstrapStage?: number               // 0-10 from design/bootstrap.md
  workerName?: string                   // wrangler.toml name
  domain?: string
  lastDeploy?: string
}

export interface ManagedSSHKey {
  name: string                          // 'groundflare-<vps>-<timestamp>'
  privateKeyPath: string                // ~/.config/groundflare/keys/<name>_ed25519
  fingerprint: string
  uploadedTo: { provider: ProviderName, providerId: string }[]
}

export interface AccountRef {
  accountId: string
  accountName: string
  keychainKey: string                   // for OS keychain lookup
  addedAt: string
}
```

State file is rewritten atomically (write to `state.json.tmp`, fsync, rename).

## Idempotency

Every mutating operation:

1. Look up resource in local state by user-friendly name
2. If found: call `provider.getVPS(state.providerId)` to verify it still exists
3. If exists: return it (no-op)
4. If not exists (drift): recreate, update state with new ID
5. If not in state: create fresh, persist to state

Tag every created resource with provider labels:
- `groundflare:managed=true`
- `groundflare:name=<user-name>`
- `groundflare:created=<ISO timestamp>`

This lets `groundflare doctor --reconcile` find orphans (in provider but not in state) and adopt or destroy them.

## Error model

```ts
// src/provider/errors.ts

export class ProviderError extends Error {
  constructor(
    public provider: ProviderName,
    message: string,
    public details: { status?: number, code?: string, requestId?: string } = {},
  ) {
    super(message)
  }
}

export class AuthError extends ProviderError { /* 401 */ }
export class NotFoundError extends ProviderError { /* 404 */ }
export class QuotaError extends ProviderError { /* 422 quota */ }
export class RateLimitError extends ProviderError {
  constructor(provider: ProviderName, public retryAfterSeconds: number) {
    super(provider, `rate limited; retry in ${retryAfterSeconds}s`)
  }
}
export class BillingError extends ProviderError { /* payment method missing */ }
```

CLI surfaces these with provider-specific guidance:

```
✗ Hetzner: BillingError — no valid payment method on file
  ↳ Open https://console.hetzner.cloud/projects/<id>/billing
  ↳ Add a payment method, then retry: groundflare up
```

## Async lifecycle

`createVPS` returns when the API confirms the VPS is being provisioned (status: `provisioning`). The caller polls `getVPS(id)` until status becomes `running`.

Helper:

```ts
// src/provider/wait.ts
export async function waitForRunning(
  provider: Provider,
  id: string,
  opts: { timeoutMs?: number, intervalMs?: number } = {},
): Promise<VPS> {
  const timeout = opts.timeoutMs ?? 120_000
  const interval = opts.intervalMs ?? 3000
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const vps = await provider.getVPS(id)
    if (vps?.status === 'running') return vps
    if (vps?.status === 'error') throw new ProviderError(provider.name, 'VPS provisioning failed')
    await sleep(interval)
  }
  throw new ProviderError(provider.name, `VPS not running after ${timeout}ms`)
}
```

## Testing strategy

Three layers:

| Layer | What it tests | When |
|---|---|---|
| **Unit** | Each provider class with mocked `fetch`. Fixtures = real recorded responses. | Every commit |
| **Integration** | Real provider API, real VPS create/destroy. Gated by env var (e.g., `HETZNER_TEST_TOKEN`). | Pre-release |
| **Conformance** | Same test suite run against every provider, asserting interface contract. Catches divergence. | Every commit |

Fixtures live in `src/provider/<name>/__fixtures__/`, recorded via `nock` or similar.

## Adding a new provider

Checklist for contributors:

1. `mkdir src/provider/<name>/`
2. Add OpenAPI URL to `scripts/refresh-openapi.ts`; run it
3. Implement `Provider` interface in `src/provider/<name>/index.ts`
4. Register in `src/provider/index.ts`
5. Add pricing data to `prices.json`
6. Add fixtures + unit tests
7. Add a row to README's "Supported providers" table
8. Document any provider-specific quirks in `src/provider/<name>/README.md`

Target: a competent contributor adds a new provider in **under a day** for a "happy path" implementation, plus another day for edge cases.

## Provider matrix (planned)

| Provider | v0.1 | v0.4 | v1.0 | Notes |
|---|---|---|---|---|
| Hetzner | ✅ | ✅ | ✅ | Default. Cheapest. EU-best. |
| DigitalOcean | — | ✅ | ✅ | US/global popularity. |
| Linode (Akamai) | — | ✅ | ✅ | US/AP. |
| Vultr | — | — | ✅ | Many regions. |
| Contabo | — | — | ✅ | Cheapest of all. Reliability mixed. |
| AWS Lightsail | — | — | future | Different billing model. |
| Oracle Cloud Free Tier | — | — | future | Free forever, but quirky. |

## Open questions

1. **Region auto-detection.** Detect user's IP → suggest closest provider region. Implementation: free IP geo API (ipapi.co or similar); fall back to user choice. Privacy: anonymize before any telemetry.
2. **Provider-side backups vs restic.** Each provider offers snapshots (Hetzner ~20% extra cost). Stick with restic for portability — but expose `--use-provider-snapshots` for users who prefer it?
3. **Should provider implementations be split into separate npm packages?** Pro: smaller core install. Con: install friction (`npm install groundflare-provider-hetzner`). Leaning: **monolithic for v1**, split if install size becomes painful.
4. **OpenAPI spec drift.** What if Hetzner ships a breaking API change between our quarterly refreshes? Mitigation: pin api-version header where supported; CI canary against live API daily.
5. **Provider feature parity gaps.** Some providers don't support cloud-init (Vultr partial), don't have arm64 (varies), etc. Document per-provider in `src/provider/<name>/README.md` and surface in `groundflare init` provider picker.
