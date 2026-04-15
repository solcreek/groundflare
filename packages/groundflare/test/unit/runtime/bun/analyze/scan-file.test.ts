import { describe, it, expect } from 'vitest'
import { scanFile } from '../../../../../src/runtime/bun/analyze/scan-file.js'

describe('scanFile — env binding accesses', () => {
  it('captures env.<name> member accesses with file:line:column', () => {
    const src = `export default {
  async fetch(req, env) {
    return env.DB.prepare('select 1').first()
  }
}`
    const r = scanFile('worker.ts', src)
    expect(r.parseError).toBe(null)
    expect(r.envAccesses).toHaveLength(1)
    expect(r.envAccesses[0]?.binding).toBe('DB')
    expect(r.envAccesses[0]?.location.file).toBe('worker.ts')
    expect(r.envAccesses[0]?.location.line).toBe(3)
  })

  it('captures multiple bindings across one file', () => {
    const src = `export default {
  async fetch(_req, env) {
    await env.CACHE.put('k', 'v')
    await env.DB.prepare('select 1').first()
    return new Response(env.GREETING)
  }
}`
    const r = scanFile('worker.ts', src)
    const names = r.envAccesses.map((a) => a.binding).sort()
    expect(names).toEqual(['CACHE', 'DB', 'GREETING'])
  })

  it('does not capture env in unrelated contexts (string literals, comments)', () => {
    const src = `// env.SHOULD_NOT_MATCH appears in a comment
const note = 'env.STILL_NOT_MATCHED is a string'
export default { fetch(_, env) { return env.REAL } }`
    const r = scanFile('w.ts', src)
    expect(r.envAccesses.map((a) => a.binding)).toEqual(['REAL'])
  })

  it('ignores computed accesses env[binding] — these need manual review elsewhere', () => {
    const src = `export default {
  async fetch(_req, env) {
    const name = 'DB'
    return env[name].prepare('').first()
  }
}`
    const r = scanFile('w.ts', src)
    // Computed access yields no static binding name, so the scanner skips it.
    // (Classifier would have nothing to match anyway.)
    expect(r.envAccesses).toEqual([])
  })
})

describe('scanFile — blockers', () => {
  it('flags new HTMLRewriter() as a blocker with location', () => {
    const src = `export default {
  async fetch(req) {
    return new HTMLRewriter().on('a', {}).transform(await fetch('https://x'))
  }
}`
    const r = scanFile('handler.ts', src)
    const html = r.findings.find((f) => f.kind === 'html-rewriter')
    expect(html?.severity).toBe('blocker')
    expect(html?.location?.file).toBe('handler.ts')
    expect(html?.location?.line).toBe(3)
  })

  it('flags new WebSocketPair() as a blocker', () => {
    const src = `export default {
  async fetch() {
    const pair = new WebSocketPair()
    return new Response(null, { status: 101, webSocket: pair[1] })
  }
}`
    const r = scanFile('ws.ts', src)
    expect(r.findings.some((f) => f.kind === 'web-socket-pair')).toBe(true)
  })

  it('flags class extends DurableObject', () => {
    const src = `import { DurableObject } from 'cloudflare:workers'
export class Counter extends DurableObject {
  count = 0
  async fetch() { return new Response(String(this.count)) }
}`
    const r = scanFile('do.ts', src)
    const f = r.findings.find((x) => x.kind === 'durable-object-class')
    expect(f?.severity).toBe('blocker')
    expect(f?.detail).toBe('Counter')
  })

  it('does not flag unrelated class extends', () => {
    const src = `class Foo extends Error {}; class Bar extends Foo {}`
    const r = scanFile('cls.ts', src)
    expect(r.findings.filter((f) => f.severity === 'blocker')).toEqual([])
  })
})

describe('scanFile — review-needed signals', () => {
  it('flags caches.default access', () => {
    const src = `export default {
  async fetch(req) {
    const c = caches.default
    const hit = await c.match(req)
    return hit ?? new Response('miss')
  }
}`
    const r = scanFile('cache.ts', src)
    expect(r.findings.some((f) => f.kind === 'cache-api')).toBe(true)
  })

  it('flags ctx.waitUntil(...) as a behavioural diff, not a blocker', () => {
    const src = `export default {
  async fetch(req, env, ctx) {
    ctx.waitUntil(env.LOG.put('hit', String(Date.now())))
    return new Response('ok')
  }
}`
    const r = scanFile('w.ts', src)
    const w = r.findings.find((f) => f.kind === 'wait-until')
    expect(w?.severity).toBe('review-needed')
  })

  it('does not flag bare ctx.waitUntil access without a call', () => {
    // Edge case: someone destructures `const { waitUntil } = ctx`. The
    // scanner only flags a real call expression to keep noise down.
    const src = `export default {
  async fetch(_, __, ctx) {
    const w = ctx.waitUntil
    return new Response(typeof w)
  }
}`
    const r = scanFile('w.ts', src)
    expect(r.findings.find((f) => f.kind === 'wait-until')).toBeUndefined()
  })
})

describe('scanFile — parse errors', () => {
  it('returns a parseError instead of throwing for malformed source', () => {
    const src = `export default { fetch(req`
    const r = scanFile('broken.ts', src)
    expect(r.parseError).not.toBe(null)
    expect(r.findings).toEqual([])
    expect(r.envAccesses).toEqual([])
  })
})
