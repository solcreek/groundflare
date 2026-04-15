import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ConfigNotFoundError,
  ConfigParseError,
  findWranglerConfig,
  readConfigFile,
  stripJsonComments,
} from '../../../src/config/index.js'

describe('findWranglerConfig', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-cfg-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('finds wrangler.toml in the starting directory', async () => {
    const path = join(tmp, 'wrangler.toml')
    await writeFile(path, 'name = "x"\n')
    expect(findWranglerConfig(tmp)).toBe(path)
  })

  it('finds wrangler.jsonc when no toml present', async () => {
    const path = join(tmp, 'wrangler.jsonc')
    await writeFile(path, '{"name": "x"}')
    expect(findWranglerConfig(tmp)).toBe(path)
  })

  it('finds wrangler.json when no toml/jsonc present', async () => {
    const path = join(tmp, 'wrangler.json')
    await writeFile(path, '{"name": "x"}')
    expect(findWranglerConfig(tmp)).toBe(path)
  })

  it('prefers toml over jsonc over json when multiple exist', async () => {
    await writeFile(join(tmp, 'wrangler.json'), '{"name": "json"}')
    await writeFile(join(tmp, 'wrangler.jsonc'), '{"name": "jsonc"}')
    await writeFile(join(tmp, 'wrangler.toml'), 'name = "toml"\n')
    expect(findWranglerConfig(tmp)).toBe(join(tmp, 'wrangler.toml'))
  })

  it('walks upward when starting from a subdirectory', async () => {
    await writeFile(join(tmp, 'wrangler.toml'), 'name = "x"\n')
    const sub = join(tmp, 'a', 'b', 'c')
    await mkdir(sub, { recursive: true })
    expect(findWranglerConfig(sub)).toBe(join(tmp, 'wrangler.toml'))
  })

  it('returns null when no config exists anywhere up the tree', () => {
    // Using a temp dir that has no wrangler file and assuming /tmp ancestors
    // don't have one either — a safe assumption on developer machines + CI.
    expect(findWranglerConfig(tmp)).toBe(null)
  })

  it('accepts a relative path and resolves it', async () => {
    await writeFile(join(tmp, 'wrangler.toml'), 'name = "x"\n')
    const prev = process.cwd()
    try {
      process.chdir(tmp)
      // Compare against cwd() rather than `tmp` directly — on macOS
      // `mkdtemp` returns /var/... but process.cwd() reports /private/var/...
      // after chdir resolves the symlink.
      expect(findWranglerConfig('.')).toBe(resolve(process.cwd(), 'wrangler.toml'))
    } finally {
      process.chdir(prev)
    }
  })
})

describe('readConfigFile — TOML', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-cfg-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('parses a minimal wrangler.toml', async () => {
    const path = join(tmp, 'wrangler.toml')
    await writeFile(path, 'name = "hello"\nmain = "src/index.js"\n')
    const { wrangler, groundflare, source } = await readConfigFile(path)
    expect(wrangler.name).toBe('hello')
    expect(wrangler.main).toBe('src/index.js')
    expect(groundflare).toEqual({})
    expect(source.format).toBe('toml')
    expect(source.file).toBe(path)
  })

  it('extracts [groundflare] into its own object', async () => {
    const path = join(tmp, 'wrangler.toml')
    await writeFile(
      path,
      [
        'name = "hello"',
        '',
        '[groundflare]',
        'provider = "hetzner"',
        'region = "hel1"',
        'size = "cx22"',
      ].join('\n'),
    )
    const { wrangler, groundflare } = await readConfigFile(path)
    // The `groundflare` key is stripped from the wrangler view
    expect((wrangler as unknown as Record<string, unknown>).groundflare).toBeUndefined()
    expect(groundflare.provider).toBe('hetzner')
    expect(groundflare.region).toBe('hel1')
    expect(groundflare.size).toBe('cx22')
  })

  it('preserves wrangler binding arrays intact', async () => {
    const path = join(tmp, 'wrangler.toml')
    await writeFile(
      path,
      [
        'name = "hello"',
        '',
        '[[kv_namespaces]]',
        'binding = "CACHE"',
        'id = "kv-1"',
        '',
        '[[d1_databases]]',
        'binding = "DB"',
        'database_name = "hello"',
      ].join('\n'),
    )
    const { wrangler } = await readConfigFile(path)
    expect(wrangler.kv_namespaces).toEqual([{ binding: 'CACHE', id: 'kv-1' }])
    expect(wrangler.d1_databases).toEqual([{ binding: 'DB', database_name: 'hello' }])
  })

  it('preserves nested [groundflare.bindings.*] adapter overrides', async () => {
    const path = join(tmp, 'wrangler.toml')
    await writeFile(
      path,
      [
        'name = "hello"',
        '',
        '[[kv_namespaces]]',
        'binding = "CACHE"',
        'id = "kv-1"',
        '',
        '[groundflare.bindings.CACHE]',
        'adapter = "sqlite"',
        'path = "/var/lib/groundflare/kv/CACHE.sqlite"',
      ].join('\n'),
    )
    const { groundflare } = await readConfigFile(path)
    expect(groundflare.bindings?.CACHE).toEqual({
      adapter: 'sqlite',
      path: '/var/lib/groundflare/kv/CACHE.sqlite',
    })
  })

  it('throws ConfigParseError when `name` is missing', async () => {
    const path = join(tmp, 'wrangler.toml')
    await writeFile(path, 'main = "src/index.js"\n')
    await expect(readConfigFile(path)).rejects.toBeInstanceOf(ConfigParseError)
  })

  it('throws ConfigParseError on syntactically invalid TOML', async () => {
    const path = join(tmp, 'wrangler.toml')
    await writeFile(path, 'this is = not [ valid toml\n')
    await expect(readConfigFile(path)).rejects.toBeInstanceOf(ConfigParseError)
  })
})

describe('readConfigFile — JSON / JSONC', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-cfg-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('parses wrangler.json', async () => {
    const path = join(tmp, 'wrangler.json')
    await writeFile(
      path,
      JSON.stringify({
        name: 'hello',
        main: 'src/index.js',
        kv_namespaces: [{ binding: 'CACHE', id: 'kv-1' }],
      }),
    )
    const { wrangler, source } = await readConfigFile(path)
    expect(wrangler.name).toBe('hello')
    expect(wrangler.kv_namespaces).toHaveLength(1)
    expect(source.format).toBe('json')
  })

  it('parses wrangler.jsonc with line and block comments', async () => {
    const path = join(tmp, 'wrangler.jsonc')
    await writeFile(
      path,
      [
        '{',
        '  // the worker name',
        '  "name": "hello",',
        '  /* bindings below',
        '     matter for KV */',
        '  "kv_namespaces": [{ "binding": "CACHE", "id": "kv-1" }]',
        '}',
      ].join('\n'),
    )
    const { wrangler, source } = await readConfigFile(path)
    expect(wrangler.name).toBe('hello')
    expect(source.format).toBe('jsonc')
  })

  it('throws ConfigParseError on broken JSON', async () => {
    const path = join(tmp, 'wrangler.json')
    await writeFile(path, '{ "name": "hello", }')
    await expect(readConfigFile(path)).rejects.toBeInstanceOf(ConfigParseError)
  })
})

describe('ConfigNotFoundError', () => {
  it('mentions the starting directory in its message', () => {
    const err = new ConfigNotFoundError('/some/where')
    expect(err.message).toContain('/some/where')
    expect(err.message).toContain('wrangler.toml')
  })
})

describe('stripJsonComments', () => {
  it('removes single-line comments outside strings', () => {
    expect(stripJsonComments('{\n  // comment\n  "a": 1\n}')).not.toContain('//')
  })

  it('removes block comments outside strings', () => {
    expect(stripJsonComments('{\n  /* block */ "a": 1\n}')).not.toContain('/*')
  })

  it('does not touch // inside string literals', () => {
    const src = '{"url": "http://example.com"}'
    expect(stripJsonComments(src)).toBe(src)
  })

  it('does not touch /* inside string literals', () => {
    const src = '{"pattern": "/* not a comment */"}'
    expect(stripJsonComments(src)).toBe(src)
  })

  it('respects escaped quotes within strings', () => {
    const src = '{"msg": "she said \\"// hi\\""}'
    expect(stripJsonComments(src)).toBe(src)
  })
})
