import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  HetznerProvider,
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
    // Cast — vitest's Headers types are slightly wider than what we accept.
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
    // 204/205/304 are "null body" statuses per the fetch spec — Response()
    // throws if you give them any body, even an empty string.
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

function makeProvider(fetchImpl: typeof fetch, token = 'tok_abc'): HetznerProvider {
  return new HetznerProvider({
    token,
    baseUrl: 'https://api.test/v1',
    fetchImpl,
  })
}

// ─── Constructor ───────────────────────────────────────────────────

describe('HetznerProvider construction', () => {
  it('rejects an empty token', () => {
    expect(() => new HetznerProvider({ token: '' })).toThrow(/token is required/)
  })

  it('exposes name and displayName', () => {
    const p = new HetznerProvider({ token: 't' })
    expect(p.name).toBe('hetzner')
    expect(p.displayName).toBe('Hetzner Cloud')
  })
})

// ─── Authenticate ──────────────────────────────────────────────────

describe('authenticate', () => {
  it('returns an account on a successful probe', async () => {
    const { fetchImpl, calls } = mockFetch({
      status: 200,
      body: { locations: [] },
    })
    const provider = makeProvider(fetchImpl)
    const account = await provider.authenticate('tok_xyz')
    expect(account.name).toBe('Hetzner Cloud project')
    expect(account.id).toMatch(/^hetzner-/)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url).toBe('https://api.test/v1/locations')
    expect(calls[0]?.headers.authorization).toBe('Bearer tok_xyz')
  })

  it('throws ProviderError(unauthorized) on 401', async () => {
    const { fetchImpl } = mockFetch({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'invalid token' } },
    })
    const provider = makeProvider(fetchImpl)
    await expect(provider.authenticate('bad')).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'unauthorized',
      status: 401,
      retryable: false,
    })
  })

  it('marks 5xx errors as retryable', async () => {
    const { fetchImpl } = mockFetch({
      status: 503,
      body: { error: { code: 'service_unavailable', message: 'try later' } },
    })
    const provider = makeProvider(fetchImpl)
    await expect(provider.authenticate('tok')).rejects.toMatchObject({
      retryable: true,
      status: 503,
    })
  })

  it('marks 429 as retryable', async () => {
    const { fetchImpl } = mockFetch({
      status: 429,
      body: { error: { code: 'rate_limit_exceeded', message: 'slow down' } },
    })
    const provider = makeProvider(fetchImpl)
    await expect(provider.authenticate('tok')).rejects.toMatchObject({
      retryable: true,
      status: 429,
    })
  })

  it('produces stable account IDs for the same token', async () => {
    const { fetchImpl } = mockFetch([
      { status: 200, body: { locations: [] } },
      { status: 200, body: { locations: [] } },
    ])
    const provider = makeProvider(fetchImpl)
    const a = await provider.authenticate('same-token')
    const b = await provider.authenticate('same-token')
    expect(a.id).toBe(b.id)
  })
})

// ─── Sizes ─────────────────────────────────────────────────────────

describe('listSizes', () => {
  const sample = {
    server_types: [
      {
        id: 22,
        name: 'cx22',
        description: 'CX22',
        cores: 2,
        memory: 4,
        disk: 40,
        included_traffic: 20000,
        prices: [
          { location: 'hel1', price_monthly: { gross: '5.99', net: '4.99' } },
          { location: 'fsn1', price_monthly: { gross: '5.99', net: '4.99' } },
        ],
      },
      {
        id: 32,
        name: 'cx32',
        description: 'CX32',
        cores: 4,
        memory: 8,
        disk: 80,
        prices: [
          { location: 'hel1', price_monthly: { gross: '10.59', net: '8.99' } },
        ],
      },
    ],
  }

  it('translates server_types into Size objects', async () => {
    const { fetchImpl } = mockFetch({ body: sample })
    const provider = makeProvider(fetchImpl)
    const sizes = await provider.listSizes()
    expect(sizes).toHaveLength(2)
    expect(sizes[0]).toEqual({
      id: 'cx22',
      name: 'CX22',
      cpuCores: 2,
      ramGiB: 4,
      diskGiB: 40,
      priceMonthlyCents: 599,
      egressFreeTb: 20,
      availableInRegions: ['hel1', 'fsn1'],
    })
  })

  it('filters by region when provided', async () => {
    const { fetchImpl } = mockFetch({ body: sample })
    const provider = makeProvider(fetchImpl)
    const sizes = await provider.listSizes('fsn1')
    expect(sizes.map((s) => s.id)).toEqual(['cx22'])
  })
})

// ─── Regions ───────────────────────────────────────────────────────

describe('listRegions', () => {
  it('translates locations into Region objects', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        locations: [
          {
            id: 1,
            name: 'hel1',
            description: 'Helsinki DC Park 1',
            country: 'FI',
            city: 'Helsinki',
          },
        ],
      },
    })
    const provider = makeProvider(fetchImpl)
    const regions = await provider.listRegions()
    expect(regions).toEqual([
      {
        id: 'hel1',
        name: 'Helsinki DC Park 1',
        country: 'FI',
        city: 'Helsinki',
      },
    ])
  })
})

// ─── SSH keys ──────────────────────────────────────────────────────

describe('SSH keys', () => {
  it('uploadSSHKey POSTs the right body and parses the result', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: {
        ssh_key: {
          id: 42,
          name: 'laptop',
          fingerprint: 'aa:bb:cc',
          public_key: 'ssh-ed25519 AAAA',
        },
      },
    })
    const provider = makeProvider(fetchImpl)
    const key = await provider.uploadSSHKey({
      name: 'laptop',
      publicKey: 'ssh-ed25519 AAAA',
    })
    expect(key).toEqual({ id: '42', name: 'laptop', fingerprint: 'aa:bb:cc' })

    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('https://api.test/v1/ssh_keys')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      name: 'laptop',
      public_key: 'ssh-ed25519 AAAA',
    })
    expect(calls[0]?.headers['content-type']).toBe('application/json')
  })

  it('listSSHKeys returns normalized keys', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        ssh_keys: [
          { id: 1, name: 'a', fingerprint: 'fa', public_key: 'k1' },
          { id: 2, name: 'b', fingerprint: 'fb', public_key: 'k2' },
        ],
      },
    })
    const provider = makeProvider(fetchImpl)
    const keys = await provider.listSSHKeys()
    expect(keys).toEqual([
      { id: '1', name: 'a', fingerprint: 'fa' },
      { id: '2', name: 'b', fingerprint: 'fb' },
    ])
  })

  it('deleteSSHKey URL-encodes the id', async () => {
    const { fetchImpl, calls } = mockFetch({ status: 204 })
    const provider = makeProvider(fetchImpl)
    await provider.deleteSSHKey('weird/id')
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.url).toBe('https://api.test/v1/ssh_keys/weird%2Fid')
  })
})

// ─── VPS lifecycle ─────────────────────────────────────────────────

describe('VPS lifecycle', () => {
  const baseProvision: ProvisionOptions = {
    name: 'gf-test',
    size: 'cx22',
    region: 'hel1',
    sshKeyIds: ['42', '99'],
  }

  it('createVPS posts the right payload and applies defaults', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: {
        server: makeFakeServer({ id: 1001 }),
      },
    })
    const provider = makeProvider(fetchImpl)
    const vps = await provider.createVPS(baseProvision)
    expect(vps.id).toBe('1001')
    expect(vps.size).toBe('cx22')
    expect(vps.region).toBe('hel1')
    expect(vps.publicIPv4).toBe('1.2.3.4')

    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('https://api.test/v1/servers')
    const body = JSON.parse(calls[0]?.body ?? '{}')
    expect(body).toEqual({
      name: 'gf-test',
      server_type: 'cx22',
      location: 'hel1',
      image: 'ubuntu-24.04',
      ssh_keys: ['42', '99'],
      start_after_create: true,
    })
  })

  it('createVPS includes user_data and labels when provided', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: { server: makeFakeServer({ id: 1 }) },
    })
    const provider = makeProvider(fetchImpl)
    await provider.createVPS({
      ...baseProvision,
      userData: '#cloud-config\nrun: echo hi',
      labels: { workspace: 'demo' },
    })
    const body = JSON.parse(calls[0]?.body ?? '{}')
    expect(body.user_data).toBe('#cloud-config\nrun: echo hi')
    expect(body.labels).toEqual({ workspace: 'demo' })
  })

  it('getVPS returns null on 404 (rather than throwing)', async () => {
    const { fetchImpl } = mockFetch({
      status: 404,
      body: { error: { code: 'not_found', message: 'no such server' } },
    })
    const provider = makeProvider(fetchImpl)
    const result = await provider.getVPS('does-not-exist')
    expect(result).toBe(null)
  })

  it('getVPS still throws on non-404 errors', async () => {
    const { fetchImpl } = mockFetch({
      status: 500,
      body: { error: { code: 'internal', message: 'oops' } },
    })
    const provider = makeProvider(fetchImpl)
    await expect(provider.getVPS('1')).rejects.toBeInstanceOf(ProviderError)
  })

  it('listVPS translates each server', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        servers: [makeFakeServer({ id: 1, name: 'a' }), makeFakeServer({ id: 2, name: 'b' })],
      },
    })
    const provider = makeProvider(fetchImpl)
    const list = await provider.listVPS()
    expect(list.map((v) => v.name)).toEqual(['a', 'b'])
  })

  it('destroyVPS sends DELETE and tolerates 204', async () => {
    const { fetchImpl, calls } = mockFetch({ status: 204 })
    const provider = makeProvider(fetchImpl)
    await provider.destroyVPS('1001')
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.url).toBe('https://api.test/v1/servers/1001')
  })

  it.each([
    ['initializing', 'initializing'],
    ['starting', 'initializing'],
    ['running', 'running'],
    ['stopping', 'stopped'],
    ['off', 'stopped'],
    ['deleting', 'deleting'],
    ['migrating', 'unknown'],
  ])('maps Hetzner status %s -> %s', async (raw, expected) => {
    const { fetchImpl } = mockFetch({
      body: { server: makeFakeServer({ id: 1, status: raw }) },
    })
    const provider = makeProvider(fetchImpl)
    const vps = await provider.getVPS('1')
    expect(vps?.status).toBe(expected)
  })

  it('omits IPv4/IPv6 when the server response lacks them', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        server: {
          id: 1,
          name: 'no-ips',
          status: 'initializing',
          public_net: {},
          server_type: { name: 'cx22' },
          datacenter: { location: { name: 'hel1' } },
          created: '2026-04-14T00:00:00Z',
        },
      },
    })
    const provider = makeProvider(fetchImpl)
    const vps = await provider.getVPS('1')
    expect(vps?.publicIPv4).toBeUndefined()
    expect(vps?.publicIPv6).toBeUndefined()
  })
})

// ─── Pricing ───────────────────────────────────────────────────────

describe('estimateMonthlyCost', () => {
  it('returns the static price for known sizes', () => {
    const provider = new HetznerProvider({ token: 't' })
    expect(provider.estimateMonthlyCost({ size: 'cx23', region: 'hel1' })).toBe(499)
    expect(provider.estimateMonthlyCost({ size: 'cax11', region: 'fsn1' })).toBe(549)
  })

  it('returns 0 for unknown sizes (caller treats as no quote)', () => {
    const provider = new HetznerProvider({ token: 't' })
    expect(provider.estimateMonthlyCost({ size: 'gx9999', region: 'hel1' })).toBe(0)
  })
})

// ─── Transport edge cases ──────────────────────────────────────────

describe('transport', () => {
  it('translates network errors into ProviderError(network)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const provider = makeProvider(fetchImpl)
    await expect(provider.listSizes()).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'network',
      retryable: true,
      status: undefined,
    })
  })

  it('translates AbortError (timeout) into ProviderError(timeout)', async () => {
    // Simulate a fetch that respects the AbortSignal but never resolves.
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }) as unknown as typeof fetch

    const provider = new HetznerProvider({
      token: 't',
      baseUrl: 'https://api.test/v1',
      fetchImpl,
      timeoutMs: 50,
    })
    await expect(provider.listSizes()).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    })
  })

  it('translates malformed JSON responses into ProviderError(bad_response)', async () => {
    const { fetchImpl } = mockFetch({ status: 200, text: 'not really json {{{' })
    const provider = makeProvider(fetchImpl)
    await expect(provider.listSizes()).rejects.toMatchObject({
      code: 'bad_response',
      status: 200,
      retryable: false,
    })
  })

  it('treats 204 No Content as a successful empty result', async () => {
    const { fetchImpl } = mockFetch({ status: 204 })
    const provider = makeProvider(fetchImpl)
    // deleteSSHKey expects 204 — should not throw or return anything.
    await expect(provider.deleteSSHKey('1')).resolves.toBeUndefined()
  })
})

// ─── Test fixtures ─────────────────────────────────────────────────

function makeFakeServer(
  overrides: Partial<{
    id: number
    name: string
    status: string
  }> = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? 'fake',
    status: overrides.status ?? 'initializing',
    public_net: {
      ipv4: { ip: '1.2.3.4' },
      ipv6: { ip: '2001:db8::1' },
    },
    server_type: { name: 'cx22' },
    datacenter: { location: { name: 'hel1' } },
    created: '2026-04-14T00:00:00Z',
    labels: { managed_by: 'groundflare' },
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})
