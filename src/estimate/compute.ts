/**
 * Top-level orchestration: Usage → Estimate.
 */

import {
  chooseHetznerTier,
  classifyProfile,
  collectWarnings,
  computeSizingDemand,
  costCloudflare,
  costHetzner,
  sumLines,
} from './cost.js'
import type { Confidence, Estimate, Prices, Usage } from './types.js'

export interface ComputeOptions {
  /**
   * Confidence the caller has in the input data. Interactive mode defaults
   * to "low" (lots of guesses); CF-API-fetched data gets "high".
   */
  readonly confidence: Confidence
}

export function computeEstimate(
  usage: Usage,
  prices: Prices,
  opts: ComputeOptions,
): Estimate {
  const profile = classifyProfile(usage)
  const demand = computeSizingDemand(usage)
  const { tier, spec, fits } = chooseHetznerTier(demand, prices)

  const cfLines = costCloudflare(usage, prices)
  const hzLines = costHetzner(tier, spec, usage, profile, prices)
  const cfMonthly = sumLines(cfLines)
  const hzMonthly = sumLines(hzLines)

  // Round monthly first so annual reads as monthly × 12 to the penny —
  // otherwise rounding drift makes the two numbers look inconsistent.
  const savingsMonthlyRaw = cfMonthly - hzMonthly
  const savingsMonthly = round(savingsMonthlyRaw)
  const savingsAnnual = round(savingsMonthly * 12)
  const savingsPercent = cfMonthly > 0 ? (savingsMonthlyRaw / cfMonthly) * 100 : 0

  return {
    profile,
    confidence: opts.confidence,
    currency: prices.currency,
    pricesUpdated: prices.updated,
    current: {
      provider: 'cloudflare',
      monthly: round(cfMonthly),
      breakdown: cfLines.map((l) => ({ label: l.label, amount: round(l.amount) })),
    },
    target: {
      provider: 'hetzner',
      tier,
      monthly: round(hzMonthly),
      breakdown: hzLines.map((l) => ({ label: l.label, amount: round(l.amount) })),
    },
    savings: {
      monthly: savingsMonthly,
      annual: savingsAnnual,
      percent: round(savingsPercent),
    },
    warnings: collectWarnings(usage, fits),
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
