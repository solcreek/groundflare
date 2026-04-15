import { describe, expect, it } from 'vitest'

import {
  BAKED_PRICES,
  computeEstimate,
  renderEstimate,
  USAGE_DEFAULTS,
} from '../../../src/estimate/index.js'

describe('renderEstimate', () => {
  it('produces a multi-line ASCII box', () => {
    const out = renderEstimate(
      computeEstimate(USAGE_DEFAULTS, BAKED_PRICES, { confidence: 'low' }),
    )
    expect(out.split('\n').length).toBeGreaterThan(10)
    expect(out).toMatch(/^\+-+\+$/m)
  })

  it('includes the profile, tier, and savings number for a profile-A workload with real savings', () => {
    // Scale up D1 + R2 usage so CF overtakes Hetzner and savings are positive.
    const usage = {
      ...USAGE_DEFAULTS,
      requestsPerMonth: 20_000_000,
      d1StorageGB: 5,
      d1ReadsPerMonth: 8_000_000,
      r2StorageGB: 20,
    }
    const e = computeEstimate(usage, BAKED_PRICES, { confidence: 'low' })
    const out = renderEstimate(e)
    expect(out).toContain('Workload profile: A')
    expect(out).toMatch(/Hetzner CX\d{2}/)
    expect(e.savings.monthly).toBeGreaterThan(0)
    expect(out).toContain(`$${e.savings.monthly.toFixed(2)}/mo`)
  })

  it('shows "no savings" messaging when CF is already cheaper', () => {
    // Empty Workers workload (just the $5 base fee, no D1/KV/R2) → VPS
    // (min $4.80 + $3 backups = $7.80) is more expensive than CF.
    const usage = {
      ...USAGE_DEFAULTS,
      requestsPerMonth: 1_000,
      d1StorageGB: 0,
      d1ReadsPerMonth: 0,
      d1WritesPerMonth: 0,
      r2StorageGB: 0,
      r2ClassAOpsPerMonth: 0,
      r2ClassBOpsPerMonth: 0,
    }
    const e = computeEstimate(usage, BAKED_PRICES, { confidence: 'low' })
    expect(e.savings.monthly).toBeLessThanOrEqual(0)
    expect(renderEstimate(e)).toContain('No savings')
  })

  it('lists warnings when present', () => {
    const e = computeEstimate(
      { ...USAGE_DEFAULTS, usesWorkersAI: true },
      BAKED_PRICES,
      { confidence: 'low' },
    )
    const out = renderEstimate(e)
    expect(out).toContain('Warnings')
    expect(out).toContain('Workers AI')
  })

  it('omits the warnings section when there are none', () => {
    const e = computeEstimate(USAGE_DEFAULTS, BAKED_PRICES, { confidence: 'low' })
    const out = renderEstimate(e)
    expect(out).not.toContain('Warnings')
  })
})
