/**
 * CLI-side consumer of the Router Worker's `/__metrics` endpoint.
 *
 * This module parses the Prometheus text-format output the Router
 * emits and aggregates it into a per-worker table suitable for
 * `groundflare status`. The parser is intentionally narrow — it
 * handles the exact shapes `src/runtime/workspace/router.ts` emits
 * (labeled counters + histograms, double-quoted label values, the
 * `worker=` label), not arbitrary Prometheus text. That keeps the
 * code small and the failure modes obvious.
 *
 * Percentile estimation (p50/p95/p99) comes from the histogram
 * buckets via linear interpolation between the two bucket boundaries
 * that straddle the quantile. Counts are cumulative since the Router
 * booted; display is "count / uptime", not instantaneous rate.
 */

export interface PromSeries {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly value: number
}

/**
 * Parse a Prometheus text-format body. Lines starting with `#` are
 * skipped, blank lines are skipped, and any line that doesn't match
 * the expected `name{labels} value` or `name value` shape is dropped
 * silently — the parser is fault-tolerant because a partial or
 * corrupt body shouldn't crash `groundflare status`.
 */
export function parsePromText(text: string): PromSeries[] {
  const out: PromSeries[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const parsed = parseLine(line)
    if (parsed !== null) out.push(parsed)
  }
  return out
}

function parseLine(line: string): PromSeries | null {
  // `name{labels} value` or `name value`
  const braceIdx = line.indexOf('{')
  if (braceIdx < 0) {
    const spaceIdx = line.indexOf(' ')
    if (spaceIdx < 0) return null
    const name = line.slice(0, spaceIdx)
    const value = Number.parseFloat(line.slice(spaceIdx + 1))
    if (!Number.isFinite(value)) return null
    return { name, labels: {}, value }
  }

  const name = line.slice(0, braceIdx)
  const closeIdx = line.indexOf('}', braceIdx)
  if (closeIdx < 0) return null
  const labelsBlock = line.slice(braceIdx + 1, closeIdx)
  const labels = parseLabels(labelsBlock)
  if (labels === null) return null
  const value = Number.parseFloat(line.slice(closeIdx + 1).trim())
  if (!Number.isFinite(value)) return null
  return { name, labels, value }
}

/**
 * Parse the `a="x",b="y"` form. Only handles double-quoted values
 * with `\\`, `\"`, `\n` escapes — matches what `escapeLabel` in
 * router.ts emits. Returns null on any shape violation.
 */
function parseLabels(
  block: string,
): Readonly<Record<string, string>> | null {
  const labels: Record<string, string> = {}
  let i = 0
  while (i < block.length) {
    // Skip whitespace + optional leading comma.
    while (i < block.length && (block[i] === ' ' || block[i] === ',')) i++
    if (i >= block.length) break
    const eqIdx = block.indexOf('=', i)
    if (eqIdx < 0) return null
    const key = block.slice(i, eqIdx).trim()
    if (key.length === 0) return null
    if (block[eqIdx + 1] !== '"') return null
    // Consume the quoted value, honoring escapes.
    let j = eqIdx + 2
    let value = ''
    let closed = false
    while (j < block.length) {
      const ch = block[j]
      if (ch === '\\' && j + 1 < block.length) {
        const next = block[j + 1]
        if (next === 'n') value += '\n'
        else if (next === '"') value += '"'
        else if (next === '\\') value += '\\'
        else value += next
        j += 2
      } else if (ch === '"') {
        closed = true
        j += 1
        break
      } else {
        value += ch
        j += 1
      }
    }
    if (!closed) return null
    labels[key] = value
    i = j
  }
  return labels
}

// ─── Aggregation ────────────────────────────────────────────────────

/** Metric-name constants — kept in one place so both emit + consume stay aligned. */
const METRIC_REQUESTS_TOTAL = 'groundflare_worker_requests_total'
const METRIC_DURATION_BUCKET =
  'groundflare_worker_request_duration_seconds_bucket'
const METRIC_DURATION_SUM = 'groundflare_worker_request_duration_seconds_sum'
const METRIC_DURATION_COUNT =
  'groundflare_worker_request_duration_seconds_count'
const METRIC_ERRORS_TOTAL = 'groundflare_worker_errors_total'

export interface WorkerMetrics {
  readonly worker: string
  readonly requestCount: number
  /** counter value keyed by status class ("2xx", "3xx", ...) — missing classes are 0. */
  readonly byStatusClass: Readonly<Record<string, number>>
  readonly errorCount: number
  readonly byErrorKind: Readonly<Record<string, number>>
  /** `null` when the histogram recorded zero observations. */
  readonly latencyMs: {
    readonly p50: number
    readonly p95: number
    readonly p99: number
  } | null
}

/**
 * Roll parsed series up into one entry per worker. Workers are
 * identified by the `worker` label — any series without one is
 * skipped. The return array is sorted by worker name so the CLI
 * prints a stable order.
 */
export function aggregateByWorker(series: readonly PromSeries[]): WorkerMetrics[] {
  const byWorker = new Map<
    string,
    {
      statusCounts: Map<string, number>
      errorCounts: Map<string, number>
      bucketCounts: Array<{ le: number; count: number }>
      infBucket: number | null
      sum: number
      count: number
    }
  >()

  function entry(worker: string) {
    let e = byWorker.get(worker)
    if (!e) {
      e = {
        statusCounts: new Map(),
        errorCounts: new Map(),
        bucketCounts: [],
        infBucket: null,
        sum: 0,
        count: 0,
      }
      byWorker.set(worker, e)
    }
    return e
  }

  for (const s of series) {
    const worker = s.labels.worker
    if (worker === undefined) continue
    const e = entry(worker)

    if (s.name === METRIC_REQUESTS_TOTAL) {
      const cls = s.labels.status_class ?? 'unknown'
      e.statusCounts.set(cls, (e.statusCounts.get(cls) ?? 0) + s.value)
    } else if (s.name === METRIC_ERRORS_TOTAL) {
      const kind = s.labels.kind ?? 'unknown'
      e.errorCounts.set(kind, (e.errorCounts.get(kind) ?? 0) + s.value)
    } else if (s.name === METRIC_DURATION_BUCKET) {
      const le = s.labels.le
      if (le === '+Inf') {
        e.infBucket = s.value
      } else if (le !== undefined) {
        const num = Number.parseFloat(le)
        if (Number.isFinite(num)) {
          e.bucketCounts.push({ le: num, count: s.value })
        }
      }
    } else if (s.name === METRIC_DURATION_SUM) {
      e.sum = s.value
    } else if (s.name === METRIC_DURATION_COUNT) {
      e.count = s.value
    }
  }

  const out: WorkerMetrics[] = []
  for (const [worker, e] of byWorker) {
    e.bucketCounts.sort((a, b) => a.le - b.le)
    const total = e.infBucket ?? e.count
    const latencyMs =
      e.count > 0
        ? {
            p50: estimatePercentile(e.bucketCounts, total, 0.5) * 1000,
            p95: estimatePercentile(e.bucketCounts, total, 0.95) * 1000,
            p99: estimatePercentile(e.bucketCounts, total, 0.99) * 1000,
          }
        : null

    let requestCount = 0
    for (const v of e.statusCounts.values()) requestCount += v

    let errorCount = 0
    for (const v of e.errorCounts.values()) errorCount += v

    out.push({
      worker,
      requestCount,
      byStatusClass: Object.fromEntries(e.statusCounts),
      errorCount,
      byErrorKind: Object.fromEntries(e.errorCounts),
      latencyMs,
    })
  }
  out.sort((a, b) => a.worker.localeCompare(b.worker))
  return out
}

/**
 * Linear interpolation between bucket boundaries. Matches the method
 * `histogram_quantile()` uses in PromQL.
 */
function estimatePercentile(
  buckets: ReadonlyArray<{ le: number; count: number }>,
  total: number,
  q: number,
): number {
  if (total <= 0 || buckets.length === 0) return 0
  const target = q * total
  let prevLe = 0
  let prevCount = 0
  for (const b of buckets) {
    if (b.count >= target) {
      const span = b.count - prevCount
      if (span <= 0) return b.le
      const t = (target - prevCount) / span
      return prevLe + (b.le - prevLe) * t
    }
    prevLe = b.le
    prevCount = b.count
  }
  // Target is past the last finite bucket — we don't know the upper
  // bound, so return the last le as a conservative floor.
  return prevLe
}

// ─── Rendering ──────────────────────────────────────────────────────

/**
 * Render an ASCII table of per-worker metrics for `groundflare
 * status`. Returns a multi-line string with a trailing newline. When
 * the input is empty, returns a friendly one-liner so the CLI
 * doesn't print a bare header.
 */
export function renderMetricsTable(workers: readonly WorkerMetrics[]): string {
  if (workers.length === 0) {
    return '  no tenant activity recorded yet\n'
  }
  const rows: string[][] = [
    ['worker', 'reqs', 'err', '2xx/3xx/4xx/5xx', 'p50 ms', 'p95 ms', 'p99 ms'],
  ]
  for (const w of workers) {
    const classes = ['2xx', '3xx', '4xx', '5xx']
      .map((c) => String(Math.trunc(w.byStatusClass[c] ?? 0)))
      .join('/')
    const lat = w.latencyMs
    rows.push([
      w.worker,
      String(Math.trunc(w.requestCount)),
      String(Math.trunc(w.errorCount)),
      classes,
      lat ? lat.p50.toFixed(1) : '—',
      lat ? lat.p95.toFixed(1) : '—',
      lat ? lat.p99.toFixed(1) : '—',
    ])
  }
  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map((r) => r[col]!.length)),
  )
  const out: string[] = []
  for (const r of rows) {
    const padded = r
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join('  ')
    out.push('  ' + padded)
  }
  return out.join('\n') + '\n'
}
