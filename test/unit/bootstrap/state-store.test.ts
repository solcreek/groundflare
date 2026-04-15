import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'

import { BootstrapStateStore, BootstrapError } from '../../../src/bootstrap/index.js'
import type { BootstrapState } from '../../../src/bootstrap/index.js'

const isPosix = platform() !== 'win32'
let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gf-state-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function makeStore(): BootstrapStateStore {
  return new BootstrapStateStore({ directory: tmp })
}

const sampleState: BootstrapState = {
  workspace: 'demo',
  provider: 'hetzner',
  completedStages: ['provider.auth'],
  startedAt: '2026-04-14T00:00:00.000Z',
  updatedAt: '2026-04-14T00:00:01.000Z',
  account: { id: 'hetzner-abc', name: 'Hetzner Cloud project' },
}

describe('BootstrapStateStore', () => {
  it('load() returns null when the file does not exist', async () => {
    const s = makeStore()
    expect(await s.load('demo')).toBe(null)
  })

  it('save() then load() round-trips', async () => {
    const s = makeStore()
    await s.save(sampleState)
    const loaded = await s.load('demo')
    expect(loaded).toEqual(sampleState)
  })

  it('save() applies mode 0600 to the file and 0700 to the directory', async () => {
    if (!isPosix) return
    const s = makeStore()
    await s.save(sampleState)
    const fileStat = await stat(s.pathFor('demo'))
    expect(fileStat.mode & 0o777).toBe(0o600)
    const dirStat = await stat(s.directory)
    expect(dirStat.mode & 0o777).toBe(0o700)
  })

  it('save is atomic — no .tmp leftover after success', async () => {
    const s = makeStore()
    await s.save(sampleState)
    const fs = await import('node:fs/promises')
    const entries = await fs.readdir(s.directory)
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([])
  })

  it('load() throws BootstrapError(state_corrupt) for invalid JSON', async () => {
    const s = makeStore()
    await writeFile(s.pathFor('demo'), 'not json {{', 'utf-8')
    await expect(s.load('demo')).rejects.toMatchObject({
      name: 'BootstrapError',
      code: 'state_corrupt',
    })
  })

  it('load() throws BootstrapError(state_corrupt) for wrong schema', async () => {
    const s = makeStore()
    await writeFile(s.pathFor('demo'), JSON.stringify({ wrong: true }), 'utf-8')
    await expect(s.load('demo')).rejects.toMatchObject({ code: 'state_corrupt' })
  })

  it('list() returns workspace names sorted', async () => {
    const s = makeStore()
    await s.save({ ...sampleState, workspace: 'beta' })
    await s.save({ ...sampleState, workspace: 'alpha' })
    await s.save({ ...sampleState, workspace: 'gamma' })
    expect(await s.list()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('list() returns [] when the directory does not exist', async () => {
    const s = new BootstrapStateStore({ directory: join(tmp, 'missing') })
    expect(await s.list()).toEqual([])
  })

  it('rejects invalid workspace names', async () => {
    const s = makeStore()
    await expect(s.load('Bad Name')).rejects.toBeInstanceOf(BootstrapError)
    await expect(s.load('123-starts-with-digit')).rejects.toBeInstanceOf(BootstrapError)
  })
})

describe('BootstrapStateStore.defaultDirectory', () => {
  it('respects XDG_CONFIG_HOME', () => {
    const original = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = '/custom/xdg'
    try {
      expect(BootstrapStateStore.defaultDirectory()).toBe('/custom/xdg/groundflare/state')
    } finally {
      if (original === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = original
    }
  })

  it('falls back to ~/.config/groundflare/state', () => {
    const original = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    try {
      expect(BootstrapStateStore.defaultDirectory()).toMatch(
        /\/\.config\/groundflare\/state$/,
      )
    } finally {
      if (original !== undefined) process.env.XDG_CONFIG_HOME = original
    }
  })
})
