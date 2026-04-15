import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deepMerge,
  extractEnvOverrides,
  resolveConfig,
  STATIC_DEFAULTS,
} from '../../../src/config/index.js'
import type { ReadConfigResult } from '../../../src/config/schema.js'

// Helper: build a minimal ReadConfigResult without touching the filesystem.
function fakeRead(groundflare: ReadConfigResult['groundflare'] = {}): ReadConfigResult {
  return {
    wrangler: { name: 'hello', main: 'src/index.js' },
    groundflare,
    source: { file: '/fake/wrangler.toml', format: 'toml' },
  }
}

describe('deepMerge', () => {
  it('replaces primitives with the later value', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 })
  })

  it('merges plain objects recursively', () => {
    expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 99, z: 3 } })).toEqual({
      a: { x: 1, y: 99, z: 3 },
    })
  })

  it('replaces arrays wholesale (does not concatenate)', () => {
    expect(deepMerge({ xs: [1, 2, 3] }, { xs: [4] })).toEqual({ xs: [4] })
  })

  it('treats undefined in the patch as "no change"', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 })
  })

  it('keeps keys only in the base when the patch does not mention them', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 })
  })

  it('does not mutate its inputs', () => {
    const base = { a: { x: 1 } }
    const patch = { a: { x: 99 } }
    const result = deepMerge(base, patch)
    expect(base.a.x).toBe(1)
    expect(patch.a.x).toBe(99)
    expect(result.a.x).toBe(99)
  })
})

describe('extractEnvOverrides', () => {
  it('passes through valid top-level strings', () => {
    expect(
      extractEnvOverrides({
        GROUNDFLARE_REGION: 'hel1',
        GROUNDFLARE_SIZE: 'cx22',
        GROUNDFLARE_DOMAIN: 'api.example.com',
        GROUNDFLARE_EMAIL: 'you@example.com',
        GROUNDFLARE_BACKUP: 'b2:my-bucket',
      }),
    ).toEqual({
      region: 'hel1',
      size: 'cx22',
      domain: 'api.example.com',
      email: 'you@example.com',
      backup: 'b2:my-bucket',
    })
  })

  it('accepts valid enums', () => {
    expect(extractEnvOverrides({ GROUNDFLARE_PROVIDER: 'hetzner' })).toEqual({
      provider: 'hetzner',
    })
    expect(extractEnvOverrides({ GROUNDFLARE_RUNTIME: 'bun' })).toEqual({
      runtime: 'bun',
    })
  })

  it('ignores invalid enum values', () => {
    expect(extractEnvOverrides({ GROUNDFLARE_PROVIDER: 'aws' })).toEqual({})
    expect(extractEnvOverrides({ GROUNDFLARE_RUNTIME: 'deno' })).toEqual({})
  })

  it('returns an empty object when no GROUNDFLARE_* vars are set', () => {
    expect(extractEnvOverrides({ PATH: '/usr/bin', HOME: '/home/x' })).toEqual({})
  })

  it('ignores empty-string values (treated as unset)', () => {
    expect(extractEnvOverrides({ GROUNDFLARE_REGION: '' })).toEqual({})
  })
})

describe('resolveConfig', () => {
  it('applies STATIC_DEFAULTS when the file has no [groundflare] section', async () => {
    const { resolved } = await resolveConfig({ preRead: fakeRead() })
    expect(resolved.runtime).toBe(STATIC_DEFAULTS.runtime)
    expect(resolved.observability?.metrics).toBe('prometheus')
    expect(resolved.observability?.logs).toBe('json')
  })

  it('file [groundflare] section overrides static defaults', async () => {
    const { resolved } = await resolveConfig({
      preRead: fakeRead({
        provider: 'hetzner',
        size: 'cx22',
        observability: { metrics: 'none' },
      }),
    })
    expect(resolved.provider).toBe('hetzner')
    expect(resolved.size).toBe('cx22')
    expect(resolved.observability?.metrics).toBe('none')
    // logs was not specified in the file — static default still wins
    expect(resolved.observability?.logs).toBe('json')
  })

  it('cliOverrides win over file section', async () => {
    const { resolved } = await resolveConfig({
      preRead: fakeRead({ size: 'cx22' }),
      cliOverrides: { size: 'cx42' },
    })
    expect(resolved.size).toBe('cx42')
  })

  it('env vars win over cliOverrides', async () => {
    const { resolved } = await resolveConfig({
      preRead: fakeRead({ size: 'cx22' }),
      cliOverrides: { size: 'cx32' },
      env: { GROUNDFLARE_SIZE: 'cx42' },
    })
    expect(resolved.size).toBe('cx42')
  })

  it('applies [groundflare.env.<name>] when envName matches', async () => {
    const { resolved } = await resolveConfig({
      preRead: fakeRead({
        provider: 'hetzner',
        size: 'cx22',
        env: {
          production: { size: 'cx42', domain: 'api.example.com' },
        },
      }),
      envName: 'production',
    })
    expect(resolved.size).toBe('cx42')
    expect(resolved.provider).toBe('hetzner')
    expect(resolved.domain).toBe('api.example.com')
  })

  it('does not apply env overrides when envName is unset', async () => {
    const { resolved } = await resolveConfig({
      preRead: fakeRead({
        size: 'cx22',
        env: { production: { size: 'cx42' } },
      }),
    })
    expect(resolved.size).toBe('cx22')
  })

  it('strips the `env` namespace from the resolved section', async () => {
    const { resolved } = await resolveConfig({
      preRead: fakeRead({
        size: 'cx22',
        env: { staging: { size: 'cx11' } },
      }),
    })
    // `env` is a namespace for overrides, not a runtime field
    expect(resolved.env).toBeUndefined()
  })

  it('merges nested binding adapter overrides deeply', async () => {
    const { resolved } = await resolveConfig({
      preRead: fakeRead({
        bindings: {
          CACHE: { adapter: 'sqlite', path: '/var/lib/groundflare/kv/CACHE.sqlite' },
        },
      }),
      cliOverrides: {
        bindings: {
          CACHE: { path: '/tmp/override.sqlite' },
        },
      },
    })
    // The CLI override should not wipe the `adapter` field — deep merge
    expect(resolved.bindings?.CACHE).toEqual({
      adapter: 'sqlite',
      path: '/tmp/override.sqlite',
    })
  })

  it('preserves the original ReadConfigResult fields', async () => {
    const result = await resolveConfig({
      preRead: fakeRead({ provider: 'hetzner' }),
    })
    expect(result.wrangler.name).toBe('hello')
    expect(result.source.format).toBe('toml')
    expect(result.groundflare.provider).toBe('hetzner')
  })
})

describe('resolveConfig — disk path', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-res-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('reads from disk when preRead is not supplied', async () => {
    await writeFile(
      join(tmp, 'wrangler.toml'),
      ['name = "hello"', '', '[groundflare]', 'provider = "hetzner"'].join('\n'),
    )
    const { resolved } = await resolveConfig({ cwd: tmp })
    expect(resolved.provider).toBe('hetzner')
    expect(resolved.runtime).toBe('workerd') // from STATIC_DEFAULTS
  })

  it('throws ConfigNotFoundError when no wrangler config is found', async () => {
    await expect(resolveConfig({ cwd: tmp })).rejects.toMatchObject({
      name: 'ConfigNotFoundError',
    })
  })
})
