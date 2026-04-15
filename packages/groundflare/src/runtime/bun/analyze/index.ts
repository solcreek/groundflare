/**
 * `groundflare bun analyze` core — read wrangler.toml, walk the source
 * tree, classify findings, return an AnalysisReport. Stays I/O-free in
 * its hot path: callers pass in a {readFile, listFiles} adapter so the
 * unit tests don't touch the filesystem.
 *
 * The CLI command in `src/cli/commands/bun.ts` wires this to the real
 * filesystem.
 */

import { posix } from 'node:path'
import type { WranglerConfig } from '../../../config/schema.js'
import { classifyBindings } from './classify.js'
import { scanFile, type RawEnvAccess } from './scan-file.js'
import type {
  AnalysisReport,
  AnalysisSummary,
  Finding,
  Severity,
} from './types.js'

export type { AnalysisReport, AnalysisSummary, Finding, Severity, FindingKind } from './types.js'
export type { RawEnvAccess } from './scan-file.js'
export { renderHuman, renderJson } from './report.js'
export { scanFile } from './scan-file.js'
export { classifyBindings } from './classify.js'

export interface AnalyzeFs {
  /** Return source-file paths (relative to projectRoot) under sourceRoot. */
  listSourceFiles(sourceRoot: string): Promise<string[]>
  /** Read a source file as UTF-8 text. */
  readSource(relPath: string): Promise<string>
}

export interface AnalyzeOptions {
  wrangler: WranglerConfig
  /**
   * Directory the analyzer walks looking for source files. Relative
   * paths in the report are computed against this. Default: parent of
   * wrangler.main, or the project root if main is unset.
   */
  sourceRoot: string
  fs: AnalyzeFs
}

export async function analyzeWorkspace(
  opts: AnalyzeOptions,
): Promise<AnalysisReport> {
  const files = await opts.fs.listSourceFiles(opts.sourceRoot)
  const sourceFindings: Finding[] = []
  const allEnvAccesses: RawEnvAccess[] = []

  for (const rel of files) {
    const source = await opts.fs.readSource(rel)
    const result = scanFile(rel, source)
    if (result.parseError) {
      sourceFindings.push({
        kind: 'unknown-env-access',
        severity: 'review-needed',
        message: `parse error: ${result.parseError.message}`,
        location: { file: rel, line: 1, column: 1 },
      })
      continue
    }
    sourceFindings.push(...result.findings)
    allEnvAccesses.push(...result.envAccesses)
  }

  const bindingFindings = classifyBindings({
    wrangler: opts.wrangler,
    envAccesses: allEnvAccesses,
  })

  const findings = [...bindingFindings, ...sourceFindings].sort(compareFindings)

  const summary = summarize(findings)
  const verdict =
    summary.blockers > 0
      ? 'blocked'
      : summary.reviewNeeded > 0
        ? 'needs-changes'
        : 'ready'

  return {
    workerName: opts.wrangler.name,
    sourceRoot: opts.sourceRoot,
    filesScanned: files.length,
    findings,
    summary,
    verdict,
  }
}

function summarize(findings: readonly Finding[]): AnalysisSummary {
  let compatible = 0
  let reviewNeeded = 0
  let blockers = 0
  for (const f of findings) {
    if (f.severity === 'compatible') compatible++
    else if (f.severity === 'review-needed') reviewNeeded++
    else blockers++
  }
  return { compatible, reviewNeeded, blockers }
}

function compareFindings(a: Finding, b: Finding): number {
  const sev = severityOrder(a.severity) - severityOrder(b.severity)
  if (sev !== 0) return sev
  if (a.location && b.location) {
    const f = a.location.file.localeCompare(b.location.file)
    if (f !== 0) return f
    if (a.location.line !== b.location.line)
      return a.location.line - b.location.line
    return a.location.column - b.location.column
  }
  if (a.location && !b.location) return 1 // bindings first within a severity bucket
  if (!a.location && b.location) return -1
  return a.kind.localeCompare(b.kind)
}

function severityOrder(s: Severity): number {
  // Compatible first, blockers last — matches how the human report renders.
  if (s === 'compatible') return 0
  if (s === 'review-needed') return 1
  return 2
}

/** Re-exported so callers don't import from posix directly. */
export const joinPosix = posix.join
