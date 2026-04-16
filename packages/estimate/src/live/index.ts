/**
 * refreshPrices — try to pull live prices for each provider the user has
 * configured, merge them over the baked fallback, and return the final
 * table alongside per-provider source metadata. Failures never fatal:
 * worst case we hand back the baked table and note why.
 */

import type { SecretReader } from '../secrets.js'
import type { PriceSource, Prices, VPSTierSpec } from '../types.js'

import { fetchDOPricing, DOPricingError } from './digitalocean.js'
import { fetchHetznerPricing, HetznerPricingError } from './hetzner.js'

export { fetchDOPricing, DOPricingError } from './digitalocean.js'
export type { FetchDOPricingOptions, DOLivePrices } from './digitalocean.js'
export { fetchHetznerPricing, HetznerPricingError } from './hetzner.js'
export type { FetchHetznerOptions, HetznerLivePrices } from './hetzner.js'

export interface RefreshPricesOptions {
  readonly baked: Prices
  readonly secrets: SecretReader
  readonly disableLive?: boolean
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
    sources.push({ provider: 'digitalocean', kind: 'baked', reason: 'live disabled' })
    sources.push({ provider: 'linode', kind: 'baked', reason: 'live disabled' })
    return { prices, sources }
  }

  // ─── Hetzner ────────────────────────────────────────────────
  const hetznerToken = await opts.secrets.get('provider.hetzner.token')
  if (hetznerToken === null || hetznerToken.length === 0) {
    sources.push({ provider: 'hetzner', kind: 'baked', reason: 'no token configured' })
  } else {
    try {
      const live = await fetchHetznerPricing({
        token: hetznerToken,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      })
      prices = mergeLiveTiers(prices, 'hetzner', live.tiers)
      if (live.egressOverageUsdPerTb > 0) {
        prices = {
          ...prices,
          extras: { ...prices.extras, hetzner_egress_overage_per_tb: live.egressOverageUsdPerTb },
        }
      }
      sources.push({ provider: 'hetzner', kind: 'live', fetchedAt: live.fetchedAt })
    } catch (err) {
      const reason =
        err instanceof HetznerPricingError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
      sources.push({ provider: 'hetzner', kind: 'baked', reason })
    }
  }

  // ─── DigitalOcean ───────────────────────────────────────────
  const doToken = await opts.secrets.get('provider.digitalocean.token')
  if (doToken === null || doToken.length === 0) {
    sources.push({ provider: 'digitalocean', kind: 'baked', reason: 'no token configured' })
  } else {
    try {
      const live = await fetchDOPricing({
        token: doToken,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      })
      prices = mergeLiveTiers(prices, 'digitalocean', live.tiers)
      sources.push({ provider: 'digitalocean', kind: 'live', fetchedAt: live.fetchedAt })
    } catch (err) {
      const reason =
        err instanceof DOPricingError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
      sources.push({ provider: 'digitalocean', kind: 'baked', reason })
    }
  }

  return { prices, sources }
}

function mergeLiveTiers(
  prices: Prices,
  provider: 'hetzner' | 'digitalocean' | 'linode',
  liveTiers: Partial<Record<string, VPSTierSpec>>,
): Prices {
  const bakedTable = prices[provider]
  const merged = { ...bakedTable }
  for (const [tier, live] of Object.entries(liveTiers)) {
    if (live === undefined) continue
    const bakedSpec = bakedTable[tier]
    if (bakedSpec !== undefined) {
      // Keep vcpu/ram/disk from baked when the live source doesn't provide
      // them (Hetzner /pricing omits these; DO /sizes includes them).
      merged[tier] = {
        vcpu: live.vcpu || bakedSpec.vcpu,
        ram_gb: live.ram_gb || bakedSpec.ram_gb,
        disk_gb: live.disk_gb || bakedSpec.disk_gb,
        price: live.price,
        traffic_tb: live.traffic_tb,
      }
    } else {
      merged[tier] = live
    }
  }
  return { ...prices, [provider]: merged }
}
