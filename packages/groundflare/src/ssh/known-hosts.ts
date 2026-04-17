/**
 * `ssh-keygen -R <host>` wrapper — purge stale host-key entries from
 * `~/.ssh/known_hosts`.
 *
 * Motivation: when a VPS is destroyed and the provider later reassigns
 * the same public IP to a fresh droplet, the operator's local
 * `known_hosts` still caches the *old* host's public key. OpenSSH's
 * default `StrictHostKeyChecking=accept-new` then refuses the new
 * connection with a scary "host key for <ip> has changed" error —
 * annoying when you know full well why.
 *
 * Destroy is the obvious place to clean up: at destroy time we know
 * the entries are stale, and the box is gone so TOFU is moot. We do
 * NOT clean up at provision time because a mid-flight entry is
 * sometimes the *correct* one (e.g. interrupted bootstrap being
 * resumed).
 *
 * Best-effort by contract: `ssh-keygen` exits 0 when nothing matched,
 * so the common case is quiet no-op. When things do go wrong
 * (binary missing on Windows without OpenSSH, read-only FS, locked
 * file) we surface per-host errors in the result rather than
 * throwing — callers should log them but keep going; a lingering
 * stale entry is irritating, not destructive.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess

export interface KnownHostsCleanupResult {
  readonly removed: readonly string[]
  readonly errors: readonly { host: string; message: string }[]
}

export interface RemoveKnownHostsOptions {
  /** Inject a spawn impl for tests. Defaults to node:child_process spawn. */
  readonly spawnImpl?: SpawnFn
  /** Override the ssh-keygen binary. Defaults to `ssh-keygen` on $PATH. */
  readonly binary?: string
}

/**
 * Remove matching host-key entries from the default known_hosts file
 * for each host in the list. Accepts bare hosts (IPv4 / IPv6 /
 * hostname) and OpenSSH's bracketed port form `[host]:port` when a
 * non-standard port is in play.
 *
 * Duplicates + empty strings are silently skipped.
 */
export async function removeKnownHostsEntries(
  hosts: readonly string[],
  opts: RemoveKnownHostsOptions = {},
): Promise<KnownHostsCleanupResult> {
  const spawnImpl = opts.spawnImpl ?? (nodeSpawn as SpawnFn)
  const binary = opts.binary ?? 'ssh-keygen'
  const seen = new Set<string>()
  const removed: string[] = []
  const errors: { host: string; message: string }[] = []
  for (const host of hosts) {
    if (host === '' || seen.has(host)) continue
    seen.add(host)
    try {
      await runSshKeygenRemove(spawnImpl, binary, host)
      removed.push(host)
    } catch (err) {
      errors.push({
        host,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { removed, errors }
}

function runSshKeygenRemove(
  spawnImpl: SpawnFn,
  binary: string,
  host: string,
): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawnImpl(binary, ['-R', host], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const errChunks: string[] = []
    child.stderr?.on('data', (c: Buffer | string) => {
      errChunks.push(typeof c === 'string' ? c : c.toString())
    })
    child.on('error', (err) => {
      rejectFn(new Error(`failed to spawn ${binary}: ${err.message}`))
    })
    child.on('exit', (code, signal) => {
      if (code === 0) return resolveFn()
      const detail = errChunks.join('').trim()
      rejectFn(
        new Error(
          `${binary} -R ${host} exited ${code ?? `signal ${signal}`}${detail !== '' ? `: ${detail}` : ''}`,
        ),
      )
    })
  })
}
