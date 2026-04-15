/**
 * Stage 1 — SSH key management.
 *
 * Idempotent flow:
 *   1. If state already has sshKey + the local key files exist + the
 *      provider still has the matching public key, skip.
 *   2. Else, generate a new ed25519 keypair locally (mode 0600 / 0644),
 *      upload the public key to the provider, and persist the new IDs.
 *
 * The keypair is workspace-scoped (filename includes workspace) so
 * deleting one workspace doesn't lock the operator out of others.
 */

import { join } from 'node:path'

import {
  defaultKeypairDirectory,
  fileExists,
  generateEd25519Keypair,
  saveKeypair,
} from '../keypair.js'
import type { Stage } from '../types.js'

const STAGE_ID = 'provider.ssh-key'

export interface SshKeyStageOptions {
  /** Override the directory keys are written to. Defaults to ~/.config/groundflare/keys. */
  readonly directory?: string
}

export function sshKeyStage(opts: SshKeyStageOptions = {}): Stage {
  const directory = opts.directory ?? defaultKeypairDirectory()

  return {
    id: STAGE_ID,
    description: 'Manage SSH keypair (generate locally, upload to provider)',

    async isComplete(ctx) {
      const recorded = ctx.state.sshKey
      if (recorded === undefined) return false
      // Both the local files AND the provider record must exist; if either
      // is gone we re-run the stage to restore consistency.
      const haveBoth =
        (await fileExists(recorded.localPath)) &&
        (await fileExists(recorded.localPublicPath))
      if (!haveBoth) return false
      try {
        const remote = await ctx.provider.listSSHKeys()
        return remote.some((k) => k.id === recorded.providerId)
      } catch {
        // If the provider call fails we can't be sure — better to re-run
        // and let stage 2 catch any duplicate-name errors than skip and
        // fail later.
        return false
      }
    },

    async run(ctx) {
      const basename = sshKeyBasename(ctx.workspace)
      const privateKeyPath = join(directory, basename)
      const publicKeyPath = `${privateKeyPath}.pub`
      const keyName = `groundflare-${ctx.workspace}`

      // Reuse the local key if it already exists (e.g. operator wiped
      // state but kept the keypair). Otherwise generate fresh.
      const reuseExisting =
        (await fileExists(privateKeyPath)) && (await fileExists(publicKeyPath))

      let publicKeyOpenSsh: string
      let fingerprint: string
      if (reuseExisting) {
        const fs = await import('node:fs/promises')
        publicKeyOpenSsh = (await fs.readFile(publicKeyPath, 'utf-8')).trim()
        const { sha256Fingerprint } = await import('../keypair.js')
        fingerprint = sha256Fingerprint(publicKeyOpenSsh)
        ctx.log('info', `reusing existing local keypair at ${privateKeyPath}`)
      } else {
        const generated = await generateEd25519Keypair(keyName)
        await saveKeypair(generated, { directory, basename })
        publicKeyOpenSsh = generated.publicKeyOpenSsh
        fingerprint = generated.fingerprint
        ctx.log('info', `generated new ed25519 keypair at ${privateKeyPath}`)
      }

      // Look for a matching key already on the provider — re-uploading
      // the same public key gives a duplicate-fingerprint error on most
      // providers.
      const existing = await ctx.provider.listSSHKeys()
      const match = existing.find((k) => k.fingerprint === fingerprint)
      let providerId: string
      if (match) {
        providerId = match.id
        ctx.log('info', `provider already has matching key (id=${match.id})`)
      } else {
        const uploaded = await ctx.provider.uploadSSHKey({
          name: keyName,
          publicKey: publicKeyOpenSsh,
        })
        providerId = uploaded.id
        ctx.log('info', `uploaded public key to provider (id=${uploaded.id})`)
      }

      ctx.state.sshKey = {
        providerId,
        fingerprint,
        localPath: privateKeyPath,
        localPublicPath: publicKeyPath,
      }
    },
  }
}

function sshKeyBasename(workspace: string): string {
  return `${workspace}_ed25519`
}

/**
 * Convenience: same as `sshKeyStage()` with default options. Most callers
 * use this; the factory form is for tests that want a custom directory.
 */
export const defaultSshKeyStage = sshKeyStage()

// Re-export so consumers don't need to know the directory layout.
export function defaultPrivateKeyPathFor(workspace: string): string {
  return join(defaultKeypairDirectory(), sshKeyBasename(workspace))
}
