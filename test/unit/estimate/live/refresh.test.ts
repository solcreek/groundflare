import { describe, expect, it, vi } from 'vitest'

import { MemorySecretStore } from '../../../../src/secret/index.js'
import {
  BAKED_PRICES,
  refreshPrices,
} from '../../../../src/estimate/index.js'

const MOCK_OK_BODY = {
  pricing: {
    currency: 'EUR',
    vat_rate: '19.00',
    server_types: [
      {
        id: 22,
        name: 'cx22',
        prices: [
          {
            location: 'fsn1',
            price_hourly: { net: '0.005', gross: '0.006' },
            price_monthly: { net: '4.51', gross: '5.37' },
            included_traffic: 21_990_232_555_520,
            price_per_tb_traffic: { net: '1.00', gross: '1.19' },
          },
        ],
      },
    ],
  },
}

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
      }),
  ) as unknown as typeof fetch
}

describe('refreshPrices', () => {
  it('falls back to baked with reason when no token is configured', async () => {
    const { prices, sources } = await refreshPrices({
      baked: BAKED_PRICES,
      secrets: new MemorySecretStore(),
    })
    expect(prices).toBe(BAKED_PRICES)
    expect(sources[0]).toEqual({
      provider: 'hetzner',
      kind: 'baked',
      reason: 'no token configured',
    })
  })

  it('falls back to baked with "live disabled" when disableLive', async () => {
    const { prices, sources } = await refreshPrices({
      baked: BAKED_PRICES,
      secrets: new MemorySecretStore({ 'provider.hetzner.token': 'x' }),
      disableLive: true,
    })
    expect(prices).toBe(BAKED_PRICES)
    expect(sources[0]?.reason).toBe('live disabled')
  })

  it('merges live hetzner prices over baked, preserving vcpu/ram/disk', async () => {
    const secrets = new MemorySecretStore({ 'provider.hetzner.token': 'abc' })
    const { prices, sources } = await refreshPrices({
      baked: BAKED_PRICES,
      secrets,
      fetchImpl: fakeFetch(MOCK_OK_BODY),
    })
    // Live price was merged (not equal to the baked 4.80).
    expect(prices.hetzner.cx22.price).not.toBe(BAKED_PRICES.hetzner.cx22.price)
    // vcpu/ram/disk preserved from baked (not in /v1/pricing).
    expect(prices.hetzner.cx22.vcpu).toBe(BAKED_PRICES.hetzner.cx22.vcpu)
    expect(prices.hetzner.cx22.ram_gb).toBe(BAKED_PRICES.hetzner.cx22.ram_gb)
    expect(prices.hetzner.cx22.disk_gb).toBe(BAKED_PRICES.hetzner.cx22.disk_gb)
    // Tiers not in the live response (cx32/42/52) are left at baked values.
    expect(prices.hetzner.cx32).toEqual(BAKED_PRICES.hetzner.cx32)
    expect(sources[0]?.kind).toBe('live')
    expect(sources[0]?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('falls back to baked + carries the error reason on fetch failure', async () => {
    const secrets = new MemorySecretStore({ 'provider.hetzner.token': 'bad' })
    const { prices, sources } = await refreshPrices({
      baked: BAKED_PRICES,
      secrets,
      fetchImpl: fakeFetch({ error: 'unauthorized' }, 401),
    })
    expect(prices).toBe(BAKED_PRICES)
    expect(sources[0]?.kind).toBe('baked')
    expect(sources[0]?.reason).toMatch(/auth/)
  })
})
