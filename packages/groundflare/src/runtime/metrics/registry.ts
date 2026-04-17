/**
 * Minimal Prometheus-compatible metric primitives.
 *
 * Zero dependencies, ~250 LOC. The runtime's `/__metrics` endpoint
 * serializes a `MetricRegistry` to OpenMetrics / Prometheus exposition
 * format; a consumer's Prometheus server (or Grafana Cloud, or any
 * scraper) parses it natively. See design/observability.md for the
 * full metric taxonomy this module serves.
 *
 * Why hand-rolled instead of `prom-client`? Two reasons:
 *
 *   1. This code ships as source to the VPS (inlined into the Router
 *      Worker's capnp config), so every added dependency either gets
 *      bundled into the worker or has to be stubbed at the workerd
 *      boundary. Text-format output is ~50 lines; deserves its own
 *      surface.
 *   2. Prometheus's `text/plain; version=0.0.4` format is dead simple
 *      and hasn't changed in a decade. Not a place that warrants a
 *      maintained dep.
 *
 * The API is a subset of prom-client: Counter, Gauge, Histogram.
 * Summaries (quantile-at-emit) are deliberately omitted — histograms
 * let the scraper compute quantiles cheaply and composably across
 * replicas, which is the design we want as this scales past
 * single-VPS deployments.
 *
 * Label keys are compile-time typed: `Counter<'worker' | 'status_class'>`
 * means `.inc({ worker: 'api', status_class: '2xx' })` and no other
 * shape. Catches typos at the instrumentation site, which is where
 * metrics routinely rot.
 */

// ─── Label handling ───────────────────────────────────────────────

export type Labels<K extends string> = Record<K, string>

/**
 * Serialize a label map to a stable key for series lookup. Keys are
 * sorted so `{a: '1', b: '2'}` and `{b: '2', a: '1'}` land on the
 * same series. Empty label set → empty string.
 */
function serializeLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  return keys.map((k) => `${k}=${labels[k]!}`).join(',')
}

/**
 * Render a label map into the `{key="value",…}` format used in
 * Prometheus output. Values are escaped per the exposition format:
 * backslash, double-quote, and newline are the three mandatory
 * escapes. Keys are NOT quoted — Prometheus requires them to be
 * valid identifiers, which we enforce at metric construction.
 */
function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  const pairs = keys.map((k) => `${k}="${escapeLabelValue(labels[k]!)}"`)
  return `{${pairs.join(',')}}`
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function assertValidName(name: string, kind: 'metric' | 'label'): void {
  const re = kind === 'metric' ? METRIC_NAME_RE : LABEL_NAME_RE
  if (!re.test(name)) {
    throw new Error(`invalid ${kind} name ${JSON.stringify(name)} — must match ${re.source}`)
  }
}

// ─── Format helpers ───────────────────────────────────────────────

/**
 * Render a JS number for Prometheus. Infinity → `+Inf` / `-Inf`, NaN
 * → `NaN` literal. Integers pass through. Floats stringify normally
 * — JS's default is already Prometheus-compatible.
 */
function formatValue(v: number): string {
  if (v === Infinity) return '+Inf'
  if (v === -Infinity) return '-Inf'
  if (Number.isNaN(v)) return 'NaN'
  return String(v)
}

// ─── Counter ──────────────────────────────────────────────────────

export interface MetricDefinition<K extends string> {
  readonly name: string
  readonly help: string
  readonly labelKeys?: readonly K[]
}

/**
 * Monotonically increasing counter. Never decreases; reset only on
 * process restart.
 */
export class Counter<K extends string = never> {
  readonly name: string
  readonly help: string
  readonly labelKeys: readonly K[]
  private readonly series = new Map<string, { labels: Labels<K>; value: number }>()

  constructor(def: MetricDefinition<K>) {
    assertValidName(def.name, 'metric')
    for (const k of def.labelKeys ?? []) assertValidName(k, 'label')
    this.name = def.name
    this.help = def.help
    this.labelKeys = def.labelKeys ?? []
  }

  inc(labels: Labels<K> = {} as Labels<K>, n = 1): void {
    if (n < 0) throw new Error(`Counter.inc: ${this.name} received negative n=${n}`)
    const key = serializeLabels(labels)
    const existing = this.series.get(key)
    if (existing === undefined) {
      this.series.set(key, { labels: { ...labels }, value: n })
    } else {
      existing.value += n
    }
  }

  /** Snapshot current series for rendering. */
  collect(): Array<{ labels: Labels<K>; value: number }> {
    return [...this.series.values()]
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ]
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${formatValue(value)}`)
    }
    return lines.join('\n')
  }
}

// ─── Gauge ────────────────────────────────────────────────────────

/**
 * Set-able instantaneous value. `set`, `inc`, `dec` all legal.
 */
export class Gauge<K extends string = never> {
  readonly name: string
  readonly help: string
  readonly labelKeys: readonly K[]
  private readonly series = new Map<string, { labels: Labels<K>; value: number }>()

  constructor(def: MetricDefinition<K>) {
    assertValidName(def.name, 'metric')
    for (const k of def.labelKeys ?? []) assertValidName(k, 'label')
    this.name = def.name
    this.help = def.help
    this.labelKeys = def.labelKeys ?? []
  }

  set(labels: Labels<K>, value: number): void
  set(value: number): void
  set(arg1: Labels<K> | number, arg2?: number): void {
    const { labels, value } = this.parseArgs(arg1, arg2)
    const key = serializeLabels(labels)
    this.series.set(key, { labels: { ...labels }, value })
  }

  inc(labels: Labels<K> = {} as Labels<K>, n = 1): void {
    const key = serializeLabels(labels)
    const existing = this.series.get(key)
    if (existing === undefined) {
      this.series.set(key, { labels: { ...labels }, value: n })
    } else {
      existing.value += n
    }
  }

  dec(labels: Labels<K> = {} as Labels<K>, n = 1): void {
    this.inc(labels, -n)
  }

  private parseArgs(
    arg1: Labels<K> | number,
    arg2?: number,
  ): { labels: Labels<K>; value: number } {
    if (typeof arg1 === 'number') {
      return { labels: {} as Labels<K>, value: arg1 }
    }
    return { labels: arg1, value: arg2 ?? 0 }
  }

  collect(): Array<{ labels: Labels<K>; value: number }> {
    return [...this.series.values()]
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ]
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${formatValue(value)}`)
    }
    return lines.join('\n')
  }
}

// ─── Histogram ────────────────────────────────────────────────────

/**
 * Request-latency defaults tuned for Worker hot path. p50 in the 1–3 ms
 * range means the low bucket edge matters; wider spread into 5s covers
 * slow backend calls without making the high bucket useless.
 */
export const DEFAULT_LATENCY_BUCKETS: readonly number[] = [
  0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]

export interface HistogramDefinition<K extends string>
  extends MetricDefinition<K> {
  readonly buckets?: readonly number[]
}

interface HistogramSeries<K extends string> {
  labels: Labels<K>
  counts: number[] // per-bucket, same length as sortedBuckets
  sum: number
  count: number
}

export class Histogram<K extends string = never> {
  readonly name: string
  readonly help: string
  readonly labelKeys: readonly K[]
  readonly buckets: readonly number[]
  private readonly series = new Map<string, HistogramSeries<K>>()

  constructor(def: HistogramDefinition<K>) {
    assertValidName(def.name, 'metric')
    for (const k of def.labelKeys ?? []) assertValidName(k, 'label')
    this.name = def.name
    this.help = def.help
    this.labelKeys = def.labelKeys ?? []
    const raw = def.buckets ?? DEFAULT_LATENCY_BUCKETS
    // Sort + dedupe so callers can pass unsorted buckets without
    // silently corrupting the cumulative math.
    const sorted = [...new Set(raw)].sort((a, b) => a - b)
    if (sorted.length === 0) {
      throw new Error(`Histogram ${def.name}: buckets must be non-empty`)
    }
    this.buckets = sorted
  }

  observe(labels: Labels<K>, value: number): void
  observe(value: number): void
  observe(arg1: Labels<K> | number, arg2?: number): void {
    const { labels, value } =
      typeof arg1 === 'number'
        ? { labels: {} as Labels<K>, value: arg1 }
        : { labels: arg1, value: arg2 ?? 0 }
    const key = serializeLabels(labels)
    let s = this.series.get(key)
    if (s === undefined) {
      s = {
        labels: { ...labels },
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      }
      this.series.set(key, s)
    }
    s.sum += value
    s.count += 1
    // Cumulative histogram: every bucket at-or-above the value
    // increments. Linear scan over ~13 bucket boundaries is cheaper
    // than binary search at this size.
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) s.counts[i]! += 1
    }
  }

  collect(): Array<HistogramSeries<K>> {
    return [...this.series.values()].map((s) => ({
      labels: { ...s.labels },
      counts: [...s.counts],
      sum: s.sum,
      count: s.count,
    }))
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ]
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const bucketLabels = { ...s.labels, le: String(this.buckets[i]) }
        lines.push(
          `${this.name}_bucket${formatLabels(bucketLabels)} ${formatValue(s.counts[i]!)}`,
        )
      }
      // +Inf bucket: always the total count.
      const infLabels = { ...s.labels, le: '+Inf' }
      lines.push(
        `${this.name}_bucket${formatLabels(infLabels)} ${formatValue(s.count)}`,
      )
      lines.push(`${this.name}_sum${formatLabels(s.labels)} ${formatValue(s.sum)}`)
      lines.push(
        `${this.name}_count${formatLabels(s.labels)} ${formatValue(s.count)}`,
      )
    }
    return lines.join('\n')
  }
}

// ─── Registry ─────────────────────────────────────────────────────

type AnyMetric =
  | Counter<string>
  | Gauge<string>
  | Histogram<string>

/**
 * Holds a collection of metrics and renders them all at once in the
 * Prometheus exposition format. One registry per Worker isolate is
 * the typical setup; the Router Worker creates its own on boot and
 * the `/__metrics` handler calls `.render()` on every request.
 */
export class MetricRegistry {
  private readonly metrics = new Map<string, AnyMetric>()

  register(metric: AnyMetric): AnyMetric {
    if (this.metrics.has(metric.name)) {
      throw new Error(`MetricRegistry: metric ${metric.name} already registered`)
    }
    this.metrics.set(metric.name, metric)
    return metric
  }

  /** Helper to construct + register a Counter in one call. */
  counter<K extends string>(def: MetricDefinition<K>): Counter<K> {
    const c = new Counter<K>(def)
    this.register(c)
    return c
  }

  gauge<K extends string>(def: MetricDefinition<K>): Gauge<K> {
    const g = new Gauge<K>(def)
    this.register(g)
    return g
  }

  histogram<K extends string>(def: HistogramDefinition<K>): Histogram<K> {
    const h = new Histogram<K>(def)
    this.register(h)
    return h
  }

  /**
   * Render all registered metrics in Prometheus text format. Stable
   * order: metrics emit in registration order so scrapers see a
   * consistent layout across requests (cheaper diffs, easier debug).
   */
  render(): string {
    const blocks: string[] = []
    for (const m of this.metrics.values()) {
      blocks.push(m.render())
    }
    // Trailing newline is required by the Prometheus text format.
    return blocks.join('\n') + '\n'
  }

  /** Number of registered metrics — useful for tests. */
  size(): number {
    return this.metrics.size
  }

  /** Exposed for tests that need to poke at specific metrics. */
  get(name: string): AnyMetric | undefined {
    return this.metrics.get(name)
  }
}

/** Prometheus content-type header for `/__metrics` responses. */
export const PROMETHEUS_CONTENT_TYPE =
  'text/plain; version=0.0.4; charset=utf-8'
