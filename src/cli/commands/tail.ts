import { defineCommand } from 'citty'
import { notImplemented } from '../log.js'

export default defineCommand({
  meta: {
    name: 'tail',
    description: 'Stream structured logs from the Worker via SSH + journalctl',
  },
  args: {
    worker: { type: 'string', description: 'Restrict to a specific worker name' },
    errors: { type: 'boolean', description: 'Show only level >= error' },
    since: { type: 'string', description: 'Back-fill duration, e.g. 5m' },
    follow: { type: 'boolean', description: 'Follow new entries (default when TTY)' },
  },
  async run() {
    notImplemented('tail', 'needs provider SSH helper (v0.1 W3)')
  },
})
