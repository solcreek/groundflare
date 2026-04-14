import { defineCommand } from 'citty'
import { notImplemented } from '../log.js'

export default defineCommand({
  meta: {
    name: 'estimate',
    description: 'Compare Cloudflare usage cost against a self-hosted VPS',
  },
  args: {
    bill: { type: 'string', description: 'Path to a Cloudflare invoice CSV' },
    'cf-token': { type: 'string', description: 'Cloudflare API token for live lookup' },
    'account-id': { type: 'string', description: 'Cloudflare account ID' },
    profile: {
      type: 'string',
      description: 'Workload profile override: a | b | c | d',
    },
  },
  async run() {
    notImplemented('estimate', 'cost model wired up in a later v0.1 commit (see design/cost-estimate.md)')
  },
})
