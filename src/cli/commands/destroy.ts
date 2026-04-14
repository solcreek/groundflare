import { defineCommand } from 'citty'
import { notImplemented } from '../log.js'

export default defineCommand({
  meta: {
    name: 'destroy',
    description: 'Tear down the VPS and clean up provider resources',
  },
  args: {
    yes: { type: 'boolean', description: 'Skip confirmation prompt' },
  },
  async run() {
    notImplemented('destroy', 'destructive path — guarded behind explicit confirmation (v0.1 W3)')
  },
})
