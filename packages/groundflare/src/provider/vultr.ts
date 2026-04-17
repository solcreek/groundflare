/**
 * Vultr (Choopa) provider implementation.
 *
 * API reference: https://www.vultr.com/api/
 *
 * Follows the HttpProvider pattern established by Hetzner / DigitalOcean /
 * Linode. Vultr-isms worth knowing:
 *
 *   - Error envelope is `{ error: string }` (sometimes with a sibling
 *     `status` number). Flatter than every other provider.
 *
 *   - OS is identified by a numeric `os_id` — not a string slug like
 *     every other provider. Ubuntu 24.04 LTS x64 = `2284` at time of
 *     writing (verified via `GET /v2/os`). We default to that and let
 *     `opts.image` override if it's a numeric string.
 *
 *   - SSH keys attach by UUID via an array field named `sshkey_id`
 *     (not `ssh_keys` / `authorized_keys` / `ssh_keys[]`). We pass
 *     `opts.sshKeyIds` through unchanged.
 *
 *   - `user_data` is plain base64 at the top level of the create body
 *     — NOT wrapped in a `metadata.` object like Linode.
 *
 *   - Instance status needs BOTH `status` + `power_status` fields to
 *     map cleanly onto our VPSStatus union: `active` on its own isn't
 *     enough, we also need to know whether the server is powered on.
 *
 *   - No `root_pass` required (unlike Linode). The Vultr console lets
 *     the operator reset it from the dashboard if they need to.
 *
 *   - Vultr doesn't return an SSH key fingerprint — compute one
 *     client-side, same as Linode.
 *
 *   - Tags are a flat array of strings.
 *
 *   - IP allowlist: most API keys are set to restrict write endpoints
 *     to specific source IPs. `GET /v2/regions` + `/v2/plans` are
 *     reachable without allowlist; everything we need (ssh-keys,
 *     instances, account) isn't. If the user's IP changes, they'll
 *     see 401 "Unauthorized IP address" from ProviderError. No
 *     client-side workaround — they have to update the dashboard.
 *
 * Out of scope for v0.1: cursor-based pagination follow-through (we
 * set per_page=500, enough for every account), Blocks/Volumes/Load
 * Balancers/Reserved IPs.
 */

import { createHash } from 'node:crypto'

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

const VULTR_API_BASE = 'https://api.vultr.com/v2'
const DEFAULT_OS_ID = 2284 // Ubuntu 24.04 LTS x64 (as of 2026-04)

export type VultrClientOptions = HttpProviderOptions

export class VultrProvider extends HttpProvider implements Provider {
  readonly name = 'vultr' as const
  readonly displayName = 'Vultr'

  constructor(opts: VultrClientOptions) {
    super(opts, { brand: 'Vultr', defaultBaseUrl: VULTR_API_BASE })
  }

  // ─── Auth ─────────────────────────────────────────────────────

  async authenticate(_token: string): Promise<Account> {
    const data = await this.request<{ account: VultrAccount }>(
      'GET',
      '/account',
    )
    return {
      id: data.account.email || 'vultr-unknown',
      name: data.account.name || data.account.email,
      email: data.account.email,
    }
  }

  // ─── Discovery ────────────────────────────────────────────────

  async listSizes(region?: string): Promise<readonly Size[]> {
    const data = await this.request<PaginatedPlans>(
      'GET',
      '/plans?per_page=500',
    )
    const sizes = data.plans.map(toSize)
    if (region) {
      return sizes.filter((s) => s.availableInRegions.includes(region))
    }
    return sizes
  }

  async listRegions(): Promise<readonly Region[]> {
    const data = await this.request<PaginatedRegions>(
      'GET',
      '/regions?per_page=500',
    )
    return data.regions.map(toRegion)
  }

  // ─── SSH keys ────────────────────────────────────────────────

  async uploadSSHKey(opts: SSHKeyOptions): Promise<SSHKey> {
    const data = await this.request<{ ssh_key: VultrSSHKey }>(
      'POST',
      '/ssh-keys',
      { name: opts.name, ssh_key: opts.publicKey },
    )
    return toSSHKey(data.ssh_key)
  }

  async listSSHKeys(): Promise<readonly SSHKey[]> {
    const data = await this.request<PaginatedSSHKeys>(
      'GET',
      '/ssh-keys?per_page=500',
    )
    return data.ssh_keys.map(toSSHKey)
  }

  async deleteSSHKey(id: string): Promise<void> {
    await this.request('DELETE', `/ssh-keys/${encodeURIComponent(id)}`)
  }

  // ─── VPS lifecycle ───────────────────────────────────────────

  async createVPS(opts: ProvisionOptions): Promise<VPS> {
    // `opts.image` is a cross-provider string. For Vultr we need a
    // numeric os_id — accept a numeric string override, otherwise
    // default to the baked-in Ubuntu 24.04 LTS ID.
    const osId =
      opts.image !== undefined && /^\d+$/.test(opts.image)
        ? Number.parseInt(opts.image, 10)
        : DEFAULT_OS_ID

    const body: Record<string, unknown> = {
      region: opts.region,
      plan: opts.size,
      label: opts.name,
      os_id: osId,
      sshkey_id: opts.sshKeyIds,
      // Dedupe — bootstrap passes labels including `'managed-by':
      // 'groundflare'`, whose value would collide with the prepended
      // marker tag. Vultr accepts duplicates today but the Set keeps
      // the payload honest (and matches the Linode fix in 910bf74).
      tags: [...new Set(['groundflare', ...Object.values(opts.labels ?? {})])],
    }
    if (opts.userData !== undefined) {
      // Vultr expects base64-encoded user_data at the top level of
      // the create body, not wrapped in `metadata.user_data` like
      // Linode.
      body.user_data = Buffer.from(opts.userData, 'utf-8').toString('base64')
    }

    const data = await this.request<{ instance: VultrInstance }>(
      'POST',
      '/instances',
      body,
    )
    return toVPS(data.instance)
  }

  async getVPS(id: string): Promise<VPS | null> {
    try {
      const data = await this.request<{ instance: VultrInstance }>(
        'GET',
        `/instances/${encodeURIComponent(id)}`,
      )
      return toVPS(data.instance)
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null
      throw err
    }
  }

  async listVPS(): Promise<readonly VPS[]> {
    const data = await this.request<PaginatedInstances>(
      'GET',
      '/instances?per_page=500',
    )
    return data.instances.map(toVPS)
  }

  async destroyVPS(id: string): Promise<void> {
    await this.request('DELETE', `/instances/${encodeURIComponent(id)}`)
  }

  // ─── Pricing ─────────────────────────────────────────────────

  estimateMonthlyCost(opts: { size: string; region: string }): number {
    void opts.region
    return VULTR_PRICE_TABLE.get(opts.size) ?? 0
  }

  // ─── Error translation ───────────────────────────────────────
  //
  // Vultr's envelope is `{"error": "..."}` on most failures, sometimes
  // with a sibling `status` number. Simpler than Linode's
  // `{errors: [...]}` array; we treat the whole string as the human
  // message and use HTTP status as the code.
  protected parseError(body: unknown): { code: string; message: string } {
    if (
      body !== null &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'string'
    ) {
      return {
        code: 'error',
        message: (body as { error: string }).error,
      }
    }
    return { code: 'unknown', message: 'no message' }
  }
}

// ─── Vultr response shapes ────────────────────────────────────────

interface PaginatedPlans {
  plans: VultrPlan[]
}

interface PaginatedRegions {
  regions: VultrRegion[]
}

interface PaginatedSSHKeys {
  ssh_keys: VultrSSHKey[]
}

interface PaginatedInstances {
  instances: VultrInstance[]
}

interface VultrAccount {
  email: string
  name: string
}

interface VultrPlan {
  id: string
  vcpu_count: number
  ram: number          // MB
  disk: number         // GB
  bandwidth: number    // GB
  monthly_cost: number // USD
  type: string
  locations: string[]
}

function toSize(p: VultrPlan): Size {
  return {
    id: p.id,
    name: p.id, // Vultr doesn't return a human-friendly label on plans.
    cpuCores: p.vcpu_count,
    ramGiB: p.ram / 1024,
    diskGiB: p.disk,
    priceMonthlyCents: Math.round(p.monthly_cost * 100),
    egressFreeTb: p.bandwidth > 0 ? p.bandwidth / 1000 : undefined,
    availableInRegions: p.locations,
  }
}

interface VultrRegion {
  id: string
  city: string
  country: string
  continent: string
  options?: string[]
}

function toRegion(r: VultrRegion): Region {
  return {
    id: r.id,
    name: `${r.city}, ${r.country}`,
    country: r.country,
    city: r.city,
  }
}

interface VultrSSHKey {
  id: string
  name: string
  ssh_key: string
  date_created: string
}

function toSSHKey(k: VultrSSHKey): SSHKey {
  return {
    id: k.id,
    name: k.name,
    fingerprint: fingerprintSshKey(k.ssh_key),
  }
}

/**
 * Compute a SHA-256 fingerprint for an OpenSSH-format public key.
 * Vultr (like Linode) doesn't return one, so callers that match keys
 * by fingerprint rely on this. Lowercase hex with colons, matching
 * the `SSHKey.fingerprint` contract.
 */
function fingerprintSshKey(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/)
  if (parts.length < 2) return ''
  const keyData = parts[1]!
  let decoded: Buffer
  try {
    decoded = Buffer.from(keyData, 'base64')
  } catch {
    return ''
  }
  const hash = createHash('sha256').update(decoded).digest()
  return hash.toString('hex').match(/.{2}/g)!.join(':')
}

interface VultrInstance {
  id: string
  main_ip?: string
  v6_main_ip?: string
  status: string            // pending / active / suspended / closed
  power_status?: string     // running / stopped
  plan: string
  region: string
  date_created: string
  label?: string
  tags?: string[]
}

function toVPS(i: VultrInstance): VPS {
  const out: Mutable<VPS> = {
    id: i.id,
    name: i.label ?? '',
    status: mapStatus(i.status, i.power_status),
    size: i.plan,
    region: i.region,
    createdAt: i.date_created,
  }
  // Vultr returns `"0.0.0.0"` for main_ip before the instance boots —
  // strip that sentinel so callers get `undefined` until a real IP
  // lands, matching how DO + Linode report "not yet assigned".
  if (i.main_ip && i.main_ip !== '0.0.0.0') {
    out.publicIPv4 = i.main_ip
  }
  if (i.v6_main_ip && i.v6_main_ip.length > 0 && i.v6_main_ip !== '::') {
    out.publicIPv6 = i.v6_main_ip
  }
  if (i.tags && i.tags.length > 0) {
    out.labels = Object.fromEntries(i.tags.map((t) => [t, '']))
  }
  return out as VPS
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Vultr reports two status fields. `status` tracks the subscription
 * lifecycle (paid, active, cancelled); `power_status` tracks whether
 * the server is turned on. Combining them gives the VPSStatus our
 * interface promises — both are needed because `active + stopped`
 * and `active + running` are very different states.
 */
function mapStatus(status: string, powerStatus?: string): VPSStatus {
  if (status === 'pending') return 'initializing'
  if (status === 'active') {
    if (powerStatus === 'running') return 'running'
    if (powerStatus === 'stopped') return 'stopped'
    // Active but no power_status yet = still booting from the API's
    // perspective.
    return 'initializing'
  }
  if (status === 'suspended' || status === 'closed') return 'unknown'
  return 'unknown'
}

// ─── Static price table (USD cents/month) ─────────────────────────
//
// Snapshot of common Vultr Cloud Compute (vc2) shared-CPU tiers.
// Refreshed manually; estimateMonthlyCost returns 0 for sizes not
// listed so callers can treat 0 as "no quote".
const VULTR_PRICE_TABLE = new Map<string, number>([
  ['vc2-1c-1gb', 600],
  ['vc2-1c-2gb', 1200],
  ['vc2-2c-2gb', 1800],
  ['vc2-2c-4gb', 2400],
  ['vc2-4c-8gb', 4800],
  ['vc2-6c-16gb', 9600],
  ['vc2-8c-32gb', 19200],
])
