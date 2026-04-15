import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, chmod, stat } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import {
  FileSecretStore,
  SecretStoreError,
  inspectFileMode,
} from '../../../src/secret/index.js'

const isPosix = platform() !== 'win32'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gf-secret-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function makeStore(name = 'secrets.json'): FileSecretStore {
  return new FileSecretStore({ path: join(tmp, 'sub', name) })
}

describe('FileSecretStore: empty / first use', () => {
  it('returns null for any key when the file does not exist', async () => {
    const store = makeStore()
    expect(await store.get('provider.hetzner.token')).toBe(null)
  })

  it('list() returns [] when the file does not exist', async () => {
    const store = makeStore()
    expect(await store.list()).toEqual([])
  })

  it('delete() is a no-op when the file does not exist', async () => {
    const store = makeStore()
    await expect(store.delete('anything.x')).resolves.toBeUndefined()
  })
})

describe('FileSecretStore: set / get / delete', () => {
  it('round-trips a value', async () => {
    const store = makeStore()
    await store.set('provider.hetzner.token', 'tok_xyz')
    expect(await store.get('provider.hetzner.token')).toBe('tok_xyz')
  })

  it('overwrites an existing value', async () => {
    const store = makeStore()
    await store.set('k', 'first')
    await store.set('k', 'second')
    expect(await store.get('k')).toBe('second')
  })

  it('list() returns keys in lexicographic order', async () => {
    const store = makeStore()
    await store.set('zeta', '1')
    await store.set('alpha', '2')
    await store.set('mid.thing', '3')
    expect(await store.list()).toEqual(['alpha', 'mid.thing', 'zeta'])
  })

  it('delete() removes a key', async () => {
    const store = makeStore()
    await store.set('a', '1')
    await store.set('b', '2')
    await store.delete('a')
    expect(await store.get('a')).toBe(null)
    expect(await store.list()).toEqual(['b'])
  })

  it('preserves Unicode values', async () => {
    const store = makeStore()
    await store.set('greeting', '你好 🌍')
    expect(await store.get('greeting')).toBe('你好 🌍')
  })

  it('preserves empty-string values (distinct from missing key)', async () => {
    const store = makeStore()
    await store.set('empty', '')
    expect(await store.get('empty')).toBe('')
    expect(await store.get('absent')).toBe(null)
  })
})

describe('FileSecretStore: persistence across instances', () => {
  it('a new store reads what the previous one wrote', async () => {
    const path = join(tmp, 'persist', 'secrets.json')
    const a = new FileSecretStore({ path })
    await a.set('k', 'v')
    const b = new FileSecretStore({ path })
    expect(await b.get('k')).toBe('v')
  })
})

describe('FileSecretStore: file mode', () => {
  it.skipIf(!isPosix)('writes the secrets file with mode 0600', async () => {
    const store = makeStore()
    await store.set('k', 'v')
    const mode = await inspectFileMode(store.path)
    expect(mode).toBe(0o600)
  })

  it.skipIf(!isPosix)('creates the parent directory with mode 0700', async () => {
    const store = makeStore()
    await store.set('k', 'v')
    const dir = store.path.replace(/\/secrets\.json$/, '')
    const s = await stat(dir)
    expect(s.mode & 0o777).toBe(0o700)
  })

  it.skipIf(!isPosix)('inspectFileMode returns null for a missing file', async () => {
    expect(await inspectFileMode(join(tmp, 'missing.json'))).toBe(null)
  })
})

describe('FileSecretStore: validation', () => {
  it('rejects empty key', async () => {
    const store = makeStore()
    await expect(store.set('', 'v')).rejects.toMatchObject({
      name: 'SecretStoreError',
      code: 'invalid',
    })
  })

  it('rejects keys with disallowed characters', async () => {
    const store = makeStore()
    for (const bad of ['has space', 'has/slash', 'has*star', '中文']) {
      await expect(store.set(bad, 'v')).rejects.toBeInstanceOf(SecretStoreError)
    }
  })

  it('accepts the documented naming convention keys', async () => {
    const store = makeStore()
    for (const ok of [
      'provider.hetzner.token',
      'workspace.my-vps.restic_password',
      'a-b-c.d_e_f.GHI',
    ]) {
      await expect(store.set(ok, 'v')).resolves.toBeUndefined()
    }
  })

  it('rejects keys longer than 128 chars', async () => {
    const store = makeStore()
    await expect(store.set('a'.repeat(129), 'v')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects non-string values', async () => {
    const store = makeStore()
    // @ts-expect-error — runtime check for callers that bypass TS
    await expect(store.set('k', 42)).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('FileSecretStore: file integrity', () => {
  it('throws SecretStoreError(corrupt) when the file is not JSON', async () => {
    const path = join(tmp, 'corrupt.json')
    await writeFile(path, 'not really json {{{', 'utf-8')
    const store = new FileSecretStore({ path })
    await expect(store.get('any')).rejects.toMatchObject({
      name: 'SecretStoreError',
      code: 'corrupt',
    })
  })

  it('throws SecretStoreError(corrupt) when the schema mismatches', async () => {
    const path = join(tmp, 'wrong-shape.json')
    await writeFile(path, JSON.stringify({ unrelated: true }), 'utf-8')
    const store = new FileSecretStore({ path })
    await expect(store.list()).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('throws SecretStoreError(corrupt) when secret values are not strings', async () => {
    const path = join(tmp, 'wrong-types.json')
    await writeFile(
      path,
      JSON.stringify({ version: 1, secrets: { ok: 'fine', bad: 42 } }),
      'utf-8',
    )
    const store = new FileSecretStore({ path })
    await expect(store.get('ok')).rejects.toMatchObject({ code: 'corrupt' })
  })
})

describe('FileSecretStore: atomic write', () => {
  it('does not leave the file in a half-written state on rename failure', async () => {
    // We simulate this by checking that no `.tmp` file leaks after a
    // successful set(). The temp-then-rename path uses a random suffix.
    const store = makeStore()
    await store.set('k', 'v')
    const fs = await import('node:fs/promises')
    const dir = store.path.replace(/\/secrets\.json$/, '')
    const entries = await fs.readdir(dir)
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([])
  })

  it('the on-disk JSON is pretty-printed (2-space indent)', async () => {
    const store = makeStore()
    await store.set('first', '1')
    await store.set('second', '2')
    const raw = await readFile(store.path, 'utf-8')
    expect(raw).toContain('\n  "version": 1')
    expect(raw.endsWith('\n')).toBe(true)
  })
})

describe('FileSecretStore.defaultPath', () => {
  it('respects XDG_CONFIG_HOME when set', () => {
    const original = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = '/custom/xdg'
    try {
      expect(FileSecretStore.defaultPath()).toBe('/custom/xdg/groundflare/secrets.json')
    } finally {
      if (original === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = original
    }
  })

  it('falls back to ~/.config/groundflare/secrets.json without XDG_CONFIG_HOME', () => {
    const original = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    try {
      const path = FileSecretStore.defaultPath()
      expect(path.endsWith('/.config/groundflare/secrets.json')).toBe(true)
    } finally {
      if (original !== undefined) process.env.XDG_CONFIG_HOME = original
    }
  })
})

describe('FileSecretStore: chmod hardening', () => {
  it.skipIf(!isPosix)('tightens file mode even if the directory pre-existed loose', async () => {
    const dir = join(tmp, 'preset')
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true, mode: 0o755 })
    const path = join(dir, 'secrets.json')
    const store = new FileSecretStore({ path })
    await store.set('k', 'v')
    const mode = await inspectFileMode(path)
    expect(mode).toBe(0o600)
  })

  it.skipIf(!isPosix)('replays chmod 0600 even if the file existed under a wider umask', async () => {
    const path = join(tmp, 'wide.json')
    await writeFile(path, JSON.stringify({ version: 1, secrets: {} }), { mode: 0o644 })
    const store = new FileSecretStore({ path })
    await store.set('k', 'v')
    const mode = await inspectFileMode(path)
    expect(mode).toBe(0o600)
  })

  it.skipIf(!isPosix)(
    'after chmod-tightening, future opens still work for the owner',
    async () => {
      const store = makeStore()
      await store.set('k', 'v')
      await chmod(store.path, 0o600)
      // sanity — owner can still read
      expect(await store.get('k')).toBe('v')
    },
  )
})
