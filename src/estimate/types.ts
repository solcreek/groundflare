/**
 * Types for `groundflare estimate`.
 *
 * Usage is what the user tells us about their current CF workload.
 * Prices is loaded from the baked prices.json.
 * Estimate is what we return — breakdowns + totals + confidence.
 */

export interface Usage {
  /** Worker requests per month. */
  readonly requestsPerMonth: number
  /** Average CPU time per request (ms). Default ~2ms for typical workloads. */
  readonly cpuMsPerRequest: number
  /** Average response body size (KB). */
  readonly avgResponseKB: number

  readonly d1StorageGB: number
  readonly d1ReadsPerMonth: number
  readonly d1WritesPerMonth: number

  readonly kvStorageGB: number
  readonly kvReadsPerMonth: number
  readonly kvWritesPerMonth: number

  readonly r2StorageGB: number
  readonly r2ClassAOpsPerMonth: number
  readonly r2ClassBOpsPerMonth: number

  /**
   * DO instance count (distinct IDs, not requests). Each instance holds a
   * small amount of RAM in workerd, and — on CF — bills per request.
   */
  readonly doInstanceCount: number
  readonly doRequestsPerMonth: number
  /** Sum of DO duration × allocated memory, expressed in GB-seconds. */
  readonly doDurationGBSeconds: number
  readonly doStorageGB: number

  /**
   * Features that can't be migrated to workerd (Workers AI, Browser
   * Rendering, Vectorize, Hyperdrive). We flag these in the output but
   * leave them on CF.
   */
  readonly usesWorkersAI: boolean
  readonly usesBrowserRendering: boolean
  readonly usesVectorize: boolean
  readonly usesHyperdrive: boolean
}

export type Profile =
  /** Typical micro-SaaS. */
  | 'A'
  /** Media-heavy (high egress / large responses). */
  | 'B'
  /** Compute-heavy (high CPU time / request). */
  | 'C'
  /** Data-heavy (large DB or heavy reads). */
  | 'D'

export type HetznerTier = 'cx22' | 'cx32' | 'cx42' | 'cx52'

export type Confidence = 'high' | 'medium' | 'low'

export interface Prices {
  readonly updated: string
  readonly currency: 'USD' | 'EUR'
  readonly cloudflare: CloudflarePrices
  readonly hetzner: Record<HetznerTier, HetznerTierSpec>
  readonly extras: ExtrasPrices
}

export interface CloudflarePrices {
  readonly workers_paid_base: number
  readonly workers_request_included_million: number
  readonly workers_request_per_million: number
  readonly workers_cpu_ms_included_million: number
  readonly workers_cpu_ms_per_million: number
  readonly d1_storage_per_gb: number
  readonly d1_reads_per_million: number
  readonly d1_writes_per_million: number
  readonly kv_reads_per_million: number
  readonly kv_writes_per_million: number
  readonly kv_storage_per_gb: number
  readonly r2_storage_per_gb: number
  readonly r2_class_a_per_million: number
  readonly r2_class_b_per_million: number
  readonly do_requests_per_million: number
  readonly do_duration_gb_s_per_million: number
  readonly do_storage_per_gb: number
}

export interface HetznerTierSpec {
  readonly price: number
  readonly vcpu: number
  readonly ram_gb: number
  readonly disk_gb: number
  readonly traffic_tb: number
}

export interface ExtrasPrices {
  readonly hetzner_egress_overage_per_tb: number
  readonly restic_b2_monthly_flat: number
  readonly bunny_cdn_per_gb: number
}

export interface CostLine {
  readonly label: string
  readonly amount: number
}

export interface Estimate {
  readonly profile: Profile
  readonly confidence: Confidence
  readonly currency: string
  readonly pricesUpdated: string
  readonly current: {
    readonly provider: 'cloudflare'
    readonly monthly: number
    readonly breakdown: readonly CostLine[]
  }
  readonly target: {
    readonly provider: 'hetzner'
    readonly tier: HetznerTier
    readonly monthly: number
    readonly breakdown: readonly CostLine[]
  }
  readonly savings: {
    readonly monthly: number
    readonly annual: number
    readonly percent: number
  }
  readonly warnings: readonly Warning[]
}

export interface Warning {
  readonly code: string
  readonly message: string
  readonly impact: 'keep-on-cf' | 'not-recommended' | 'review'
}
