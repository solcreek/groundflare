import { describe, it, expect, vi } from 'vitest'
import {
  LinodeProvider,
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

function makeProvider(fetchImpl: typeof fetch, token = 'tok_abc'): LinodeProvider {
  return new LinodeProvider({
    token,
    baseUrl: 'https://api.test/v4',
    fetchImpl,
  })
}

// Sample OpenSSH public key used across tests. The fingerprint is
// deterministic (SHA-256 of the decoded base64 body, hex with colons).
const SAMPLE_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA0000000000000000000000000000000000000000000 user@host'

// ─── Constructor ───────────────────────────────────────────────────

describe('LinodeProvider construction', () => {
  it('rejects an empty token', () => {
    expect(() => new LinodeProvider({ token: '' })).toThrow(/token is required/)
  })

  it('exposes name and displayName', () => {
    const p = new LinodeProvider({ token: 't' })
    expect(p.name).toBe('linode')
    expect(p.displayName).toContain('Linode')
  })
})

// ─── Authenticate ──────────────────────────────────────────────────

describe('LinodeProvider.authenticate', () => {
  it('returns an account derived from /account', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: { email: 'ops@example.com', first_name: 'Ada', last_name: 'Lovelace' },
    })
    const provider = makeProvider(fetchImpl)
    const acc = await provider.authenticate('tok_abc')
    expect(calls[0]?.url).toBe('https://api.test/v4/account')
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.headers['authorization']).toBe('Bearer tok_abc')
    expect(acc.email).toBe('ops@example.com')
    expect(acc.name).toBe('Ada Lovelace')
  })

  it('translates 401 into ProviderError(unauthorized)', async () => {
    const { fetchImpl } = mockFetch({
      status: 401,
      body: { errors: [{ reason: 'Invalid Token' }] },
    })
    const provider = makeProvider(fetchImpl)
    await expect(provider.authenticate('bad')).rejects.toMatchObject({
      name: 'ProviderError',
      status: 401,
    })
  })
})

// ─── Discovery ─────────────────────────────────────────────────────

describe('LinodeProvider.listSizes', () => {
  it('maps /linode/types into Size[]', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: {
        data: [
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
        ],
        page: 1,
        pages: 1,
        results: 1,
      },
    })
    const provider = makeProvider(fetchImpl)
    const sizes = await provider.listSizes()
    expect(calls[0]?.url).toContain('/linode/types')
    expect(sizes).toHaveLength(1)
    expect(sizes[0]).toMatchObject({
      id: 'g6-standard-2',
      cpuCores: 2,
      ramGiB: 4,
      diskGiB: 80,
      priceMonthlyCents: 2400,
      egressFreeTb: 4,
    })
  })

  it('with region filter: returns [] when region lacks Linodes capability', async () => {
    const { fetchImpl } = mockFetch([
      {
        body: {
          data: [
            {
              id: 'g6-nanode-1',
              label: 'Nanode',
              vcpus: 1,
              memory: 1024,
              disk: 25600,
              transfer: 1000,
              price: { hourly: 0.0075, monthly: 5 },
            },
          ],
          page: 1,
          pages: 1,
          results: 1,
        },
      },
      {
        body: {
          data: [
            {
              id: 'us-east',
              country: 'US',
              label: 'Newark, NJ',
              capabilities: ['Object Storage'], // no "Linodes"
              status: 'ok',
            },
          ],
          page: 1,
          pages: 1,
          results: 1,
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    expect(await provider.listSizes('us-east')).toEqual([])
  })
})

describe('LinodeProvider.listRegions', () => {
  it('returns regions that are ok AND have Linodes capability', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        data: [
          {
            id: 'us-east',
            country: 'US',
            label: 'Newark, NJ',
            capabilities: ['Linodes', 'Volumes'],
            status: 'ok',
          },
          {
            id: 'obj-only',
            country: 'US',
            label: 'Object Storage',
            capabilities: ['Object Storage'],
            status: 'ok',
          },
          {
            id: 'outage',
            country: 'US',
            label: 'Broken',
            capabilities: ['Linodes'],
            status: 'outage',
          },
        ],
        page: 1,
        pages: 1,
        results: 3,
      },
    })
    const provider = makeProvider(fetchImpl)
    const regions = await provider.listRegions()
    expect(regions.map((r) => r.id)).toEqual(['us-east'])
    expect(regions[0]?.name).toBe('Newark, NJ')
    expect(regions[0]?.country).toBe('US')
  })
})

// ─── SSH keys ──────────────────────────────────────────────────────

describe('LinodeProvider SSH keys', () => {
  it('uploads an SSH key and computes a SHA-256 fingerprint client-side', async () => {
    const { fetchImpl, calls } = mockFetch({
      body: { id: 42, label: 'ops', ssh_key: SAMPLE_KEY, created: '2026-04-01T00:00:00Z' },
    })
    const provider = makeProvider(fetchImpl)
    const key = await provider.uploadSSHKey({ name: 'ops', publicKey: SAMPLE_KEY })
    expect(calls[0]?.url).toBe('https://api.test/v4/profile/sshkeys')
    expect(calls[0]?.method).toBe('POST')
    expect(JSON.parse(calls[0]!.body!)).toEqual({ label: 'ops', ssh_key: SAMPLE_KEY })
    expect(key.id).toBe('42')
    // Fingerprint format: lowercase hex with colons, 32 pairs.
    expect(key.fingerprint).toMatch(/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/)
  })

  it('returns the same fingerprint for identical keys (deterministic)', async () => {
    const { fetchImpl } = mockFetch([
      { body: { id: 1, label: 'a', ssh_key: SAMPLE_KEY, created: '2026-04-01T00:00:00Z' } },
      { body: { id: 2, label: 'b', ssh_key: SAMPLE_KEY, created: '2026-04-02T00:00:00Z' } },
    ])
    const provider = makeProvider(fetchImpl)
    const k1 = await provider.uploadSSHKey({ name: 'a', publicKey: SAMPLE_KEY })
    const k2 = await provider.uploadSSHKey({ name: 'b', publicKey: SAMPLE_KEY })
    expect(k1.fingerprint).toBe(k2.fingerprint)
  })

  it('lists SSH keys from /profile/sshkeys', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        data: [
          { id: 1, label: 'k1', ssh_key: SAMPLE_KEY, created: '2026-04-01T00:00:00Z' },
          { id: 2, label: 'k2', ssh_key: SAMPLE_KEY, created: '2026-04-02T00:00:00Z' },
        ],
        page: 1,
        pages: 1,
        results: 2,
      },
    })
    const provider = makeProvider(fetchImpl)
    const keys = await provider.listSSHKeys()
    expect(keys).toHaveLength(2)
    expect(keys[0]?.id).toBe('1')
  })

  it('deletes an SSH key via DELETE', async () => {
    const { fetchImpl, calls } = mockFetch({ status: 204 })
    const provider = makeProvider(fetchImpl)
    await provider.deleteSSHKey('42')
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.url).toBe('https://api.test/v4/profile/sshkeys/42')
  })
})

// ─── VPS lifecycle ─────────────────────────────────────────────────

describe('LinodeProvider.createVPS', () => {
  function provisionOpts(): ProvisionOptions {
    return {
      name: 'web-1',
      size: 'g6-standard-2',
      region: 'us-east',
      sshKeyIds: ['42'],
      userData: '#cloud-config\nfoo: bar\n',
      labels: { env: 'production' },
    }
  }

  it('fetches each SSH key by ID and passes content as authorized_keys', async () => {
    const { fetchImpl, calls } = mockFetch([
      // GET /profile/sshkeys/42 — fetch public key content
      { body: { id: 42, label: 'ops', ssh_key: SAMPLE_KEY, created: '2026-04-01T00:00:00Z' } },
      // POST /linode/instances — create
      {
        body: {
          id: 123,
          label: 'web-1',
          region: 'us-east',
          type: 'g6-standard-2',
          status: 'provisioning',
          created: '2026-04-16T00:00:00Z',
          ipv4: ['203.0.113.42', '192.168.1.1'],
          ipv6: '2001:db8::1/128',
          tags: ['groundflare', 'production'],
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    const vps = await provider.createVPS(provisionOpts())

    // First call: fetch the SSH key content
    expect(calls[0]?.url).toBe('https://api.test/v4/profile/sshkeys/42')
    // Second call: create
    expect(calls[1]?.method).toBe('POST')
    expect(calls[1]?.url).toBe('https://api.test/v4/linode/instances')
    const body = JSON.parse(calls[1]!.body!)
    expect(body.type).toBe('g6-standard-2')
    expect(body.region).toBe('us-east')
    expect(body.label).toBe('web-1')
    expect(body.image).toBe('linode/ubuntu24.04')
    expect(body.authorized_keys).toEqual([SAMPLE_KEY])
    // user_data is base64-encoded under metadata
    expect(body.metadata?.user_data).toBe(
      Buffer.from('#cloud-config\nfoo: bar\n', 'utf-8').toString('base64'),
    )
    // Tags include groundflare + label values
    expect(body.tags).toContain('groundflare')
    expect(body.tags).toContain('production')
    // Linode requires root_pass even with SSH keys present. We ship a
    // strong throwaway — cloud-init disables password auth server-side.
    expect(typeof body.root_pass).toBe('string')
    expect(body.root_pass.length).toBeGreaterThanOrEqual(20)

    // Result maps correctly
    expect(vps.id).toBe('123')
    expect(vps.status).toBe('initializing')
    // Public IPv4 is the non-RFC1918 one
    expect(vps.publicIPv4).toBe('203.0.113.42')
    // IPv6 CIDR suffix is stripped
    expect(vps.publicIPv6).toBe('2001:db8::1')
  })

  it('omits metadata.user_data when no userData is provided', async () => {
    const { fetchImpl, calls } = mockFetch([
      { body: { id: 42, label: 'ops', ssh_key: SAMPLE_KEY, created: '2026-04-01T00:00:00Z' } },
      {
        body: {
          id: 1,
          label: 'n',
          region: 'us-east',
          type: 'g6-nanode-1',
          status: 'provisioning',
          created: '2026-04-16T00:00:00Z',
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    const opts: ProvisionOptions = {
      name: 'n',
      size: 'g6-nanode-1',
      region: 'us-east',
      sshKeyIds: ['42'],
    }
    await provider.createVPS(opts)
    const body = JSON.parse(calls[1]!.body!)
    expect(body.metadata).toBeUndefined()
  })

  it('works with zero SSH keys (skips the fetch step)', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        body: {
          id: 1,
          label: 'n',
          region: 'us-east',
          type: 'g6-nanode-1',
          status: 'provisioning',
          created: '2026-04-16T00:00:00Z',
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    await provider.createVPS({
      name: 'n',
      size: 'g6-nanode-1',
      region: 'us-east',
      sshKeyIds: [],
    })
    // Only one call: no sshkey lookups, just the create.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.test/v4/linode/instances')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.authorized_keys).toEqual([])
  })

  it('deduplicates tags when a label value collides with the "groundflare" marker', async () => {
    // Regression: Linode strictly rejects duplicate tags with
    //   400 — Tag N (groundflare) is a duplicate tag (tag first occurs at index 0)
    // Bootstrap passes labels = { 'managed-by': 'groundflare', workspace: <name> }
    // so `Object.values` yields ['groundflare', <name>] and the naive
    // `tags: ['groundflare', ...values]` ships a duplicate.
    const { fetchImpl, calls } = mockFetch([
      {
        body: {
          id: 1,
          label: 'smoke',
          region: 'us-central',
          type: 'g6-nanode-1',
          status: 'provisioning',
          created: '2026-04-17T00:00:00Z',
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    await provider.createVPS({
      name: 'smoke',
      size: 'g6-nanode-1',
      region: 'us-central',
      sshKeyIds: [],
      labels: { 'managed-by': 'groundflare', workspace: 'smoke' },
    })
    const body = JSON.parse(calls[0]!.body!)
    // Must contain both distinct values, exactly once each.
    expect(body.tags).toContain('groundflare')
    expect(body.tags).toContain('smoke')
    expect(new Set(body.tags).size).toBe(body.tags.length)
    expect(body.tags.filter((t: string) => t === 'groundflare')).toHaveLength(
      1,
    )
  })
})

describe('LinodeProvider.getVPS', () => {
  it('returns the instance when found', async () => {
    const { fetchImpl } = mockFetch({
      body: {
        id: 7,
        label: 'web-1',
        region: 'us-east',
        type: 'g6-standard-2',
        status: 'running',
        created: '2026-04-01T00:00:00Z',
        ipv4: ['203.0.113.42'],
      },
    })
    const provider = makeProvider(fetchImpl)
    const vps = await provider.getVPS('7')
    expect(vps?.id).toBe('7')
    expect(vps?.status).toBe('running')
  })

  it('returns null on 404', async () => {
    const { fetchImpl } = mockFetch({
      status: 404,
      body: { errors: [{ reason: 'Not found' }] },
    })
    const provider = makeProvider(fetchImpl)
    expect(await provider.getVPS('nope')).toBeNull()
  })

  it('rethrows non-404 errors', async () => {
    const { fetchImpl } = mockFetch({
      status: 500,
      body: { errors: [{ reason: 'Internal error' }] },
    })
    const provider = makeProvider(fetchImpl)
    await expect(provider.getVPS('x')).rejects.toBeInstanceOf(ProviderError)
  })
})

// ─── Pricing ───────────────────────────────────────────────────────

describe('LinodeProvider.estimateMonthlyCost', () => {
  it('returns cents for a known tier', () => {
    const p = new LinodeProvider({ token: 't' })
    expect(p.estimateMonthlyCost({ size: 'g6-standard-2', region: 'us-east' })).toBe(
      2400,
    )
  })

  it('returns 0 for an unknown tier', () => {
    const p = new LinodeProvider({ token: 't' })
    expect(p.estimateMonthlyCost({ size: 'g6-future-99', region: 'x' })).toBe(0)
  })
})

// ─── Error translation ────────────────────────────────────────────

describe('LinodeProvider error translation', () => {
  it('surfaces field + reason from { errors: [{ field, reason }] }', async () => {
    const { fetchImpl } = mockFetch({
      status: 400,
      body: {
        errors: [
          { field: 'label', reason: 'Label is required' },
          { field: 'region', reason: 'Not a valid region' },
        ],
      },
    })
    const provider = makeProvider(fetchImpl)
    try {
      await provider.createVPS({
        name: '',
        size: 'g6-nanode-1',
        region: 'mars',
        sshKeyIds: [],
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      const pe = err as ProviderError
      expect(pe.status).toBe(400)
      expect(pe.code).toBe('label') // first error's field becomes the code
      expect(pe.message).toContain('Label is required')
      expect(pe.message).toContain('Not a valid region')
    }
  })

  it('falls back to code=error when field is missing', async () => {
    const { fetchImpl } = mockFetch({
      status: 401,
      body: { errors: [{ reason: 'Invalid Token' }] },
    })
    const provider = makeProvider(fetchImpl)
    try {
      await provider.authenticate('bad')
      throw new Error('should have thrown')
    } catch (err) {
      const pe = err as ProviderError
      expect(pe.code).toBe('error')
      expect(pe.message).toContain('Invalid Token')
    }
  })
})
