import { describe, expect, it, vi } from 'vitest'

import {
  BAKED_PRICES,
  MemorySecretReader,
  refreshPrices,
} from '../../../src/index.js'

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
      secrets: new MemorySecretReader(),
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
      secrets: new MemorySecretReader({ 'provider.hetzner.token': 'x' }),
      disableLive: true,
    })
    expect(prices).toBe(BAKED_PRICES)
    expect(sources[0]?.reason).toBe('live disabled')
  })

  it('merges live hetzner prices over baked, preserving vcpu/ram/disk', async () => {
    const secrets = new MemorySecretReader({ 'provider.hetzner.token': 'abc' })
    const { prices, sources } = await refreshPrices({
      baked: BAKED_PRICES,
      secrets,
      fetchImpl: fakeFetch(MOCK_OK_BODY),
    })
    // Live price was merged (not equal to the baked 4.80).
    expect(prices.hetzner.cx22!.price).not.toBe(BAKED_PRICES.hetzner.cx22!.price)
    // vcpu/ram/disk preserved from baked (not in /v1/pricing).
    expect(prices.hetzner.cx22!.vcpu).toBe(BAKED_PRICES.hetzner.cx22!.vcpu)
    expect(prices.hetzner.cx22!.ram_gb).toBe(BAKED_PRICES.hetzner.cx22!.ram_gb)
    expect(prices.hetzner.cx22!.disk_gb).toBe(BAKED_PRICES.hetzner.cx22!.disk_gb)
    // Tiers not in the live response (cx32/42/52) are left at baked values.
    expect(prices.hetzner.cx32).toEqual(BAKED_PRICES.hetzner.cx32)
    expect(sources[0]?.kind).toBe('live')
    expect(sources[0]?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('falls back to baked + carries the error reason on fetch failure', async () => {
    const secrets = new MemorySecretReader({ 'provider.hetzner.token': 'bad' })
    const { prices, sources } = await refreshPrices({
      baked: BAKED_PRICES,
      secrets,
      fetchImpl: fakeFetch({ error: 'unauthorized' }, 401),
    })
    expect(prices).toBe(BAKED_PRICES)
    expect(sources[0]?.kind).toBe('baked')
    expect(sources[0]?.reason).toMatch(/auth/)
  })

  it('records a linode source entry and attempts live fetch when the token is set', async () => {
    // Shared fetch mock: all three providers hit this. Linode expects
    // `{data:[...]}`; DO and Hetzner will shape-reject, which is fine —
    // we only assert on the Linode entry here.
    const linodeBody = {
      data: [
        {
          id: 'g6-standard-2',
          label: 'Linode 4GB',
          vcpus: 2,
          memory: 4096,
          disk: 81920,
          transfer: 4000,
          price: { hourly: 0.036, monthly: 22 }, // deliberately different from baked 24
          class: 'standard',
        },
      ],
      page: 1,
      pages: 1,
      results: 1,
    }
    const secrets = new MemorySecretReader({ 'provider.linode.token': 'abc' })
    const { prices, sources } = await refreshPrices({
      baked: BAKED_PRICES,
      secrets,
      fetchImpl: fakeFetch(linodeBody),
    })
    // Live price was merged for g6-standard-2.
    expect(prices.linode['g6-standard-2']?.price).toBe(22)
    // Baked price for an un-refreshed tier is preserved.
    expect(prices.linode['g6-nanode-1']).toEqual(BAKED_PRICES.linode['g6-nanode-1'])
    const linodeSource = sources.find((s) => s.provider === 'linode')
    expect(linodeSource?.kind).toBe('live')
    expect(linodeSource?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('records linode as baked with "no token" when LINODE_TOKEN is unset', async () => {
    const { sources } = await refreshPrices({
      baked: BAKED_PRICES,
      secrets: new MemorySecretReader(),
    })
    const linodeSource = sources.find((s) => s.provider === 'linode')
    expect(linodeSource?.kind).toBe('baked')
    expect(linodeSource?.reason).toBe('no token configured')
  })
})
