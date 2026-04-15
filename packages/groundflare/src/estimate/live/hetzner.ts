/**
 * Live Hetzner pricing fetch via `GET /v1/pricing`.
 *
 * Response shape follows Hetzner's documented schema (confirmed against
 * github.com/hetznercloud/hcloud-go/hcloud/schema/pricing.go):
 *
 *   {
 *     "pricing": {
 *       "currency": "EUR",
 *       "vat_rate": "19.00",
 *       "server_types": [
 *         {
 *           "id": 22, "name": "cx22",
 *           "prices": [{
 *             "location": "fsn1",
 *             "price_monthly": { "net": "4.5100", "gross": "5.3669" },
 *             "included_traffic": 21990232555520,
 *             "price_per_tb_traffic": { "net": "1.0000", "gross": "1.1900" }
 *           }, ...]
 *         }
 *       ]
 *     }
 *   }
 *
 * Auth: Bearer token (any customer project token). The endpoint rejects
 * unauthenticated requests with 401 "token is required".
 *
 * Currency: Hetzner serves EUR. We convert to USD at a fixed rate here
 * so the Estimate output stays in one currency. The rate is a
 * rough constant — acceptable for a cost comparison that's already
 * labelled as an estimate; precise FX belongs in a separate path.
 */

import type { HetznerTier, HetznerTierSpec } from '../types.js'

const HETZNER_PRICING_URL = 'https://api.hetzner.cloud/v1/pricing'
/** Approximate EUR→USD. Update with a real FX source if precision matters. */
const EUR_TO_USD = 1.07
// Hetzner's "20 TB included" is actually 20 TiB (1024⁴ bytes). Their UI
// labels it "TB" per colloquial convention, but the API returns the
// binary value. We divide by 1024⁴ so our display matches theirs.
const BYTES_PER_TB = 1024 ** 4
/** Tiers we currently ship size metadata for. */
const KNOWN_TIERS: readonly HetznerTier[] = ['cx22', 'cx32', 'cx42', 'cx52']

// ─── API response shape ────────────────────────────────────────────
interface PricingApiResponse {
  pricing: {
    currency: string
    server_types: readonly PricingServerType[]
  }
}
interface PricingServerType {
  id: number
  name: string
  prices: readonly PricingServerTypePrice[]
}
interface PricingServerTypePrice {
  location: string
  price_monthly: { net: string; gross: string }
  included_traffic: number // bytes
  price_per_tb_traffic: { net: string; gross: string }
}

// ─── Public API ────────────────────────────────────────────────────

export class HetznerPricingError extends Error {
  constructor(
    message: string,
    public readonly code: 'auth' | 'network' | 'parse' | 'shape',
    options?: { cause?: unknown },
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'HetznerPricingError'
  }
}

export interface FetchHetznerOptions {
  /** Bearer token. Any Hetzner project token works — read-only is fine. */
  readonly token: string
  /** Override for tests. Must match `fetch`'s signature. */
  readonly fetchImpl?: typeof fetch
  /** Override EUR→USD conversion for tests. */
  readonly eurToUsd?: number
  /** Override `AbortSignal` for cancellation/tests. */
  readonly signal?: AbortSignal
}

export interface HetznerLivePrices {
  /** Fetched tier overrides, keyed by tier name. */
  readonly tiers: Partial<Record<HetznerTier, HetznerTierSpec>>
  /** Egress overage per TB, in USD (converted from EUR). */
  readonly egressOverageUsdPerTb: number
  /** ISO timestamp of the fetch. */
  readonly fetchedAt: string
}

export async function fetchHetznerPricing(
  opts: FetchHetznerOptions,
): Promise<HetznerLivePrices> {
  const fetchFn = opts.fetchImpl ?? fetch
  const fx = opts.eurToUsd ?? EUR_TO_USD

  let res: Response
  try {
    res = await fetchFn(HETZNER_PRICING_URL, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/json',
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    throw new HetznerPricingError(
      `network error talking to Hetzner: ${err instanceof Error ? err.message : String(err)}`,
      'network',
      { cause: err },
    )
  }

  if (res.status === 401 || res.status === 403) {
    throw new HetznerPricingError(
      `Hetzner rejected the token (HTTP ${res.status}); rotate it via \`groundflare secret set provider.hetzner.token <new>\``,
      'auth',
    )
  }
  if (!res.ok) {
    throw new HetznerPricingError(
      `Hetzner /v1/pricing returned HTTP ${res.status}`,
      'network',
    )
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    throw new HetznerPricingError(`failed to parse Hetzner JSON`, 'parse', { cause: err })
  }

  if (!isPricingApiResponse(body)) {
    throw new HetznerPricingError(
      `Hetzner response did not match the expected pricing shape`,
      'shape',
    )
  }

  const byName = new Map<string, PricingServerType>()
  for (const st of body.pricing.server_types) byName.set(st.name, st)

  const tiers: Partial<Record<HetznerTier, HetznerTierSpec>> = {}
  let maxPricePerTbEur = 0
  for (const tierName of KNOWN_TIERS) {
    const server = byName.get(tierName)
    if (server === undefined) continue
    const firstPrice = server.prices[0]
    if (firstPrice === undefined) continue

    const monthlyEur = parseMoney(firstPrice.price_monthly.net)
    if (monthlyEur === null) continue
    const overagePerTbEur = parseMoney(firstPrice.price_per_tb_traffic.net)
    if (overagePerTbEur !== null && overagePerTbEur > maxPricePerTbEur) {
      maxPricePerTbEur = overagePerTbEur
    }

    // Only override price + traffic; keep the local vcpu/ram/disk numbers
    // since the /pricing endpoint doesn't include them (they live in
    // /v1/server_types and are stable anyway).
    tiers[tierName] = {
      // These three fields are filled in by the merge step later from the
      // baked table; we leave placeholders here and let the caller merge.
      vcpu: 0,
      ram_gb: 0,
      disk_gb: 0,
      price: round(monthlyEur * fx, 2),
      traffic_tb: Math.round(firstPrice.included_traffic / BYTES_PER_TB),
    }
  }

  return {
    tiers,
    egressOverageUsdPerTb: round(maxPricePerTbEur * fx, 2),
    fetchedAt: new Date().toISOString(),
  }
}

// ─── helpers ───────────────────────────────────────────────────────

function parseMoney(s: string): number | null {
  if (typeof s !== 'string') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function round(n: number, digits: number): number {
  const m = 10 ** digits
  return Math.round(n * m) / m
}

function isPricingApiResponse(v: unknown): v is PricingApiResponse {
  if (typeof v !== 'object' || v === null) return false
  const o = v as { pricing?: unknown }
  if (typeof o.pricing !== 'object' || o.pricing === null) return false
  const p = o.pricing as { server_types?: unknown }
  return Array.isArray(p.server_types)
}
