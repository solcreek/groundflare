/**
 * `groundflare destroy` — tear down a bootstrapped VPS and forget the
 * workspace state. Destructive: always prompts unless --yes is passed.
 *
 * Sequence:
 *   1. Load state for the workspace.
 *   2. Construct the provider from the stored provider name + secret store.
 *   3. Call provider.destroyVPS(vps.id).
 *   4. Delete the SSH key from the provider (only if no other workspace
 *      references it — each workspace usually has its own per-
 *      bootstrap key, but a defensive scan prevents breaking a shared
 *      setup).
 *   5. Remove the local keypair files (best-effort).
 *   6. Purge known_hosts entries for the retired VPS IP (added 6a90b63).
 *   7. Remove the local state file so `up` starts fresh next time.
 *
 * Notes:
 *   - The SSH key cleanup is best-effort — a failed delete (key already
 *     gone at the provider, 404, etc.) logs a warning but never blocks
 *     the overall destroy.
 *   - The secret store entry (`provider.<name>.token`) is NOT touched —
 *     it's per-provider-account, not per-workspace.
 *   - DNS records, backups, and external resources are out of scope.
 */

import { defineCommand } from 'citty'
import { unlink } from 'node:fs/promises'

import {
  BootstrapStateStore,
  type BootstrapState,
} from '../../bootstrap/index.js'
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
import { removeKnownHostsEntries } from '../../ssh/index.js'
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

      // Best-effort: delete the provider-side SSH key + local keypair
      // files if no other workspace on the same provider references
      // the same key. Per-workspace key naming is the norm (bootstrap
      // stage 01 generates `<workspace>_ed25519`), but the share check
      // guards the rare "I manually reused a key across workspaces"
      // setup — losing their auth mid-deploy would be very bad.
      if (state.sshKey !== undefined) {
        await cleanUpSshKey({
          provider,
          providerName: state.provider,
          sshKey: state.sshKey,
          currentWorkspace: workspace,
          stateStore,
        })
      }

      // Best-effort purge of stale known_hosts entries so the operator
      // doesn't hit "host key has changed" errors on the next `up` if
      // the provider recycles this public IP (common on Hetzner hel1).
      await cleanUpKnownHosts(state.vps)
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

/**
 * Delete the provider-side SSH key and local keypair files, but only
 * when no other workspace state references the same `providerId` on
 * the same provider. A shared-key setup is unusual (bootstrap
 * generates per-workspace keys) but legitimate — e.g. the operator
 * manually seeded a shared ed25519 key for a team-access setup —
 * and we don't want destroy on workspace A to lock them out of B.
 *
 * Best-effort throughout: any error logs a warning and continues.
 * The overall destroy never fails because of a leftover SSH key.
 *
 * Exported so the share-check + skip path can be exercised in unit
 * tests without spinning up the full destroy command.
 */
export async function cleanUpSshKey(opts: {
  provider: Provider
  providerName: string
  sshKey: NonNullable<BootstrapState['sshKey']>
  currentWorkspace: string
  stateStore: BootstrapStateStore
}): Promise<void> {
  // Scan sibling state files for the same key.
  const sharers: string[] = []
  try {
    const others = await opts.stateStore.list()
    for (const name of others) {
      if (name === opts.currentWorkspace) continue
      const sibling = await opts.stateStore.load(name).catch(() => null)
      if (sibling === null) continue
      if (
        sibling.provider === opts.providerName &&
        sibling.sshKey?.providerId === opts.sshKey.providerId
      ) {
        sharers.push(name)
      }
    }
  } catch (err) {
    log.warn(
      `could not scan other workspaces for SSH-key share check: ` +
        `${err instanceof Error ? err.message : String(err)}; ` +
        `leaving SSH key in place to be safe`,
    )
    return
  }

  if (sharers.length > 0) {
    log.info(
      `SSH key ${opts.sshKey.providerId} is also referenced by workspace(s): ` +
        `${sharers.join(', ')} — leaving it at the provider`,
    )
    return
  }

  // Provider-side delete.
  try {
    await opts.provider.deleteSSHKey(opts.sshKey.providerId)
    log.success(`removed SSH key ${opts.sshKey.providerId} from provider`)
  } catch (err) {
    const msg = err instanceof ProviderError
      ? `${err.message} (${err.code})`
      : err instanceof Error
        ? err.message
        : String(err)
    log.warn(`could not delete SSH key ${opts.sshKey.providerId}: ${msg}`)
  }

  // Local keypair cleanup. ENOENT is fine — means we're doing
  // re-destroy or the key was already moved by the operator.
  for (const path of [opts.sshKey.localPath, opts.sshKey.localPublicPath]) {
    try {
      await unlink(path)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn(`could not remove local key ${path}: ${(err as Error).message}`)
      }
    }
  }
}

async function cleanUpKnownHosts(
  vps: NonNullable<BootstrapState['vps']>,
): Promise<void> {
  const hosts: string[] = []
  if (vps.ipv4 !== '') hosts.push(vps.ipv4)
  if (vps.ipv6 !== undefined && vps.ipv6 !== '') hosts.push(vps.ipv6)
  if (vps.port !== undefined && vps.port !== 22 && vps.ipv4 !== '') {
    hosts.push(`[${vps.ipv4}]:${vps.port}`)
  }
  if (hosts.length === 0) return
  const result = await removeKnownHostsEntries(hosts)
  if (result.removed.length > 0) {
    log.info(
      `cleaned known_hosts for ${result.removed.join(', ')} (avoids "host key changed" on IP reuse)`,
    )
  }
  for (const e of result.errors) {
    log.warn(`known_hosts cleanup for ${e.host} failed: ${e.message}`)
  }
}

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
