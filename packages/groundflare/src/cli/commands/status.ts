/**
 * `groundflare status` — one-screen snapshot of workspace health.
 *
 * Two modes:
 *   (no args)         list all known workspaces with basic state info
 *   --workspace <w>   SSH in, probe systemctl + curl health, print details
 */

import { defineCommand } from 'citty'

import {
  BootstrapStateStore,
  type BootstrapState,
} from '../../bootstrap/index.js'
import { resolveConfig } from '../../config/index.js'
import {
  UnknownProviderError,
  createProvider,
  type Provider,
  type ProviderName,
} from '../../provider/index.js'
import { FileSecretStore } from '../../secret/index.js'
import { OpenSshClient, type SshClient } from '../../ssh/index.js'
import {
  collectDrift,
  hasDrift,
  renderDriftChecks,
  summarizeDrift,
} from '../drift.js'
import { log } from '../log.js'

const SYSTEMD_UNITS = [
  'groundflare-worker.service',
  'caddy.service',
] as const

const LISTEN_ADDRESS = '127.0.0.1:8080'

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show a one-screen snapshot of the Worker + VPS health',
  },
  args: {
    workspace: {
      type: 'string',
      description: 'Probe this workspace via SSH; omit to list all workspaces',
    },
    host: {
      type: 'string',
      description: 'Optional Host header for the health probe (defaults to localhost)',
    },
    'check-drift': {
      type: 'boolean',
      description:
        'Run drift detection (provider + DNS + systemd + files). Exits 1 if drift found.',
    },
  },
  async run({ args }) {
    const store = new BootstrapStateStore()

    if (args.workspace === undefined) {
      await printWorkspaceList(store)
      return
    }

    const state = await store.load(args.workspace)
    if (state === null) {
      log.error(`no state for workspace ${JSON.stringify(args.workspace)}`)
      process.exit(1)
    }
    const driftFound = await printWorkspaceDetail(state, args.host, {
      checkDrift: args['check-drift'] === true,
    })
    if (driftFound) process.exit(1)
  },
})

async function printWorkspaceList(store: BootstrapStateStore): Promise<void> {
  const names = await store.list()
  if (names.length === 0) {
    log.info('no workspaces yet — run `groundflare up --workspace <name>`')
    return
  }
  for (const name of names) {
    const state = await store.load(name)
    if (state === null) {
      process.stdout.write(`${name}\t(unreadable)\n`)
      continue
    }
    const vps = state.vps?.ipv4 ?? '(no vps)'
    const stages = state.completedStages.length
    process.stdout.write(`${name}\t${state.provider}\t${vps}\t${stages} stages complete\n`)
  }
}

async function printWorkspaceDetail(
  state: BootstrapState,
  hostOverride: string | undefined,
  opts: { checkDrift: boolean },
): Promise<boolean> {
  process.stdout.write(`workspace:  ${state.workspace}\n`)
  process.stdout.write(`provider:   ${state.provider}\n`)
  process.stdout.write(`started:    ${state.startedAt}\n`)
  process.stdout.write(`updated:    ${state.updatedAt}\n`)
  process.stdout.write(`stages:     ${state.completedStages.join(', ') || '(none)'}\n`)

  if (state.vps === undefined) {
    process.stdout.write(`vps:        (not provisioned)\n`)
    return false
  }
  process.stdout.write(
    `vps:        ${state.vps.id} (${state.vps.ipv4}, ${state.vps.size}@${state.vps.region})\n`,
  )

  if (state.sshKey === undefined) {
    process.stdout.write(`ssh:        no key on record — cannot probe remote\n`)
    return false
  }

  const ssh: SshClient = new OpenSshClient({
    target: {
      host: state.vps.ipv4,
      user: state.vps.user,
      privateKeyPath: state.sshKey.localPath,
      ...(state.vps.port !== undefined ? { port: state.vps.port } : {}),
    },
  })

  process.stdout.write(`\nsystemd units:\n`)
  for (const unit of SYSTEMD_UNITS) {
    const r = await ssh.run(`systemctl is-active ${unit}`, { timeoutMs: 10_000 })
    const status = r.stdout.trim() || (r.exitCode === 0 ? 'active' : 'inactive')
    process.stdout.write(`  ${unit.padEnd(32)} ${status}\n`)
  }

  const host = hostOverride ?? 'localhost'
  process.stdout.write(`\nhealth probe (Host: ${host}):\n`)
  const started = Date.now()
  const probe = await ssh.run(
    `curl -o /dev/null -s -w "%{http_code}" --max-time 10 -H "Host: ${host}" http://${LISTEN_ADDRESS}/`,
    { timeoutMs: 15_000 },
  )
  const elapsed = Date.now() - started
  if (probe.exitCode !== 0) {
    process.stdout.write(`  curl exited ${probe.exitCode}: ${probe.stderr.trim()}\n`)
  } else {
    process.stdout.write(`  HTTP ${probe.stdout.trim()} in ${elapsed}ms\n`)
  }

  if (!opts.checkDrift) return false
  return await runDriftSection(state, ssh)
}

async function runDriftSection(
  state: BootstrapState,
  ssh: SshClient,
): Promise<boolean> {
  process.stdout.write(`\ndrift:\n`)

  // domain comes from wrangler.toml in cwd — best-effort, non-fatal if
  // missing. We still run provider/systemd/files checks in that case.
  let domain: string | undefined
  try {
    const { groundflare } = await resolveConfig({ cwd: process.cwd() })
    domain = groundflare.domain
  } catch {
    // no wrangler.toml in cwd — skip DNS category
  }

  const provider = await tryLoadProvider(state.provider as ProviderName)

  const checks = await collectDrift({
    state,
    ...(domain !== undefined ? { domain } : {}),
    provider,
    ssh,
  })
  process.stdout.write(renderDriftChecks(checks))
  process.stdout.write(`  ${summarizeDrift(checks)}\n`)
  return hasDrift(checks)
}

/**
 * Like destroy.ts's constructProvider, but we never exit — drift runs
 * best-effort. Missing token just means we skip the provider category
 * (still useful on its own).
 */
async function tryLoadProvider(name: ProviderName): Promise<Provider | null> {
  try {
    const secrets = new FileSecretStore()
    const token = await secrets.get(`provider.${name}.token`)
    if (token === null || token.length === 0) return null
    return createProvider(name, { token })
  } catch (err) {
    if (err instanceof UnknownProviderError) return null
    return null
  }
}
