import { describe, it, expect } from 'vitest'
import {
  analyzeWorkspace,
  type AnalyzeFs,
} from '../../../../../src/runtime/bun/analyze/index.js'
import type { WranglerConfig } from '../../../../../src/config/schema.js'

function memoryFs(files: Record<string, string>): AnalyzeFs {
  return {
    async listSourceFiles() {
      return Object.keys(files).sort()
    },
    async readSource(path) {
      const content = files[path]
      if (content === undefined) throw new Error(`missing: ${path}`)
      return content
    },
  }
}

describe('analyzeWorkspace — verdict', () => {
  it('returns "ready" when no blockers and no review items', async () => {
    const wrangler: WranglerConfig = {
      name: 'demo',
      kv_namespaces: [{ binding: 'CACHE', id: '...' }],
    }
    const r = await analyzeWorkspace({
      wrangler,
      sourceRoot: 'src',
      fs: memoryFs({
        'src/index.ts': `export default {
          async fetch(_req, env) { return new Response(await env.CACHE.get('k')) }
        }`,
      }),
    })
    expect(r.verdict).toBe('ready')
    expect(r.summary.blockers).toBe(0)
    expect(r.summary.reviewNeeded).toBe(0)
  })

  it('returns "blocked" when source uses HTMLRewriter', async () => {
    const r = await analyzeWorkspace({
      wrangler: { name: 'demo' },
      sourceRoot: 'src',
      fs: memoryFs({
        'src/index.ts': `export default {
          fetch() { return new HTMLRewriter().transform(new Response()) }
        }`,
      }),
    })
    expect(r.verdict).toBe('blocked')
    expect(r.summary.blockers).toBeGreaterThan(0)
  })

  it('returns "blocked" when wrangler declares a Durable Object binding', async () => {
    const r = await analyzeWorkspace({
      wrangler: {
        name: 'demo',
        durable_objects: { bindings: [{ name: 'C', class_name: 'Counter' }] },
      },
      sourceRoot: 'src',
      fs: memoryFs({ 'src/index.ts': `export default { fetch() { return new Response() } }` }),
    })
    expect(r.verdict).toBe('blocked')
  })

  it('returns "needs-changes" when only review-needed items present', async () => {
    const r = await analyzeWorkspace({
      wrangler: { name: 'demo' },
      sourceRoot: 'src',
      fs: memoryFs({
        'src/index.ts': `export default {
          async fetch(req, _env, ctx) {
            ctx.waitUntil(fetch('https://x'))
            return new Response('ok')
          }
        }`,
      }),
    })
    expect(r.verdict).toBe('needs-changes')
    expect(r.summary.reviewNeeded).toBeGreaterThan(0)
    expect(r.summary.blockers).toBe(0)
  })
})

describe('analyzeWorkspace — output shape', () => {
  it('reports filesScanned + workerName + sourceRoot', async () => {
    const r = await analyzeWorkspace({
      wrangler: { name: 'my-api' },
      sourceRoot: 'workers',
      fs: memoryFs({
        'workers/a.ts': 'export default { fetch() { return new Response() } }',
        'workers/b.ts': 'export default { fetch() { return new Response() } }',
      }),
    })
    expect(r.workerName).toBe('my-api')
    expect(r.sourceRoot).toBe('workers')
    expect(r.filesScanned).toBe(2)
  })

  it('orders findings: compatible → review-needed → blocker', async () => {
    const r = await analyzeWorkspace({
      wrangler: {
        name: 'demo',
        kv_namespaces: [{ binding: 'CACHE', id: '...' }],
      },
      sourceRoot: 'src',
      fs: memoryFs({
        'src/index.ts': `export default {
          async fetch(req, _env, ctx) {
            ctx.waitUntil(fetch('https://x'))
            return new HTMLRewriter().transform(new Response())
          }
        }`,
      }),
    })
    const severities = r.findings.map((f) => f.severity)
    const indexOfBlocker = severities.indexOf('blocker')
    const indexOfReview = severities.indexOf('review-needed')
    const indexOfCompat = severities.indexOf('compatible')
    expect(indexOfCompat).toBeLessThan(indexOfReview)
    expect(indexOfReview).toBeLessThan(indexOfBlocker)
  })

  it('treats parse errors as review-needed (does not crash the run)', async () => {
    const r = await analyzeWorkspace({
      wrangler: { name: 'demo' },
      sourceRoot: 'src',
      fs: memoryFs({
        'src/index.ts': 'export default { fetch(req',
      }),
    })
    expect(r.verdict).not.toBe('blocked')
    expect(r.findings.some((f) => /parse error/.test(f.message))).toBe(true)
  })
})
