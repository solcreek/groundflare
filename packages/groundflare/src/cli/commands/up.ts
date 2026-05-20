/**
 * `groundflare up` — combined provision + deploy.
 *
 * Runs runBootstrap() (provider auth → SSH key → create VPS → wait →
 * cloud-init → install workerd → install systemd units) followed by
 * runDeploy() (bundle + upload + restart + health probe). Idempotent:
 * re-running with the same workspace resumes bootstrap from the last
 * successful stage, then deploys the latest code.
 *
 * Flags mirror bootstrap/deploy + a few escape hatches:
 *   --skip-bootstrap   skip straight to deploy (for already-up workspaces)
 *   --skip-deploy      bootstrap only, don't push code
 */

import { defineCommand } from 'citty'
import { resolve as resolvePath } from 'node:path'

import {
  BootstrapError,
  BootstrapStateStore,
  runBootstrap,
} from '../../bootstrap/index.js'
import { DeployError, runDeploy } from '../../deploy/index.js'
import { resolveConfig } from '../../config/index.js'
import type { ProviderName } from 'capstan'
import { workspaceWorkerFromConfig } from '../../runtime/workspace/index.js'
import { log } from '../log.js'
import { buildUpPlan, confirmPlan } from '../plan.js'
import { resolveCliVersion } from '../version.js'

const SUPPORTED_PROVIDERS: readonly ProviderName[] = [
  'hetzner',
  'digitalocean',
  'linode',
  'vultr',
]

export default defineCommand({
  meta: {
    name: 'up',
    description: 'Provision a VPS (if needed) and deploy the Worker',
  },
  args: {
    workspace: {
      type: 'string',
      required: true,
      description: 'Workspace name (used for state + DNS naming)',
    },
    cwd: {
      type: 'string',
      description: 'Directory containing wrangler.toml (default: current directory)',
    },
    provider: {
      type: 'string',
      description: 'VPS provider (default: from [groundflare].provider)',
    },
    region: {
      type: 'string',
      description: 'Provider region (default: from [groundflare].region)',
    },
    size: {
      type: 'string',
      description: 'VPS size tier (default: from [groundflare].size)',
    },
    'acme-email': {
      type: 'string',
      description: 'Email for Caddy/ACME registration (default: from [groundflare].email)',
    },
    domain: {
      type: 'string',
      description: 'Primary domain (default: from [groundflare].domain)',
    },
    'skip-bootstrap': {
      type: 'boolean',
      description: 'Skip provisioning; assume the VPS is already bootstrapped',
    },
    'skip-deploy': {
      type: 'boolean',
      description: 'Run bootstrap only; do not bundle + upload Worker code',
    },
    yes: {
      type: 'boolean',
      description: 'Auto-approve the plan without the interactive prompt',
    },
  },
  async run({ args }) {
    const workspace = args.workspace
    const cwd = resolvePath(args.cwd ?? process.cwd())

    const { groundflare } = await resolveConfig({ cwd })

    const provider = (args.provider ?? groundflare.provider) as ProviderName | undefined
    if (provider === undefined) {
      log.error('no provider specified — pass --provider or set [groundflare].provider')
      process.exit(1)
    }
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      log.error(`unsupported provider ${JSON.stringify(provider)}`)
      process.exit(1)
    }

    const region = args.region ?? groundflare.region
    const size = args.size ?? groundflare.size
    const acmeEmail = args['acme-email'] ?? groundflare.email
    const domain = args.domain ?? groundflare.domain

    if (region === undefined || size === undefined || acmeEmail === undefined) {
      log.error(
        'missing required fields: region, size, and acme-email must be set ' +
          '(via flags or [groundflare] section)',
      )
      process.exit(1)
    }

    const logFn = (level: 'info' | 'warn' | 'error' | 'debug', message: string): void => {
      if (level === 'error') log.error(message)
      else if (level === 'warn') log.warn(message)
      else if (level === 'debug') log.debug(message)
      else log.info(message)
    }

    // ─── Plan + confirm ────────────────────────────────────────────
    // Show the user what's about to happen before we spend real money
    // on a droplet. For repeat `up` on an existing workspace this
    // collapses to "redeploy" and stays out of the way.
    const stateStore = new BootstrapStateStore()
    const existingState = await stateStore.load(workspace)
    const { wrangler, groundflare: gfRead } = await resolveConfig({ cwd })
    const worker = workspaceWorkerFromConfig(wrangler, gfRead)
    const plan = buildUpPlan({
      workspace,
      provider,
      region,
      size,
      domain,
      preview: gfRead.preview,
      vpsExists:
        existingState !== null &&
        existingState.vps !== undefined &&
        existingState.vps.ipv4.length > 0,
      completedStages: existingState?.completedStages ?? [],
      workers: [worker],
    })
    const approved = await confirmPlan(plan, {
      skip: args.yes === true,
      defaultAnswer: existingState !== null, // redeploy: default yes; fresh: default no
    })
    if (!approved) {
      log.info('aborted')
      return
    }

    // ─── Bootstrap ─────────────────────────────────────────────────
    let state
    if (args['skip-bootstrap'] === true) {
      state = await stateStore.load(workspace)
      if (state === null) {
        log.error(
          `--skip-bootstrap set but no state found for ${JSON.stringify(workspace)}`,
        )
        process.exit(1)
      }
      log.info(`skipping bootstrap (state: ${state.vps?.ipv4 ?? 'no vps'})`)
    } else {
      try {
        state = await runBootstrap({
          workspace,
          provider,
          region,
          size,
          acmeEmail,
          placeholderDomain: domain ?? `${workspace}.invalid`,
          log: logFn,
          ...(groundflare.runtime !== undefined ? { runtime: groundflare.runtime } : {}),
        })
      } catch (err) {
        if (err instanceof BootstrapError) {
          log.error(`${err.message} (${err.code}${err.stageId ? ` @ ${err.stageId}` : ''})`)
          process.exit(1)
        }
        throw err
      }
    }

    // ─── Deploy ────────────────────────────────────────────────────
    if (args['skip-deploy'] === true) {
      log.info('skipping deploy (--skip-deploy)')
      return
    }

    const groundflareVersion = await resolveCliVersion()

    try {
      const result = await runDeploy({
        workspace,
        workingDirectory: cwd,
        bootstrapState: state,
        acmeEmail,
        groundflareVersion,
        log: logFn,
      })
      log.success(`up complete: ${result.tenants.length} tenant(s) deployed`)
      if (result.healthCheck) {
        log.info(`  health: ${result.healthCheck.status} in ${result.healthCheck.durationMs}ms`)
      }
      if (result.previewUrl !== undefined) {
        log.info(`  preview: ${result.previewUrl}`)
        log.info(
          '  (sslip.io-backed; set [groundflare].domain + point DNS at the VPS IP for production)',
        )
      }
    } catch (err) {
      if (err instanceof DeployError) {
        log.error(`${err.message} (${err.code})`)
        process.exit(1)
      }
      throw err
    }
  },
})
