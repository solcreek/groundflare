/**
 * Bootstrap orchestrator types.
 *
 * The orchestrator drives the 10-stage pipeline from design/bootstrap.md.
 * Every stage is idempotent (re-running is a no-op when the state already
 * indicates completion) and the orchestrator persists progress so a
 * crash mid-bootstrap can resume from the last successful stage.
 *
 * Stages live in src/bootstrap/stages/. The orchestrator itself stays
 * stage-agnostic so adding/reordering stages doesn't require framework
 * changes.
 */

import type { Provider, ProviderName } from '../provider/index.js'
import type { SecretStore } from '../secret/index.js'
import type { SshClient } from '../ssh/index.js'

export interface BootstrapState {
  /** Stable workspace name supplied by the operator. */
  workspace: string
  provider: ProviderName
  /** Stage IDs (e.g. `provider.auth`) that completed successfully. */
  completedStages: string[]
  /** ISO timestamps. */
  startedAt: string
  updatedAt: string

  // ─── Per-stage outputs (added incrementally as the pipeline runs) ───

  /** Set after Stage 0 (auth). */
  account?: {
    id: string
    name: string
  }

  /** Set after Stage 1 (ssh-key). */
  sshKey?: {
    /** Provider-side ID for the uploaded public key. */
    providerId: string
    fingerprint: string
    /** Local path to the private key on the operator's machine. */
    localPath: string
    /** Local path to the public key on the operator's machine. */
    localPublicPath: string
  }

  /** Set after Stage 2 (provision). */
  vps?: {
    id: string
    ipv4: string
    ipv6?: string
    /** Non-standard SSH port (test harness only; real providers use 22). */
    port?: number
    size: string
    region: string
    /** `groundflare`, `root`, etc. */
    user: string
  }
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

export type LogFn = (level: LogLevel, message: string) => void

export interface BootstrapContext {
  readonly workspace: string
  readonly provider: Provider
  readonly secrets: SecretStore
  readonly state: BootstrapState
  readonly log: LogFn
  /**
   * Populated by Stage 3 (wait-ssh) — earlier stages don't have an SSH
   * client yet. Stage implementations that need SSH should assert this
   * is set and throw a clear error if it isn't.
   */
  ssh?: SshClient
}

/**
 * One step in the bootstrap pipeline. Both methods receive the shared
 * BootstrapContext; a stage may mutate `ctx.state` to record output for
 * subsequent stages or for resume. The orchestrator persists `ctx.state`
 * after every successful stage.
 */
export interface Stage {
  /** Stable identifier — also the key persisted in `state.completedStages`. */
  readonly id: string
  /** Human-readable one-liner shown in CLI output. */
  readonly description: string

  /**
   * Quick check before running. Return `true` to skip the stage; the
   * orchestrator still records the stage as completed if the check passes.
   * Default behaviour (when omitted) is to consult `state.completedStages`.
   */
  isComplete?(ctx: BootstrapContext): Promise<boolean>

  /**
   * Perform the stage's work. Throw to abort the pipeline; partial state
   * is preserved so a resume picks up where the failure happened.
   */
  run(ctx: BootstrapContext): Promise<void>
}

export class BootstrapError extends Error {
  constructor(
    message: string,
    /**
     * Stable code:
     *   - `stage_failed`     a stage threw mid-execution
     *   - `prerequisite`     a required state field was missing
     *   - `state_corrupt`    the persisted state file failed to parse
     *   - `state_io`         couldn't read/write the state file
     */
    public readonly code: string,
    /** Stage ID where the failure occurred, if applicable. */
    public readonly stageId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'BootstrapError'
  }
}
