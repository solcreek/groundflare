import { defineCommand } from 'citty'
import { notImplemented } from '../log.js'

export default defineCommand({
  meta: {
    name: 'up',
    description: 'Provision a VPS (if needed) and deploy the Worker',
  },
  args: {
    provider: {
      type: 'string',
      description: 'VPS provider (hetzner | digitalocean | linode | vultr | contabo)',
    },
    region: { type: 'string', description: 'Provider region code' },
    size: { type: 'string', description: 'VPS size tier' },
    domain: { type: 'string', description: 'Domain for the Worker' },
    env: { type: 'string', description: 'Named environment (e.g. production)' },
  },
  async run() {
    notImplemented('up', 'v0.1 bootstrap pipeline in progress — see design/bootstrap.md')
  },
})
