/**
 * `groundflare destroy` — tear down a bootstrapped VPS and forget the
 * workspace state. Destructive: always prompts unless --yes is passed.
 *
 * Sequence:
 *   1. Load state for the workspace.
 *   2. Construct the provider from the stored provider name + secret store.
 *   3. Call provider.destroyVPS(vps.id).
 *   4. Remove the local state file so `up` starts fresh next time.
 *
 * Notes:
 *   - We do NOT auto-delete the SSH key from the provider or the local
 *     ~/.config/groundflare/keys — those are cheap to keep and deleting
 *     them would break any other workspaces that share the same key.
 *   - DNS records, backups, and external resources are out of scope.
 */

import { defineCommand } from 'citty'
import { unlink } from 'node:fs/promises'

import { BootstrapStateStore } from '../../bootstrap/index.js'
import { resolveConfig } from '../../config/index.js'
import {
  ProviderError,
  UnknownProviderError,
  createProvider,
  type Provider,
  type ProviderName,
} from '../../provider/index.js'
import {
  workspaceWorkerFromConfig,
  type WorkspaceWorker,
} from '../../runtime/workspace/index.js'
import { FileSecretStore } from '../../secret/index.js'
import { log } from '../log.js'
import { buildDestroyPlan, confirmPlan } from '../plan.js'

export default defineCommand({
  meta: {
    name: 'destroy',
    description: 'Tear down the VPS and clean up provider resources',
  },
  args: {
    workspace: {
      type: 'string',
      required: true,
      description: 'Workspace name to destroy',
    },
    yes: {
      type: 'boolean',
      description: 'Skip the interactive confirmation prompt',
    },
  },
  async run({ args }) {
    const workspace = args.workspace
    const stateStore = new BootstrapStateStore()
    const state = await stateStore.load(workspace)
    if (state === null) {
      log.warn(`no state found for workspace ${JSON.stringify(workspace)}; nothing to destroy`)
      return
    }

    // Recover the workspace shape for the data-loss summary. Missing
    // wrangler is non-fatal — we fall back to "no workers recovered"
    // rather than blocking destroy just because config is gone.
    let workers: WorkspaceWorker[] = []
    try {
      const { wrangler, groundflare } = await resolveConfig({ cwd: process.cwd() })
      workers = [workspaceWorkerFromConfig(wrangler, groundflare)]
    } catch {
      // No config in cwd — fine for destroy, we still know the VPS id
      // from state.
    }
    const plan = buildDestroyPlan({
      workspace,
      provider: state.provider as ProviderName,
      vps: state.vps ? { id: state.vps.id, ipv4: state.vps.ipv4 } : null,
      workers,
    })
    const approved = await confirmPlan(plan, {
      skip: args.yes === true,
      typeToConfirm: workspace,
    })
    if (!approved) {
      log.info('aborted')
      return
    }

    if (state.vps !== undefined) {
      const provider = await constructProvider(state.provider)
      try {
        await provider.destroyVPS(state.vps.id)
        log.success(`destroyed ${state.vps.id}`)
      } catch (err) {
        if (err instanceof ProviderError) {
          log.error(`provider.destroyVPS failed: ${err.message} (${err.code})`)
          process.exit(1)
        }
        throw err
      }
    }

    try {
      await unlink(stateStore.pathFor(workspace))
      log.success(`removed state file for ${workspace}`)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw err
    }
  },
})

async function constructProvider(name: string): Promise<Provider> {
  const secrets = new FileSecretStore()
  const tokenKey = `provider.${name}.token`
  const token = await secrets.get(tokenKey)
  if (token === null || token.length === 0) {
    log.error(
      `no token at secret ${JSON.stringify(tokenKey)}; ` +
        `run \`groundflare secret set ${tokenKey} <token>\` first`,
    )
    process.exit(1)
  }
  try {
    return createProvider(name as ProviderName, { token })
  } catch (err) {
    if (err instanceof UnknownProviderError) {
      log.error(err.message)
      process.exit(1)
    }
    throw err
  }
}
