/**
 * Atomic multi-file install helper — shared between the workerd and Bun
 * deploy paths.
 *
 * Given N files (each with a remote destination, owner, and mode) and a
 * list of groundflare-owned dirs that must exist beforehand:
 *
 *   1. scp every file content to `/tmp/gf-stage-<runId>-<i>`. The
 *      destinations stay untouched on any scp failure.
 *   2. Run ONE `sudo sh -s` command, feeding the install script via
 *      stdin. `set -e` aborts on the first install failure. The script
 *      mkdirs+chowns every groundflare-owned dir, then `install`s each
 *      staged file into its final location, then rms the staging
 *      files.
 *
 * Why stdin-fed-script: building one long `sudo sh -c '…'` risks
 * shell-quoting footguns on any interpolated content. With stdin
 * delivery, the script body itself is data, not a command argument.
 * Embedded paths still inherit the assumption that worker names are
 * shell-safe identifiers (wrangler upstream enforces `[a-z0-9][a-z0-9-]*`).
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SshClient } from '../ssh/index.js'
import { DeployError } from './types.js'

export interface AtomicInstallFile {
  readonly content: string
  readonly remotePath: string
  readonly owner: 'root' | 'groundflare'
  readonly mode: string
}

export interface AtomicInstallOptions {
  readonly files: readonly AtomicInstallFile[]
  /** Dirs to mkdir + chown groundflare:groundflare before installing. */
  readonly groundflareOwnedDirs: readonly string[]
}

export async function atomicInstall(
  ssh: SshClient,
  opts: AtomicInstallOptions,
): Promise<void> {
  const runId = randomBytes(6).toString('hex')
  const stagedPaths = opts.files.map((_, i) => `/tmp/gf-stage-${runId}-${i}`)

  try {
    for (let i = 0; i < opts.files.length; i++) {
      await uploadContent(ssh, opts.files[i]!.content, stagedPaths[i]!)
    }

    const lines: string[] = ['set -e']
    for (const dir of opts.groundflareOwnedDirs) {
      lines.push(`mkdir -p ${dir}`)
      lines.push(`chown groundflare:groundflare ${dir}`)
    }
    opts.files.forEach((f, i) => {
      lines.push(
        `install -m ${f.mode} -o ${f.owner} -g ${f.owner} ${stagedPaths[i]} ${f.remotePath}`,
      )
    })
    lines.push(`rm -f ${stagedPaths.join(' ')}`)
    const script = lines.join('\n') + '\n'

    const result = await ssh.run('sudo sh -s', {
      stdin: script,
      timeoutMs: 60_000,
    })
    if (result.exitCode !== 0) {
      throw new DeployError(
        `atomic install failed: ${result.stderr || result.stdout}`,
        'upload_failed',
      )
    }
  } catch (err) {
    // Best-effort cleanup of the staging area so repeated deploys
    // don't accumulate /tmp junk. Failures here are ignored.
    await ssh
      .run(`rm -f ${stagedPaths.join(' ')}`, { timeoutMs: 10_000 })
      .catch(() => {})
    throw err
  }
}

export async function uploadContent(
  ssh: SshClient,
  content: string,
  remotePath: string,
): Promise<void> {
  const localDir = await mkdtemp(join(tmpdir(), 'gf-stage-'))
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
