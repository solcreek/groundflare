import type { GroundflareSection } from './schema.js'

/**
 * Groundflare smart defaults — values that apply when the user hasn't
 * specified otherwise and which don't require runtime detection (provider
 * choice, VPS size, geo-region all need CLI interaction).
 *
 * Follows the rule from design/config.md: two fields have NO silent
 * default and must be answered explicitly — `provider` (billing implication)
 * and `backup` (data-loss implication). Those stay `undefined` here and
 * are prompted for at CLI time.
 */
export const STATIC_DEFAULTS: Readonly<GroundflareSection> = Object.freeze({
  runtime: 'workerd',
  observability: Object.freeze({
    metrics: 'prometheus',
    logs: 'json',
  }),
})

/**
 * Default adapter choice per binding kind. Overridable via
 * `[groundflare.bindings.<name>] adapter = "..."`.
 */
export const BINDING_DEFAULTS = Object.freeze({
  kv: Object.freeze({ adapter: 'sqlite' as const }),
  d1: Object.freeze({ adapter: 'libsql' as const }),
  r2: Object.freeze({ adapter: 'passthrough' as const }),
  queue: Object.freeze({ adapter: 'sqlite' as const }),
})

/**
 * Default on-disk paths for each binding's state file. Centralised so
 * the bootstrap script and the runtime adapters agree without duplicating
 * string templates.
 */
export const STATE_DIR = '/var/lib/groundflare'

export function kvStatePath(binding: string): string {
  return `${STATE_DIR}/kv/${binding}.sqlite`
}

export function d1StatePath(databaseName: string): string {
  return `${STATE_DIR}/d1/${databaseName}.sqlite`
}

export function queueStatePath(queueName: string): string {
  return `${STATE_DIR}/queues/${queueName}.sqlite`
}

export function doStatePath(className: string): string {
  return `${STATE_DIR}/do/${className}`
}

/**
 * Runtime-allocated defaults. These can't be statically known because
 * they depend on the VPS size chosen, so they're computed at provision
 * time rather than hardcoded.
 */
export function defaultRuntimeLimits(vpsRamMb: number, vpsCpuCores: number) {
  return {
    memory_mb: Math.floor(vpsRamMb * 0.5),
    cpu_pct: Math.min(80, Math.floor((vpsCpuCores / vpsCpuCores) * 80)),
  }
}
