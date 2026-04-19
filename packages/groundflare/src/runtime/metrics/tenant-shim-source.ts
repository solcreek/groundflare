/**
 * Inline JS that every tenant shim prepends to get per-binding KV/D1
 * metrics + a `/__gf_metrics` internal endpoint.
 *
 * Why it's a string constant (not a TS module the shim imports):
 *   - The shim is inlined into the capnp `esModule`. It can't `import`
 *     anything the build hasn't embedded.
 *   - Keeping the counters + render + dispatch in one small blob keeps
 *     the shim self-contained and independent of TS `MetricRegistry`
 *     (which serves the CLI / tests, not the Worker hot path).
 *
 * Conventions (same as the Router's own /__metrics):
 *   - Counter labels:   `binding`, `worker`, `op`, `status` ("ok"|"err")
 *   - Histogram labels: `binding`, `worker`, `op`
 *   - Bucket boundaries match DEFAULT_LATENCY_BUCKETS in registry.ts so
 *     dashboards that align series across router + tenant don't break.
 *
 * The `worker` label is emitted from a `GF_WORKER_NAME` constant that
 * each shim generator defines right before this blob, so one scraped
 * body can be attributed to its worker without the Router having to
 * rewrite series at aggregation time.
 *
 * Internal endpoint contract:
 *   - Router's /__metrics handler fans out with
 *     `env.<BINDING>.fetch(new Request('http://gf-internal/__gf_metrics'))`.
 *   - Shim returns 200 Prometheus text on that exact URL.
 *   - Caddy never forwards the literal `gf-internal` hostname to tenants,
 *     so external traffic can't trigger this path. (The hostname check
 *     is the authorization — no header or secret needed.)
 */
export const TENANT_METRICS_SHIM_SOURCE = `// ─── groundflare tenant metrics (inlined) ─────────────────────────
const GF_LATENCY_BUCKETS = [
  0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]
// key "binding|op|status" → count
const GF_KV_OPS = new Map()
const GF_D1_OPS = new Map()
// key "binding|op" → { counts[], sum, count }
const GF_KV_LATENCY = new Map()
const GF_D1_LATENCY = new Map()

function gf_recordLatency(map, key, durationMs) {
  let h = map.get(key)
  if (!h) {
    h = {
      counts: new Array(GF_LATENCY_BUCKETS.length).fill(0),
      sum: 0,
      count: 0,
    }
    map.set(key, h)
  }
  const secs = durationMs / 1000
  h.sum += secs
  h.count += 1
  for (let i = 0; i < GF_LATENCY_BUCKETS.length; i++) {
    if (secs <= GF_LATENCY_BUCKETS[i]) h.counts[i] += 1
  }
}

function gf_recordKv(binding, op, durationMs, ok) {
  const statusKey = ok ? 'ok' : 'err'
  const opsKey = binding + '|' + op + '|' + statusKey
  GF_KV_OPS.set(opsKey, (GF_KV_OPS.get(opsKey) || 0) + 1)
  gf_recordLatency(GF_KV_LATENCY, binding + '|' + op, durationMs)
}

function gf_recordD1(binding, op, durationMs, ok) {
  const statusKey = ok ? 'ok' : 'err'
  const opsKey = binding + '|' + op + '|' + statusKey
  GF_D1_OPS.set(opsKey, (GF_D1_OPS.get(opsKey) || 0) + 1)
  gf_recordLatency(GF_D1_LATENCY, binding + '|' + op, durationMs)
}

// Narrow helper: call an async op, record (binding, op) with latency
// and ok/err, re-throw on failure. Keeps instrumentation a one-liner
// at each call-site.
async function gf_timeKv(binding, op, fn) {
  const start = Date.now()
  try {
    const r = await fn()
    gf_recordKv(binding, op, Date.now() - start, true)
    return r
  } catch (err) {
    gf_recordKv(binding, op, Date.now() - start, false)
    throw err
  }
}
async function gf_timeD1(binding, op, fn) {
  const start = Date.now()
  try {
    const r = await fn()
    gf_recordD1(binding, op, Date.now() - start, true)
    return r
  } catch (err) {
    gf_recordD1(binding, op, Date.now() - start, false)
    throw err
  }
}

function gf_escapeLabel(v) {
  return String(v).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/\\n/g, '\\\\n')
}

function gf_renderOps(lines, opsMap, metricName, helpText) {
  if (opsMap.size === 0) return
  const w = gf_escapeLabel(GF_WORKER_NAME)
  lines.push('# HELP ' + metricName + ' ' + helpText)
  lines.push('# TYPE ' + metricName + ' counter')
  for (const [key, value] of opsMap) {
    const parts = key.split('|')
    lines.push(
      metricName +
        '{binding="' + gf_escapeLabel(parts[0]) +
        '",op="' + gf_escapeLabel(parts[1]) +
        '",status="' + gf_escapeLabel(parts[2]) +
        '",worker="' + w + '"} ' + value,
    )
  }
}

function gf_renderHist(lines, latMap, metricName, helpText) {
  if (latMap.size === 0) return
  const w = gf_escapeLabel(GF_WORKER_NAME)
  lines.push('# HELP ' + metricName + ' ' + helpText)
  lines.push('# TYPE ' + metricName + ' histogram')
  for (const [key, hist] of latMap) {
    const parts = key.split('|')
    const b = gf_escapeLabel(parts[0])
    const o = gf_escapeLabel(parts[1])
    for (let i = 0; i < GF_LATENCY_BUCKETS.length; i++) {
      lines.push(
        metricName + '_bucket{binding="' + b + '",le="' + GF_LATENCY_BUCKETS[i] +
          '",op="' + o + '",worker="' + w + '"} ' + hist.counts[i],
      )
    }
    lines.push(
      metricName + '_bucket{binding="' + b + '",le="+Inf",op="' + o + '",worker="' + w + '"} ' + hist.count,
    )
    lines.push(
      metricName + '_sum{binding="' + b + '",op="' + o + '",worker="' + w + '"} ' + hist.sum,
    )
    lines.push(
      metricName + '_count{binding="' + b + '",op="' + o + '",worker="' + w + '"} ' + hist.count,
    )
  }
}

function gf_renderMetrics() {
  const lines = []
  gf_renderOps(
    lines,
    GF_KV_OPS,
    'groundflare_binding_kv_ops_total',
    'KV binding op count by (binding, op, status)',
  )
  gf_renderHist(
    lines,
    GF_KV_LATENCY,
    'groundflare_binding_kv_duration_seconds',
    'KV binding op latency by (binding, op)',
  )
  gf_renderOps(
    lines,
    GF_D1_OPS,
    'groundflare_binding_d1_ops_total',
    'D1 binding op count by (binding, op, status)',
  )
  gf_renderHist(
    lines,
    GF_D1_LATENCY,
    'groundflare_binding_d1_duration_seconds',
    'D1 binding op latency by (binding, op)',
  )
  return lines.join('\\n') + (lines.length > 0 ? '\\n' : '')
}

function gf_handleInternalMetrics(request) {
  // Authorization is purely by hostname: Caddy never forwards the
  // literal \`gf-internal\` host to tenants, so any request that
  // arrives here with that host came from the Router's service-binding
  // fan-out. See design notes in tenant-shim-source.ts.
  let url
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  if (url.hostname !== 'gf-internal') return null
  if (url.pathname !== '/__gf_metrics') return null
  return new Response(gf_renderMetrics(), {
    status: 200,
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
  })
}
// ─── end tenant metrics ───────────────────────────────────────────

`
