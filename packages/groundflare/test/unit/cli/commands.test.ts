import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from 'citty'
import upCommand from '../../../src/cli/commands/up.js'
import deployCommand from '../../../src/cli/commands/deploy.js'
import tailCommand from '../../../src/cli/commands/tail.js'
import estimateCommand from '../../../src/cli/commands/estimate.js'
import destroyCommand from '../../../src/cli/commands/destroy.js'
import statusCommand from '../../../src/cli/commands/status.js'
import configCommand from '../../../src/cli/commands/config.js'
import { buildMain } from '../../../src/cli/index.js'
import { shouldSkipUpdateCheck } from '../../../src/cli/update-check.js'

describe('stub commands — metadata', () => {
  const stubs = [
    { name: 'up', cmd: upCommand },
    { name: 'deploy', cmd: deployCommand },
    { name: 'tail', cmd: tailCommand },
    { name: 'estimate', cmd: estimateCommand },
    { name: 'destroy', cmd: destroyCommand },
    { name: 'status', cmd: statusCommand },
  ]

  for (const { name, cmd } of stubs) {
    it(`${name} exposes meta.name and description`, async () => {
      const meta = await (typeof cmd.meta === 'function' ? cmd.meta() : cmd.meta)
      expect(meta?.name).toBe(name)
      expect(typeof meta?.description).toBe('string')
      expect(meta?.description).not.toBe('')
    })
  }
})

describe('main command', () => {
  it('wires up all expected subcommands', async () => {
    const main = await buildMain()
    const subs =
      typeof main.subCommands === 'function'
        ? await main.subCommands()
        : main.subCommands
    expect(Object.keys(subs ?? {}).sort()).toEqual(
      ['bun', 'config', 'deploy', 'destroy', 'estimate', 'secret', 'status', 'tail', 'up'].sort(),
    )
  })

  it('reads version + name from package.json', async () => {
    const main = await buildMain()
    const meta = await (typeof main.meta === 'function' ? main.meta() : main.meta)
    expect(meta?.name).toBe('groundflare')
    expect(meta?.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('config show — real end-to-end', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-cli-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('parses wrangler.toml and writes resolved JSON to stdout', async () => {
    await writeFile(
      join(tmp, 'wrangler.toml'),
      [
        'name = "hello"',
        'main = "src/index.js"',
        '',
        '[groundflare]',
        'provider = "hetzner"',
        'size = "cx22"',
      ].join('\n'),
    )

    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stdout.write

    try {
      await runCommand(configCommand, { rawArgs: ['show', '--cwd', tmp] })
    } finally {
      process.stdout.write = originalWrite
    }

    const output = chunks.join('')
    const parsed = JSON.parse(output)
    expect(parsed.wrangler.name).toBe('hello')
    expect(parsed.groundflare.provider).toBe('hetzner')
    expect(parsed.resolved.runtime).toBe('workerd') // from STATIC_DEFAULTS
    expect(parsed.resolved.provider).toBe('hetzner')
    expect(parsed.source.format).toBe('toml')
  })
})

describe('shouldSkipUpdateCheck', () => {
  const originalEnv = process.env.GROUNDFLARE_DISABLE_UPDATE_CHECK

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.GROUNDFLARE_DISABLE_UPDATE_CHECK
    else process.env.GROUNDFLARE_DISABLE_UPDATE_CHECK = originalEnv
  })

  it('returns true when env var is set to 1', () => {
    process.env.GROUNDFLARE_DISABLE_UPDATE_CHECK = '1'
    expect(shouldSkipUpdateCheck()).toBe(true)
  })

  it('returns true when --no-update-check is in argv', () => {
    delete process.env.GROUNDFLARE_DISABLE_UPDATE_CHECK
    expect(shouldSkipUpdateCheck(['node', 'gf', 'up', '--no-update-check'])).toBe(true)
  })

  it('returns false otherwise', () => {
    delete process.env.GROUNDFLARE_DISABLE_UPDATE_CHECK
    expect(shouldSkipUpdateCheck(['node', 'gf', 'up'])).toBe(false)
  })
})
