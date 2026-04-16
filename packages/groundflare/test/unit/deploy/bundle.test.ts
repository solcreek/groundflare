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

  it('throws bundle_too_large when maxBytes is exceeded', async () => {
    const entry = join(tmp, 'fat.mjs')
    // Embed a ~2 KB string; set maxBytes to 1 KB to force the failure.
    const padding = 'x'.repeat(2048)
    await writeFile(
      entry,
      `const P = ${JSON.stringify(padding)}\n` +
        `export default { async fetch() { return new Response(P) } }`,
      'utf-8',
    )
    await expect(
      bundleWorker({ entry, maxBytes: 1024 }),
    ).rejects.toMatchObject({
      name: 'DeployError',
      code: 'bundle_too_large',
    })
  })

  it('includes a size advisory in warnings when warnBytes is exceeded', async () => {
    const entry = join(tmp, 'chunky.mjs')
    const padding = 'y'.repeat(2048)
    await writeFile(
      entry,
      `const P = ${JSON.stringify(padding)}\n` +
        `export default { async fetch() { return new Response(P) } }`,
      'utf-8',
    )
    const result = await bundleWorker({
      entry,
      warnBytes: 1024,
      maxBytes: 0, // disable hard limit so we reach the warning path
    })
    expect(result.warnings.some((w) => /advisory/i.test(w))).toBe(true)
  })

  it('maxBytes: 0 disables the hard limit', async () => {
    const entry = join(tmp, 'whatever.mjs')
    await writeFile(
      entry,
      `export default { async fetch() { return new Response('ok') } }`,
      'utf-8',
    )
    await expect(
      bundleWorker({ entry, maxBytes: 0 }),
    ).resolves.toBeDefined()
  })

  it('warnBytes: 0 suppresses the advisory', async () => {
    const entry = join(tmp, 'quiet.mjs')
    const padding = 'z'.repeat(2048)
    await writeFile(
      entry,
      `const P = ${JSON.stringify(padding)}\n` +
        `export default { async fetch() { return new Response(P) } }`,
      'utf-8',
    )
    const result = await bundleWorker({ entry, warnBytes: 0, maxBytes: 0 })
    expect(result.warnings.every((w) => !/advisory/i.test(w))).toBe(true)
  })
})
