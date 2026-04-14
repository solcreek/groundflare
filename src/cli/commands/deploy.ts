import { defineCommand } from 'citty'
import { notImplemented } from '../log.js'

export default defineCommand({
  meta: {
    name: 'deploy',
    description: 'Push Worker code and roll the runtime with zero downtime',
  },
  args: {
    env: { type: 'string', description: 'Named environment (e.g. production)' },
  },
  async run() {
    notImplemented('deploy', 'requires the runtime supervisor + SCP path (v0.1 W3/W4)')
  },
})
