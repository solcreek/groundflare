import { describe, expect, it } from 'vitest'

import {
  BAKED_PRICES,
  chooseHetznerTier,
  classifyProfile,
  collectWarnings,
  computeEstimate,
  computeSizingDemand,
  costCloudflare,
  costHetzner,
  estimateEgressTB,
  sumLines,
  USAGE_DEFAULTS,
  type Usage,
} from '../../src/index.js'

function u(partial: Partial<Usage> = {}): Usage {
  return { ...USAGE_DEFAULTS, ...partial }
}

describe('classifyProfile', () => {
  it('classifies default (small) workload as A', () => {
    expect(classifyProfile(u())).toBe('A')
  })

  it('classifies large responses as B (media-heavy)', () => {
    expect(classifyProfile(u({ avgResponseKB: 2048 }))).toBe('B')
  })

  it('classifies high-egress as B', () => {
    // 50M requests × 500 KB ≈ 25 TB egress → B
    expect(
      classifyProfile(u({ requestsPerMonth: 50_000_000, avgResponseKB: 500 })),
    ).toBe('B')
  })

  it('classifies high CPU total as C', () => {
    // 10M requests × 20 ms = 200M ms → C
    expect(
      classifyProfile(
        u({ requestsPerMonth: 10_000_000, cpuMsPerRequest: 20, avgResponseKB: 5 }),
      ),
    ).toBe('C')
  })

  it('classifies heavy D1 reads as D', () => {
    expect(
      classifyProfile(u({ d1ReadsPerMonth: 50_000_000 })),
    ).toBe('D')
  })

  it('classifies large D1 storage as D', () => {
    expect(classifyProfile(u({ d1StorageGB: 20 }))).toBe('D')
  })
})

describe('estimateEgressTB', () => {
  it('10M requests × 100 KB ≈ 1 TB', () => {
    const tb = estimateEgressTB(
      u({ requestsPerMonth: 10_000_000, avgResponseKB: 100 }),
    )
    expect(tb).toBeCloseTo(1, 1)
  })
})

describe('computeSizingDemand', () => {
  it('requires at least 1 core for any workload', () => {
    const d = computeSizingDemand(u({ requestsPerMonth: 1, cpuMsPerRequest: 1 }))
    expect(d.coresNeeded).toBeGreaterThanOrEqual(1)
  })

  it('scales cores with peak RPS × CPU ms', () => {
    // 100M rpm ≈ 38.5 avg rps, peak 10× ≈ 385 rps, × 10 ms / 1000 × 1.5 = ~6 cores
    const d = computeSizingDemand(
      u({ requestsPerMonth: 100_000_000, cpuMsPerRequest: 10 }),
    )
    expect(d.coresNeeded).toBeGreaterThan(4)
  })

  it('RAM demand grows with DO instances', () => {
    const base = computeSizingDemand(u({ doInstanceCount: 0 }))
    const withDO = computeSizingDemand(u({ doInstanceCount: 10 }))
    expect(withDO.ramGBNeeded).toBeGreaterThan(base.ramGBNeeded)
  })
})

describe('chooseHetznerTier', () => {
  it('picks cx22 for the default profile A workload', () => {
    const demand = computeSizingDemand(u())
    const choice = chooseHetznerTier(demand, BAKED_PRICES)
    expect(choice.tier).toBe('cx22')
    expect(choice.fits).toBe(true)
  })

  it('scales up to cx32 when cx22 runs out of cores', () => {
    const demand = { coresNeeded: 3, ramGBNeeded: 2, diskGBNeeded: 5 }
    const choice = chooseHetznerTier(demand, BAKED_PRICES)
    expect(choice.tier).toBe('cx32')
  })

  it('marks unfit when demand exceeds cx52', () => {
    const demand = { coresNeeded: 64, ramGBNeeded: 128, diskGBNeeded: 1000 }
    const choice = chooseHetznerTier(demand, BAKED_PRICES)
    expect(choice.fits).toBe(false)
    expect(choice.tier).toBe('cx52')
  })
})

describe('costCloudflare', () => {
  it('returns at least the Workers Paid base fee', () => {
    const lines = costCloudflare(u(), BAKED_PRICES)
    expect(lines[0]!.label).toBe('Workers Paid base')
    expect(lines[0]!.amount).toBe(5)
  })

  it('charges request overage beyond 10M included', () => {
    const lines = costCloudflare(u({ requestsPerMonth: 50_000_000 }), BAKED_PRICES)
    const overage = lines.find((l) => l.label.includes('request overage'))
    expect(overage).toBeDefined()
    // 40M overage × $0.30/M = $12
    expect(overage!.amount).toBeCloseTo(12, 2)
  })

  it('skips request overage when under 10M', () => {
    const lines = costCloudflare(u({ requestsPerMonth: 5_000_000 }), BAKED_PRICES)
    expect(lines.find((l) => l.label.includes('overage'))).toBeUndefined()
  })

  it('charges D1 when any D1 dimension is non-zero', () => {
    const lines = costCloudflare(u({ d1StorageGB: 5 }), BAKED_PRICES)
    expect(lines.find((l) => l.label === 'D1')).toBeDefined()
  })

  it('omits sections with zero usage', () => {
    const lines = costCloudflare(
      u({
        kvStorageGB: 0,
        kvReadsPerMonth: 0,
        kvWritesPerMonth: 0,
        doRequestsPerMonth: 0,
        doDurationGBSeconds: 0,
        doStorageGB: 0,
      }),
      BAKED_PRICES,
    )
    expect(lines.find((l) => l.label === 'KV')).toBeUndefined()
    expect(lines.find((l) => l.label === 'Durable Objects')).toBeUndefined()
  })
})

describe('costHetzner', () => {
  it('includes the tier base price + backups', () => {
    const lines = costHetzner('cx22', BAKED_PRICES.hetzner.cx22!, u(), 'A', BAKED_PRICES)
    const vps = lines.find((l) => l.label.startsWith('VPS'))
    const backups = lines.find((l) => l.label.startsWith('Backups'))
    expect(vps?.amount).toBe(4.8)
    expect(backups?.amount).toBe(3)
  })

  it('adds CDN cost for profile B', () => {
    const lines = costHetzner(
      'cx22',
      BAKED_PRICES.hetzner.cx22!,
      u({ r2StorageGB: 50 }),
      'B',
      BAKED_PRICES,
    )
    expect(lines.find((l) => l.label.includes('CDN'))).toBeDefined()
  })

  it('adds no CDN line for profile A', () => {
    const lines = costHetzner('cx22', BAKED_PRICES.hetzner.cx22!, u(), 'A', BAKED_PRICES)
    expect(lines.find((l) => l.label.includes('CDN'))).toBeUndefined()
  })

  it('adds egress overage above included traffic', () => {
    // 100M × 500 KB ≈ 50 TB → 30 TB over on cx22's 20 TB included
    const lines = costHetzner(
      'cx22',
      BAKED_PRICES.hetzner.cx22!,
      u({ requestsPerMonth: 100_000_000, avgResponseKB: 500 }),
      'B',
      BAKED_PRICES,
    )
    const overage = lines.find((l) => l.label.includes('egress overage'))
    expect(overage).toBeDefined()
    expect(overage!.amount).toBeGreaterThan(0)
  })
})

describe('collectWarnings', () => {
  it('flags Workers AI as keep-on-cf', () => {
    const ws = collectWarnings(u({ usesWorkersAI: true }), true)
    const w = ws.find((x) => x.code === 'workers-ai')
    expect(w?.impact).toBe('keep-on-cf')
  })

  it('flags Hyperdrive as review (user may still migrate)', () => {
    const ws = collectWarnings(u({ usesHyperdrive: true }), true)
    expect(ws.find((x) => x.code === 'hyperdrive')?.impact).toBe('review')
  })

  it('flags unfit sizing as not-recommended', () => {
    const ws = collectWarnings(u(), false)
    expect(ws.find((x) => x.code === 'single-node-too-small')?.impact).toBe(
      'not-recommended',
    )
  })

  it('returns empty list for clean workload', () => {
    expect(collectWarnings(u(), true)).toEqual([])
  })
})

describe('computeEstimate (integration)', () => {
  it('produces a full estimate with savings for the default workload', () => {
    const e = computeEstimate(u(), BAKED_PRICES, { confidence: 'low' })
    expect(e.profile).toBe('A')
    expect(e.target.tier).toBe('cx22')
    expect(e.current.monthly).toBeGreaterThan(0)
    expect(e.target.monthly).toBeGreaterThan(0)
    expect(e.savings.monthly + e.target.monthly).toBeCloseTo(e.current.monthly, 2)
    expect(e.savings.annual).toBeCloseTo(e.savings.monthly * 12, 2)
  })

  it('rounds all money values to 2 decimal places', () => {
    const e = computeEstimate(u({ requestsPerMonth: 13_333_333 }), BAKED_PRICES, {
      confidence: 'low',
    })
    for (const line of [...e.current.breakdown, ...e.target.breakdown]) {
      expect(Number.isInteger(line.amount * 100)).toBe(true)
    }
  })
})

describe('sumLines', () => {
  it('returns 0 for empty list', () => {
    expect(sumLines([])).toBe(0)
  })

  it('sums amounts', () => {
    expect(sumLines([{ label: 'a', amount: 1.5 }, { label: 'b', amount: 2.25 }])).toBe(
      3.75,
    )
  })
})
