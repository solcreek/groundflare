/**
 * refreshPrices — try to pull live prices for each provider the user has
 * configured, merge them over the baked fallback, and return the final
 * table alongside per-provider source metadata. Failures never fatal:
 * worst case we hand back the baked table and note why.
 */

import type { SecretStore } from '../../secret/index.js'
import type { HetznerTier, PriceSource, Prices } from '../types.js'

import { fetchHetznerPricing, HetznerPricingError } from './hetzner.js'

export { fetchHetznerPricing, HetznerPricingError } from './hetzner.js'
export type { FetchHetznerOptions, HetznerLivePrices } from './hetzner.js'

export interface RefreshPricesOptions {
  readonly baked: Prices
  readonly secrets: SecretStore
  /** Skip live fetch entirely (e.g. CLI --no-live flag). */
  readonly disableLive?: boolean
  /** For tests. Passed through to each provider fetcher. */
  readonly fetchImpl?: typeof fetch
}

export interface RefreshedPrices {
  readonly prices: Prices
  readonly sources: readonly PriceSource[]
}

export async function refreshPrices(
  opts: RefreshPricesOptions,
): Promise<RefreshedPrices> {
  const sources: PriceSource[] = []
  let prices = opts.baked

  if (opts.disableLive === true) {
    sources.push({ provider: 'hetzner', kind: 'baked', reason: 'live disabled' })
    return { prices, sources }
  }

  const hetznerToken = await opts.secrets.get('provider.hetzner.token')
  if (hetznerToken === null || hetznerToken.length === 0) {
    sources.push({ provider: 'hetzner', kind: 'baked', reason: 'no token configured' })
    return { prices, sources }
  }

  try {
    const live = await fetchHetznerPricing({
      token: hetznerToken,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    })
    prices = mergeHetznerLive(prices, live.tiers, live.egressOverageUsdPerTb)
    sources.push({
      provider: 'hetzner',
      kind: 'live',
      fetchedAt: live.fetchedAt,
    })
  } catch (err) {
    const reason =
      err instanceof HetznerPricingError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err)
    sources.push({ provider: 'hetzner', kind: 'baked', reason })
  }

  return { prices, sources }
}

function mergeHetznerLive(
  baked: Prices,
  liveTiers: Partial<Record<HetznerTier, { price: number; traffic_tb: number }>>,
  egressUsdPerTb: number,
): Prices {
  const hetzner = { ...baked.hetzner }
  for (const [tier, live] of Object.entries(liveTiers) as [
    HetznerTier,
    { price: number; traffic_tb: number },
  ][]) {
    // Preserve vcpu/ram/disk from baked (not in /v1/pricing), override
    // price + included traffic from live.
    hetzner[tier] = {
      ...baked.hetzner[tier],
      price: live.price,
      traffic_tb: live.traffic_tb,
    }
  }
  const extras =
    egressUsdPerTb > 0
      ? { ...baked.extras, hetzner_egress_overage_per_tb: egressUsdPerTb }
      : baked.extras
  return { ...baked, hetzner, extras }
}
