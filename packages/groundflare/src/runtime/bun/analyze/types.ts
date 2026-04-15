/**
 * Shared types for `groundflare bun analyze`.
 *
 * The analyzer reads wrangler.toml + the worker source and emits a
 * structured report describing what would happen if the worker was
 * migrated to the Bun track. Three severity levels:
 *
 *   compatible    — works on Bun without code changes (most bindings)
 *   review-needed — likely to work but warrants manual inspection
 *                   (e.g. caches.default has a different fallback shape)
 *   blocker       — requires source rewrite or has no Bun analogue
 *                   (e.g. Durable Objects, HTMLRewriter)
 *
 * The CLI exits with non-zero status if any blocker findings are present,
 * matching the contract documented in design/tracks.md §`bun analyze`.
 */

export type Severity = 'compatible' | 'review-needed' | 'blocker'

/**
 * Categories the analyzer reports on. Stable strings — the JSON output
 * is a documented surface. Keep in sync with the compatibility matrix in
 * design/tracks.md.
 */
export type FindingKind =
  // ── compatible ────────────────────────────────────────────────────
  | 'fetch-handler'
  | 'scheduled-handler'
  | 'kv-binding'
  | 'd1-binding'
  | 'r2-binding'
  | 'vars-binding'
  | 'service-binding'
  // ── review-needed ─────────────────────────────────────────────────
  | 'cache-api'
  | 'wait-until'
  | 'unknown-env-access'
  // ── blocker ───────────────────────────────────────────────────────
  | 'durable-object-binding'
  | 'durable-object-class'
  | 'html-rewriter'
  | 'web-socket-pair'

export interface FindingLocation {
  /** Path relative to the project root, or absolute if outside. */
  file: string
  line: number
  column: number
}

export interface Finding {
  kind: FindingKind
  severity: Severity
  /** Short human-readable message, single line. */
  message: string
  /** Optional source location. Bindings declared in wrangler.toml have no location. */
  location?: FindingLocation
  /** Optional context — e.g. binding name for env.X access. */
  detail?: string
}

export interface AnalysisSummary {
  compatible: number
  reviewNeeded: number
  blockers: number
}

export interface AnalysisReport {
  /** Worker name from wrangler.toml. */
  workerName: string
  /** Source root that was scanned. */
  sourceRoot: string
  /** Number of source files scanned. */
  filesScanned: number
  /** Findings grouped by severity (each list ordered by file:line). */
  findings: Finding[]
  summary: AnalysisSummary
  /**
   * Top-line verdict — derived from `summary.blockers === 0`. Surfaces
   * directly in the human report so callers don't recompute.
   */
  verdict: 'ready' | 'needs-changes' | 'blocked'
}
