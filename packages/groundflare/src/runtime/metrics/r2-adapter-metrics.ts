/**
 * R2 adapter Worker metrics.
 *
 * Unlike KV and D1 (whose tenant shims are hand-assembled from strings),
 * the R2 adapter is a real TypeScript module that esbuild bundles into
 * a single ES module. That means we can write the metrics code in
 * idiomatic TS + types and import it directly from
 * `src/runtime/workerd/r2/adapter.worker.ts`.
 *
 * Metric naming matches the KV/D1 shim conventions so dashboards can
 * apply the same label selectors across binding kinds:
 *   - `groundflare_binding_r2_ops_total{binding,worker,op,status}`
 *   - `groundflare_binding_r2_duration_seconds_*{binding,worker,op}`
 *
 * `worker` is the tenant worker name (the R2 adapter service is per-
 * (worker, binding); labels are hard-coded from env at dispatch-time
 * rather than collected from requests).
 *
 * Internal endpoint: same contract as the tenant shim —
 * `http://gf-internal/__gf_metrics` returns Prometheus text. Caddy
 * never forwards this host, so the hostname check is the sole
 * authorization gate.
 */

const DEFAULT_LATENCY_BUCKETS = [
  0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]

interface HistogramState {
  counts: number[]
  sum: number
  count: number
}

/** key: `${worker}|${binding}|${op}|${status}` → count */
const opsCounters = new Map<string, number>()
/** key: `${worker}|${binding}|${op}` → HistogramState */
const opsLatency = new Map<string, HistogramState>()

function bumpLatency(key: string, durationMs: number): void {
  let h = opsLatency.get(key)
  if (!h) {
    h = {
      counts: new Array(DEFAULT_LATENCY_BUCKETS.length).fill(0),
      sum: 0,
      count: 0,
    }
    opsLatency.set(key, h)
  }
  const secs = durationMs / 1000
  h.sum += secs
  h.count += 1
  for (let i = 0; i < DEFAULT_LATENCY_BUCKETS.length; i++) {
    if (secs <= DEFAULT_LATENCY_BUCKETS[i]!) h.counts[i]! += 1
  }
}

/**
 * Record one R2 adapter op. Call from the dispatch loop with:
 *   - worker / binding  — from env text bindings the adapter gets
 *   - op                — r2-codec R2Op.method (e.g. "get", "put", "list")
 *   - durationMs        — wall time from op receipt to response ready
 *   - ok                — whether the op succeeded (non-5xx S3 response)
 */
export function recordR2Op(
  worker: string,
  binding: string,
  op: string,
  durationMs: number,
  ok: boolean,
): void {
  const statusKey = ok ? 'ok' : 'err'
  const opsKey = `${worker}|${binding}|${op}|${statusKey}`
  opsCounters.set(opsKey, (opsCounters.get(opsKey) ?? 0) + 1)
  bumpLatency(`${worker}|${binding}|${op}`, durationMs)
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function renderMetrics(): string {
  const lines: string[] = []

  if (opsCounters.size > 0) {
    lines.push(
      '# HELP groundflare_binding_r2_ops_total R2 binding op count by (worker, binding, op, status)',
    )
    lines.push('# TYPE groundflare_binding_r2_ops_total counter')
    for (const [key, value] of opsCounters) {
      const [worker, binding, op, status] = key.split('|')
      lines.push(
        `groundflare_binding_r2_ops_total{binding="${escapeLabel(binding!)}",op="${escapeLabel(op!)}",status="${escapeLabel(status!)}",worker="${escapeLabel(worker!)}"} ${value}`,
      )
    }
  }

  if (opsLatency.size > 0) {
    lines.push(
      '# HELP groundflare_binding_r2_duration_seconds R2 binding op latency by (worker, binding, op)',
    )
    lines.push('# TYPE groundflare_binding_r2_duration_seconds histogram')
    for (const [key, hist] of opsLatency) {
      const [worker, binding, op] = key.split('|')
      const b = escapeLabel(binding!)
      const o = escapeLabel(op!)
      const w = escapeLabel(worker!)
      for (let i = 0; i < DEFAULT_LATENCY_BUCKETS.length; i++) {
        lines.push(
          `groundflare_binding_r2_duration_seconds_bucket{binding="${b}",le="${DEFAULT_LATENCY_BUCKETS[i]}",op="${o}",worker="${w}"} ${hist.counts[i]}`,
        )
      }
      lines.push(
        `groundflare_binding_r2_duration_seconds_bucket{binding="${b}",le="+Inf",op="${o}",worker="${w}"} ${hist.count}`,
      )
      lines.push(
        `groundflare_binding_r2_duration_seconds_sum{binding="${b}",op="${o}",worker="${w}"} ${hist.sum}`,
      )
      lines.push(
        `groundflare_binding_r2_duration_seconds_count{binding="${b}",op="${o}",worker="${w}"} ${hist.count}`,
      )
    }
  }

  return lines.length === 0 ? '' : lines.join('\n') + '\n'
}

/**
 * Call at the very top of the adapter's fetch() handler. Returns a
 * Response when the request is targeted at the internal metrics
 * endpoint, or null — in which case the caller proceeds with normal
 * R2-protocol handling.
 */
export function handleInternalMetrics(request: Request): Response | null {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  if (url.hostname !== 'gf-internal') return null
  if (url.pathname !== '/__gf_metrics') return null
  return new Response(renderMetrics(), {
    status: 200,
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
  })
}

// Exposed for unit tests only. Production code does not call these.
export const __testing = {
  renderMetrics,
  opsCounters,
  opsLatency,
  reset(): void {
    opsCounters.clear()
    opsLatency.clear()
  },
}
