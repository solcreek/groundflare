/**
 * Drives the bootstrap pipeline: runs each Stage in order, persisting
 * progress so a crashed/aborted run resumes from the last successful
 * stage.
 *
 * Stages declare their own `isComplete` check. The orchestrator falls
 * back to consulting `state.completedStages` when a stage doesn't
 * provide one.
 */

import { BootstrapError, type BootstrapContext, type LogFn, type Stage } from './types.js'
import type { BootstrapStateStore } from './state-store.js'

export interface OrchestratorOptions {
  readonly stateStore: BootstrapStateStore
  /** Skip the persisted-state save. Useful for dry-run-style executions. */
  readonly dryRun?: boolean
}

export class BootstrapOrchestrator {
  constructor(
    private readonly stages: readonly Stage[],
    private readonly opts: OrchestratorOptions,
  ) {
    if (stages.length === 0) {
      throw new BootstrapError('orchestrator requires at least one stage', 'prerequisite')
    }
    const seen = new Set<string>()
    for (const stage of stages) {
      if (seen.has(stage.id)) {
        throw new BootstrapError(
          `duplicate stage id ${JSON.stringify(stage.id)}`,
          'prerequisite',
        )
      }
      seen.add(stage.id)
    }
  }

  async run(ctx: BootstrapContext): Promise<void> {
    for (const stage of this.stages) {
      const log: LogFn = (level, message) =>
        ctx.log(level, `[${stage.id}] ${message}`)
      log('info', stage.description)

      const skipBecauseRecorded = ctx.state.completedStages.includes(stage.id)
      const skipBecauseCustom =
        stage.isComplete !== undefined && (await stage.isComplete(ctx))
      if (skipBecauseRecorded || skipBecauseCustom) {
        log('debug', 'already complete; skipping')
        if (!skipBecauseRecorded) {
          // The stage's own `isComplete` returned true even though the
          // state file hadn't recorded it — likely because state was
          // wiped or this is a fresh CLI run against an existing VPS.
          // Record it now so resume picks it up.
          ctx.state.completedStages.push(stage.id)
          ctx.state.updatedAt = nowIso()
          if (!this.opts.dryRun) await this.opts.stateStore.save(ctx.state)
        }
        continue
      }

      try {
        await stage.run(ctx)
      } catch (err) {
        // Persist whatever partial state the stage already wrote so a
        // resume can pick it up; surface the failure with stage id.
        ctx.state.updatedAt = nowIso()
        if (!this.opts.dryRun) {
          try {
            await this.opts.stateStore.save(ctx.state)
          } catch {
            // The save error swallows the original cause; the user gets
            // the stage error which is the more actionable one.
          }
        }
        throw new BootstrapError(
          `stage ${stage.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          'stage_failed',
          stage.id,
          { cause: err },
        )
      }

      ctx.state.completedStages.push(stage.id)
      ctx.state.updatedAt = nowIso()
      if (!this.opts.dryRun) await this.opts.stateStore.save(ctx.state)
      log('info', 'done')
    }
  }
}

function nowIso(): string {
  return new Date().toISOString()
}
