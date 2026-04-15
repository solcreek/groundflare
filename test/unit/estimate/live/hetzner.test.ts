import { describe, expect, it, vi } from 'vitest'

import {
  fetchHetznerPricing,
  HetznerPricingError,
} from '../../../../src/estimate/index.js'

/** Minimal response shaped like Hetzner's actual /v1/pricing payload. */
function mockPricingBody() {
  return {
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
              price_hourly: { net: '0.0050', gross: '0.00595' },
              price_monthly: { net: '4.51', gross: '5.367' },
              included_traffic: 21_990_232_555_520, // 20 TB
              price_per_tb_traffic: { net: '1.00', gross: '1.19' },
            },
          ],
        },
        {
          id: 32,
          name: 'cx32',
          prices: [
            {
              location: 'fsn1',
              price_hourly: { net: '0.0082', gross: '0.00976' },
              price_monthly: { net: '6.90', gross: '8.211' },
              included_traffic: 21_990_232_555_520,
              price_per_tb_traffic: { net: '1.00', gross: '1.19' },
            },
          ],
        },
        // Tier not in our KNOWN_TIERS — should be ignored.
        {
          id: 999,
          name: 'ccx33',
          prices: [
            {
              location: 'fsn1',
              price_hourly: { net: '1.0', gross: '1.19' },
              price_monthly: { net: '99.99', gross: '118.99' },
              included_traffic: 21_990_232_555_520,
              price_per_tb_traffic: { net: '2.00', gross: '2.38' },
            },
          ],
        },
      ],
    },
  }
}

function fakeFetch(
  body: unknown,
  init: { status?: number } = {},
): typeof fetch {
  return vi.fn(async () => {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('fetchHetznerPricing', () => {
  it('maps cx22 + cx32 with EUR→USD conversion and included traffic', async () => {
    const res = await fetchHetznerPricing({
      token: 'fake',
      fetchImpl: fakeFetch(mockPricingBody()),
      eurToUsd: 1.1, // use a round rate so we can assert exact values
    })

    // Net EUR 4.51 × 1.1 = 4.961 → round to 4.96
    expect(res.tiers.cx22?.price).toBeCloseTo(4.96, 2)
    expect(res.tiers.cx32?.price).toBeCloseTo(7.59, 2)

    // 20 TB included
    expect(res.tiers.cx22?.traffic_tb).toBe(20)

    // Egress overage: max of per-tier overages, EUR 1.00 × 1.1 = 1.10
    expect(res.egressOverageUsdPerTb).toBeCloseTo(1.1, 2)
    expect(res.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('skips unknown tiers (no ccx33 in output)', async () => {
    const res = await fetchHetznerPricing({
      token: 'fake',
      fetchImpl: fakeFetch(mockPricingBody()),
    })
    expect(Object.keys(res.tiers).sort()).toEqual(['cx22', 'cx32'])
  })

  it('throws auth error on HTTP 401', async () => {
    await expect(
      fetchHetznerPricing({
        token: 'bad',
        fetchImpl: fakeFetch({ error: 'unauthorized' }, { status: 401 }),
      }),
    ).rejects.toBeInstanceOf(HetznerPricingError)
  })

  it('throws shape error when response schema mismatches', async () => {
    await expect(
      fetchHetznerPricing({
        token: 'fake',
        fetchImpl: fakeFetch({ not_pricing: true }),
      }),
    ).rejects.toMatchObject({ code: 'shape' })
  })

  it('throws parse error on invalid JSON', async () => {
    await expect(
      fetchHetznerPricing({
        token: 'fake',
        fetchImpl: fakeFetch('<!DOCTYPE html>not json'),
      }),
    ).rejects.toMatchObject({ code: 'parse' })
  })

  it('throws network error when fetch itself throws', async () => {
    const failFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(
      fetchHetznerPricing({ token: 'fake', fetchImpl: failFetch }),
    ).rejects.toMatchObject({ code: 'network' })
  })
})
