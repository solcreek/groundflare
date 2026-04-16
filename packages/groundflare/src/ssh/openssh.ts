/**
 * OpenSSH-backed implementation of the SshClient interface.
 *
 * Shells out to the system `ssh` and `scp` binaries. Pros over a pure-JS
 * library (e.g. ssh2):
 *   - Zero npm deps; reuses the user's ~/.ssh/known_hosts and agent.
 *   - Identical mental model to debugging by hand on the command line.
 *   - SSH config quirks (algorithms, ciphers, jump hosts) Just Work.
 *
 * Cons we accept:
 *   - ~30ms per-command process spawn overhead (negligible vs round-trip).
 *   - Requires OpenSSH installed (true on macOS, Linux, modern Windows).
 *
 * Spawn is injectable so the test suite can substitute a mock without
 * actually launching child processes.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { platform } from 'node:os'

import {
  SshError,
  type RunOptions,
  type RunResult,
  type SshClient,
  type SshTarget,
  type StreamLineHandler,
  type UploadOptions,
} from './types.js'

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess

export interface OpenSshClientOptions {
  readonly target: SshTarget
  /** Inject a spawn implementation for testing. Default: node:child_process spawn. */
  readonly spawnImpl?: SpawnFn
  /** Override the ssh binary name/path. Default `ssh`. */
  readonly sshBinary?: string
  /** Override the scp binary name/path. Default `scp`. */
  readonly scpBinary?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_PORT = 22
const DEFAULT_STRICT_HOST_KEY = 'accept-new'

export class OpenSshClient implements SshClient {
  private readonly target: SshTarget
  private readonly spawnImpl: SpawnFn
  private readonly sshBinary: string
  private readonly scpBinary: string

  constructor(opts: OpenSshClientOptions) {
    this.target = opts.target
    this.spawnImpl = opts.spawnImpl ?? (nodeSpawn as SpawnFn)
    this.sshBinary = opts.sshBinary ?? 'ssh'
    this.scpBinary = opts.scpBinary ?? 'scp'
  }

  async ping(): Promise<void> {
    // 30s: on fresh VPS running cloud-init, CPU can be saturated by apt
    // upgrades — SSH handshake + key exchange + auth takes >5s under load.
    const result = await this.run('true', { timeoutMs: 30_000 })
    if (result.exitCode !== 0) {
      throw new SshError(
        `ssh ping to ${this.target.host} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
        'connect_failed',
      )
    }
  }

  async run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    const args = [...this.commonSshOptions(), this.userHost(), this.wrapCommand(command, opts)]
    return runWithCollection(
      this.spawnImpl,
      this.sshBinary,
      args,
      opts.stdin,
      opts.timeoutMs ?? this.target.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  }

  async stream(
    command: string,
    onLine: StreamLineHandler,
    opts: RunOptions = {},
  ): Promise<RunResult> {
    const args = [...this.commonSshOptions(), this.userHost(), this.wrapCommand(command, opts)]
    return runWithLineStreaming(
      this.spawnImpl,
      this.sshBinary,
      args,
      opts.stdin,
      onLine,
      opts.timeoutMs ?? this.target.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  }

  async upload(
    localPath: string,
    remotePath: string,
    opts: UploadOptions = {},
  ): Promise<void> {
    const args = [
      ...this.commonScpOptions(opts),
      localPath,
      `${this.userHost()}:${remotePath}`,
    ]
    const result = await runWithCollection(
      this.spawnImpl,
      this.scpBinary,
      args,
      undefined,
      this.target.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    if (result.exitCode !== 0) {
      throw new SshError(
        `scp upload ${localPath} -> ${remotePath} failed (exit ${result.exitCode}): ${result.stderr}`,
        'transfer_failed',
      )
    }
  }

  async download(
    remotePath: string,
    localPath: string,
    opts: UploadOptions = {},
  ): Promise<void> {
    const args = [
      ...this.commonScpOptions(opts),
      `${this.userHost()}:${remotePath}`,
      localPath,
    ]
    const result = await runWithCollection(
      this.spawnImpl,
      this.scpBinary,
      args,
      undefined,
      this.target.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    if (result.exitCode !== 0) {
      throw new SshError(
        `scp download ${remotePath} -> ${localPath} failed (exit ${result.exitCode}): ${result.stderr}`,
        'transfer_failed',
      )
    }
  }

  // ─── Argument builders ─────────────────────────────────────────

  private userHost(): string {
    return `${this.target.user}@${this.target.host}`
  }

  /** SSH options applied to every connection. */
  private commonSshOptions(): string[] {
    const args: string[] = []
    args.push('-i', this.target.privateKeyPath)
    args.push('-o', 'IdentitiesOnly=yes')
    args.push(
      '-o',
      `StrictHostKeyChecking=${this.target.strictHostKeyChecking ?? DEFAULT_STRICT_HOST_KEY}`,
    )
    args.push('-o', 'BatchMode=yes')
    args.push('-o', 'ConnectTimeout=10')
    args.push('-o', 'LogLevel=ERROR')
    if (this.target.knownHostsPath !== undefined) {
      args.push('-o', `UserKnownHostsFile=${this.target.knownHostsPath}`)
    }
    if (this.target.port !== undefined && this.target.port !== DEFAULT_PORT) {
      args.push('-p', String(this.target.port))
    }
    return args
  }

  /** SCP options — same identity/known_hosts but uses `-P` for port. */
  private commonScpOptions(opts: UploadOptions): string[] {
    const args: string[] = []
    args.push('-i', this.target.privateKeyPath)
    args.push('-o', 'IdentitiesOnly=yes')
    args.push(
      '-o',
      `StrictHostKeyChecking=${this.target.strictHostKeyChecking ?? DEFAULT_STRICT_HOST_KEY}`,
    )
    args.push('-o', 'BatchMode=yes')
    args.push('-o', 'ConnectTimeout=10')
    args.push('-o', 'LogLevel=ERROR')
    if (this.target.knownHostsPath !== undefined) {
      args.push('-o', `UserKnownHostsFile=${this.target.knownHostsPath}`)
    }
    if (this.target.port !== undefined && this.target.port !== DEFAULT_PORT) {
      args.push('-P', String(this.target.port))
    }
    if (opts.recursive === true) args.push('-r')
    if (opts.preservePermissions === true) args.push('-p')
    args.push('-q')
    return args
  }

  /**
   * Wrap a remote command with optional `cd` and `export` prefixes. Quoting
   * is sh-style — the user's command is treated as raw shell input on the
   * remote side. Callers passing user-supplied values must pre-quote.
   */
  private wrapCommand(command: string, opts: RunOptions): string {
    const parts: string[] = []
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          throw new SshError(`invalid env var name: ${JSON.stringify(k)}`, 'command_failed')
        }
        parts.push(`export ${k}=${shellSingleQuote(v)}`)
      }
    }
    if (opts.cwd) {
      parts.push(`cd ${shellSingleQuote(opts.cwd)}`)
    }
    parts.push(command)
    return parts.join(' && ')
  }
}

// ─── Spawn helpers ─────────────────────────────────────────────────

function runWithCollection(
  spawnImpl: SpawnFn,
  bin: string,
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise<RunResult>((resolveFn, rejectFn) => {
    const start = Date.now()
    const child = spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    child.stdout?.on('data', (c: Buffer | string) => {
      stdoutChunks.push(typeof c === 'string' ? c : c.toString())
    })
    child.stderr?.on('data', (c: Buffer | string) => {
      stderrChunks.push(typeof c === 'string' ? c : c.toString())
    })

    child.on('error', (err) => {
      cleanup()
      rejectFn(
        new SshError(`failed to spawn ${bin}: ${err.message}`, 'connect_failed', { cause: err }),
      )
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // Force-kill if it doesn't exit shortly after SIGTERM.
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000)
      force.unref()
    }, timeoutMs)
    timer.unref()

    function cleanup(): void {
      clearTimeout(timer)
    }

    child.on('exit', (code, signal) => {
      cleanup()
      if (timedOut) {
        rejectFn(
          new SshError(
            `${bin} timed out after ${timeoutMs}ms`,
            'timeout',
          ),
        )
        return
      }
      const exitCode = code ?? (signal !== null ? 128 : -1)
      resolveFn({
        exitCode,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        durationMs: Date.now() - start,
      })
    })

    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin)
      child.stdin.end()
    } else {
      child.stdin?.end()
    }
  })
}

function runWithLineStreaming(
  spawnImpl: SpawnFn,
  bin: string,
  args: readonly string[],
  stdin: string | undefined,
  onLine: StreamLineHandler,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise<RunResult>((resolveFn, rejectFn) => {
    const start = Date.now()
    const child = spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdoutBuf = ''
    let stderrBuf = ''
    let stdoutTotal = ''
    let stderrTotal = ''

    function flush(buf: string, source: 'stdout' | 'stderr'): string {
      let remaining = buf
      let nl = remaining.indexOf('\n')
      while (nl !== -1) {
        const line = remaining.slice(0, nl)
        onLine(line, source)
        remaining = remaining.slice(nl + 1)
        nl = remaining.indexOf('\n')
      }
      return remaining
    }

    child.stdout?.on('data', (c: Buffer | string) => {
      const text = typeof c === 'string' ? c : c.toString()
      stdoutTotal += text
      stdoutBuf = flush(stdoutBuf + text, 'stdout')
    })
    child.stderr?.on('data', (c: Buffer | string) => {
      const text = typeof c === 'string' ? c : c.toString()
      stderrTotal += text
      stderrBuf = flush(stderrBuf + text, 'stderr')
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      rejectFn(
        new SshError(`failed to spawn ${bin}: ${err.message}`, 'connect_failed', { cause: err }),
      )
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000)
      force.unref()
    }, timeoutMs)
    timer.unref()

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      // Drain any final partial line.
      if (stdoutBuf.length > 0) onLine(stdoutBuf, 'stdout')
      if (stderrBuf.length > 0) onLine(stderrBuf, 'stderr')
      if (timedOut) {
        rejectFn(new SshError(`${bin} timed out after ${timeoutMs}ms`, 'timeout'))
        return
      }
      const exitCode = code ?? (signal !== null ? 128 : -1)
      resolveFn({
        exitCode,
        stdout: stdoutTotal,
        stderr: stderrTotal,
        durationMs: Date.now() - start,
      })
    })

    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin)
      child.stdin.end()
    } else {
      child.stdin?.end()
    }
  })
}

// ─── Quoting ──────────────────────────────────────────────────────

/**
 * sh-safe single quote: wraps in `'...'` and escapes embedded single quotes
 * via the standard `'\''` sequence.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Returns true if the platform's shell is POSIX-y (macOS/Linux/WSL). */
export function isPosixShell(): boolean {
  return platform() !== 'win32'
}
