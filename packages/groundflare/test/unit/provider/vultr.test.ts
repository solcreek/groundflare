import { describe, it, expect, vi } from 'vitest'
import {
  VultrProvider,
  ProviderError,
  type ProvisionOptions,
} from '../../../src/provider/index.js'

// ─── HTTP mock helpers ─────────────────────────────────────────────

interface MockedResponse {
  status?: number
  body?: unknown
  text?: string
}

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

function mockFetch(
  responses: ReadonlyArray<MockedResponse> | MockedResponse,
): {
  fetchImpl: typeof fetch
  calls: RecordedRequest[]
} {
  const queue = Array.isArray(responses) ? [...responses] : [responses]
  const calls: RecordedRequest[] = []

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers = normaliseHeaders(
      init?.headers as Headers | Record<string, string> | string[][] | undefined,
    )
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const next = queue.shift() ?? { status: 200, body: {} }
    const status = next.status ?? 200
    const text =
      next.text !== undefined
        ? next.text
        : next.body !== undefined
          ? JSON.stringify(next.body)
          : ''
    const nullBody = status === 204 || status === 205 || status === 304
    return new Response(nullBody ? null : text, { status })
  }) as unknown as typeof fetch

  return { fetchImpl, calls }
}

function normaliseHeaders(
  h?: Headers | Record<string, string> | string[][],
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  if (h instanceof Headers) {
    for (const [k, v] of h.entries()) out[k.toLowerCase()] = v
    return out
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k!.toLowerCase()] = v!
    return out
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v)
  return out
}

function makeProvider(fetchImpl: typeof fetch, token = 'tok_abc'): VultrProvider {
  return new VultrProvider({
    token,
    baseUrl: 'https://api.test/v2',
    fetchImpl,
  })
}

const SAMPLE_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA0000000000000000000000000000000000000000000 user@host'

// ─── Constructor ───────────────────────────────────────────────────

describe('VultrProvider construction', () => {
  it('rejects an empty token', () => {
    expect(() => new VultrProvider({ token: '' })).toThrow(/token is required/)
  })

  it('exposes name and displayName', () => {
    const p = new VultrProvider({ token: 't' })
    expect(p.name).toBe('vultr')
    expect(p.displayName).toBe('Vultr')
  })
})

// ─── Authenticate ──────────────────────────────────────────────────

describe('VultrProvider.authenticate', () => {
  it('returns an account derived from /account', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: { account: { email: 'ops@example.com', name: 'Ops Team' } },
    })
    const provider = makeProvider(fetchImpl)
    const acc = await provider.authenticate('tok_abc')
    expect(calls[0]?.url).toBe('https://api.test/v2/account')
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.headers['authorization']).toBe('Bearer tok_abc')
    expect(acc.email).toBe('ops@example.com')
    expect(acc.name).toBe('Ops Team')
  })

  it('translates 401 into ProviderError', async () => {
    const { fetchImpl } = mockFetch({
      status: 401,
      body: { error: 'Unauthorized IP address: 1.2.3.4' },
    })
    const provider = makeProvider(fetchImpl)
    try {
      await provider.authenticate('bad')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      const pe = err as ProviderError
      expect(pe.status).toBe(401)
      expect(pe.message).toContain('Unauthorized IP address')
    }
  })
})

// ─── Discovery ─────────────────────────────────────────────────────

describe('VultrProvider.listSizes', () => {
  it('maps /plans into Size[]', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: {
        plans: [
          {
            id: 'vc2-2c-4gb',
            vcpu_count: 2,
            ram: 4096,
            disk: 80,
            bandwidth: 3000,
            monthly_cost: 24,
            type: 'vc2',
            locations: ['atl', 'ewr', 'sea'],
          },
        ],
      },
    })
    const provider = makeProvider(fetchImpl)
    const sizes = await provider.listSizes()
    expect(calls[0]?.url).toContain('/plans')
    expect(sizes).toHaveLength(1)
    expect(sizes[0]).toMatchObject({
      id: 'vc2-2c-4gb',
      cpuCores: 2,
      ramGiB: 4,
      diskGiB: 80,
      priceMonthlyCents: 2400,
      egressFreeTb: 3,
      availableInRegions: ['atl', 'ewr', 'sea'],
    })
  })

  it('with region filter: drops plans not available in that region', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        plans: [
          {
            id: 'vc2-1c-1gb',
            vcpu_count: 1,
            ram: 1024,
            disk: 25,
            bandwidth: 1000,
            monthly_cost: 6,
            type: 'vc2',
            locations: ['atl'],
          },
          {
            id: 'vc2-2c-4gb',
            vcpu_count: 2,
            ram: 4096,
            disk: 80,
            bandwidth: 3000,
            monthly_cost: 24,
            type: 'vc2',
            locations: ['ewr', 'sea'],
          },
        ],
      },
    })
    const provider = makeProvider(fetchImpl)
    const sizes = await provider.listSizes('atl')
    expect(sizes.map((s) => s.id)).toEqual(['vc2-1c-1gb'])
  })
})

describe('VultrProvider.listRegions', () => {
  it('maps /regions into Region[]', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        regions: [
          {
            id: 'dfw',
            city: 'Dallas',
            country: 'US',
            continent: 'North America',
            options: ['ddos_protection', 'block_storage_high_perf'],
          },
          {
            id: 'fra',
            city: 'Frankfurt',
            country: 'DE',
            continent: 'Europe',
            options: [],
          },
        ],
      },
    })
    const provider = makeProvider(fetchImpl)
    const regions = await provider.listRegions()
    expect(regions.map((r) => r.id)).toEqual(['dfw', 'fra'])
    expect(regions[0]?.city).toBe('Dallas')
    expect(regions[0]?.country).toBe('US')
  })
})

// ─── SSH keys ──────────────────────────────────────────────────────

describe('VultrProvider SSH keys', () => {
  it('uploads an SSH key via POST /ssh-keys and computes a fingerprint client-side', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: {
        ssh_key: {
          id: 'ssh-uuid-1',
          name: 'ops',
          ssh_key: SAMPLE_KEY,
          date_created: '2026-04-01T00:00:00Z',
        },
      },
    })
    const provider = makeProvider(fetchImpl)
    const key = await provider.uploadSSHKey({ name: 'ops', publicKey: SAMPLE_KEY })
    expect(calls[0]?.url).toBe('https://api.test/v2/ssh-keys')
    expect(calls[0]?.method).toBe('POST')
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      name: 'ops',
      ssh_key: SAMPLE_KEY,
    })
    expect(key.id).toBe('ssh-uuid-1')
    expect(key.fingerprint).toMatch(/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/)
  })

  it('fingerprint is deterministic across uploads of the same key', async () => {
    const { fetchImpl } = mockFetch([
      { body: { ssh_key: { id: 'a', name: 'a', ssh_key: SAMPLE_KEY, date_created: '2026-04-01T00:00:00Z' } } },
      { body: { ssh_key: { id: 'b', name: 'b', ssh_key: SAMPLE_KEY, date_created: '2026-04-02T00:00:00Z' } } },
    ])
    const provider = makeProvider(fetchImpl)
    const k1 = await provider.uploadSSHKey({ name: 'a', publicKey: SAMPLE_KEY })
    const k2 = await provider.uploadSSHKey({ name: 'b', publicKey: SAMPLE_KEY })
    expect(k1.fingerprint).toBe(k2.fingerprint)
  })

  it('deletes an SSH key via DELETE', async () => {
    const { fetchImpl, calls } = mockFetch({ status: 204 })
    const provider = makeProvider(fetchImpl)
    await provider.deleteSSHKey('ssh-uuid-42')
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.url).toBe('https://api.test/v2/ssh-keys/ssh-uuid-42')
  })
})

// ─── VPS lifecycle ─────────────────────────────────────────────────

describe('VultrProvider.createVPS', () => {
  function provisionOpts(): ProvisionOptions {
    return {
      name: 'web-1',
      size: 'vc2-2c-4gb',
      region: 'dfw',
      sshKeyIds: ['ssh-uuid-1'],
      userData: '#cloud-config\nfoo: bar\n',
      labels: { 'managed-by': 'groundflare', workspace: 'smoke' },
    }
  }

  it('sends a well-formed body and returns a normalized VPS', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: {
        instance: {
          id: 'vps-uuid-1',
          main_ip: '192.0.2.10',
          v6_main_ip: '2001:db8::1',
          status: 'pending',
          plan: 'vc2-2c-4gb',
          region: 'dfw',
          date_created: '2026-04-17T00:00:00Z',
          label: 'web-1',
          tags: ['groundflare', 'smoke'],
        },
      },
    })
    const provider = makeProvider(fetchImpl)
    const vps = await provider.createVPS(provisionOpts())

    expect(calls[0]?.url).toBe('https://api.test/v2/instances')
    expect(calls[0]?.method).toBe('POST')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.region).toBe('dfw')
    expect(body.plan).toBe('vc2-2c-4gb')
    expect(body.label).toBe('web-1')
    expect(body.os_id).toBe(2284) // Ubuntu 24.04 LTS default
    expect(body.sshkey_id).toEqual(['ssh-uuid-1'])
    // user_data base64-encoded at top level (not wrapped in metadata.*)
    expect(body.user_data).toBe(
      Buffer.from('#cloud-config\nfoo: bar\n', 'utf-8').toString('base64'),
    )
    expect(body.metadata).toBeUndefined()

    expect(vps.id).toBe('vps-uuid-1')
    expect(vps.status).toBe('initializing')
    expect(vps.publicIPv4).toBe('192.0.2.10')
    expect(vps.publicIPv6).toBe('2001:db8::1')
  })

  it('dedupes tags — label value collision with "groundflare" marker', async () => {
    // Regression: same trap as Linode 910bf74. Labels include
    // `managed-by: groundflare`, Object.values yields
    // ['groundflare', 'smoke']; naive prepend produces a dup.
    const { fetchImpl, calls } = mockFetch({
      body: {
        instance: {
          id: 'vps-1',
          main_ip: '0.0.0.0',
          status: 'pending',
          plan: 'vc2-1c-1gb',
          region: 'dfw',
          date_created: '2026-04-17T00:00:00Z',
        },
      },
    })
    const provider = makeProvider(fetchImpl)
    await provider.createVPS(provisionOpts())
    const body = JSON.parse(calls[0]!.body!)
    expect(body.tags).toContain('groundflare')
    expect(body.tags).toContain('smoke')
    expect(new Set(body.tags).size).toBe(body.tags.length)
    expect(body.tags.filter((t: string) => t === 'groundflare')).toHaveLength(
      1,
    )
  })

  it('strips "0.0.0.0" sentinel for main_ip (instance not yet booted)', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        instance: {
          id: 'vps-1',
          main_ip: '0.0.0.0',
          status: 'pending',
          plan: 'vc2-1c-1gb',
          region: 'dfw',
          date_created: '2026-04-17T00:00:00Z',
        },
      },
    })
    const provider = makeProvider(fetchImpl)
    const vps = await provider.createVPS(provisionOpts())
    expect(vps.publicIPv4).toBeUndefined()
  })

  it('opts.image numeric string overrides the default os_id', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: {
        instance: {
          id: 'vps-1',
          status: 'pending',
          plan: 'vc2-1c-1gb',
          region: 'dfw',
          date_created: '2026-04-17T00:00:00Z',
        },
      },
    })
    const provider = makeProvider(fetchImpl)
    await provider.createVPS({
      ...provisionOpts(),
      image: '1743', // Ubuntu 22.04 LTS
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.os_id).toBe(1743)
  })

  it('opts.image non-numeric string (cross-provider shape) falls back to default os_id', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: {
        instance: {
          id: 'vps-1',
          status: 'pending',
          plan: 'vc2-1c-1gb',
          region: 'dfw',
          date_created: '2026-04-17T00:00:00Z',
        },
      },
    })
    const provider = makeProvider(fetchImpl)
    await provider.createVPS({
      ...provisionOpts(),
      image: 'ubuntu-24.04', // Hetzner-shaped slug — meaningless to Vultr
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.os_id).toBe(2284) // default
  })
})

describe('VultrProvider.getVPS', () => {
  it('returns the instance when found', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        instance: {
          id: 'vps-7',
          main_ip: '192.0.2.7',
          status: 'active',
          power_status: 'running',
          plan: 'vc2-2c-4gb',
          region: 'dfw',
          date_created: '2026-04-17T00:00:00Z',
        },
      },
    })
    const provider = makeProvider(fetchImpl)
    const vps = await provider.getVPS('vps-7')
    expect(vps?.id).toBe('vps-7')
    expect(vps?.status).toBe('running')
  })

  it('returns null on 404', async () => {
    const { fetchImpl } = mockFetch({
      status: 404,
      body: { error: 'Subscription not found' },
    })
    const provider = makeProvider(fetchImpl)
    expect(await provider.getVPS('nope')).toBeNull()
  })

  it('rethrows non-404 errors', async () => {
    const { fetchImpl } = mockFetch({
      status: 500,
      body: { error: 'Internal error' },
    })
    const provider = makeProvider(fetchImpl)
    await expect(provider.getVPS('x')).rejects.toBeInstanceOf(ProviderError)
  })
})

// ─── Status mapping ────────────────────────────────────────────────

describe('VultrProvider status mapping', () => {
  async function mkInstance(
    status: string,
    powerStatus?: string,
  ): Promise<ReturnType<VultrProvider['getVPS']>> {
    const { fetchImpl } = mockFetch({
      body: {
        instance: {
          id: 'x',
          main_ip: '0.0.0.0',
          status,
          ...(powerStatus !== undefined ? { power_status: powerStatus } : {}),
          plan: 'vc2-1c-1gb',
          region: 'dfw',
          date_created: '2026-04-17T00:00:00Z',
        },
      },
    })
    const provider = makeProvider(fetchImpl)
    return provider.getVPS('x')
  }

  it('pending → initializing regardless of power_status', async () => {
    expect((await mkInstance('pending'))?.status).toBe('initializing')
    expect((await mkInstance('pending', 'running'))?.status).toBe('initializing')
  })

  it('active + running → running', async () => {
    expect((await mkInstance('active', 'running'))?.status).toBe('running')
  })

  it('active + stopped → stopped', async () => {
    expect((await mkInstance('active', 'stopped'))?.status).toBe('stopped')
  })

  it('active without power_status → initializing (still booting)', async () => {
    expect((await mkInstance('active'))?.status).toBe('initializing')
  })

  it('suspended / closed → unknown', async () => {
    expect((await mkInstance('suspended'))?.status).toBe('unknown')
    expect((await mkInstance('closed'))?.status).toBe('unknown')
  })
})

// ─── Pricing ───────────────────────────────────────────────────────

describe('VultrProvider.estimateMonthlyCost', () => {
  it('returns cents for a known tier', () => {
    const p = new VultrProvider({ token: 't' })
    expect(p.estimateMonthlyCost({ size: 'vc2-2c-4gb', region: 'dfw' })).toBe(
      2400,
    )
  })

  it('returns 0 for an unknown tier', () => {
    const p = new VultrProvider({ token: 't' })
    expect(p.estimateMonthlyCost({ size: 'vc2-future-99', region: 'x' })).toBe(
      0,
    )
  })
})

// ─── Error translation ────────────────────────────────────────────

describe('VultrProvider error translation', () => {
  it('surfaces the "error" string as the message', async () => {
    const { fetchImpl } = mockFetch({
      status: 400,
      body: { error: 'Unauthorized IP address: 1.2.3.4' },
    })
    const provider = makeProvider(fetchImpl)
    try {
      await provider.authenticate('tok')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      const pe = err as ProviderError
      expect(pe.status).toBe(400)
      expect(pe.code).toBe('error')
      expect(pe.message).toContain('Unauthorized IP address')
    }
  })

  it('handles the `{"error": "...", "status": N}` shape gracefully', async () => {
    const { fetchImpl } = mockFetch({
      status: 401,
      body: { error: 'Invalid API key', status: 401 },
    })
    const provider = makeProvider(fetchImpl)
    try {
      await provider.authenticate('tok')
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as ProviderError).message).toContain('Invalid API key')
    }
  })
})
