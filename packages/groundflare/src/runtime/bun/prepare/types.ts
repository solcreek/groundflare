/**
 * Result shape for `groundflare bun prepare`.
 *
 * The `actions` list is deliberately structured (not a free-form log)
 * so the CLI can render it consistently and, later, so a `--json`
 * flag can round-trip it to tooling.
 */

import type { AnalysisReport } from '../analyze/index.js'

export type PrepareActionKind =
  | 'runtime-set-bun'       // wrangler.toml [groundflare].runtime flipped
  | 'runtime-already-bun'   // no change needed; already on the Bun track
  | 'runtime-appended'      // [groundflare] section created from scratch
  | 'dry-run'               // --dry-run: would have written

export interface PrepareAction {
  kind: PrepareActionKind
  /** Path that was (or would have been) modified. */
  file: string
  /** Short human-readable description for the CLI report. */
  message: string
}

export interface PrepareResult {
  /** Analysis that was run first. Always present — prepare gates on it. */
  analysis: AnalysisReport
  /**
   * True if prepare succeeded in full. False if blockers forced a bail
   * before any side effects (actions will be empty, analysis carries
   * the detail).
   */
  ok: boolean
  actions: PrepareAction[]
  /**
   * Reason prepare refused to proceed, if any. Populated iff `ok === false`.
   */
  bailReason?: string
}
