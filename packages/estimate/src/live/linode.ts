/**
 * Live Linode pricing fetch via `GET /v4/linode/types`.
 *
 * Linode embeds pricing alongside the type catalog (no separate /pricing
 * endpoint), so the shape is closest to DigitalOcean's /v2/sizes fetcher.
 * Response is paginated with `{data, page, pages, results}`; page_size=100
 * comfortably fits every published type in a single request.
 *
 *   {
 *     "data": [
 *       {
 *         "id": "g6-standard-2",
 *         "label": "Linode 4GB",
 *         "vcpus": 2,
 *         "memory": 4096,     // MB
 *         "disk": 81920,      // MB
 *         "transfer": 4000,   // GB
 *         "price": { "hourly": 0.036, "monthly": 24 },
 *         "class": "standard"
 *       },
 *       ...
 *     ],
 *     "page": 1, "pages": 1, "results": N
 *   }
 *
 * Auth: Bearer PAT. Prices are already in USD — no FX conversion.
 * Egress overage: Linode charges a flat $0.005/GB outbound above plan
 * allowance. The /linode/types response doesn't expose this rate, so
 * we rely on the baked `extras.linode_egress_overage_per_tb`.
 */

import type { VPSTierSpec } from '../types.js'

const LINODE_TYPES_URL = 'https://api.linode.com/v4/linode/types?page_size=100'

/**
 * Tiers the estimate package ships size metadata for. Refresh the baked
 * table in prices.ts when this changes; the fetcher only overrides
 * tiers the baked table already knows about.
 */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'g6-nanode-1',
  'g6-standard-1',
  'g6-standard-2',
  'g6-standard-4',
  'g6-standard-6',
  'g6-dedicated-2',
  'g6-dedicated-4',
])

interface LinodeTypesResponse {
  data: readonly LinodeType[]
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
}

export class LinodePricingError extends Error {
  constructor(
    message: string,
    public readonly code: 'auth' | 'network' | 'parse' | 'shape',
    options?: { cause?: unknown },
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'LinodePricingError'
  }
}

export interface FetchLinodePricingOptions {
  readonly token: string
  readonly fetchImpl?: typeof fetch
  readonly signal?: AbortSignal
}

export interface LinodeLivePrices {
  readonly tiers: Partial<Record<string, VPSTierSpec>>
  readonly fetchedAt: string
}

export async function fetchLinodePricing(
  opts: FetchLinodePricingOptions,
): Promise<LinodeLivePrices> {
  const fetchFn = opts.fetchImpl ?? fetch

  let res: Response
  try {
    res = await fetchFn(LINODE_TYPES_URL, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/json',
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    throw new LinodePricingError(
      `network error talking to Linode: ${err instanceof Error ? err.message : String(err)}`,
      'network',
      { cause: err },
    )
  }

  if (res.status === 401 || res.status === 403) {
    throw new LinodePricingError(
      `Linode rejected the token (HTTP ${res.status})`,
      'auth',
    )
  }
  if (!res.ok) {
    throw new LinodePricingError(
      `Linode /v4/linode/types returned HTTP ${res.status}`,
      'network',
    )
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    throw new LinodePricingError('failed to parse Linode JSON', 'parse', { cause: err })
  }

  if (!isTypesResponse(body)) {
    throw new LinodePricingError('Linode response missing data array', 'shape')
  }

  const tiers: Partial<Record<string, VPSTierSpec>> = {}
  for (const t of body.data) {
    if (!KNOWN_TYPES.has(t.id)) continue
    // Linode reports memory and disk in MB; estimate.VPSTierSpec expects
    // GB. `transfer` is already in GB but we store it as TB to match the
    // other providers' traffic_tb field.
    tiers[t.id] = {
      price: t.price.monthly,
      vcpu: t.vcpus,
      ram_gb: t.memory / 1024,
      disk_gb: Math.round(t.disk / 1024),
      traffic_tb: t.transfer / 1000,
    }
  }

  return { tiers, fetchedAt: new Date().toISOString() }
}

function isTypesResponse(v: unknown): v is LinodeTypesResponse {
  if (typeof v !== 'object' || v === null) return false
  return Array.isArray((v as { data?: unknown }).data)
}
