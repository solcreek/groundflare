/**
 * `groundflare plan` — dry run. Renders what `groundflare up` would
 * do, without actually provisioning / deploying. Useful for:
 *
 *   - reviewing config changes before pushing
 *   - CI pipelines that want a human to approve before apply
 *   - sanity check after editing wrangler.toml
 *
 * Does NOT exit non-zero when no changes are detected — the exit
 * code just signals "plan ran successfully". Read the printed output
 * to decide what to do next.
 *
 * Phase 3 will add drift detection (DNS resolution check, remote
 * systemd-unit probe, capnp hash compare). Today this is purely a
 * static plan from local state + wrangler config.
 */

import { defineCommand } from 'citty'
import { resolve as resolvePath } from 'node:path'

import { BootstrapStateStore } from '../../bootstrap/index.js'
import { resolveConfig } from '../../config/index.js'
import type { ProviderName } from '../../provider/index.js'
import { workspaceWorkerFromConfig } from '../../runtime/workspace/index.js'
import { log } from '../log.js'
import { buildUpPlan, renderPlan } from '../plan.js'

const SUPPORTED_PROVIDERS: readonly ProviderName[] = [
  'hetzner',
  'digitalocean',
  'linode',
  'vultr',
]

export default defineCommand({
  meta: {
    name: 'plan',
    description: 'Show what `groundflare up` would do, without running it',
  },
  args: {
    workspace: {
      type: 'string',
      required: true,
      description: 'Workspace name (must match a bootstrap state file or be fresh)',
    },
    cwd: {
      type: 'string',
      description: 'Directory containing wrangler.toml (default: current directory)',
    },
  },
  async run({ args }) {
    const workspace = args.workspace
    const cwd = resolvePath(args.cwd ?? process.cwd())

    const { wrangler, groundflare } = await resolveConfig({ cwd })

    const provider = groundflare.provider
    const region = groundflare.region
    const size = groundflare.size
    if (provider === undefined || region === undefined || size === undefined) {
      log.error(
        'plan needs provider + region + size in [groundflare]. Fill them in and re-run.',
      )
      process.exit(1)
    }
    if (!SUPPORTED_PROVIDERS.includes(provider as ProviderName)) {
      log.error(`unsupported provider ${JSON.stringify(provider)}`)
      process.exit(1)
    }

    const stateStore = new BootstrapStateStore()
    const existingState = await stateStore.load(workspace)
    const worker = workspaceWorkerFromConfig(wrangler, groundflare)

    const plan = buildUpPlan({
      workspace,
      provider: provider as ProviderName,
      region,
      size,
      domain: groundflare.domain,
      vpsExists:
        existingState !== null &&
        existingState.vps !== undefined &&
        existingState.vps.ipv4.length > 0,
      completedStages: existingState?.completedStages ?? [],
      workers: [worker],
    })

    process.stdout.write(renderPlan(plan))
    // No exit code signalling — this is an informational command.
    // Phase 3 may grow an `--exit-code` flag mirroring `terraform
    // plan -detailed-exitcode` (2 = changes queued).
  },
})
