/**
 * Baked-in pricing table.
 *
 * Kept as a TypeScript const (not a separate .json) so it flows through
 * tsc without a copy-assets build step. The shape matches the Prices
 * interface; when the hybrid API-refresh path lands later, this same
 * object will serve as the fallback when live lookups fail.
 *
 * Refresh cadence: design/cost-estimate.md calls for a monthly CI cron
 * to reconcile against each provider's pricing API and open PRs when
 * anything drifts >1%.
 */

import type { Prices } from './types.js'

export const BAKED_PRICES: Prices = {
  updated: '2026-04-14',
  currency: 'USD',
  cloudflare: {
    workers_paid_base: 5.0,
    workers_request_included_million: 10,
    workers_request_per_million: 0.3,
    workers_cpu_ms_included_million: 30,
    workers_cpu_ms_per_million: 0.02,
    d1_storage_per_gb: 0.75,
    d1_reads_per_million: 0.001,
    d1_writes_per_million: 1.0,
    kv_reads_per_million: 0.5,
    kv_writes_per_million: 5.0,
    kv_storage_per_gb: 0.5,
    r2_storage_per_gb: 0.015,
    r2_class_a_per_million: 4.5,
    r2_class_b_per_million: 0.36,
    do_requests_per_million: 0.2,
    do_duration_gb_s_per_million: 12.5,
    do_storage_per_gb: 0.2,
  },
  hetzner: {
    cx22: { price: 4.8, vcpu: 2, ram_gb: 4, disk_gb: 40, traffic_tb: 20 },
    cx32: { price: 7.5, vcpu: 4, ram_gb: 8, disk_gb: 80, traffic_tb: 20 },
    cx42: { price: 14.0, vcpu: 8, ram_gb: 16, disk_gb: 160, traffic_tb: 20 },
    cx52: { price: 28.0, vcpu: 16, ram_gb: 32, disk_gb: 320, traffic_tb: 20 },
  },
  digitalocean: {
    's-1vcpu-512mb-10gb': { price: 4, vcpu: 1, ram_gb: 0.5, disk_gb: 10, traffic_tb: 0.5 },
    's-1vcpu-1gb': { price: 6, vcpu: 1, ram_gb: 1, disk_gb: 25, traffic_tb: 1 },
    's-1vcpu-2gb': { price: 12, vcpu: 1, ram_gb: 2, disk_gb: 50, traffic_tb: 2 },
    's-2vcpu-2gb': { price: 18, vcpu: 2, ram_gb: 2, disk_gb: 60, traffic_tb: 3 },
    's-2vcpu-4gb': { price: 24, vcpu: 2, ram_gb: 4, disk_gb: 80, traffic_tb: 4 },
    's-4vcpu-8gb': { price: 48, vcpu: 4, ram_gb: 8, disk_gb: 160, traffic_tb: 5 },
    's-8vcpu-16gb': { price: 96, vcpu: 8, ram_gb: 16, disk_gb: 320, traffic_tb: 6 },
    'c-2': { price: 42, vcpu: 2, ram_gb: 4, disk_gb: 25, traffic_tb: 4 },
    'c-4': { price: 84, vcpu: 4, ram_gb: 8, disk_gb: 50, traffic_tb: 5 },
  },
  extras: {
    hetzner_egress_overage_per_tb: 1.0,
    do_egress_overage_per_tb: 10.24,
    restic_b2_monthly_flat: 3.0,
    bunny_cdn_per_gb: 0.005,
  },
}

export function loadBakedPrices(): Prices {
  return BAKED_PRICES
}

/**
 * Days since the baked prices were published. Used to decide whether to
 * warn the user the table is stale.
 */
export function priceAgeDays(prices: Prices, now: Date = new Date()): number {
  const updated = new Date(prices.updated + 'T00:00:00Z')
  return Math.floor((now.getTime() - updated.getTime()) / 86_400_000)
}
