import { defineCommand } from 'citty'
import { notImplemented } from '../log.js'

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show a one-screen snapshot of the Worker + VPS health',
  },
  async run() {
    notImplemented('status', 'fetches /metrics + systemctl state; depends on runtime supervisor (v0.1 W4)')
  },
})
