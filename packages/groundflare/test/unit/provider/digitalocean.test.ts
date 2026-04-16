import { describe, expect, it, vi } from 'vitest'

import {
  DigitalOceanProvider,
  ProviderError,
} from '../../../src/provider/index.js'

// ─── Mock fetch helpers ────────────────────────────────────────

function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => {
    return new Response(
      status === 204 ? null : JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

function mockFetchMulti(responses: Array<{ body: unknown; status?: number }>): typeof fetch {
  const queue = [...responses]
  return vi.fn(async () => {
    const next = queue.shift() ?? { body: {}, status: 200 }
    return new Response(
      next.status === 204 ? null : JSON.stringify(next.body),
      { status: next.status ?? 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

function provider(fetchImpl: typeof fetch): DigitalOceanProvider {
  return new DigitalOceanProvider({ token: 'test-token', fetchImpl })
}

// ─── Tests ─────────────────────────────────────────────────────

describe('DigitalOceanProvider — authenticate', () => {
  it('returns account info from /v2/account', async () => {
    const p = provider(
      mockFetch({
        account: {
          uuid: 'abc-123',
          email: 'user@example.com',
          name: 'Test User',
          status: 'active',
          droplet_limit: 25,
        },
      }),
    )
    const acct = await p.authenticate('ignored')
    expect(acct.id).toBe('abc-123')
    expect(acct.name).toBe('Test User')
    expect(acct.email).toBe('user@example.com')
  })
})

describe('DigitalOceanProvider — listSizes', () => {
  it('maps slug/vcpus/memory/disk/transfer/price to Size', async () => {
    const p = provider(
      mockFetch({
        sizes: [
          {
            slug: 's-1vcpu-1gb',
            memory: 1024,
            vcpus: 1,
            disk: 25,
            transfer: 1.0,
            price_monthly: 6,
            price_hourly: 0.00893,
            regions: ['nyc1', 'sfo3'],
            available: true,
            description: 'Basic',
          },
          {
            slug: 'old-tier',
            memory: 512,
            vcpus: 1,
            disk: 10,
            transfer: 0.5,
            price_monthly: 4,
            price_hourly: 0.006,
            regions: ['nyc1'],
            available: false,
            description: 'Legacy',
          },
        ],
      }),
    )
    const sizes = await p.listSizes()
    expect(sizes).toHaveLength(1) // unavailable filtered out
    expect(sizes[0]!.id).toBe('s-1vcpu-1gb')
    expect(sizes[0]!.cpuCores).toBe(1)
    expect(sizes[0]!.ramGiB).toBe(1)
    expect(sizes[0]!.diskGiB).toBe(25)
    expect(sizes[0]!.priceMonthlyCents).toBe(600)
    expect(sizes[0]!.egressFreeTb).toBe(1.0)
    expect(sizes[0]!.availableInRegions).toEqual(['nyc1', 'sfo3'])
  })

  it('filters by region when provided', async () => {
    const p = provider(
      mockFetch({
        sizes: [
          {
            slug: 'a',
            memory: 1024,
            vcpus: 1,
            disk: 25,
            transfer: 1,
            price_monthly: 6,
            price_hourly: 0.009,
            regions: ['nyc1'],
            available: true,
            description: 'A',
          },
          {
            slug: 'b',
            memory: 2048,
            vcpus: 2,
            disk: 50,
            transfer: 2,
            price_monthly: 12,
            price_hourly: 0.018,
            regions: ['sfo3'],
            available: true,
            description: 'B',
          },
        ],
      }),
    )
    const sizes = await p.listSizes('nyc1')
    expect(sizes).toHaveLength(1)
    expect(sizes[0]!.id).toBe('a')
  })
})

describe('DigitalOceanProvider — listRegions', () => {
  it('maps slug/name and filters to available', async () => {
    const p = provider(
      mockFetch({
        regions: [
          { slug: 'nyc1', name: 'New York 1', available: true, sizes: [], features: [] },
          { slug: 'ams1', name: 'Amsterdam 1', available: false, sizes: [], features: [] },
        ],
      }),
    )
    const regions = await p.listRegions()
    expect(regions).toHaveLength(1)
    expect(regions[0]).toEqual({ id: 'nyc1', name: 'New York 1' })
  })
})

describe('DigitalOceanProvider — SSH keys', () => {
  it('uploads a key and returns the provider-assigned ID', async () => {
    const p = provider(
      mockFetch({
        ssh_key: {
          id: 12345,
          name: 'gf-test',
          fingerprint: 'ab:cd:ef',
          public_key: 'ssh-ed25519 AAAA...',
        },
      }),
    )
    const key = await p.uploadSSHKey({
      name: 'gf-test',
      publicKey: 'ssh-ed25519 AAAA...',
    })
    expect(key.id).toBe('12345')
    expect(key.fingerprint).toBe('ab:cd:ef')
  })

  it('deleteSSHKey succeeds on 204', async () => {
    const p = provider(mockFetch({}, 204))
    await expect(p.deleteSSHKey('12345')).resolves.toBeUndefined()
  })
})

describe('DigitalOceanProvider — VPS lifecycle', () => {
  it('createVPS maps networks.v4 to publicIPv4', async () => {
    const p = provider(
      mockFetch({
        droplet: {
          id: 99,
          name: 'gf-demo',
          status: 'active',
          networks: {
            v4: [
              { ip_address: '10.0.0.1', type: 'private' },
              { ip_address: '203.0.113.5', type: 'public' },
            ],
          },
          size: { slug: 's-1vcpu-1gb' },
          region: { slug: 'nyc1', name: 'New York 1' },
          created_at: '2026-04-15T00:00:00Z',
          tags: ['groundflare'],
        },
      }),
    )
    const vps = await p.createVPS({
      name: 'gf-demo',
      size: 's-1vcpu-1gb',
      region: 'nyc1',
      sshKeyIds: ['12345'],
    })
    expect(vps.id).toBe('99')
    expect(vps.publicIPv4).toBe('203.0.113.5')
    expect(vps.status).toBe('running')
    expect(vps.size).toBe('s-1vcpu-1gb')
    expect(vps.region).toBe('nyc1')
  })

  it('getVPS returns null on 404', async () => {
    const p = provider(
      mockFetch({ id: 'not_found', message: 'not found' }, 404),
    )
    expect(await p.getVPS('999')).toBeNull()
  })

  it('destroyVPS succeeds on 204', async () => {
    const p = provider(mockFetch({}, 204))
    await expect(p.destroyVPS('99')).resolves.toBeUndefined()
  })

  it('maps status "new" to initializing', async () => {
    const p = provider(
      mockFetch({
        droplet: {
          id: 1,
          name: 'x',
          status: 'new',
          size: { slug: 'x' },
          region: { slug: 'x' },
          created_at: '2026-01-01T00:00:00Z',
        },
      }),
    )
    const vps = await p.getVPS('1')
    expect(vps?.status).toBe('initializing')
  })
})

describe('DigitalOceanProvider — error handling', () => {
  it('throws unauthorized on 401', async () => {
    const p = provider(
      mockFetch({ id: 'unauthorized', message: 'bad token' }, 401),
    )
    await expect(p.authenticate('x')).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
      retryable: false,
    })
  })

  it('throws retryable on 429', async () => {
    const p = provider(
      mockFetch({ id: 'too_many_requests', message: 'rate limited' }, 429),
    )
    await expect(p.listRegions()).rejects.toMatchObject({
      retryable: true,
      status: 429,
    })
  })

  it('throws retryable on 500', async () => {
    const p = provider(
      mockFetch({ id: 'server_error', message: 'internal' }, 500),
    )
    await expect(p.listRegions()).rejects.toMatchObject({
      retryable: true,
    })
  })

  it('throws network error when fetch throws', async () => {
    const fail = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const p = provider(fail)
    await expect(p.listRegions()).rejects.toBeInstanceOf(ProviderError)
  })

  it('constructor rejects empty token', () => {
    expect(
      () => new DigitalOceanProvider({ token: '' }),
    ).toThrow('token is required')
  })
})

describe('DigitalOceanProvider — estimateMonthlyCost', () => {
  it('returns baked price for known size', () => {
    const p = new DigitalOceanProvider({ token: 'x' })
    expect(p.estimateMonthlyCost({ size: 's-1vcpu-1gb', region: 'nyc1' })).toBe(600)
  })

  it('returns 0 for unknown size', () => {
    const p = new DigitalOceanProvider({ token: 'x' })
    expect(p.estimateMonthlyCost({ size: 'z-999', region: 'nyc1' })).toBe(0)
  })
})
