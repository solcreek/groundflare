/**
 * Deploy pipeline types.
 *
 * `runDeploy()` orchestrates the steps the CLI's `groundflare deploy`
 * command (and `groundflare up`'s deploy phase) runs after bootstrap is
 * complete: bundle the user's Worker code, render the capnp + Caddyfile,
 * push everything to the VPS, restart systemd units, probe /health.
 */

import type { BootstrapState, LogFn } from '../bootstrap/index.js'
import type { SshClient } from '../ssh/index.js'

export interface RunDeployOptions {
  /** Workspace name (matches the bootstrap state file). */
  readonly workspace: string

  /** Directory containing wrangler.toml. Defaults to process.cwd(). */
  readonly workingDirectory?: string

  /**
   * Bootstrap state for this workspace. Loaded by the CLI before calling
   * runDeploy; contains the VPS IPv4 + SSH key path the deploy needs.
   */
  readonly bootstrapState: BootstrapState

  /**
   * Pre-built SshClient. When omitted, runDeploy constructs an
   * OpenSshClient from the bootstrap state. Tests inject a mock here.
   */
  readonly ssh?: SshClient

  /**
   * ACME email for Caddy's Let's Encrypt registration. Reused from the
   * bootstrap's acmeEmail option — the CLI passes the same value through.
   */
  readonly acmeEmail: string

  /** Optional progress logger. Defaults to a stderr writer. */
  readonly log?: LogFn

  /**
   * Skip the actual SSH steps — renders the bundle + configs but doesn't
   * push anything. Useful for `groundflare deploy --dry-run` to preview.
   */
  readonly dryRun?: boolean
}

export interface DeployResult {
  readonly workspace: string
  /**
   * Which runtime this deploy targeted. Mirror ("workerd") is the
   * default when wrangler's `[groundflare] runtime` is unset; Bun-track
   * deploys require `runtime = "bun"` (usually set by
   * `groundflare bun prepare`).
   */
  readonly runtime: 'workerd' | 'bun'
  readonly tenants: readonly TenantDeployResult[]
  /**
   * Bytes of the workerd capnp config uploaded. Zero on Bun-track
   * deploys (the equivalent content ships as server.ts + adapter
   * sources, counted separately in bunArtifactBytes).
   */
  readonly capnpBytes: number
  /**
   * Bytes of the Bun-track artifact (server.ts + adapters/*.ts) uploaded.
   * Zero on workerd-track deploys.
   */
  readonly bunArtifactBytes: number
  readonly caddyfileBytes: number
  readonly healthCheck?: {
    readonly status: number
    readonly durationMs: number
  }
  readonly dryRun: boolean
}

export interface TenantDeployResult {
  readonly name: string
  readonly domain: string | undefined
  readonly bundleBytes: number
}

export class DeployError extends Error {
  constructor(
    message: string,
    /**
     * Stable codes:
     *   - `config_missing`       no wrangler.toml in the workingDirectory
     *   - `bundle_failed`        esbuild reported errors
     *   - `not_bootstrapped`     the supplied state has no VPS IP
     *   - `upload_failed`        scp returned non-zero
     *   - `restart_failed`       systemctl restart fell over
     *   - `health_failed`        post-restart probe didn't return 200
     */
    public readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'DeployError'
  }
}
