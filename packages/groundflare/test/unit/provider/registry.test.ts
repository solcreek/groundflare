import { describe, it, expect } from 'vitest'

import {
  DigitalOceanProvider,
  HetznerProvider,
  PROVIDER_REGISTRY,
  UnknownProviderError,
  createProvider,
  listImplementedProviders,
} from '../../../src/provider/index.js'

describe('createProvider', () => {
  it('returns a HetznerProvider for name="hetzner"', () => {
    const p = createProvider('hetzner', { token: 't' })
    expect(p).toBeInstanceOf(HetznerProvider)
    expect(p.name).toBe('hetzner')
  })

  it('returns a DigitalOceanProvider for name="digitalocean"', () => {
    const p = createProvider('digitalocean', { token: 't' })
    expect(p).toBeInstanceOf(DigitalOceanProvider)
    expect(p.name).toBe('digitalocean')
  })

  it('throws UnknownProviderError for a name that has no implementation yet', () => {
    expect(() => createProvider('linode', { token: 't' })).toThrow(
      UnknownProviderError,
    )
    try {
      createProvider('linode', { token: 't' })
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownProviderError)
      expect((err as UnknownProviderError).providerName).toBe('linode')
      expect((err as Error).message).toContain('linode')
      // Error lists what IS supported, not what isn't.
      expect((err as Error).message).toMatch(/hetzner|digitalocean/)
    }
  })

  it('rejects an empty token before dispatching to a factory', () => {
    expect(() => createProvider('hetzner', { token: '' })).toThrow(
      /token is required/,
    )
  })
})

describe('listImplementedProviders', () => {
  it('returns only names that have a factory in the registry', () => {
    const names = listImplementedProviders()
    expect(names).toContain('hetzner')
    expect(names).toContain('digitalocean')
    // Planned-but-unimplemented providers are absent.
    expect(names).not.toContain('linode')
    expect(names).not.toContain('vultr')
    expect(names).not.toContain('contabo')
  })

  it('stays in sync with PROVIDER_REGISTRY', () => {
    expect(new Set(listImplementedProviders())).toEqual(
      new Set(Object.keys(PROVIDER_REGISTRY)),
    )
  })
})
