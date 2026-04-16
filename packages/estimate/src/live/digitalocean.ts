/**
 * Live DigitalOcean pricing fetch via GET /v2/sizes.
 *
 * DO embeds pricing in the sizes catalog (no dedicated /pricing endpoint).
 * Requires a Bearer PAT. Prices are already in USD — no FX conversion.
 */

import type { VPSTierSpec } from '../types.js'

const DO_SIZES_URL = 'https://api.digitalocean.com/v2/sizes?per_page=200'

const KNOWN_SLUGS: ReadonlySet<string> = new Set([
  's-1vcpu-512mb-10gb',
  's-1vcpu-1gb',
  's-1vcpu-2gb',
  's-2vcpu-2gb',
  's-2vcpu-4gb',
  's-4vcpu-8gb',
  's-8vcpu-16gb',
  'c-2',
  'c-4',
])

interface DOSizeResponse {
  sizes: readonly DOSize[]
}

interface DOSize {
  slug: string
  vcpus: number
  memory: number       // MB
  disk: number         // GB
  transfer: number     // TB
  price_monthly: number
  available: boolean
}

export class DOPricingError extends Error {
  constructor(
    message: string,
    public readonly code: 'auth' | 'network' | 'parse' | 'shape',
    options?: { cause?: unknown },
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'DOPricingError'
  }
}

export interface FetchDOPricingOptions {
  readonly token: string
  readonly fetchImpl?: typeof fetch
  readonly signal?: AbortSignal
}

export interface DOLivePrices {
  readonly tiers: Partial<Record<string, VPSTierSpec>>
  readonly fetchedAt: string
}

export async function fetchDOPricing(
  opts: FetchDOPricingOptions,
): Promise<DOLivePrices> {
  const fetchFn = opts.fetchImpl ?? fetch

  let res: Response
  try {
    res = await fetchFn(DO_SIZES_URL, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/json',
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    throw new DOPricingError(
      `network error talking to DigitalOcean: ${err instanceof Error ? err.message : String(err)}`,
      'network',
      { cause: err },
    )
  }

  if (res.status === 401 || res.status === 403) {
    throw new DOPricingError(
      `DigitalOcean rejected the token (HTTP ${res.status})`,
      'auth',
    )
  }
  if (!res.ok) {
    throw new DOPricingError(
      `DigitalOcean /v2/sizes returned HTTP ${res.status}`,
      'network',
    )
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    throw new DOPricingError('failed to parse DO JSON', 'parse', { cause: err })
  }

  if (!isSizesResponse(body)) {
    throw new DOPricingError('DO response missing sizes array', 'shape')
  }

  const tiers: Partial<Record<string, VPSTierSpec>> = {}
  for (const s of body.sizes) {
    if (!s.available || !KNOWN_SLUGS.has(s.slug)) continue
    tiers[s.slug] = {
      price: s.price_monthly,
      vcpu: s.vcpus,
      ram_gb: s.memory / 1024,
      disk_gb: s.disk,
      traffic_tb: s.transfer,
    }
  }

  return { tiers, fetchedAt: new Date().toISOString() }
}

function isSizesResponse(v: unknown): v is DOSizeResponse {
  if (typeof v !== 'object' || v === null) return false
  return Array.isArray((v as { sizes?: unknown }).sizes)
}
