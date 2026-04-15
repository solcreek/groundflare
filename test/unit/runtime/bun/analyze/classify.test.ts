import { describe, it, expect } from 'vitest'
import { classifyBindings } from '../../../../../src/runtime/bun/analyze/classify.js'
import type { WranglerConfig } from '../../../../../src/config/schema.js'

const baseConfig: WranglerConfig = { name: 'demo' }

describe('classifyBindings — inventory', () => {
  it('emits a compatible finding for every KV / D1 / R2 binding', () => {
    const out = classifyBindings({
      wrangler: {
        ...baseConfig,
        kv_namespaces: [{ binding: 'CACHE', id: '...' }],
        d1_databases: [{ binding: 'DB', database_name: 'app' }],
        r2_buckets: [{ binding: 'ASSETS', bucket_name: 'a' }],
      },
      envAccesses: [],
    })
    const kinds = out.map((f) => f.kind).sort()
    expect(kinds).toEqual(['d1-binding', 'kv-binding', 'r2-binding'])
    expect(out.every((f) => f.severity === 'compatible')).toBe(true)
  })

  it('includes vars as compatible bindings', () => {
    const out = classifyBindings({
      wrangler: {
        ...baseConfig,
        vars: { GREETING: 'hi', COUNT: 3 },
      },
      envAccesses: [],
    })
    const names = out.map((f) => f.detail).sort()
    expect(names).toEqual(['COUNT', 'GREETING'])
    expect(out.every((f) => f.kind === 'vars-binding')).toBe(true)
  })

  it('flags Durable Object bindings as blockers', () => {
    const out = classifyBindings({
      wrangler: {
        ...baseConfig,
        durable_objects: {
          bindings: [{ name: 'COUNTER', class_name: 'Counter' }],
        },
      },
      envAccesses: [],
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('durable-object-binding')
    expect(out[0]?.severity).toBe('blocker')
  })

  it('orders bindings deterministically (alphabetical within each kind)', () => {
    const a = classifyBindings({
      wrangler: {
        ...baseConfig,
        kv_namespaces: [
          { binding: 'Z', id: '1' },
          { binding: 'A', id: '2' },
        ],
      },
      envAccesses: [],
    })
    const b = classifyBindings({
      wrangler: {
        ...baseConfig,
        kv_namespaces: [
          { binding: 'A', id: '2' },
          { binding: 'Z', id: '1' },
        ],
      },
      envAccesses: [],
    })
    expect(a.map((f) => f.detail)).toEqual(b.map((f) => f.detail))
    expect(a.map((f) => f.detail)).toEqual(['A', 'Z'])
  })
})

describe('classifyBindings — unknown env access', () => {
  it('emits a review-needed finding for env.X with no matching binding', () => {
    const out = classifyBindings({
      wrangler: baseConfig,
      envAccesses: [
        {
          binding: 'MYSTERY',
          location: { file: 'w.ts', line: 5, column: 12 },
        },
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('unknown-env-access')
    expect(out[0]?.severity).toBe('review-needed')
    expect(out[0]?.detail).toBe('MYSTERY')
  })

  it('deduplicates repeated unknown env accesses', () => {
    const out = classifyBindings({
      wrangler: baseConfig,
      envAccesses: [
        { binding: 'X', location: { file: 'a.ts', line: 1, column: 1 } },
        { binding: 'X', location: { file: 'b.ts', line: 9, column: 1 } },
      ],
    })
    expect(out).toHaveLength(1)
  })

  it('does not emit unknown-env-access for bindings that exist in wrangler.toml', () => {
    const out = classifyBindings({
      wrangler: {
        ...baseConfig,
        kv_namespaces: [{ binding: 'CACHE', id: '...' }],
      },
      envAccesses: [
        { binding: 'CACHE', location: { file: 'w.ts', line: 1, column: 1 } },
      ],
    })
    expect(out.filter((f) => f.kind === 'unknown-env-access')).toEqual([])
  })
})
