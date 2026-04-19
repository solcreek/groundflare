import { describe, it, expect } from 'vitest'

import {
  aggregateByWorker,
  parsePromText,
  renderMetricsTable,
} from '../../../src/cli/metrics.js'
import { generateRouterJs } from '../../../src/runtime/workspace/index.js'

// ─── Parser ─────────────────────────────────────────────────────────

describe('parsePromText', () => {
  it('parses a labeled counter line', () => {
    const out = parsePromText(
      'groundflare_worker_requests_total{status_class="2xx",worker="api"} 5',
    )
    expect(out).toEqual([
      {
        name: 'groundflare_worker_requests_total',
        labels: { status_class: '2xx', worker: 'api' },
        value: 5,
      },
    ])
  })

  it('parses an unlabeled metric (no {} block)', () => {
    const out = parsePromText('up 1')
    expect(out).toEqual([{ name: 'up', labels: {}, value: 1 }])
  })

  it('skips comment lines and blank lines', () => {
    const out = parsePromText(
      ['# HELP x a', '# TYPE x counter', '', 'x{w="a"} 7', ''].join('\n'),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.value).toBe(7)
  })

  it('handles the special le="+Inf" bucket', () => {
    const out = parsePromText(
      'groundflare_worker_request_duration_seconds_bucket{le="+Inf",worker="api"} 42',
    )
    expect(out[0]?.labels.le).toBe('+Inf')
    expect(out[0]?.value).toBe(42)
  })

  it('decodes common label escapes', () => {
    const out = parsePromText(`x{k="a\\"b\\nc\\\\d"} 1`)
    expect(out[0]?.labels.k).toBe('a"b\nc\\d')
  })

  it('drops unparsable lines silently', () => {
    const out = parsePromText('garbage\nvalid 1\nalso garbage}{=')
    expect(out.map((s) => s.name)).toEqual(['valid'])
  })
})

// ─── Aggregation ────────────────────────────────────────────────────

describe('aggregateByWorker', () => {
  it('rolls up counts + percentiles per worker', () => {
    const series = parsePromText(
      [
        'groundflare_worker_requests_total{status_class="2xx",worker="api"} 8',
        'groundflare_worker_requests_total{status_class="5xx",worker="api"} 2',
        'groundflare_worker_errors_total{kind="uncaught",worker="api"} 2',
        'groundflare_worker_request_duration_seconds_bucket{le="0.01",worker="api"} 5',
        'groundflare_worker_request_duration_seconds_bucket{le="0.1",worker="api"} 9',
        'groundflare_worker_request_duration_seconds_bucket{le="1",worker="api"} 10',
        'groundflare_worker_request_duration_seconds_bucket{le="+Inf",worker="api"} 10',
        'groundflare_worker_request_duration_seconds_sum{worker="api"} 0.4',
        'groundflare_worker_request_duration_seconds_count{worker="api"} 10',
      ].join('\n'),
    )
    const agg = aggregateByWorker(series)
    expect(agg).toHaveLength(1)
    const w = agg[0]!
    expect(w.worker).toBe('api')
    expect(w.requestCount).toBe(10)
    expect(w.byStatusClass).toEqual({ '2xx': 8, '5xx': 2 })
    expect(w.errorCount).toBe(2)
    expect(w.byErrorKind).toEqual({ uncaught: 2 })
    expect(w.latencyMs).not.toBeNull()
    // p50: target=5, falls at the 0.01 boundary (count 5 == target),
    // linear interp returns 0.01 s = 10 ms.
    expect(w.latencyMs!.p50).toBeCloseTo(10, 1)
    // p95: target=9.5, crosses 0.1 boundary (count 9 → 10 across 0.1 → 1).
    // interp: 0.1 + (1 - 0.1) * (9.5 - 9)/(10 - 9) = 0.55 s = 550 ms.
    expect(w.latencyMs!.p95).toBeCloseTo(550, 0)
  })

  it('returns latencyMs=null when count==0', () => {
    const agg = aggregateByWorker(
      parsePromText(
        [
          'groundflare_worker_request_duration_seconds_bucket{le="+Inf",worker="idle"} 0',
          'groundflare_worker_request_duration_seconds_sum{worker="idle"} 0',
          'groundflare_worker_request_duration_seconds_count{worker="idle"} 0',
        ].join('\n'),
      ),
    )
    expect(agg[0]?.latencyMs).toBeNull()
  })

  it('sorts workers by name', () => {
    const agg = aggregateByWorker(
      parsePromText(
        [
          'groundflare_worker_requests_total{status_class="2xx",worker="z"} 1',
          'groundflare_worker_requests_total{status_class="2xx",worker="a"} 1',
          'groundflare_worker_requests_total{status_class="2xx",worker="m"} 1',
        ].join('\n'),
      ),
    )
    expect(agg.map((w) => w.worker)).toEqual(['a', 'm', 'z'])
  })

  it('rolls up binding-level series (kv/d1/r2) per worker with err split', () => {
    const agg = aggregateByWorker(
      parsePromText(
        [
          // Router-level so the worker gets a base entry too.
          'groundflare_worker_requests_total{status_class="2xx",worker="api"} 3',
          // KV: 5 ok + 1 err across two bindings → kv total 6, err 1.
          'groundflare_binding_kv_ops_total{binding="CACHE",op="get",status="ok",worker="api"} 3',
          'groundflare_binding_kv_ops_total{binding="CACHE",op="put",status="ok",worker="api"} 2',
          'groundflare_binding_kv_ops_total{binding="CACHE",op="get",status="err",worker="api"} 1',
          // D1: 2 ok only.
          'groundflare_binding_d1_ops_total{binding="DB",op="run",status="ok",worker="api"} 2',
          // R2 attributed to a different worker — must not leak.
          'groundflare_binding_r2_ops_total{binding="MEDIA",op="get",status="ok",worker="cdn"} 4',
        ].join('\n'),
      ),
    )
    const api = agg.find((w) => w.worker === 'api')!
    expect(api.bindings).toEqual([
      { kind: 'kv', opCount: 6, errCount: 1 },
      { kind: 'd1', opCount: 2, errCount: 0 },
    ])
    const cdn = agg.find((w) => w.worker === 'cdn')!
    expect(cdn.bindings).toEqual([
      { kind: 'r2', opCount: 4, errCount: 0 },
    ])
  })

  it('skips series without a worker label', () => {
    const agg = aggregateByWorker(
      parsePromText(
        [
          'groundflare_worker_requests_total{status_class="2xx"} 7',
          'groundflare_worker_requests_total{status_class="2xx",worker="api"} 3',
        ].join('\n'),
      ),
    )
    expect(agg).toHaveLength(1)
    expect(agg[0]?.worker).toBe('api')
    expect(agg[0]?.requestCount).toBe(3)
  })

  it('round-trips the exact format the Router Worker emits', async () => {
    // Execute the generated router body in a sandbox, drive a few
    // requests through it, then scrape /__metrics and parse the
    // result. This guards the emit ↔ consume contract across the
    // serialization boundary.
    const source = generateRouterJs(
      [
        { name: 'api', entryPath: 'w/api.js', domain: 'api.test' },
        { name: 'admin', entryPath: 'w/admin.js', domain: 'admin.test' },
      ],
      { version: '0.0.0-test' },
    )
    const body = source.replace(/export default (\{[\s\S]*\})\s*$/, 'return $1')
    const factory = new Function('Response', 'URL', body)
    const router = factory(Response, URL) as {
      fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response>
    }

    const env = {
      WORKER_API: {
        fetch: async (): Promise<Response> => new Response('ok'),
      },
      WORKER_ADMIN: {
        fetch: async (): Promise<Response> =>
          new Response('nope', { status: 500 }),
      },
    }
    await router.fetch(new Request('https://api.test/'), env, {})
    await router.fetch(new Request('https://api.test/'), env, {})
    await router.fetch(new Request('https://admin.test/'), env, {})

    const text = await router
      .fetch(new Request('http://127.0.0.1:8080/__metrics'), {}, {})
      .then((r) => r.text())

    const agg = aggregateByWorker(parsePromText(text))
    expect(agg.map((w) => w.worker)).toEqual(['admin', 'api'])
    const api = agg.find((w) => w.worker === 'api')!
    expect(api.requestCount).toBe(2)
    expect(api.byStatusClass['2xx']).toBe(2)
    expect(api.errorCount).toBe(0)
    const admin = agg.find((w) => w.worker === 'admin')!
    expect(admin.byStatusClass['5xx']).toBe(1)
  })
})

// ─── Rendering ──────────────────────────────────────────────────────

describe('renderMetricsTable', () => {
  it('renders a friendly line when there is nothing to show', () => {
    expect(renderMetricsTable([])).toBe('  no tenant activity recorded yet\n')
  })

  it('renders a column-aligned table with header + worker rows', () => {
    const table = renderMetricsTable([
      {
        worker: 'api',
        requestCount: 12,
        byStatusClass: { '2xx': 11, '5xx': 1 },
        errorCount: 1,
        byErrorKind: { uncaught: 1 },
        latencyMs: { p50: 2.4, p95: 45, p99: 120 },
        bindings: [
          { kind: 'kv', opCount: 30, errCount: 0 },
          { kind: 'd1', opCount: 5, errCount: 1 },
        ],
      },
    ])
    expect(table).toContain('worker')
    expect(table).toContain('api')
    // Status class breakdown preserves 2xx/3xx/4xx/5xx order even when
    // 3xx/4xx are absent (rendered as 0).
    expect(table).toContain('11/0/0/1')
    expect(table).toContain('2.4')
    // Binding rollup: ops total, errs after slash when > 0.
    expect(table).toContain('kv:30')
    expect(table).toContain('d1:5/1')
    expect(table).toMatch(/\n$/)
  })

  it('renders dashes when latencyMs is null and bindings are empty', () => {
    const table = renderMetricsTable([
      {
        worker: 'idle',
        requestCount: 0,
        byStatusClass: {},
        errorCount: 0,
        byErrorKind: {},
        latencyMs: null,
        bindings: [],
      },
    ])
    expect(table).toMatch(/idle\s.*—\s+—\s+—/)
  })
})
