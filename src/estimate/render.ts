/**
 * Terminal renderer for `groundflare estimate`.
 *
 * Plain ASCII box — no colour, no unicode tricks. Readable in dumb
 * terminals and pipeable through `tee` without breaking.
 */

import type { Estimate } from './types.js'

const WIDTH = 56

export function renderEstimate(estimate: Estimate): string {
  const lines: string[] = []
  lines.push(topBorder())
  lines.push(center('groundflare estimate'))
  lines.push(center(`Workload profile: ${profileLabel(estimate.profile)}`))
  lines.push(center(`Confidence: ${estimate.confidence}`))
  lines.push(separator())
  lines.push(blank())

  lines.push(costRow(`Current Cloudflare`, estimate.current.monthly, estimate.currency, true))
  for (const line of estimate.current.breakdown) {
    lines.push(costSubRow(line.label, line.amount, estimate.currency))
  }
  lines.push(blank())

  lines.push(
    costRow(
      `Target: Hetzner ${estimate.target.tier.toUpperCase()}`,
      estimate.target.monthly,
      estimate.currency,
      true,
    ),
  )
  for (const line of estimate.target.breakdown) {
    lines.push(costSubRow(line.label, line.amount, estimate.currency))
  }
  lines.push(blank())

  lines.push(separator())
  lines.push(savingsLine(estimate))
  lines.push(blank())

  if (estimate.warnings.length > 0) {
    lines.push(row(`Warnings:`))
    for (const w of estimate.warnings) {
      lines.push(row(`  - ${w.message}`))
    }
    lines.push(blank())
  }

  lines.push(row(`Prices: ${estimate.pricesUpdated}`))
  if (estimate.priceSources && estimate.priceSources.length > 0) {
    for (const src of estimate.priceSources) {
      const tag = src.kind === 'live' ? 'live' : 'baked'
      const extra =
        src.kind === 'live' && src.fetchedAt
          ? ` (${src.fetchedAt.slice(0, 10)})`
          : src.reason
            ? ` — ${src.reason}`
            : ''
      lines.push(row(`  ${src.provider}: ${tag}${extra}`))
    }
  }
  lines.push(bottomBorder())
  return lines.join('\n')
}

function topBorder(): string {
  return '+' + '-'.repeat(WIDTH - 2) + '+'
}
function bottomBorder(): string {
  return topBorder()
}
function separator(): string {
  return '+' + '-'.repeat(WIDTH - 2) + '+'
}
function blank(): string {
  return '|' + ' '.repeat(WIDTH - 2) + '|'
}
function center(text: string): string {
  const inner = WIDTH - 2
  const padTotal = Math.max(0, inner - text.length)
  const left = Math.floor(padTotal / 2)
  const right = padTotal - left
  return '|' + ' '.repeat(left) + text + ' '.repeat(right) + '|'
}
function row(text: string): string {
  const inner = WIDTH - 4 // two spaces of padding
  const truncated = text.length > inner ? text.slice(0, inner - 1) + '…' : text
  return '| ' + truncated + ' '.repeat(inner - truncated.length) + ' |'
}

function costRow(label: string, amount: number, currency: string, bold: boolean): string {
  const left = bold ? label : `  ${label}`
  const right = `${formatMoney(amount, currency)}/mo`
  return padRow(left, right)
}

function costSubRow(label: string, amount: number, currency: string): string {
  return padRow(`  ${label}`, formatMoney(amount, currency))
}

function savingsLine(estimate: Estimate): string {
  const s = estimate.savings
  if (s.monthly <= 0) {
    return row(
      `No savings at this workload size — CF is already the cheaper path.`,
    )
  }
  const line =
    `Savings: ${formatMoney(s.monthly, estimate.currency)}/mo ` +
    `(${formatMoney(s.annual, estimate.currency)}/yr, ${s.percent.toFixed(0)}%)`
  return row(line)
}

function padRow(left: string, right: string): string {
  const inner = WIDTH - 4
  const gap = Math.max(1, inner - left.length - right.length)
  return '| ' + left + ' '.repeat(gap) + right + ' |'
}

function profileLabel(profile: string): string {
  switch (profile) {
    case 'A':
      return 'A (typical micro-SaaS)'
    case 'B':
      return 'B (media-heavy)'
    case 'C':
      return 'C (compute-heavy)'
    case 'D':
      return 'D (data-heavy)'
    default:
      return profile
  }
}

function formatMoney(amount: number, currency: string): string {
  const symbol = currency === 'EUR' ? 'EUR ' : '$'
  return `${symbol}${amount.toFixed(2)}`
}
