import { describe, it, expect } from 'vitest'

import {
  DigitalOceanProvider,
  HetznerProvider,
  LinodeProvider,
  PROVIDER_REGISTRY,
  UnknownProviderError,
  VultrProvider,
  createProvider,
  listImplementedProviders,
  type ProviderName,
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

  it('returns a LinodeProvider for name="linode"', () => {
    const p = createProvider('linode', { token: 't' })
    expect(p).toBeInstanceOf(LinodeProvider)
    expect(p.name).toBe('linode')
  })

  it('returns a VultrProvider for name="vultr"', () => {
    const p = createProvider('vultr', { token: 't' })
    expect(p).toBeInstanceOf(VultrProvider)
    expect(p.name).toBe('vultr')
  })

  it('throws UnknownProviderError for a name outside the supported set', () => {
    // Every ProviderName in the union is now implemented — reach
    // outside it to exercise the UnknownProviderError path.
    const bogus = 'aws' as ProviderName
    expect(() => createProvider(bogus, { token: 't' })).toThrow(
      UnknownProviderError,
    )
    try {
      createProvider(bogus, { token: 't' })
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownProviderError)
      expect((err as UnknownProviderError).providerName).toBe('aws')
      expect((err as Error).message).toContain('aws')
      // Error lists what IS supported, not what isn't.
      expect((err as Error).message).toMatch(
        /hetzner|digitalocean|linode|vultr/,
      )
    }
  })

  it('rejects an empty token before dispatching to a factory', () => {
    expect(() => createProvider('hetzner', { token: '' })).toThrow(
      /token is required/,
    )
  })
})

describe('listImplementedProviders', () => {
  it('returns every name in the registry', () => {
    const names = listImplementedProviders()
    expect(names).toContain('hetzner')
    expect(names).toContain('digitalocean')
    expect(names).toContain('linode')
    expect(names).toContain('vultr')
  })

  it('stays in sync with PROVIDER_REGISTRY', () => {
    expect(new Set(listImplementedProviders())).toEqual(
      new Set(Object.keys(PROVIDER_REGISTRY)),
    )
  })
})
