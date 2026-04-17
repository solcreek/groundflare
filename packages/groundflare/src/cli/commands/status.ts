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
import {
  aggregateByWorker,
  parsePromText,
  renderMetricsTable,
} from '../metrics.js'

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
    const driftFound = await printWorkspaceDetail(state, {
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

  process.stdout.write(`\nhealth:\n`)
  const started = Date.now()
  const probe = await ssh.run(
    // `-w "\\n%{http_code}"` appends the HTTP status on its own line
    // after the body so we can parse both. Same curl invocation the
    // deploy-time probe in src/deploy/run.ts uses.
    `curl -s -w "\\n%{http_code}" --max-time 10 http://${LISTEN_ADDRESS}/__health`,
    { timeoutMs: 15_000 },
  )
  const elapsed = Date.now() - started
  if (probe.exitCode !== 0) {
    process.stdout.write(`  curl exited ${probe.exitCode}: ${probe.stderr.trim()}\n`)
  } else {
    const parsed = parseHealth(probe.stdout)
    if (parsed === null) {
      process.stdout.write(
        `  unparsable /__health response: ${JSON.stringify(probe.stdout.slice(0, 120))}\n`,
      )
    } else if (parsed.status !== 200) {
      process.stdout.write(`  HTTP ${parsed.status} in ${elapsed}ms\n`)
    } else {
      const payload = parsed.body
      const uptime = payload
        ? formatUptime(payload.uptime_seconds)
        : '(unknown)'
      const version = payload?.version ?? '(unknown)'
      process.stdout.write(
        `  HTTP ${parsed.status} in ${elapsed}ms — uptime ${uptime}, version ${version}\n`,
      )
    }
  }

  // /__metrics is loopback-only, so the SSH session (which lands on
  // 127.0.0.1 from workerd's perspective) is the only way to scrape
  // it. Failures are non-fatal — status stays useful even if metrics
  // happen to be unavailable (e.g. workerd restart in progress).
  process.stdout.write(`\nmetrics (cumulative since worker boot):\n`)
  const metricsProbe = await ssh.run(
    `curl -fsS --max-time 10 http://${LISTEN_ADDRESS}/__metrics`,
    { timeoutMs: 15_000 },
  )
  if (metricsProbe.exitCode !== 0) {
    process.stdout.write(
      `  unavailable (curl exit ${metricsProbe.exitCode}: ${metricsProbe.stderr.trim()})\n`,
    )
  } else {
    const series = parsePromText(metricsProbe.stdout)
    const workers = aggregateByWorker(series)
    process.stdout.write(renderMetricsTable(workers))
  }

  if (!opts.checkDrift) return false
  return await runDriftSection(state, ssh)
}

interface HealthPayload {
  status: string
  uptime_seconds: number
  version: string
}

/**
 * Split the `<body>\n<status>` output of `curl -s -w "\n%{http_code}"`.
 * Body is parsed as JSON; unparseable bodies return a non-null parse
 * with a null body so the caller can still print the status code.
 */
function parseHealth(
  stdout: string,
): { status: number; body: HealthPayload | null } | null {
  const trimmed = stdout.trimEnd()
  const nl = trimmed.lastIndexOf('\n')
  if (nl < 0) return null
  const status = Number.parseInt(trimmed.slice(nl + 1).trim(), 10)
  if (Number.isNaN(status)) return null
  let body: HealthPayload | null = null
  try {
    const parsed = JSON.parse(trimmed.slice(0, nl)) as Partial<HealthPayload>
    if (
      typeof parsed.status === 'string' &&
      typeof parsed.uptime_seconds === 'number' &&
      typeof parsed.version === 'string'
    ) {
      body = parsed as HealthPayload
    }
  } catch {
    // body stays null
  }
  return { status, body }
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '(unknown)'
  if (seconds < 60) return `${Math.trunc(seconds)}s`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h${mins % 60}m`
  const days = Math.floor(hrs / 24)
  return `${days}d${hrs % 24}h`
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
  const drift = hasDrift(checks)
  if (drift) {
    // Most drift states reconcile by re-running the deploy flow:
    // `up` resumes bootstrap from wherever state left off, restarts
    // missing systemd units, and re-uploads the capnp/Caddyfile. The
    // minority that doesn't heal this way (IP rotated externally,
    // DNS pointing elsewhere) still needs operator attention, but
    // pointing them at `up` first is the right default hint.
    process.stdout.write(
      `  → run \`groundflare up --workspace ${state.workspace}\` to reconcile\n`,
    )
  }
  return drift
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
