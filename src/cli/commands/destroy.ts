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
import { consola } from 'consola'
import { unlink } from 'node:fs/promises'

import { BootstrapStateStore } from '../../bootstrap/index.js'
import { HetznerProvider, type Provider, ProviderError } from '../../provider/index.js'
import { FileSecretStore } from '../../secret/index.js'
import { log } from '../log.js'

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

    const vpsDesc = state.vps
      ? `${state.vps.id} (${state.vps.ipv4} @ ${state.provider})`
      : '(no VPS recorded — will only remove local state)'
    log.info(`workspace: ${workspace}`)
    log.info(`vps: ${vpsDesc}`)

    if (args.yes !== true) {
      const confirmed = await consola.prompt(
        `Destroy VPS and delete local state for ${JSON.stringify(workspace)}?`,
        { type: 'confirm', initial: false },
      )
      if (confirmed !== true) {
        log.info('aborted')
        return
      }
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
  switch (name) {
    case 'hetzner':
      return new HetznerProvider({ token })
    default:
      log.error(`provider ${JSON.stringify(name)} not supported (Hetzner only in v0.1)`)
      process.exit(1)
  }
}
