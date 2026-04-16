/**
 * Bun-track staging planner — the Bun counterpart to the workerd
 * file list assembled inline in runDeploy.
 *
 * Pure function: given a BunArtifact and the compiled user bundle,
 * returns the list of files to install and the groundflare-owned dirs
 * that must be mkdir+chown'd first. runDeploy hands this plan to
 * `atomicInstall()` together with the Caddyfile, so both tracks land
 * on the VPS through the same single `sudo sh -s` transaction.
 *
 * Previously this file owned its own ssh.run sequence (uploadAsUser x N
 * + uploadAsRoot for the systemd unit + ensureRemoteDir per state dir).
 * Splitting that into plan + shared install makes both tracks testable
 * as pure pipelines and eliminates mid-sequence scp failures that left
 * the deploy root half-upgraded.
 */

import type { BunArtifact } from '../runtime/bun/build.js'
import type { AtomicInstallFile } from './stage.js'

const BUN_UNIT_REMOTE_PATH = '/etc/systemd/system/groundflare-worker.service'

export interface PlanBunStagingOptions {
  readonly artifact: BunArtifact
  /** User's compiled entry module (esbuild output). */
  readonly userBundle: string
}

export interface BunStagingPlan {
  readonly files: readonly AtomicInstallFile[]
  /**
   * groundflare-owned dirs that must exist + be chowned before the
   * install phase. Includes `deployRoot` itself, the `adapters/`
   * subdir, and each per-binding state dir (kv/, d1/, r2/).
   */
  readonly groundflareOwnedDirs: readonly string[]
  /** Total bytes written for server.ts + adapters. */
  readonly artifactBytes: number
  /** Bytes of the user bundle (same contract as the workerd track). */
  readonly userBundleBytes: number
  /** Bytes of the systemd unit content. */
  readonly unitBytes: number
}

export function planBunStaging(opts: PlanBunStagingOptions): BunStagingPlan {
  const { artifact, userBundle } = opts
  const { deployRoot, serverSource, adapterSources, systemdUnit } = artifact

  const files: AtomicInstallFile[] = []

  // server.ts (Bun.serve entry)
  files.push({
    content: serverSource,
    remotePath: artifact.entryModulePath,
    owner: 'groundflare',
    mode: '0644',
  })

  // adapter sources (adapters/kv.ts, d1.ts, r2.ts, sigv4.ts)
  let adapterBytes = 0
  for (const [rel, content] of Object.entries(adapterSources)) {
    files.push({
      content,
      remotePath: `${deployRoot}/${rel}`,
      owner: 'groundflare',
      mode: '0644',
    })
    adapterBytes += Buffer.byteLength(content, 'utf-8')
  }

  // user bundle (imported by server.ts as ./user.js)
  files.push({
    content: userBundle,
    remotePath: `${deployRoot}/${artifact.userEntryRelativePath}`,
    owner: 'groundflare',
    mode: '0644',
  })

  // systemd unit
  files.push({
    content: systemdUnit,
    remotePath: BUN_UNIT_REMOTE_PATH,
    owner: 'root',
    mode: '0644',
  })

  // Dirs under groundflare ownership. artifact.stateDirs already
  // includes deployRoot as its first entry; we add the adapters subdir
  // explicitly.
  const groundflareOwnedDirs = [
    ...artifact.stateDirs,
    `${deployRoot}/adapters`,
  ]

  return {
    files,
    groundflareOwnedDirs,
    artifactBytes: Buffer.byteLength(serverSource, 'utf-8') + adapterBytes,
    userBundleBytes: Buffer.byteLength(userBundle, 'utf-8'),
    unitBytes: Buffer.byteLength(systemdUnit, 'utf-8'),
  }
}
