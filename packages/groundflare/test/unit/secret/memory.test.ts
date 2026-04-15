import { describe, it, expect } from 'vitest'
import { MemorySecretStore, SecretStoreError } from '../../../src/secret/index.js'

describe('MemorySecretStore', () => {
  it('round-trips a value', async () => {
    const store = new MemorySecretStore()
    await store.set('provider.hetzner.token', 'tok_xyz')
    expect(await store.get('provider.hetzner.token')).toBe('tok_xyz')
  })

  it('returns null for missing keys', async () => {
    const store = new MemorySecretStore()
    expect(await store.get('absent.thing')).toBe(null)
  })

  it('list returns sorted keys', async () => {
    const store = new MemorySecretStore({ b: '2', a: '1', c: '3' })
    expect(await store.list()).toEqual(['a', 'b', 'c'])
  })

  it('delete removes the key', async () => {
    const store = new MemorySecretStore({ a: '1' })
    await store.delete('a')
    expect(await store.get('a')).toBe(null)
  })

  it('delete on missing key is a no-op', async () => {
    const store = new MemorySecretStore()
    await expect(store.delete('absent.x')).resolves.toBeUndefined()
  })

  it('initial values seed the store', async () => {
    const store = new MemorySecretStore({
      'provider.hetzner.token': 'A',
      'workspace.demo.restic_password': 'B',
    })
    expect(await store.get('provider.hetzner.token')).toBe('A')
    expect(await store.get('workspace.demo.restic_password')).toBe('B')
  })

  it('initial values pass through key validation', () => {
    expect(
      () => new MemorySecretStore({ 'invalid key with spaces': 'x' }),
    ).toThrow(SecretStoreError)
  })

  it('rejects invalid key on set', async () => {
    const store = new MemorySecretStore()
    await expect(store.set('has space', 'v')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects non-string value on set', async () => {
    const store = new MemorySecretStore()
    // @ts-expect-error — runtime guard
    await expect(store.set('k', 99)).rejects.toMatchObject({ code: 'invalid' })
  })
})
