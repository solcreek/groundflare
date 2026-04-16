import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveBuiltEntry } from '../../../src/deploy/detect-built-entry.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gf-builtentry-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function touch(path: string): Promise<void> {
  await mkdir(join(tmp, path, '..'), { recursive: true })
  await writeFile(join(tmp, path), 'export default {}')
}

describe('resolveBuiltEntry', () => {
  it('uses configured main when it exists and is built (.js/.mjs)', async () => {
    await touch('dist/worker.js')
    const r = resolveBuiltEntry({ cwd: tmp, main: 'dist/worker.js' })
    expect(r.source).toBe('config')
    expect(r.path).toBe(join(tmp, 'dist/worker.js'))
  })

  it('detects @astrojs/cloudflare v13+ at dist/server/entry.mjs', async () => {
    await touch('src/worker.ts')
    await touch('dist/server/entry.mjs')
    const r = resolveBuiltEntry({ cwd: tmp, main: 'src/worker.ts' })
    expect(r.source).toBe('framework-detected')
    expect(r.framework).toMatch(/astro/i)
    expect(r.path).toBe(join(tmp, 'dist/server/entry.mjs'))
  })

  it('detects @astrojs/cloudflare v12 at dist/_worker.js/index.js', async () => {
    await touch('src/worker.ts')
    await touch('dist/_worker.js/index.js')
    const r = resolveBuiltEntry({ cwd: tmp, main: 'src/worker.ts' })
    expect(r.source).toBe('framework-detected')
    expect(r.framework).toContain('v12')
  })

  it('prefers @astrojs/cloudflare v13+ over v12 when both exist', async () => {
    await touch('src/worker.ts')
    await touch('dist/server/entry.mjs')
    await touch('dist/_worker.js/index.js')
    const r = resolveBuiltEntry({ cwd: tmp, main: 'src/worker.ts' })
    expect(r.path).toBe(join(tmp, 'dist/server/entry.mjs'))
  })

  it('detects SvelteKit adapter output', async () => {
    await touch('src/worker.ts')
    await touch('.svelte-kit/cloudflare/_worker.js')
    const r = resolveBuiltEntry({ cwd: tmp, main: 'src/worker.ts' })
    expect(r.framework).toContain('svelte')
  })

  it('falls back to config main when no framework output exists', async () => {
    await touch('src/worker.ts')
    const r = resolveBuiltEntry({ cwd: tmp, main: 'src/worker.ts' })
    // src/*.ts is treated as source; falls through to candidates; none
    // exist, so config is returned as fallback (with the source path).
    expect(r.source).toBe('config')
    expect(r.path).toBe(join(tmp, 'src/worker.ts'))
  })

  it('throws when mustExist + nothing found', () => {
    expect(() =>
      resolveBuiltEntry({ cwd: tmp, main: 'missing.js', mustExist: true }),
    ).toThrow(/no built entry found/)
  })

  it('treats dist/*.js as built (not source)', async () => {
    await touch('dist/main.js')
    const r = resolveBuiltEntry({ cwd: tmp, main: 'dist/main.js' })
    expect(r.source).toBe('config')
  })
})
