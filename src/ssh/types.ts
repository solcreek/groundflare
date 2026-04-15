/**
 * SSH client abstraction.
 *
 * groundflare uses SSH for two distinct purposes:
 *   1. Bootstrap — run apt-install + write systemd units + reload daemons.
 *   2. Operate — `groundflare tail` streams journald, `deploy` SCPs
 *      bundles up, `status` runs systemctl/curl probes.
 *
 * The interface here is implementation-agnostic; the OpenSshClient in
 * src/ssh/openssh.ts shells out to the system `ssh`/`scp` binaries
 * (zero npm deps, reuses ~/.ssh known_hosts), and a future ssh2-based
 * implementation could slot in by satisfying the same interface.
 */

export interface SshTarget {
  /** IP address or DNS name of the VPS. */
  readonly host: string
  /** Port. Default 22. */
  readonly port?: number
  /** Remote user. groundflare provisions VPSes with a `groundflare` user. */
  readonly user: string
  /** Path to the SSH private key (passed via `-i`). */
  readonly privateKeyPath: string
  /**
   * Path to a known_hosts file to use exclusively. If omitted, OpenSSH
   * uses the user's ~/.ssh/known_hosts plus system files.
   */
  readonly knownHostsPath?: string
  /**
   * Default `accept-new` — auto-trust on first connection but reject
   * subsequent key changes (TOFU). Set to `yes` for production where
   * the host key has been pre-pinned by the bootstrap stage.
   */
  readonly strictHostKeyChecking?: 'yes' | 'no' | 'accept-new'
  /** Per-command default timeout (ms). Overridable per call. */
  readonly defaultTimeoutMs?: number
}

export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** Wall-clock duration of the command in milliseconds. */
  readonly durationMs: number
}

export interface RunOptions {
  /** String fed to the remote process's stdin. */
  readonly stdin?: string
  /** Remote working directory (`cd <cwd> && <command>`). */
  readonly cwd?: string
  /** Remote env vars (`export K=V; <command>`). */
  readonly env?: Record<string, string>
  /** Override per-command timeout in milliseconds. */
  readonly timeoutMs?: number
}

export type StreamLineHandler = (line: string, source: 'stdout' | 'stderr') => void

export interface UploadOptions {
  /** Required for directories. */
  readonly recursive?: boolean
  /** Preserve file mode + atime/mtime (`-p`). */
  readonly preservePermissions?: boolean
}

/**
 * Errors thrown by the client. `code` is a stable string the caller can
 * match on; `cause` carries the underlying error if any.
 */
export class SshError extends Error {
  constructor(
    message: string,
    /**
     * Stable machine-readable code:
     *   - `connect_failed`     network or auth failure during handshake
     *   - `command_failed`     remote process exited non-zero
     *   - `timeout`            command exceeded its timeout
     *   - `transfer_failed`    scp/sftp returned non-zero
     *   - `not_ready`          waitForSshTcpReady timed out
     */
    public readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'SshError'
  }
}

export interface SshClient {
  /** Run a quick noop command to confirm the connection works. */
  ping(): Promise<void>

  /** Run a command on the remote host; resolves with stdout/stderr/exit. */
  run(command: string, options?: RunOptions): Promise<RunResult>

  /**
   * Run a command, streaming stdout + stderr line-by-line via the handler.
   * Resolves once the command exits. Useful for `groundflare tail`.
   */
  stream(
    command: string,
    onLine: StreamLineHandler,
    options?: RunOptions,
  ): Promise<RunResult>

  /** Upload a local file/directory to a remote path. */
  upload(localPath: string, remotePath: string, options?: UploadOptions): Promise<void>

  /** Download a remote file/directory to a local path. */
  download(remotePath: string, localPath: string, options?: UploadOptions): Promise<void>
}

// ─── TCP readiness probe ──────────────────────────────────────────

export interface WaitForSshOptions {
  readonly host: string
  readonly port?: number
  /** Total wall-clock budget. Default 120_000 (2 minutes). */
  readonly maxWaitMs?: number
  /** Sleep between probes. Default 3000 (3 seconds). */
  readonly intervalMs?: number
  /** Connect attempt timeout per probe. Default 5000. */
  readonly perAttemptTimeoutMs?: number
}
