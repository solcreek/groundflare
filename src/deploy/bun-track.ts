/**
 * Bun-track deploy helper — the Bun counterpart to the capnp + bundle
 * upload sequence in runDeploy's workerd path.
 *
 * Given a BunArtifact and a compiled user bundle, this function:
 *   1. Ensures the on-VPS state directories exist (kv/, d1/, r2/ …).
 *   2. Uploads server.ts + adapters/*.ts + user.js under the deploy root.
 *   3. Installs the Bun systemd unit (overwriting whatever stage 06 of
 *      bootstrap put there — the file name is shared between tracks, so
 *      the upgrade is a pure content swap).
 *
 * Returns the byte counts of the artifacts written so runDeploy can
 * surface them in its DeployResult.
 *
 * Pure helper — doesn't start / restart systemd itself; the caller owns
 * that sequencing (single daemon-reload + restart after Caddy is also
 * in place).
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BunArtifact } from '../runtime/bun/build.js'
import type { LogFn } from '../bootstrap/index.js'
import type { SshClient } from '../ssh/index.js'
import { DeployError } from './types.js'

const BUN_UNIT_REMOTE_PATH = '/etc/systemd/system/groundflare-worker.service'

export interface BunTrackStageOptions {
  ssh: SshClient
  artifact: BunArtifact
  /**
   * User's compiled entry module (esbuild output). Written to
   * `<deployRoot>/<userEntryRelativePath>`. The shim imports from
   * this path at runtime.
   */
  userBundle: string
  log: LogFn
}

export interface BunTrackStageResult {
  /** Total bytes written for server.ts + adapters. */
  artifactBytes: number
  /** Bytes of the user bundle (same contract as the workerd track). */
  userBundleBytes: number
  /** Bytes of the systemd unit content. */
  unitBytes: number
}

export async function stageBunArtifact(
  opts: BunTrackStageOptions,
): Promise<BunTrackStageResult> {
  const { ssh, artifact, userBundle, log } = opts
  const { deployRoot, serverSource, adapterSources, systemdUnit } = artifact

  // ─── 1. state dirs ─────────────────────────────────────────────
  for (const dir of artifact.stateDirs) {
    await ensureRemoteDir(ssh, dir)
  }
  // adapters/ lives under deployRoot — same permissions as the rest of
  // the groundflare-owned tree.
  await ensureRemoteDir(ssh, `${deployRoot}/adapters`)

  // ─── 2. server + adapters + user bundle ────────────────────────
  log('info', `uploading Bun server.ts + ${Object.keys(adapterSources).length} adapter sources`)
  await uploadAsUser(
    ssh,
    serverSource,
    artifact.entryModulePath,
    'groundflare',
    '0644',
  )
  let adapterBytes = 0
  for (const [rel, content] of Object.entries(adapterSources)) {
    await uploadAsUser(
      ssh,
      content,
      `${deployRoot}/${rel}`,
      'groundflare',
      '0644',
    )
    adapterBytes += Buffer.byteLength(content, 'utf-8')
  }

  const userEntryPath = `${deployRoot}/${artifact.userEntryRelativePath}`
  log('info', `uploading user bundle to ${userEntryPath}`)
  await uploadAsUser(ssh, userBundle, userEntryPath, 'groundflare', '0644')

  // ─── 3. systemd unit ───────────────────────────────────────────
  log('info', `installing Bun systemd unit at ${BUN_UNIT_REMOTE_PATH}`)
  await uploadAsRoot(ssh, systemdUnit, BUN_UNIT_REMOTE_PATH, '0644')

  return {
    artifactBytes: Buffer.byteLength(serverSource, 'utf-8') + adapterBytes,
    userBundleBytes: Buffer.byteLength(userBundle, 'utf-8'),
    unitBytes: Buffer.byteLength(systemdUnit, 'utf-8'),
  }
}

// ─── SSH helpers (siblings of the ones in run.ts) ─────────────────
//
// Kept local to this file so run.ts stays the single source of truth
// for the workerd path. Re-using the helpers across files would drag
// the DeployError import pattern across runtime boundaries and make
// the split harder to reason about.

async function uploadAsUser(
  ssh: SshClient,
  content: string,
  remoteFinalPath: string,
  owner: string,
  mode: string,
): Promise<void> {
  const tmpPath = `/tmp/groundflare-upload-${randomBytes(6).toString('hex')}`
  await uploadContent(ssh, content, tmpPath)
  const result = await ssh.run(
    `sudo install -m ${mode} -o ${owner} -g ${owner} ${tmpPath} ${remoteFinalPath} && rm -f ${tmpPath}`,
    { timeoutMs: 30_000 },
  )
  if (result.exitCode !== 0) {
    throw new DeployError(
      `failed to install ${remoteFinalPath}: ${result.stderr || result.stdout}`,
      'upload_failed',
    )
  }
}

async function uploadAsRoot(
  ssh: SshClient,
  content: string,
  remoteFinalPath: string,
  mode: string,
): Promise<void> {
  const tmpPath = `/tmp/groundflare-upload-${randomBytes(6).toString('hex')}`
  await uploadContent(ssh, content, tmpPath)
  const result = await ssh.run(
    `sudo install -m ${mode} -o root -g root ${tmpPath} ${remoteFinalPath} && rm -f ${tmpPath}`,
    { timeoutMs: 30_000 },
  )
  if (result.exitCode !== 0) {
    throw new DeployError(
      `failed to install ${remoteFinalPath}: ${result.stderr || result.stdout}`,
      'upload_failed',
    )
  }
}

async function uploadContent(
  ssh: SshClient,
  content: string,
  remotePath: string,
): Promise<void> {
  const localDir = await mkdtemp(join(tmpdir(), 'gf-bun-upload-'))
  const localPath = join(localDir, 'payload')
  try {
    await writeFile(localPath, content, 'utf-8')
    await ssh.upload(localPath, remotePath)
  } catch (err) {
    throw new DeployError(
      `scp ${remotePath} failed: ${err instanceof Error ? err.message : String(err)}`,
      'upload_failed',
      { cause: err },
    )
  } finally {
    await rm(localDir, { recursive: true, force: true })
  }
}

async function ensureRemoteDir(ssh: SshClient, dir: string): Promise<void> {
  const result = await ssh.run(
    `sudo mkdir -p ${dir} && sudo chown groundflare:groundflare ${dir}`,
    { timeoutMs: 10_000 },
  )
  if (result.exitCode !== 0) {
    throw new DeployError(
      `failed to create ${dir}: ${result.stderr || result.stdout}`,
      'upload_failed',
    )
  }
}
