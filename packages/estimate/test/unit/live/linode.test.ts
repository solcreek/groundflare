import { describe, expect, it, vi } from 'vitest'

import {
  fetchLinodePricing,
  LinodePricingError,
} from '../../../src/index.js'

/** Shaped like Linode's real /v4/linode/types response. */
function mockTypesBody() {
  return {
    data: [
      {
        id: 'g6-nanode-1',
        label: 'Nanode 1GB',
        vcpus: 1,
        memory: 1024,
        disk: 25600,
        transfer: 1000,
        price: { hourly: 0.0075, monthly: 5 },
        class: 'nanode',
      },
      {
        id: 'g6-standard-2',
        label: 'Linode 4GB',
        vcpus: 2,
        memory: 4096,
        disk: 81920,
        transfer: 4000,
        price: { hourly: 0.036, monthly: 24 },
        class: 'standard',
      },
      // Tier not in KNOWN_TYPES — should be ignored.
      {
        id: 'g1-gpu-rtx6000-1',
        label: 'Dedicated GPU 32GB',
        vcpus: 8,
        memory: 32768,
        disk: 655360,
        transfer: 16000,
        price: { hourly: 1.5, monthly: 1000 },
        class: 'gpu',
      },
    ],
    page: 1,
    pages: 1,
    results: 3,
  }
}

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

describe('fetchLinodePricing', () => {
  it('maps known tiers into VPSTierSpec shape with GB conversions', async () => {
    const res = await fetchLinodePricing({
      token: 'fake',
      fetchImpl: fakeFetch(mockTypesBody()),
    })
    expect(res.tiers['g6-nanode-1']).toEqual({
      price: 5,
      vcpu: 1,
      ram_gb: 1,
      disk_gb: 25,
      traffic_tb: 1,
    })
    expect(res.tiers['g6-standard-2']).toEqual({
      price: 24,
      vcpu: 2,
      ram_gb: 4,
      disk_gb: 80,
      traffic_tb: 4,
    })
    // GPU tier filtered out.
    expect(res.tiers['g1-gpu-rtx6000-1']).toBeUndefined()
    expect(res.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('sends a Bearer token and hits /v4/linode/types', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = typeof input === 'string' ? input : input.toString()
      const h = new Headers(init?.headers)
      seenAuth = h.get('authorization') ?? ''
      return new Response(JSON.stringify(mockTypesBody()), { status: 200 })
    }) as unknown as typeof fetch
    await fetchLinodePricing({ token: 'abc', fetchImpl: spy })
    expect(seenUrl).toContain('/v4/linode/types')
    expect(seenAuth).toBe('Bearer abc')
  })

  it('throws LinodePricingError(auth) on 401', async () => {
    await expect(
      fetchLinodePricing({
        token: 'bad',
        fetchImpl: fakeFetch({ errors: [{ reason: 'Invalid Token' }] }, 401),
      }),
    ).rejects.toMatchObject({
      name: 'LinodePricingError',
      code: 'auth',
    })
  })

  it('throws LinodePricingError(network) on 5xx', async () => {
    await expect(
      fetchLinodePricing({ token: 'x', fetchImpl: fakeFetch({}, 503) }),
    ).rejects.toMatchObject({
      code: 'network',
    })
  })

  it('throws LinodePricingError(shape) on malformed body', async () => {
    await expect(
      fetchLinodePricing({
        token: 'x',
        fetchImpl: fakeFetch({ not: 'what we expected' }),
      }),
    ).rejects.toMatchObject({
      code: 'shape',
    })
  })

  it('propagates network errors from fetch itself', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    try {
      await fetchLinodePricing({ token: 'x', fetchImpl: failingFetch })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LinodePricingError)
      expect((err as LinodePricingError).code).toBe('network')
      expect((err as Error).message).toContain('ECONNREFUSED')
    }
  })
})
