/**
 * Hetzner Cloud provider implementation.
 *
 * API reference: https://docs.hetzner.cloud/
 *
 * The class is constructed with a token and exposes the Provider methods.
 * For testability, a fetch implementation can be injected — the default
 * uses the global Node 18+ fetch.
 *
 * What this implements (v0.1 scope):
 *   - GET  /server_types          → listSizes
 *   - GET  /locations             → listRegions
 *   - POST /ssh_keys              → uploadSSHKey
 *   - GET  /ssh_keys              → listSSHKeys
 *   - DELETE /ssh_keys/:id        → deleteSSHKey
 *   - POST /servers               → createVPS
 *   - GET  /servers/:id           → getVPS
 *   - GET  /servers               → listVPS
 *   - DELETE /servers/:id         → destroyVPS
 *
 * Out of scope for now: pagination follow-through (we set per_page=50),
 * action-completion polling (createVPS returns when the server resource
 * is created; the bootstrap stage waits for SSH separately), volumes,
 * load balancers, networks.
 */

import {
  ProviderError,
  type Account,
  type Provider,
  type ProvisionOptions,
  type Region,
  type SSHKey,
  type SSHKeyOptions,
  type Size,
  type VPS,
  type VPSStatus,
} from './types.js'
import { HttpProvider, type HttpProviderOptions } from './http-base.js'

const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1'
const DEFAULT_IMAGE = 'ubuntu-24.04'

export type HetznerClientOptions = HttpProviderOptions

export class HetznerProvider extends HttpProvider implements Provider {
  readonly name = 'hetzner' as const
  readonly displayName = 'Hetzner Cloud'

  constructor(opts: HetznerClientOptions) {
    super(opts, { brand: 'Hetzner', defaultBaseUrl: HETZNER_API_BASE })
  }

  // ─── Auth ─────────────────────────────────────────────────────

  async authenticate(token: string): Promise<Account> {
    // Hetzner doesn't expose a /me endpoint at the project level. We
    // verify the token by making the smallest possible authenticated
    // request and rely on the 401 path for invalid tokens.
    const probeClient = new HetznerProvider({
      token,
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    })
    await probeClient.request('GET', '/locations')
    return {
      id: synthesizeAccountId(token),
      name: 'Hetzner Cloud project',
    }
  }

  // ─── Discovery ────────────────────────────────────────────────

  async listSizes(region?: string): Promise<readonly Size[]> {
    const data = await this.request<{ server_types: HetznerServerType[] }>(
      'GET',
      '/server_types?per_page=50',
    )
    const sizes = data.server_types.map(toSize)
    if (region) {
      return sizes.filter((s) => s.availableInRegions.includes(region))
    }
    return sizes
  }

  async listRegions(): Promise<readonly Region[]> {
    const data = await this.request<{ locations: HetznerLocation[] }>(
      'GET',
      '/locations?per_page=50',
    )
    return data.locations.map(toRegion)
  }

  // ─── SSH keys ────────────────────────────────────────────────

  async uploadSSHKey(opts: SSHKeyOptions): Promise<SSHKey> {
    const data = await this.request<{ ssh_key: HetznerSSHKey }>('POST', '/ssh_keys', {
      name: opts.name,
      public_key: opts.publicKey,
    })
    return toSSHKey(data.ssh_key)
  }

  async listSSHKeys(): Promise<readonly SSHKey[]> {
    const data = await this.request<{ ssh_keys: HetznerSSHKey[] }>(
      'GET',
      '/ssh_keys?per_page=50',
    )
    return data.ssh_keys.map(toSSHKey)
  }

  async deleteSSHKey(id: string): Promise<void> {
    await this.request('DELETE', `/ssh_keys/${encodeURIComponent(id)}`)
  }

  // ─── VPS lifecycle ───────────────────────────────────────────

  async createVPS(opts: ProvisionOptions): Promise<VPS> {
    const body: Record<string, unknown> = {
      name: opts.name,
      server_type: opts.size,
      location: opts.region,
      image: opts.image ?? DEFAULT_IMAGE,
      ssh_keys: opts.sshKeyIds,
      start_after_create: true,
    }
    if (opts.userData !== undefined) body.user_data = opts.userData
    if (opts.labels !== undefined) body.labels = opts.labels

    const data = await this.request<{ server: HetznerServer }>('POST', '/servers', body)
    return toVPS(data.server)
  }

  async getVPS(id: string): Promise<VPS | null> {
    try {
      const data = await this.request<{ server: HetznerServer }>(
        'GET',
        `/servers/${encodeURIComponent(id)}`,
      )
      return toVPS(data.server)
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null
      throw err
    }
  }

  async listVPS(): Promise<readonly VPS[]> {
    const data = await this.request<{ servers: HetznerServer[] }>(
      'GET',
      '/servers?per_page=50',
    )
    return data.servers.map(toVPS)
  }

  async destroyVPS(id: string): Promise<void> {
    await this.request('DELETE', `/servers/${encodeURIComponent(id)}`)
  }

  // ─── Pricing ─────────────────────────────────────────────────

  estimateMonthlyCost(opts: { size: string; region: string }): number {
    void opts.region
    const cents = HETZNER_PRICE_TABLE.get(opts.size)
    return cents ?? 0
  }

  // ─── Error translation ───────────────────────────────────────
  //
  // Hetzner returns { error: { code, message, ... } } on failed requests.
  protected parseError(body: unknown): { code: string; message: string } {
    return {
      code: pickErrorCode(body),
      message: pickErrorMessage(body),
    }
  }
}

// ─── Type translation ──────────────────────────────────────────────

interface HetznerServerType {
  id: number
  name: string
  description: string
  cores: number
  memory: number
  disk: number
  prices: Array<{
    location: string
    price_monthly: { gross: string; net: string }
  }>
  included_traffic?: number
}

function toSize(t: HetznerServerType): Size {
  // Hetzner reports prices per location. Pick the first one as canonical;
  // most sizes are priced uniformly. (cx22 in hel1 == cx22 in fsn1.)
  const firstPrice = t.prices[0]
  const monthly = firstPrice ? Number.parseFloat(firstPrice.price_monthly.gross) : 0
  return {
    id: t.name,
    name: t.description,
    cpuCores: t.cores,
    ramGiB: t.memory,
    diskGiB: t.disk,
    priceMonthlyCents: Math.round(monthly * 100),
    egressFreeTb: t.included_traffic ? t.included_traffic / 1000 : undefined,
    availableInRegions: t.prices.map((p) => p.location),
  }
}

interface HetznerLocation {
  id: number
  name: string
  description: string
  country: string
  city: string
}

function toRegion(l: HetznerLocation): Region {
  return {
    id: l.name,
    name: l.description,
    country: l.country,
    city: l.city,
  }
}

interface HetznerSSHKey {
  id: number
  name: string
  fingerprint: string
  public_key: string
}

function toSSHKey(k: HetznerSSHKey): SSHKey {
  return { id: String(k.id), name: k.name, fingerprint: k.fingerprint }
}

interface HetznerServer {
  id: number
  name: string
  status: string
  public_net?: {
    ipv4?: { ip?: string }
    ipv6?: { ip?: string }
  }
  server_type?: { name?: string }
  datacenter?: { location?: { name?: string } }
  created: string
  labels?: Record<string, string>
}

function toVPS(s: HetznerServer): VPS {
  // Build the result by accumulating only defined fields so tests can do
  // strict equality without "undefined-vs-missing" gotchas.
  const out: Mutable<VPS> = {
    id: String(s.id),
    name: s.name,
    status: mapStatus(s.status),
    size: s.server_type?.name ?? '',
    region: s.datacenter?.location?.name ?? '',
    createdAt: s.created,
  }
  if (s.public_net?.ipv4?.ip !== undefined) out.publicIPv4 = s.public_net.ipv4.ip
  if (s.public_net?.ipv6?.ip !== undefined) out.publicIPv6 = s.public_net.ipv6.ip
  if (s.labels !== undefined) out.labels = s.labels
  return out as VPS
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function mapStatus(raw: string): VPSStatus {
  switch (raw) {
    case 'initializing':
    case 'starting':
      return 'initializing'
    case 'running':
      return 'running'
    case 'stopping':
    case 'off':
      return 'stopped'
    case 'deleting':
      return 'deleting'
    default:
      return 'unknown'
  }
}

// ─── Error parsing ─────────────────────────────────────────────────

function pickErrorCode(body: unknown): string {
  if (
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    body.error !== null &&
    typeof body.error === 'object' &&
    'code' in body.error &&
    typeof body.error.code === 'string'
  ) {
    return body.error.code
  }
  return 'unknown'
}

function pickErrorMessage(body: unknown): string {
  if (
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    body.error !== null &&
    typeof body.error === 'object' &&
    'message' in body.error &&
    typeof body.error.message === 'string'
  ) {
    return body.error.message
  }
  return 'no message'
}

// ─── Account synthesis ─────────────────────────────────────────────

function synthesizeAccountId(token: string): string {
  // Hash-derived ID so the same token across CLI invocations produces a
  // stable identifier without exposing the token itself in logs.
  let hash = 0
  for (let i = 0; i < token.length; i++) {
    hash = (hash * 31 + token.charCodeAt(i)) >>> 0
  }
  return `hetzner-${hash.toString(36)}`
}

// ─── Static price table ────────────────────────────────────────────

/**
 * Snapshot of common Hetzner shared-vCPU sizes, in EUR cents/month
 * (gross). Refreshed manually; estimateMonthlyCost falls back to 0 for
 * sizes not in the table. The CLI's `groundflare estimate` should call
 * `listSizes()` for live numbers when an API token is available.
 */
const HETZNER_PRICE_TABLE = new Map<string, number>([
  ['cx22', 599],
  ['cx32', 1059],
  ['cx42', 2099],
  ['cx52', 4099],
  ['cax11', 414],
  ['cax21', 749],
  ['cax31', 1349],
  ['cax41', 2699],
])
