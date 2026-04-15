/**
 * Translator: Unix cron expression → systemd `OnCalendar=` value.
 *
 * groundflare uses systemd timers (one .timer + .service pair per cron
 * entry) to fire scheduled events, because:
 *   - OS-native scheduler, no extra daemon
 *   - `Persistent=true` catches up missed triggers across VPS downtime
 *   - `systemctl list-timers` + journald make observability trivial
 *
 * Cron and systemd OnCalendar have different grammars; this module
 * converts the common patterns CF Workers users actually write.
 * Complex expressions (ranges, comma lists in non-DOW fields) throw
 * UnsupportedCronError — see design/workspaces.md open questions. A
 * richer translator can land without API churn as more real-world
 * examples emerge.
 *
 * Supported forms:
 *   *          every value
 *   N          specific value (decimal integer)
 *   *\/N       every N (step starting at 0)
 *   DOW only:  lists "0,1,5" and ranges "1-5" (for weekday names)
 */

export class UnsupportedCronError extends Error {
  constructor(message: string, public readonly expression: string) {
    super(`Unsupported cron expression ${JSON.stringify(expression)}: ${message}`)
    this.name = 'UnsupportedCronError'
  }
}

export type CronField =
  | { readonly kind: 'any' }
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'step'; readonly step: number }

export type WeekdayField =
  | CronField
  | { readonly kind: 'list'; readonly values: readonly number[] }
  | { readonly kind: 'range'; readonly from: number; readonly to: number }

export interface CronFields {
  readonly minute: CronField
  readonly hour: CronField
  readonly day: CronField
  readonly month: CronField
  readonly weekday: WeekdayField
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new UnsupportedCronError(
      `expected 5 whitespace-separated fields, got ${parts.length}`,
      expr,
    )
  }
  return {
    minute: parseSimpleField(parts[0]!, 0, 59, 'minute', expr),
    hour: parseSimpleField(parts[1]!, 0, 23, 'hour', expr),
    day: parseSimpleField(parts[2]!, 1, 31, 'day', expr),
    month: parseSimpleField(parts[3]!, 1, 12, 'month', expr),
    weekday: parseWeekdayField(parts[4]!, expr),
  }
}

function parseSimpleField(
  spec: string,
  min: number,
  max: number,
  name: string,
  expr: string,
): CronField {
  if (spec === '*') return { kind: 'any' }
  const stepMatch = /^\*\/(\d+)$/.exec(spec)
  if (stepMatch) {
    const step = Number(stepMatch[1])
    if (!Number.isInteger(step) || step <= 0 || step > max) {
      throw new UnsupportedCronError(
        `step value out of range for ${name}: ${spec}`,
        expr,
      )
    }
    return { kind: 'step', step }
  }
  if (/^\d+$/.test(spec)) {
    const value = Number(spec)
    if (value < min || value > max) {
      throw new UnsupportedCronError(
        `${name} value ${value} out of range [${min}, ${max}]`,
        expr,
      )
    }
    return { kind: 'value', value }
  }
  throw new UnsupportedCronError(
    `unsupported ${name} field ${JSON.stringify(spec)} (expected *, N, or */N)`,
    expr,
  )
}

function parseWeekdayField(spec: string, expr: string): WeekdayField {
  if (spec === '*') return { kind: 'any' }

  const stepMatch = /^\*\/(\d+)$/.exec(spec)
  if (stepMatch) {
    const step = Number(stepMatch[1])
    if (!Number.isInteger(step) || step <= 0 || step > 7) {
      throw new UnsupportedCronError(
        `weekday step out of range: ${spec}`,
        expr,
      )
    }
    return { kind: 'step', step }
  }

  if (/^\d+$/.test(spec)) {
    return { kind: 'value', value: normalizeWeekday(Number(spec), expr) }
  }

  const rangeMatch = /^(\d+)-(\d+)$/.exec(spec)
  if (rangeMatch) {
    const from = normalizeWeekday(Number(rangeMatch[1]), expr)
    const to = normalizeWeekday(Number(rangeMatch[2]), expr)
    if (to < from) {
      throw new UnsupportedCronError(
        `weekday range ${spec} wraps past Saturday; split into two crons`,
        expr,
      )
    }
    return { kind: 'range', from, to }
  }

  if (/^(\d+,)+\d+$/.test(spec)) {
    const values = spec.split(',').map((v) => normalizeWeekday(Number(v), expr))
    const dedup = Array.from(new Set(values)).sort((a, b) => a - b)
    return { kind: 'list', values: dedup }
  }

  throw new UnsupportedCronError(
    `unsupported weekday field ${JSON.stringify(spec)} (expected *, N, N-M, N,M,..., or */N)`,
    expr,
  )
}

function normalizeWeekday(value: number, expr: string): number {
  // Cron accepts both 0 and 7 for Sunday; normalize to 0 so our lookup
  // table indexes cleanly.
  if (value === 7) return 0
  if (value < 0 || value > 6) {
    throw new UnsupportedCronError(`weekday ${value} out of range [0, 7]`, expr)
  }
  return value
}

/**
 * Translate a 5-field cron expression to a systemd OnCalendar value.
 *
 * Output format: `[Weekdays] *-Month-Day Hour:Minute:00`, with `*` for
 * any, `N` for specific value, `0/N` for step. Weekday prefix present
 * only when the field is not `*`.
 */
export function cronToSystemdCalendar(expr: string): string {
  const fields = parseCron(expr)

  const minute = renderSimple(fields.minute, 0, 59)
  const hour = renderSimple(fields.hour, 0, 23)
  const day = renderSimple(fields.day, 1, 31)
  const month = renderSimple(fields.month, 1, 12)
  const weekday = renderWeekday(fields.weekday)

  const datePart = `*-${month}-${day}`
  const timePart = `${hour}:${minute}:00`

  return weekday === '' ? `${datePart} ${timePart}` : `${weekday} ${datePart} ${timePart}`
}

function renderSimple(field: CronField, min: number, max: number): string {
  switch (field.kind) {
    case 'any':
      return '*'
    case 'value':
      return String(field.value)
    case 'step':
      return `${min}/${field.step}`
  }
  // `max` is part of the signature for future symmetry even if currently
  // unused in the step rendering (systemd infers the upper bound itself).
  void max
}

function renderWeekday(field: WeekdayField): string {
  switch (field.kind) {
    case 'any':
      return ''
    case 'value':
      return WEEKDAY_NAMES[field.value]!
    case 'step':
      // A */N weekday: enumerate the days it matches (rare, e.g. */2 -> Sun,Tue,Thu,Sat).
      return enumerateStep(0, 6, field.step)
        .map((d) => WEEKDAY_NAMES[d]!)
        .join(',')
    case 'range':
      return `${WEEKDAY_NAMES[field.from]!}..${WEEKDAY_NAMES[field.to]!}`
    case 'list':
      return field.values.map((v) => WEEKDAY_NAMES[v]!).join(',')
  }
}

function enumerateStep(min: number, max: number, step: number): number[] {
  const out: number[] = []
  for (let i = min; i <= max; i += step) out.push(i)
  return out
}
