/**
 * `groundflare tail` — stream journalctl output from the remote VPS.
 *
 * We follow `journalctl -u groundflare-worker.service` over SSH,
 * forwarding each line to stdout. Ctrl-C tears down the SSH child.
 *
 * `--since` maps to journalctl's -S flag (accepts "5m", "1h", ISO-8601).
 * `--errors` filters to priority 3 (err) and worse via -p.
 */

import { defineCommand } from 'citty'

import { BootstrapStateStore } from '../../bootstrap/index.js'
import { OpenSshClient, shellSingleQuote } from '../../ssh/index.js'
import { log } from '../log.js'

const DEFAULT_UNIT = 'groundflare-worker.service'

export default defineCommand({
  meta: {
    name: 'tail',
    description: 'Stream structured logs from the Worker via SSH + journalctl',
  },
  args: {
    workspace: {
      type: 'string',
      required: true,
      description: 'Workspace whose VPS to tail',
    },
    unit: {
      type: 'string',
      description: `systemd unit to follow (default: ${DEFAULT_UNIT})`,
    },
    errors: { type: 'boolean', description: 'Show only level >= error' },
    since: { type: 'string', description: 'Back-fill window, e.g. 5m or 2026-04-14' },
    follow: {
      type: 'boolean',
      description: 'Keep streaming new entries (default: true when stdout is a TTY)',
    },
  },
  async run({ args }) {
    const store = new BootstrapStateStore()
    const state = await store.load(args.workspace)
    if (state === null) {
      log.error(`no state for workspace ${JSON.stringify(args.workspace)}`)
      process.exit(1)
    }
    if (state.vps === undefined || state.sshKey === undefined) {
      log.error(`workspace ${JSON.stringify(args.workspace)} is not bootstrapped (no VPS/SSH key)`)
      process.exit(1)
    }

    const unit = args.unit ?? DEFAULT_UNIT
    const follow = args.follow ?? process.stdout.isTTY === true

    const parts = ['sudo', 'journalctl', '-u', shellSingleQuote(unit), '--no-pager']
    if (follow) parts.push('-f')
    if (args.errors === true) parts.push('-p', '3')
    if (args.since !== undefined) parts.push('-S', shellSingleQuote(args.since))

    const command = parts.join(' ')
    const ssh = new OpenSshClient({
      target: {
        host: state.vps.ipv4,
        user: state.vps.user,
        privateKeyPath: state.sshKey.localPath,
      },
    })

    const result = await ssh.stream(
      command,
      (line, source) => {
        const sink = source === 'stderr' ? process.stderr : process.stdout
        sink.write(`${line}\n`)
      },
      // No timeout when following — stream stays open until SIGINT.
      follow ? {} : { timeoutMs: 30_000 },
    )
    if (result.exitCode !== 0 && result.exitCode !== 130) {
      // 130 = SIGINT from a `-f` session; normal exit.
      process.exit(result.exitCode)
    }
  },
})
