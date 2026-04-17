/**
 * `groundflare deploy` — push Worker code to an already-bootstrapped VPS.
 *
 * Reads the workspace's bootstrap state from
 * ~/.config/groundflare/state/<workspace>.json, then invokes
 * src/deploy/run.ts to bundle + upload + restart + health-probe.
 *
 * `--dry-run` renders the bundle and configs but skips all SSH operations.
 */

import { defineCommand } from 'citty'
import { resolve as resolvePath } from 'node:path'

import { BootstrapStateStore } from '../../bootstrap/index.js'
import { DeployError, runDeploy } from '../../deploy/index.js'
import { log } from '../log.js'
import { resolveCliVersion } from '../version.js'

export default defineCommand({
  meta: {
    name: 'deploy',
    description: 'Push Worker code and roll the runtime with zero downtime',
  },
  args: {
    workspace: {
      type: 'string',
      required: true,
      description: 'Workspace name (matches the bootstrap state file)',
    },
    cwd: {
      type: 'string',
      description: 'Directory containing wrangler.toml (default: current directory)',
    },
    'acme-email': {
      type: 'string',
      description: 'Email for Caddy/ACME registration (overrides stored value)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Render bundle + configs locally without touching the VPS',
    },
  },
  async run({ args }) {
    const workspace = args.workspace
    const cwd = resolvePath(args.cwd ?? process.cwd())
    const dryRun = args['dry-run'] === true

    const stateStore = new BootstrapStateStore()
    const state = await stateStore.load(workspace)
    if (state === null) {
      log.error(
        `no bootstrap state for workspace ${JSON.stringify(workspace)} — ` +
          `run \`groundflare up --workspace ${workspace}\` first`,
      )
      process.exit(1)
    }

    const acmeEmail = args['acme-email']
    if (acmeEmail === undefined || acmeEmail === '') {
      log.error('--acme-email is required (used by Caddy for Let\'s Encrypt registration)')
      process.exit(1)
    }

    const groundflareVersion = await resolveCliVersion()

    try {
      const result = await runDeploy({
        workspace,
        workingDirectory: cwd,
        bootstrapState: state,
        acmeEmail,
        dryRun,
        groundflareVersion,
        log: (level, message) => {
          if (level === 'error') log.error(message)
          else if (level === 'warn') log.warn(message)
          else if (level === 'debug') log.debug(message)
          else log.info(message)
        },
      })
      reportResult(result)
    } catch (err) {
      if (err instanceof DeployError) {
        log.error(`${err.message} (${err.code})`)
        process.exit(1)
      }
      throw err
    }
  },
})

function reportResult(result: {
  readonly workspace: string
  readonly tenants: readonly { name: string; domain: string | undefined; bundleBytes: number }[]
  readonly capnpBytes: number
  readonly caddyfileBytes: number
  readonly healthCheck?: { status: number; durationMs: number }
  readonly dryRun: boolean
}): void {
  const mode = result.dryRun ? 'dry-run' : 'deploy'
  log.success(`${mode} complete for workspace ${result.workspace}`)
  for (const t of result.tenants) {
    const domain = t.domain ?? '(no domain)'
    log.info(`  ${t.name} → ${domain} (${t.bundleBytes} bytes)`)
  }
  log.info(`  capnp: ${result.capnpBytes} bytes, Caddyfile: ${result.caddyfileBytes} bytes`)
  if (result.healthCheck) {
    log.info(`  health: ${result.healthCheck.status} in ${result.healthCheck.durationMs}ms`)
  }
}
