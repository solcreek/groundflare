/**
 * Pure cost + sizing functions. No I/O, no prompting — unit-testable.
 *
 * Algorithm mirrors design/cost-estimate.md §Core algorithm. Anything
 * below that's numeric should be traceable back to that doc.
 */

import type {
  CostLine,
  HetznerTier,
  Prices,
  Profile,
  TargetProvider,
  Usage,
  VPSTierSpec,
  Warning,
} from './types.js'

const BYTES_PER_KB = 1000
const BYTES_PER_TB = BYTES_PER_KB * BYTES_PER_KB * BYTES_PER_KB * BYTES_PER_KB

const HETZNER_TIERS: readonly HetznerTier[] = ['cx22', 'cx32', 'cx42', 'cx52']
const DO_TIERS: readonly string[] = [
  's-1vcpu-512mb-10gb',
  's-1vcpu-1gb',
  's-1vcpu-2gb',
  's-2vcpu-2gb',
  's-2vcpu-4gb',
  's-4vcpu-8gb',
  's-8vcpu-16gb',
]
const LINODE_TIERS: readonly string[] = [
  'g6-nanode-1',
  'g6-standard-1',
  'g6-standard-2',
  'g6-dedicated-2',
  'g6-standard-4',
  'g6-dedicated-4',
  'g6-standard-6',
]

/** ─── Classification ─────────────────────────────────────────── */

export function classifyProfile(usage: Usage): Profile {
  const egressTB = estimateEgressTB(usage)
  if (egressTB > 10 || usage.avgResponseKB > 1000) return 'B'

  const totalCpuMsMillions =
    (usage.requestsPerMonth * usage.cpuMsPerRequest) / 1_000_000
  if (totalCpuMsMillions > 100) return 'C'

  if (usage.d1ReadsPerMonth > 10_000_000 || usage.d1StorageGB > 5) return 'D'
  return 'A'
}

export function estimateEgressTB(usage: Usage): number {
  const bytes = usage.requestsPerMonth * usage.avgResponseKB * BYTES_PER_KB
  return bytes / BYTES_PER_TB
}

/** ─── VPS sizing ─────────────────────────────────────────────── */

export interface SizingDemand {
  readonly coresNeeded: number
  readonly ramGBNeeded: number
  readonly diskGBNeeded: number
}

export function computeSizingDemand(usage: Usage): SizingDemand {
  const avgRps = usage.requestsPerMonth / (30 * 24 * 3600)
  const peakRps = avgRps * 10
  const coresNeeded = Math.max(
    1,
    Math.ceil((peakRps * usage.cpuMsPerRequest) / 1000 * 1.5),
  )
  const ramGBNeeded =
    1 + 0.5 * Math.min(usage.doInstanceCount, 200) + Math.min(usage.kvStorageGB, 4)
  const diskGBNeeded =
    2 * (usage.d1StorageGB + usage.kvStorageGB + usage.r2StorageGB)
  return { coresNeeded, ramGBNeeded, diskGBNeeded }
}

export interface TierChoice {
  readonly tier: string
  readonly spec: VPSTierSpec
  readonly fits: boolean
}

function tierList(provider: TargetProvider): readonly string[] {
  switch (provider) {
    case 'digitalocean':
      return DO_TIERS
    case 'linode':
      return LINODE_TIERS
    case 'hetzner':
      return HETZNER_TIERS
  }
}

function tierTable(provider: TargetProvider, prices: Prices): Record<string, VPSTierSpec> {
  switch (provider) {
    case 'digitalocean':
      return prices.digitalocean
    case 'linode':
      return prices.linode
    case 'hetzner':
      return prices.hetzner
  }
}

/** @deprecated Use chooseTier with explicit provider. */
export function chooseHetznerTier(
  demand: SizingDemand,
  prices: Prices,
): TierChoice {
  return chooseTier(demand, 'hetzner', prices)
}

export function chooseTier(
  demand: SizingDemand,
  provider: TargetProvider,
  prices: Prices,
): TierChoice {
  const tiers = tierList(provider)
  const table = tierTable(provider, prices)
  for (const tier of tiers) {
    const spec = table[tier]
    if (spec === undefined) continue
    if (
      demand.coresNeeded <= spec.vcpu &&
      demand.ramGBNeeded <= spec.ram_gb &&
      demand.diskGBNeeded <= spec.disk_gb * 0.875
    ) {
      return { tier, spec, fits: true }
    }
  }
  const topTier = tiers[tiers.length - 1]!
  const topSpec = table[topTier]!
  return { tier: topTier, spec: topSpec, fits: false }
}

/** ─── CF cost ────────────────────────────────────────────────── */

export function costCloudflare(usage: Usage, prices: Prices): CostLine[] {
  const cf = prices.cloudflare
  const lines: CostLine[] = []

  lines.push({ label: 'Workers Paid base', amount: cf.workers_paid_base })

  const requestOverageMillions = Math.max(
    0,
    usage.requestsPerMonth / 1_000_000 - cf.workers_request_included_million,
  )
  if (requestOverageMillions > 0) {
    lines.push({
      label: 'Workers request overage',
      amount: requestOverageMillions * cf.workers_request_per_million,
    })
  }

  const cpuMsMillions = (usage.requestsPerMonth * usage.cpuMsPerRequest) / 1_000_000
  const cpuMsOverageMillions = Math.max(
    0,
    cpuMsMillions - cf.workers_cpu_ms_included_million,
  )
  if (cpuMsOverageMillions > 0) {
    lines.push({
      label: 'Workers CPU-ms overage',
      amount: cpuMsOverageMillions * cf.workers_cpu_ms_per_million,
    })
  }

  if (usage.d1StorageGB > 0 || usage.d1ReadsPerMonth > 0 || usage.d1WritesPerMonth > 0) {
    const d1Cost =
      usage.d1StorageGB * cf.d1_storage_per_gb +
      (usage.d1ReadsPerMonth / 1_000_000) * cf.d1_reads_per_million +
      (usage.d1WritesPerMonth / 1_000_000) * cf.d1_writes_per_million
    if (d1Cost > 0) lines.push({ label: 'D1', amount: d1Cost })
  }

  if (usage.kvStorageGB > 0 || usage.kvReadsPerMonth > 0 || usage.kvWritesPerMonth > 0) {
    const kvCost =
      usage.kvStorageGB * cf.kv_storage_per_gb +
      (usage.kvReadsPerMonth / 1_000_000) * cf.kv_reads_per_million +
      (usage.kvWritesPerMonth / 1_000_000) * cf.kv_writes_per_million
    if (kvCost > 0) lines.push({ label: 'KV', amount: kvCost })
  }

  if (usage.r2StorageGB > 0 || usage.r2ClassAOpsPerMonth > 0 || usage.r2ClassBOpsPerMonth > 0) {
    const r2Cost =
      usage.r2StorageGB * cf.r2_storage_per_gb +
      (usage.r2ClassAOpsPerMonth / 1_000_000) * cf.r2_class_a_per_million +
      (usage.r2ClassBOpsPerMonth / 1_000_000) * cf.r2_class_b_per_million
    if (r2Cost > 0) lines.push({ label: 'R2', amount: r2Cost })
  }

  if (usage.doRequestsPerMonth > 0 || usage.doDurationGBSeconds > 0 || usage.doStorageGB > 0) {
    const doCost =
      (usage.doRequestsPerMonth / 1_000_000) * cf.do_requests_per_million +
      (usage.doDurationGBSeconds / 1_000_000) * cf.do_duration_gb_s_per_million +
      usage.doStorageGB * cf.do_storage_per_gb
    if (doCost > 0) lines.push({ label: 'Durable Objects', amount: doCost })
  }

  return lines
}

/** ─── Target VPS cost (generic across providers) ────────────── */

/** @deprecated Use costTarget. */
export function costHetzner(
  tier: string,
  spec: VPSTierSpec,
  usage: Usage,
  profile: Profile,
  prices: Prices,
): CostLine[] {
  return costTarget('hetzner', tier, spec, usage, profile, prices)
}

export function costTarget(
  provider: TargetProvider,
  tier: string,
  spec: VPSTierSpec,
  usage: Usage,
  profile: Profile,
  prices: Prices,
): CostLine[] {
  const providerName = providerLabel(provider)
  const lines: CostLine[] = []
  lines.push({
    label: `VPS (${tier}, ${spec.vcpu} vCPU / ${spec.ram_gb} GB)`,
    amount: spec.price,
  })

  const egressTB = estimateEgressTB(usage)
  const overageTB = Math.max(0, egressTB - spec.traffic_tb)
  if (overageTB > 0) {
    const ratePerTB = egressOverageRate(provider, prices)
    lines.push({
      label: `${providerName} egress overage (${overageTB.toFixed(1)} TB)`,
      amount: overageTB * ratePerTB,
    })
  }

  lines.push({
    label: 'Backups (restic → B2)',
    amount: prices.extras.restic_b2_monthly_flat,
  })

  if (profile === 'B') {
    const assetGB = Math.max(0, usage.r2StorageGB + egressTB * 1024)
    lines.push({
      label: 'CDN (Bunny) for profile B assets',
      amount: assetGB * prices.extras.bunny_cdn_per_gb,
    })
  }

  return lines
}

/** ─── Warnings ───────────────────────────────────────────────── */

export function collectWarnings(usage: Usage, tierFits: boolean): Warning[] {
  const warnings: Warning[] = []
  if (usage.usesWorkersAI) {
    warnings.push({
      code: 'workers-ai',
      message: 'Workers AI has no local runtime — keep this binding on CF.',
      impact: 'keep-on-cf',
    })
  }
  if (usage.usesBrowserRendering) {
    warnings.push({
      code: 'browser-rendering',
      message: 'Browser Rendering has no local runtime — use Browserless or similar.',
      impact: 'keep-on-cf',
    })
  }
  if (usage.usesVectorize) {
    warnings.push({
      code: 'vectorize',
      message: 'Vectorize isn\'t supported yet — keep this binding on CF or self-host Qdrant/Weaviate.',
      impact: 'keep-on-cf',
    })
  }
  if (usage.usesHyperdrive) {
    warnings.push({
      code: 'hyperdrive',
      message: 'Hyperdrive pools remote Postgres — run libSQL locally or point at real Postgres.',
      impact: 'review',
    })
  }
  if (!tierFits) {
    warnings.push({
      code: 'single-node-too-small',
      message: 'Workload exceeds the largest available tier — single-node self-host is not recommended.',
      impact: 'not-recommended',
    })
  }
  return warnings
}

export function sumLines(lines: readonly CostLine[]): number {
  return lines.reduce((acc, l) => acc + l.amount, 0)
}

function providerLabel(provider: TargetProvider): string {
  switch (provider) {
    case 'digitalocean':
      return 'DigitalOcean'
    case 'linode':
      return 'Linode'
    case 'hetzner':
      return 'Hetzner'
  }
}

function egressOverageRate(provider: TargetProvider, prices: Prices): number {
  switch (provider) {
    case 'digitalocean':
      return prices.extras.do_egress_overage_per_tb
    case 'linode':
      return prices.extras.linode_egress_overage_per_tb
    case 'hetzner':
      return prices.extras.hetzner_egress_overage_per_tb
  }
}
