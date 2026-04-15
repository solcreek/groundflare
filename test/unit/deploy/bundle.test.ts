import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bundleWorker, DeployError } from '../../../src/deploy/index.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gf-bundle-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('bundleWorker', () => {
  it('bundles a trivial ES module', async () => {
    const entry = join(tmp, 'index.mjs')
    await writeFile(
      entry,
      `export default { async fetch() { return new Response('ok') } }`,
      'utf-8',
    )
    const result = await bundleWorker({ entry })
    expect(result.code).toContain('fetch')
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.warnings).toEqual([])
  })

  it('inlines a relative import into a single module', async () => {
    const helper = join(tmp, 'helper.mjs')
    const entry = join(tmp, 'index.mjs')
    await writeFile(helper, `export const GREETING = 'hi from helper'`, 'utf-8')
    await writeFile(
      entry,
      `import { GREETING } from './helper.mjs'\n` +
        `export default { async fetch() { return new Response(GREETING) } }`,
      'utf-8',
    )
    const result = await bundleWorker({ entry })
    expect(result.code).toContain('hi from helper')
    // No `import` statements should remain — everything was inlined.
    expect(result.code).not.toMatch(/^\s*import /m)
  })

  it('treats cloudflare:workers as external (never inlined)', async () => {
    const entry = join(tmp, 'index.mjs')
    await writeFile(
      entry,
      `import { DurableObject } from 'cloudflare:workers'\n` +
        `export class X extends DurableObject {}\n` +
        `export default { async fetch() { return new Response('ok') } }`,
      'utf-8',
    )
    const result = await bundleWorker({ entry })
    // The import must survive as-is so workerd resolves it to its built-in.
    // esbuild emits double-quoted imports; allow either quote style.
    expect(result.code).toMatch(/from ["']cloudflare:workers["']/)
  })

  it('throws DeployError(bundle_failed) on syntax error', async () => {
    const entry = join(tmp, 'broken.mjs')
    await writeFile(entry, 'export default { fetch: (', 'utf-8')
    await expect(bundleWorker({ entry })).rejects.toMatchObject({
      name: 'DeployError',
      code: 'bundle_failed',
    })
  })

  it('throws DeployError(bundle_failed) on missing entry', async () => {
    await expect(
      bundleWorker({ entry: join(tmp, 'does-not-exist.mjs') }),
    ).rejects.toBeInstanceOf(DeployError)
  })

  it('minify option shrinks the bundle', async () => {
    const entry = join(tmp, 'large.mjs')
    const source =
      'const reallyLongVariableNameForMinification = "x".repeat(100)\n' +
      'export default { async fetch() { return new Response(reallyLongVariableNameForMinification) } }'
    await writeFile(entry, source, 'utf-8')
    const normal = await bundleWorker({ entry })
    const minified = await bundleWorker({ entry, minify: true })
    expect(minified.bytes).toBeLessThan(normal.bytes)
  })
})
