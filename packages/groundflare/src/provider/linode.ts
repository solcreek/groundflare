/**
 * Linode (Akamai Cloud) provider implementation.
 *
 * API reference: https://techdocs.akamai.com/linode-api/reference/
 *
 * Follows the HttpProvider pattern established by Hetzner + DigitalOcean.
 * Linode-isms worth knowing:
 *
 *   - Error envelope is `{ errors: [{ field?, reason }] }` — flatter than
 *     Hetzner's `.error.{code,message}` or DO's `.{id,message}`.
 *     `field` identifies the offending input; we concatenate reasons for
 *     the human-readable message.
 *   - Instance creation takes **public-key strings** via `authorized_keys`,
 *     not SSH key IDs. We fetch each ID's `ssh_key` content up front so
 *     the interface stays ID-based for callers.
 *   - `user_data` is passed via `metadata.user_data`, base64-encoded.
 *     Instance types / regions that don't support the Metadata Service
 *     will 400 here — fail loud beats silent.
 *   - Linode doesn't expose an SSH-key fingerprint; we compute one
 *     client-side (SHA-256 of the base64-decoded key material, hex with
 *     colons — matches the `SSHKey.fingerprint` contract).
 *   - `ipv6` arrives as `"2001:db8::1/128"`; strip the CIDR suffix before
 *     returning to callers that just want a connectable address.
 *
 * Out of scope for v0.1: pagination follow-through (we set page_size=100),
 * tag-based filtering on listVPS, Volumes, NodeBalancers, VLANs.
 */

import { createHash, randomBytes } from 'node:crypto'

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

const LINODE_API_BASE = 'https://api.linode.com/v4'
const DEFAULT_IMAGE = 'linode/ubuntu24.04'

export type LinodeClientOptions = HttpProviderOptions

export class LinodeProvider extends HttpProvider implements Provider {
  readonly name = 'linode' as const
  readonly displayName = 'Linode (Akamai Cloud)'

  constructor(opts: LinodeClientOptions) {
    super(opts, { brand: 'Linode', defaultBaseUrl: LINODE_API_BASE })
  }

  // ─── Auth ─────────────────────────────────────────────────────

  async authenticate(_token: string): Promise<Account> {
    const data = await this.request<LinodeAccount>('GET', '/account')
    return {
      id: data.email || 'linode-unknown',
      name: `${data.first_name ?? ''} ${data.last_name ?? ''}`.trim() || data.email,
      email: data.email,
    }
  }

  // ─── Discovery ────────────────────────────────────────────────

  async listSizes(region?: string): Promise<readonly Size[]> {
    const data = await this.request<PaginatedResponse<LinodeType>>(
      'GET',
      '/linode/types?page_size=100',
    )
    const sizes = data.data.map((t) => toSize(t, region))
    if (region) {
      // Linode doesn't return per-type region availability in /linode/types.
      // Cross-reference with /regions to find which types are available.
      const regions = await this.request<PaginatedResponse<LinodeRegion>>(
        'GET',
        '/regions?page_size=100',
      )
      const match = regions.data.find((r) => r.id === region)
      if (!match) return []
      // A region lists capabilities, not specific type IDs. All standard
      // Linode types are available in every region that has the
      // "Linodes" capability — so if that capability is present, all
      // sizes are available.
      const hasLinodes = match.capabilities.some(
        (c) => c.toLowerCase() === 'linodes',
      )
      return hasLinodes ? sizes : []
    }
    return sizes
  }

  async listRegions(): Promise<readonly Region[]> {
    const data = await this.request<PaginatedResponse<LinodeRegion>>(
      'GET',
      '/regions?page_size=100',
    )
    return data.data
      .filter((r) => r.status === 'ok')
      .filter((r) => r.capabilities.some((c) => c.toLowerCase() === 'linodes'))
      .map(toRegion)
  }

  // ─── SSH keys ────────────────────────────────────────────────

  async uploadSSHKey(opts: SSHKeyOptions): Promise<SSHKey> {
    const data = await this.request<LinodeSSHKey>(
      'POST',
      '/profile/sshkeys',
      { label: opts.name, ssh_key: opts.publicKey },
    )
    return toSSHKey(data)
  }

  async listSSHKeys(): Promise<readonly SSHKey[]> {
    const data = await this.request<PaginatedResponse<LinodeSSHKey>>(
      'GET',
      '/profile/sshkeys?page_size=100',
    )
    return data.data.map(toSSHKey)
  }

  async deleteSSHKey(id: string): Promise<void> {
    await this.request('DELETE', `/profile/sshkeys/${encodeURIComponent(id)}`)
  }

  // ─── VPS lifecycle ───────────────────────────────────────────

  async createVPS(opts: ProvisionOptions): Promise<VPS> {
    // Linode takes public-key strings, not IDs. Fetch each key's content
    // up front. Typical groundflare deploys have one key, so this is a
    // single extra roundtrip.
    const authorizedKeys = await Promise.all(
      opts.sshKeyIds.map(async (id) => {
        const key = await this.request<LinodeSSHKey>(
          'GET',
          `/profile/sshkeys/${encodeURIComponent(id)}`,
        )
        return key.ssh_key
      }),
    )

    const body: Record<string, unknown> = {
      type: opts.size,
      region: opts.region,
      label: opts.name,
      image: opts.image ?? DEFAULT_IMAGE,
      authorized_keys: authorizedKeys,
      // Linode's POST /linode/instances requires `root_pass` even when
      // SSH keys are provided via `authorized_keys` — the docs mark it
      // optional, the API rejects with `400 root_pass is required` if
      // absent. We generate a strong throwaway (32 base64url chars)
      // and never surface it: cloud-init disables password auth as
      // part of the standard groundflare user-data, and no caller has
      // a path to recover this value. If you need VPS console access
      // after the fact, reset the root password from the Linode
      // dashboard.
      root_pass: `gf-${randomBytes(24).toString('base64url')}`,
      // Dedupe: Linode strictly rejects `tags` arrays that contain the
      // same value twice ("Tag N is a duplicate tag"). The caller's
      // `labels` can legitimately include a value that collides with
      // the mandatory 'groundflare' marker — e.g. bootstrap passes
      // `{ 'managed-by': 'groundflare', workspace: <name> }` and
      // `Object.values` yields `['groundflare', <name>]`. Pass through
      // a Set so order is preserved but duplicates are dropped.
      tags: [
        ...new Set(['groundflare', ...Object.values(opts.labels ?? {})]),
      ],
    }
    if (opts.userData !== undefined) {
      body.metadata = {
        user_data: Buffer.from(opts.userData, 'utf-8').toString('base64'),
      }
    }

    const data = await this.request<LinodeInstance>(
      'POST',
      '/linode/instances',
      body,
    )
    return toVPS(data)
  }

  async getVPS(id: string): Promise<VPS | null> {
    try {
      const data = await this.request<LinodeInstance>(
        'GET',
        `/linode/instances/${encodeURIComponent(id)}`,
      )
      return toVPS(data)
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null
      throw err
    }
  }

  async listVPS(): Promise<readonly VPS[]> {
    const data = await this.request<PaginatedResponse<LinodeInstance>>(
      'GET',
      '/linode/instances?page_size=100',
    )
    return data.data.map(toVPS)
  }

  async destroyVPS(id: string): Promise<void> {
    await this.request('DELETE', `/linode/instances/${encodeURIComponent(id)}`)
  }

  // ─── Pricing ─────────────────────────────────────────────────

  estimateMonthlyCost(opts: { size: string; region: string }): number {
    void opts.region
    return LINODE_PRICE_TABLE.get(opts.size) ?? 0
  }

  // ─── Error translation ───────────────────────────────────────
  //
  // Linode returns `{ errors: [{ field?, reason }] }`. We surface the
  // first error's field as the code (or `error` if no field) and
  // concatenate all reasons into the message.
  protected parseError(body: unknown): { code: string; message: string } {
    if (
      body !== null &&
      typeof body === 'object' &&
      'errors' in body &&
      Array.isArray((body as { errors: unknown }).errors)
    ) {
      const errors = (body as { errors: Array<{ field?: string; reason: string }> }).errors
      if (errors.length > 0) {
        const first = errors[0]!
        const code = first.field ?? 'error'
        const message = errors.map((e) => e.reason).join('; ')
        return { code, message }
      }
    }
    return { code: 'unknown', message: 'no message' }
  }
}

// ─── Linode response shapes ───────────────────────────────────────

interface PaginatedResponse<T> {
  data: T[]
  page: number
  pages: number
  results: number
}

interface LinodeAccount {
  email: string
  first_name?: string
  last_name?: string
  company?: string
}

interface LinodeType {
  id: string
  label: string
  vcpus: number
  memory: number      // MB
  disk: number        // MB
  transfer: number    // GB
  price: { hourly: number; monthly: number }
  class?: string
  network_out?: number
}

function toSize(t: LinodeType, _region?: string): Size {
  return {
    id: t.id,
    name: t.label,
    cpuCores: t.vcpus,
    ramGiB: t.memory / 1024,
    diskGiB: t.disk / 1024,
    priceMonthlyCents: Math.round(t.price.monthly * 100),
    egressFreeTb: t.transfer > 0 ? t.transfer / 1000 : undefined,
    // Linode doesn't advertise per-type region availability on the
    // /linode/types endpoint; callers filter using /regions separately.
    availableInRegions: [],
  }
}

interface LinodeRegion {
  id: string
  country: string
  label: string
  capabilities: string[]
  status: string
}

function toRegion(r: LinodeRegion): Region {
  return {
    id: r.id,
    name: r.label,
    country: r.country,
  }
}

interface LinodeSSHKey {
  id: number
  label: string
  ssh_key: string
  created: string
}

function toSSHKey(k: LinodeSSHKey): SSHKey {
  return {
    id: String(k.id),
    name: k.label,
    fingerprint: fingerprintSshKey(k.ssh_key),
  }
}

/**
 * Compute a SHA-256 fingerprint for an OpenSSH-format public key.
 * Linode doesn't return one, so callers that need to match keys by
 * fingerprint (audit log, key-rotation detection) rely on this.
 *
 * Output format matches the `SSHKey.fingerprint` contract: lowercase
 * hex with colons, e.g. `ab:cd:ef:...` (64 hex chars, 32 pairs).
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

interface LinodeInstance {
  id: number
  label: string
  region: string
  type: string
  status: string
  created: string
  ipv4?: string[]
  ipv6?: string | null
  tags?: string[]
}

function toVPS(i: LinodeInstance): VPS {
  const out: Mutable<VPS> = {
    id: String(i.id),
    name: i.label,
    status: mapStatus(i.status),
    size: i.type,
    region: i.region,
    createdAt: i.created,
  }
  // Linode's ipv4 array mixes public + private (e.g. 192.168.*). Find
  // the first non-private IPv4; fall back to the first entry if we
  // can't tell them apart.
  if (i.ipv4 && i.ipv4.length > 0) {
    out.publicIPv4 = i.ipv4.find((ip) => !isPrivateIPv4(ip)) ?? i.ipv4[0]!
  }
  if (i.ipv6) {
    // Linode returns "2001:db8::1/128" — strip the CIDR suffix.
    out.publicIPv6 = i.ipv6.split('/')[0]!
  }
  if (i.tags && i.tags.length > 0) {
    out.labels = Object.fromEntries(i.tags.map((t) => [t, '']))
  }
  return out as VPS
}

function isPrivateIPv4(ip: string): boolean {
  // RFC 1918 ranges. Linode also uses 192.168.x for private networking.
  return (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  )
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function mapStatus(raw: string): VPSStatus {
  switch (raw) {
    case 'provisioning':
    case 'booting':
      return 'initializing'
    case 'running':
      return 'running'
    case 'offline':
    case 'shutting_down':
    case 'rebooting':
      return 'stopped'
    case 'deleting':
      return 'deleting'
    default:
      return 'unknown'
  }
}

// ─── Static price table (USD cents/month) ─────────────────────────
//
// Snapshot of common Linode shared- and dedicated-CPU tiers. Refreshed
// manually; estimateMonthlyCost returns 0 for sizes not listed so
// callers can treat 0 as "no quote".
const LINODE_PRICE_TABLE = new Map<string, number>([
  ['g6-nanode-1', 500],
  ['g6-standard-1', 1200],
  ['g6-standard-2', 2400],
  ['g6-standard-4', 4800],
  ['g6-standard-6', 9600],
  ['g6-standard-8', 19200],
  ['g6-dedicated-2', 3600],
  ['g6-dedicated-4', 7200],
  ['g6-dedicated-8', 14400],
])
