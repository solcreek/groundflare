/**
 * DigitalOcean provider implementation.
 *
 * API reference: https://docs.digitalocean.com/reference/api/
 *
 * Follows the same pattern as HetznerProvider. Notable DO-isms:
 *   - VPS → "Droplet"; sizes → "slugs" (s-1vcpu-1gb, s-2vcpu-4gb…)
 *   - SSH keys are managed under /v2/account/keys
 *   - Pricing is embedded per-size, no dedicated /pricing endpoint
 *   - Droplet creation returns before an IPv4 is assigned; the bootstrap
 *     poll handles that
 *   - Auth via Bearer PAT against /v2/account
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

const DO_API_BASE = 'https://api.digitalocean.com/v2'
const DEFAULT_IMAGE = 'ubuntu-24-04-x64'
const DEFAULT_TIMEOUT_MS = 30_000

export interface DigitalOceanClientOptions {
  readonly token: string
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

export class DigitalOceanProvider implements Provider {
  readonly name = 'digitalocean' as const
  readonly displayName = 'DigitalOcean'

  private readonly token: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: DigitalOceanClientOptions) {
    if (!opts.token || opts.token.length === 0) {
      throw new TypeError('DigitalOceanProvider: token is required')
    }
    this.token = opts.token
    this.baseUrl = opts.baseUrl ?? DO_API_BASE
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  // ─── Auth ─────────────────────────────────────────────────────

  async authenticate(_token: string): Promise<Account> {
    const data = await this.request<{ account: DOAccount }>('GET', '/account')
    return {
      id: data.account.uuid,
      name: data.account.name || data.account.email,
      email: data.account.email,
    }
  }

  // ─── Discovery ────────────────────────────────────────────────

  async listSizes(region?: string): Promise<readonly Size[]> {
    const data = await this.request<{ sizes: DOSize[] }>(
      'GET',
      '/sizes?per_page=200',
    )
    let sizes = data.sizes.filter((s) => s.available).map(toSize)
    if (region) {
      sizes = sizes.filter((s) => s.availableInRegions.includes(region))
    }
    return sizes
  }

  async listRegions(): Promise<readonly Region[]> {
    const data = await this.request<{ regions: DORegion[] }>(
      'GET',
      '/regions?per_page=50',
    )
    return data.regions.filter((r) => r.available).map(toRegion)
  }

  // ─── SSH keys ────────────────────────────────────────────────

  async uploadSSHKey(opts: SSHKeyOptions): Promise<SSHKey> {
    const data = await this.request<{ ssh_key: DOSSHKey }>(
      'POST',
      '/account/keys',
      { name: opts.name, public_key: opts.publicKey },
    )
    return toSSHKey(data.ssh_key)
  }

  async listSSHKeys(): Promise<readonly SSHKey[]> {
    const data = await this.request<{ ssh_keys: DOSSHKey[] }>(
      'GET',
      '/account/keys?per_page=200',
    )
    return data.ssh_keys.map(toSSHKey)
  }

  async deleteSSHKey(id: string): Promise<void> {
    await this.request('DELETE', `/account/keys/${encodeURIComponent(id)}`)
  }

  // ─── VPS lifecycle ───────────────────────────────────────────

  async createVPS(opts: ProvisionOptions): Promise<VPS> {
    const body: Record<string, unknown> = {
      name: opts.name,
      size: opts.size,
      region: opts.region,
      image: opts.image ?? DEFAULT_IMAGE,
      ssh_keys: opts.sshKeyIds.map(Number),
      monitoring: true,
      tags: ['groundflare'],
    }
    if (opts.userData !== undefined) body.user_data = opts.userData
    if (opts.labels !== undefined) {
      body.tags = ['groundflare', ...Object.values(opts.labels)]
    }

    const data = await this.request<{ droplet: DODroplet }>(
      'POST',
      '/droplets',
      body,
    )
    return toVPS(data.droplet)
  }

  async getVPS(id: string): Promise<VPS | null> {
    try {
      const data = await this.request<{ droplet: DODroplet }>(
        'GET',
        `/droplets/${encodeURIComponent(id)}`,
      )
      return toVPS(data.droplet)
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null
      throw err
    }
  }

  async listVPS(): Promise<readonly VPS[]> {
    const data = await this.request<{ droplets: DODroplet[] }>(
      'GET',
      '/droplets?per_page=200&tag_name=groundflare',
    )
    return data.droplets.map(toVPS)
  }

  async destroyVPS(id: string): Promise<void> {
    await this.request('DELETE', `/droplets/${encodeURIComponent(id)}`)
  }

  // ─── Pricing ─────────────────────────────────────────────────

  estimateMonthlyCost(opts: { size: string; region: string }): number {
    void opts.region
    // DO prices are in the /v2/sizes response. For offline estimation
    // we keep a small baked table of common tiers. Return 0 for
    // unknown sizes — callers treat 0 as "no quote".
    return DO_PRICE_TABLE.get(opts.size) ?? 0
  }

  // ─── Internal HTTP transport ─────────────────────────────────

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    }
    let bodyText: string | undefined
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      bodyText = JSON.stringify(body)
    }

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: bodyText,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError(
          `DigitalOcean ${method} ${path} timed out after ${this.timeoutMs}ms`,
          'timeout',
          undefined,
          true,
          { cause: err },
        )
      }
      throw new ProviderError(
        `DigitalOcean ${method} ${path}: network error`,
        'network',
        undefined,
        true,
        { cause: err },
      )
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 204) {
      return undefined as T
    }

    const text = await response.text()
    let json: unknown
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch (err) {
        throw new ProviderError(
          `DigitalOcean ${method} ${path}: malformed response body`,
          'bad_response',
          response.status,
          false,
          { cause: err },
        )
      }
    }

    if (response.status >= 200 && response.status < 300) {
      return json as T
    }

    const code = pickErrorCode(json)
    const message = pickErrorMessage(json)
    throw new ProviderError(
      `DigitalOcean ${method} ${path}: ${response.status} ${code} — ${message}`,
      code,
      response.status,
      isRetryableStatus(response.status),
    )
  }
}

// ─── DO response shapes ───────────────────────────────────────────

interface DOAccount {
  uuid: string
  email: string
  name: string
  status: string
  droplet_limit: number
}

interface DOSize {
  slug: string
  memory: number      // MB
  vcpus: number
  disk: number        // GB
  transfer: number    // TB
  price_monthly: number
  price_hourly: number
  regions: string[]
  available: boolean
  description: string
}

function toSize(s: DOSize): Size {
  return {
    id: s.slug,
    name: s.description || s.slug,
    cpuCores: s.vcpus,
    ramGiB: s.memory / 1024,
    diskGiB: s.disk,
    priceMonthlyCents: Math.round(s.price_monthly * 100),
    egressFreeTb: s.transfer > 0 ? s.transfer : undefined,
    availableInRegions: s.regions,
  }
}

interface DORegion {
  slug: string
  name: string
  available: boolean
  sizes: string[]
  features: string[]
}

function toRegion(r: DORegion): Region {
  return {
    id: r.slug,
    name: r.name,
  }
}

interface DOSSHKey {
  id: number
  name: string
  fingerprint: string
  public_key: string
}

function toSSHKey(k: DOSSHKey): SSHKey {
  return { id: String(k.id), name: k.name, fingerprint: k.fingerprint }
}

interface DODroplet {
  id: number
  name: string
  status: string
  networks?: {
    v4?: Array<{ ip_address: string; type: string }>
    v6?: Array<{ ip_address: string; type: string }>
  }
  size?: { slug: string }
  size_slug?: string
  region?: { slug: string; name: string }
  created_at: string
  tags?: string[]
}

function toVPS(d: DODroplet): VPS {
  const out: Mutable<VPS> = {
    id: String(d.id),
    name: d.name,
    status: mapStatus(d.status),
    size: d.size?.slug ?? d.size_slug ?? '',
    region: d.region?.slug ?? '',
    createdAt: d.created_at,
  }
  const publicV4 = d.networks?.v4?.find((n) => n.type === 'public')
  if (publicV4?.ip_address) out.publicIPv4 = publicV4.ip_address
  const publicV6 = d.networks?.v6?.find((n) => n.type === 'public')
  if (publicV6?.ip_address) out.publicIPv6 = publicV6.ip_address
  if (d.tags && d.tags.length > 0) {
    out.labels = Object.fromEntries(d.tags.map((t) => [t, '']))
  }
  return out as VPS
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function mapStatus(raw: string): VPSStatus {
  switch (raw) {
    case 'new':
      return 'initializing'
    case 'active':
      return 'running'
    case 'off':
    case 'archive':
      return 'stopped'
    default:
      return 'unknown'
  }
}

// ─── Error parsing ────────────────────────────────────────────────

function pickErrorCode(body: unknown): string {
  if (
    body !== null &&
    typeof body === 'object' &&
    'id' in body &&
    typeof (body as { id: unknown }).id === 'string'
  ) {
    return (body as { id: string }).id
  }
  return 'unknown'
}

function pickErrorMessage(body: unknown): string {
  if (
    body !== null &&
    typeof body === 'object' &&
    'message' in body &&
    typeof (body as { message: unknown }).message === 'string'
  ) {
    return (body as { message: string }).message
  }
  return 'no message'
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

// ─── Static price table (USD cents/month) ─────────────────────────

const DO_PRICE_TABLE = new Map<string, number>([
  ['s-1vcpu-512mb-10gb', 400],
  ['s-1vcpu-1gb', 600],
  ['s-1vcpu-2gb', 1200],
  ['s-2vcpu-2gb', 1800],
  ['s-2vcpu-4gb', 2400],
  ['s-4vcpu-8gb', 4800],
  ['s-8vcpu-16gb', 9600],
  ['c-2', 4200],
  ['c-4', 8400],
  ['c-8', 16800],
])
