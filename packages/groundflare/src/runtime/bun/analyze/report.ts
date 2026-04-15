/**
 * Render an AnalysisReport as either machine-readable JSON or a
 * human-friendly summary suitable for a terminal.
 *
 * Both renderers are pure string-producers so the CLI can swap in a
 * `--json` flag without branching deep inside command code.
 */

import type { AnalysisReport, Finding, Severity } from './types.js'

const SEVERITY_LABEL: Record<Severity, string> = {
  compatible: '✓',
  'review-needed': '⚠',
  blocker: '✗',
}

const SEVERITY_HEADER: Record<Severity, string> = {
  compatible: 'Can migrate as-is',
  'review-needed': 'Needs review',
  blocker: 'Cannot migrate',
}

export function renderJson(report: AnalysisReport): string {
  return JSON.stringify(report, null, 2)
}

export function renderHuman(report: AnalysisReport): string {
  const lines: string[] = []
  lines.push(
    `Analyzing worker "${report.workerName}" — ${report.filesScanned} source ${
      report.filesScanned === 1 ? 'file' : 'files'
    } in ${report.sourceRoot}`,
  )
  lines.push('')

  for (const severity of [
    'compatible',
    'review-needed',
    'blocker',
  ] as Severity[]) {
    const items = report.findings.filter((f) => f.severity === severity)
    if (items.length === 0) continue
    lines.push(`${SEVERITY_LABEL[severity]} ${SEVERITY_HEADER[severity]}:`)
    for (const f of items) {
      lines.push(`  - ${f.message}${formatLocation(f)}`)
    }
    lines.push('')
  }

  lines.push(verdictLine(report))
  return lines.join('\n')
}

function formatLocation(f: Finding): string {
  if (!f.location) return ''
  return `  (${f.location.file}:${f.location.line}:${f.location.column})`
}

function verdictLine(report: AnalysisReport): string {
  switch (report.verdict) {
    case 'ready':
      return `Ready for the Bun track. Run \`groundflare bun prepare\` next.`
    case 'needs-changes':
      return `Migration is possible but ${pluralize(
        report.summary.reviewNeeded,
        'item',
      )} need${report.summary.reviewNeeded === 1 ? 's' : ''} review first.`
    case 'blocked':
      return `Bun track not viable: ${pluralize(
        report.summary.blockers,
        'blocker',
      )} found. Stay on the Mirror (workerd) track.`
  }
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
