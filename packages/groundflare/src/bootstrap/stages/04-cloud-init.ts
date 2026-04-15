/**
 * Stage 4 — Wait for cloud-init to finish.
 *
 * cloud-init runs once on first boot to install packages, create the
 * groundflare user, configure UFW + fail2ban, etc. (see
 * src/runtime/bootstrap/cloud-init.ts for the user-data we generate.)
 *
 * `cloud-init status --wait` blocks until cloud-init reaches `done` or
 * `error`. Returns instantly if it's already done — safe to re-run.
 *
 * The default timeout is generous (10 minutes): cloud-init does
 * package_update + package_upgrade which can take several minutes on a
 * cold image, especially in regions with slow apt mirrors.
 */

import { BootstrapError, type Stage } from '../types.js'

const STAGE_ID = 'system.cloud-init'

export interface CloudInitStageOptions {
  /** Timeout for the SSH command. Default 10 minutes. */
  readonly timeoutMs?: number
}

export function cloudInitStage(opts: CloudInitStageOptions = {}): Stage {
  return {
    id: STAGE_ID,
    description: 'Wait for cloud-init to finish first-boot setup',

    async run(ctx) {
      if (!ctx.ssh) {
        throw new BootstrapError(
          'cloud-init wait requires the wait-ssh stage to have completed first',
          'prerequisite',
          STAGE_ID,
        )
      }

      const timeoutMs = opts.timeoutMs ?? 10 * 60_000
      ctx.log('info', 'waiting for `cloud-init status --wait` (this can take several minutes)')

      const result = await ctx.ssh.run('sudo cloud-init status --wait', { timeoutMs })

      if (result.exitCode !== 0) {
        throw new BootstrapError(
          `cloud-init exited non-zero (${result.exitCode}); stderr:\n${result.stderr.slice(0, 4000)}`,
          'stage_failed',
          STAGE_ID,
        )
      }

      ctx.log('info', `cloud-init complete (took ${result.durationMs}ms)`)
    },
  }
}
