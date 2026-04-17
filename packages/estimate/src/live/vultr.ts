/**
 * Live Vultr pricing fetch via `GET /v2/plans`.
 *
 * Closest to DigitalOcean's shape — prices are embedded in the plan
 * catalog and response is paginated via `{plans, meta}`. We set
 * per_page=500 which covers every published plan in one request.
 *
 *   {
 *     "plans": [
 *       {
 *         "id": "vc2-2c-4gb",
 *         "vcpu_count": 2,
 *         "ram": 4096,       // MB
 *         "disk": 80,        // GB
 *         "bandwidth": 3000, // GB
 *         "monthly_cost": 24,
 *         "type": "vc2",
 *         "locations": ["atl", "ewr", ...]
 *       },
 *       ...
 *     ],
 *     "meta": { "total": N }
 *   }
 *
 * Auth: Bearer API key. Prices already USD — no FX conversion.
 *
 * Note: Vultr's per-key IP allowlist may reject this request even when
 * the key is otherwise valid. `GET /v2/plans` is a read endpoint and
 * usually reachable without allowlist, but some account configurations
 * still block it. The resulting 401 surfaces as
 * LinodePricingError(auth) and refreshPrices falls back to baked.
 */

import type { VPSTierSpec } from '../types.js'

const VULTR_PLANS_URL = 'https://api.vultr.com/v2/plans?per_page=500'

/**
 * Tiers the estimate package ships size metadata for. Refresh the
 * baked table in prices.ts when this changes; the fetcher only
 * overrides tiers the baked table already knows about.
 */
const KNOWN_PLANS: ReadonlySet<string> = new Set([
  'vc2-1c-1gb',
  'vc2-1c-2gb',
  'vc2-2c-2gb',
  'vc2-2c-4gb',
  'vc2-4c-8gb',
  'vc2-6c-16gb',
  'vc2-8c-32gb',
])

interface VultrPlansResponse {
  plans: readonly VultrPlan[]
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

export class VultrPricingError extends Error {
  constructor(
    message: string,
    public readonly code: 'auth' | 'network' | 'parse' | 'shape',
    options?: { cause?: unknown },
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'VultrPricingError'
  }
}

export interface FetchVultrPricingOptions {
  readonly token: string
  readonly fetchImpl?: typeof fetch
  readonly signal?: AbortSignal
}

export interface VultrLivePrices {
  readonly tiers: Partial<Record<string, VPSTierSpec>>
  readonly fetchedAt: string
}

export async function fetchVultrPricing(
  opts: FetchVultrPricingOptions,
): Promise<VultrLivePrices> {
  const fetchFn = opts.fetchImpl ?? fetch

  let res: Response
  try {
    res = await fetchFn(VULTR_PLANS_URL, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/json',
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    throw new VultrPricingError(
      `network error talking to Vultr: ${err instanceof Error ? err.message : String(err)}`,
      'network',
      { cause: err },
    )
  }

  if (res.status === 401 || res.status === 403) {
    throw new VultrPricingError(
      `Vultr rejected the token (HTTP ${res.status}) — ` +
        `note that Vultr keys have per-key IP allowlists; update the ` +
        `list in the Vultr dashboard if your source IP changed`,
      'auth',
    )
  }
  if (!res.ok) {
    throw new VultrPricingError(
      `Vultr /v2/plans returned HTTP ${res.status}`,
      'network',
    )
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    throw new VultrPricingError('failed to parse Vultr JSON', 'parse', { cause: err })
  }

  if (!isPlansResponse(body)) {
    throw new VultrPricingError('Vultr response missing plans array', 'shape')
  }

  const tiers: Partial<Record<string, VPSTierSpec>> = {}
  for (const p of body.plans) {
    if (!KNOWN_PLANS.has(p.id)) continue
    tiers[p.id] = {
      price: p.monthly_cost,
      vcpu: p.vcpu_count,
      ram_gb: p.ram / 1024,
      disk_gb: p.disk,
      traffic_tb: p.bandwidth / 1000,
    }
  }

  return { tiers, fetchedAt: new Date().toISOString() }
}

function isPlansResponse(v: unknown): v is VultrPlansResponse {
  if (typeof v !== 'object' || v === null) return false
  return Array.isArray((v as { plans?: unknown }).plans)
}
