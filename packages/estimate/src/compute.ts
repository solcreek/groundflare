/**
 * Top-level orchestration: Usage → Estimate.
 */

import {
  chooseTier,
  classifyProfile,
  collectWarnings,
  computeSizingDemand,
  costCloudflare,
  costTarget,
  sumLines,
} from './cost.js'
import type {
  Confidence,
  Estimate,
  PriceSource,
  Prices,
  TargetProvider,
  Usage,
} from './types.js'

export interface ComputeOptions {
  readonly confidence: Confidence
  readonly priceSources?: readonly PriceSource[]
  /** Which VPS provider to compare against. Default: hetzner. */
  readonly targetProvider?: TargetProvider
}

export function computeEstimate(
  usage: Usage,
  prices: Prices,
  opts: ComputeOptions,
): Estimate {
  const provider: TargetProvider = opts.targetProvider ?? 'hetzner'
  const profile = classifyProfile(usage)
  const demand = computeSizingDemand(usage)
  const { tier, spec, fits } = chooseTier(demand, provider, prices)

  const cfLines = costCloudflare(usage, prices)
  const targetLines = costTarget(provider, tier, spec, usage, profile, prices)
  const cfMonthly = sumLines(cfLines)
  const targetMonthly = sumLines(targetLines)

  const savingsMonthlyRaw = cfMonthly - targetMonthly
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
      provider,
      tier,
      monthly: round(targetMonthly),
      breakdown: targetLines.map((l) => ({ label: l.label, amount: round(l.amount) })),
    },
    savings: {
      monthly: savingsMonthly,
      annual: savingsAnnual,
      percent: round(savingsPercent),
    },
    warnings: collectWarnings(usage, fits),
    ...(opts.priceSources !== undefined ? { priceSources: opts.priceSources } : {}),
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
