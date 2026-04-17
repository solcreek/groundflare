import { describe, expect, it } from 'vitest'

import {
  Counter,
  DEFAULT_LATENCY_BUCKETS,
  Gauge,
  Histogram,
  MetricRegistry,
  PROMETHEUS_CONTENT_TYPE,
} from '../../../../src/runtime/metrics/index.js'

// ─── Counter ──────────────────────────────────────────────────────

describe('Counter', () => {
  it('increments — unlabeled', () => {
    const c = new Counter({ name: 'reqs', help: 'reqs total' })
    c.inc()
    c.inc({}, 4)
    const out = c.render()
    expect(out).toContain('# HELP reqs reqs total')
    expect(out).toContain('# TYPE reqs counter')
    expect(out).toContain('reqs 5')
  })

  it('increments — labeled, groups per label set', () => {
    const c = new Counter<'worker' | 'status_class'>({
      name: 'r',
      help: 'r',
      labelKeys: ['worker', 'status_class'],
    })
    c.inc({ worker: 'api', status_class: '2xx' })
    c.inc({ worker: 'api', status_class: '2xx' }, 2)
    c.inc({ worker: 'api', status_class: '5xx' })
    c.inc({ worker: 'admin', status_class: '2xx' })

    const series = c.collect()
    expect(series).toHaveLength(3)
    const api2xx = series.find(
      (s) => s.labels.worker === 'api' && s.labels.status_class === '2xx',
    )
    expect(api2xx?.value).toBe(3)
  })

  it('sorts label keys so caller argument order does not split the series', () => {
    const c = new Counter<'a' | 'b'>({
      name: 'x',
      help: 'x',
      labelKeys: ['a', 'b'],
    })
    c.inc({ a: '1', b: '2' })
    // Same logical labels, different argument-literal order.
    c.inc({ b: '2', a: '1' })
    expect(c.collect()).toHaveLength(1)
    expect(c.collect()[0]?.value).toBe(2)
  })

  it('rejects negative increments', () => {
    const c = new Counter({ name: 'x', help: 'x' })
    expect(() => c.inc({}, -1)).toThrow(/negative/)
  })

  it('rejects invalid metric + label names at construction', () => {
    expect(() => new Counter({ name: 'bad name', help: 'x' })).toThrow(
      /invalid metric name/,
    )
    expect(
      () =>
        new Counter({
          name: 'ok',
          help: 'x',
          labelKeys: ['valid', 'bad-key'] as const,
        }),
    ).toThrow(/invalid label name/)
  })
})

// ─── Gauge ────────────────────────────────────────────────────────

describe('Gauge', () => {
  it('set / inc / dec with and without labels', () => {
    const g = new Gauge<'mount'>({
      name: 'disk',
      help: 'bytes',
      labelKeys: ['mount'],
    })
    g.set({ mount: '/' }, 100)
    g.inc({ mount: '/' }, 50)
    g.dec({ mount: '/' }, 30)

    g.set({ mount: '/var' }, 0)

    const slashSeries = g.collect().find((s) => s.labels.mount === '/')
    expect(slashSeries?.value).toBe(120)

    const out = g.render()
    expect(out).toContain('# TYPE disk gauge')
    expect(out).toContain('disk{mount="/"} 120')
    expect(out).toContain('disk{mount="/var"} 0')
  })

  it('unlabeled set overload accepts a raw number', () => {
    const g = new Gauge({ name: 'up', help: 'up' })
    g.set(1)
    expect(g.collect()[0]?.value).toBe(1)
  })
})

// ─── Histogram ────────────────────────────────────────────────────

describe('Histogram', () => {
  it('renders cumulative buckets, sum, count, and +Inf bucket', () => {
    const h = new Histogram({
      name: 'lat',
      help: 'latency',
      buckets: [0.01, 0.1, 1],
    })
    h.observe(0.005) // → all 3 buckets
    h.observe(0.05) // → 0.1, 1
    h.observe(0.5) //  → 1
    h.observe(5) //    → none (only +Inf)

    const out = h.render()
    expect(out).toContain('# TYPE lat histogram')
    expect(out).toContain('lat_bucket{le="0.01"} 1')
    expect(out).toContain('lat_bucket{le="0.1"} 2')
    expect(out).toContain('lat_bucket{le="1"} 3')
    expect(out).toContain('lat_bucket{le="+Inf"} 4')
    expect(out).toContain('lat_sum 5.555')
    expect(out).toContain('lat_count 4')
  })

  it('accepts unsorted buckets and dedupes them', () => {
    const h = new Histogram({
      name: 'x',
      help: 'x',
      buckets: [0.5, 0.1, 0.5, 0.01],
    })
    expect(h.buckets).toEqual([0.01, 0.1, 0.5])
  })

  it('defaults to DEFAULT_LATENCY_BUCKETS for Worker hot path', () => {
    const h = new Histogram({ name: 'x', help: 'x' })
    expect(h.buckets).toEqual(DEFAULT_LATENCY_BUCKETS)
  })

  it('rejects empty bucket set', () => {
    expect(() => new Histogram({ name: 'x', help: 'x', buckets: [] })).toThrow(
      /non-empty/,
    )
  })

  it('separate series per label combo', () => {
    const h = new Histogram<'worker'>({
      name: 'dur',
      help: 'dur',
      labelKeys: ['worker'],
      buckets: [0.1, 1],
    })
    h.observe({ worker: 'a' }, 0.05)
    h.observe({ worker: 'b' }, 0.5)

    const out = h.render()
    expect(out).toContain('dur_bucket{le="0.1",worker="a"} 1')
    expect(out).toContain('dur_bucket{le="0.1",worker="b"} 0')
  })
})

// ─── Registry ─────────────────────────────────────────────────────

describe('MetricRegistry', () => {
  it('registers metrics and renders them in registration order', () => {
    const reg = new MetricRegistry()
    const c = reg.counter({ name: 'reqs', help: 'count' })
    const g = reg.gauge({ name: 'up', help: 'up' })
    c.inc({}, 42)
    g.set(1)

    const text = reg.render()
    // Order preserved: reqs block before up block.
    const reqsIdx = text.indexOf('# HELP reqs')
    const upIdx = text.indexOf('# HELP up')
    expect(reqsIdx).toBeLessThan(upIdx)
    // Trailing newline required by the exposition format.
    expect(text.endsWith('\n')).toBe(true)
  })

  it('rejects duplicate registration of the same metric name', () => {
    const reg = new MetricRegistry()
    reg.counter({ name: 'x', help: 'x' })
    expect(() => reg.counter({ name: 'x', help: 'x' })).toThrow(
      /already registered/,
    )
  })

  it('size + get expose the inner map for tests', () => {
    const reg = new MetricRegistry()
    reg.counter({ name: 'a', help: 'a' })
    reg.gauge({ name: 'b', help: 'b' })
    expect(reg.size()).toBe(2)
    expect(reg.get('a')).toBeInstanceOf(Counter)
    expect(reg.get('b')).toBeInstanceOf(Gauge)
    expect(reg.get('nope')).toBeUndefined()
  })

  it('PROMETHEUS_CONTENT_TYPE is the exposition-format header', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    )
  })
})

// ─── Label escaping ───────────────────────────────────────────────

describe('label value escaping', () => {
  it('escapes backslash / double-quote / newline per exposition spec', () => {
    const c = new Counter<'msg'>({
      name: 'log',
      help: 'log',
      labelKeys: ['msg'],
    })
    c.inc({ msg: 'it "worked"\nkinda\\' })
    const out = c.render()
    expect(out).toContain(`log{msg="it \\"worked\\"\\nkinda\\\\"} 1`)
  })

  it('unlabeled metrics emit no {} block', () => {
    const c = new Counter({ name: 'bare', help: 'bare' })
    c.inc()
    expect(c.render()).toContain('bare 1')
    expect(c.render()).not.toContain('bare{}')
  })
})
