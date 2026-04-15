/**
 * `groundflare estimate` — v0.1 scope:
 *   - interactive prompt only (no CF API, no CSV)
 *   - Hetzner target only
 *   - terminal output only
 *
 * See design/cost-estimate.md for the extended roadmap.
 */

import { defineCommand } from 'citty'

import {
  computeEstimate,
  loadBakedPrices,
  priceAgeDays,
  promptUsage,
  renderEstimate,
} from '../../estimate/index.js'
import { log } from '../log.js'

const STALE_AFTER_DAYS = 90

export default defineCommand({
  meta: {
    name: 'estimate',
    description: 'Compare Cloudflare usage cost against a self-hosted VPS',
  },
  args: {
    // Present for CLI forward-compat; unimplemented in v0.1.
    bill: { type: 'string', description: 'Path to a Cloudflare invoice CSV (v0.2+)' },
    'cf-token': {
      type: 'string',
      description: 'Cloudflare API token for live lookup (v0.3+)',
    },
    'account-id': { type: 'string', description: 'Cloudflare account ID (v0.3+)' },
    profile: {
      type: 'string',
      description: 'Workload profile override: a | b | c | d (v0.2+)',
    },
  },
  async run({ args }) {
    if (args.bill !== undefined || args['cf-token'] !== undefined) {
      log.warn(
        'bill + cf-token inputs land in v0.2/v0.3 — falling back to interactive mode',
      )
    }

    const prices = loadBakedPrices()
    const age = priceAgeDays(prices)
    if (age > STALE_AFTER_DAYS) {
      log.warn(
        `pricing table is ${age} days old (updated ${prices.updated}); numbers may drift`,
      )
    }

    const usage = await promptUsage()
    const estimate = computeEstimate(usage, prices, { confidence: 'low' })
    process.stdout.write(renderEstimate(estimate) + '\n')
  },
})
