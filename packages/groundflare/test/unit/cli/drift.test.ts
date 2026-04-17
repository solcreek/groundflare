/**
 * Unit tests for drift detection collectors + renderers.
 *
 * `collectDrift` talks to a Provider + SshClient + DNS resolver; all
 * three are fakeable at the interface seam so these tests run without
 * hitting the network. Focus is on the verdict matrix (ok/warn/drift)
 * for each category, not on SSH/provider implementation details.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  collectDrift,
  hasDrift,
  renderDriftChecks,
  summarizeDrift,
  type DriftCheck,
} from '../../../src/cli/drift.js'
import type { BootstrapState } from '../../../src/bootstrap/index.js'
import type { Provider, VPS } from '../../../src/provider/index.js'
import type { RunResult, SshClient } from '../../../src/ssh/index.js'

// ─── Fixtures ───────────────────────────────────────────────────────

function baseState(
  overrides: Partial<BootstrapState> = {},
): BootstrapState {
  return {
    workspace: 'demo',
    provider: 'digitalocean',
    completedStages: [],
    startedAt: '2026-04-16T00:00:00Z',
    updatedAt: '2026-04-16T00:00:00Z',
    vps: {
      id: '12345',
      ipv4: '203.0.113.10',
      size: 's-1vcpu-1gb',
      region: 'sgp1',
      user: 'groundflare',
    },
    ...overrides,
  }
}

function liveVps(overrides: Partial<VPS> = {}): VPS {
  return {
    id: '12345',
    name: 'demo',
    status: 'running',
    publicIPv4: '203.0.113.10',
    size: 's-1vcpu-1gb',
    region: 'sgp1',
    createdAt: '2026-04-16T00:00:00Z',
    ...overrides,
  }
}

function fakeProvider(impl: Partial<Provider> = {}): Provider {
  return {
    name: 'digitalocean',
    displayName: 'DigitalOcean',
    authenticate: vi.fn(),
    listSizes: vi.fn(),
    listRegions: vi.fn(),
    uploadSSHKey: vi.fn(),
    listSSHKeys: vi.fn(),
    deleteSSHKey: vi.fn(),
    createVPS: vi.fn(),
    getVPS: vi.fn().mockResolvedValue(liveVps()),
    listVPS: vi.fn(),
    destroyVPS: vi.fn(),
    estimateMonthlyCost: vi.fn().mockReturnValue(6),
    ...impl,
  } as unknown as Provider
}

/**
 * Build a fake SshClient that dispatches run() through a lookup table
 * of command-matcher → result. Unmatched commands return exit=1 so
 * missing expectations surface loudly.
 */
function fakeSsh(
  handlers: Array<{ match: RegExp | string; result: Partial<RunResult> }>,
): SshClient {
  return {
    ping: vi.fn(),
    upload: vi.fn(),
    stream: vi.fn(),
    run: vi.fn(async (cmd: string) => {
      for (const h of handlers) {
        const matched =
          typeof h.match === 'string' ? cmd.includes(h.match) : h.match.test(cmd)
        if (matched) {
          return {
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
            ...h.result,
          }
        }
      }
      return { exitCode: 1, stdout: '', stderr: 'no match', durationMs: 1 }
    }),
  } as unknown as SshClient
}

// ─── provider category ─────────────────────────────────────────────

describe('collectDrift — provider category', () => {
  it('ok when live VPS matches recorded id + ip + size', async () => {
    const checks = await collectDrift({
      state: baseState(),
      provider: fakeProvider(),
      ssh: null,
    })
    expect(checks).toHaveLength(1)
    expect(checks[0]?.category).toBe('provider')
    expect(checks[0]?.severity).toBe('ok')
  })

  it('drift when VPS is gone (destroyed outside groundflare)', async () => {
    const checks = await collectDrift({
      state: baseState(),
      provider: fakeProvider({
        getVPS: vi.fn().mockResolvedValue(null),
      }),
      ssh: null,
    })
    expect(checks[0]?.severity).toBe('drift')
    expect(checks[0]?.detail).toMatch(/not found/)
  })

  it('drift when the public IP rotated', async () => {
    const checks = await collectDrift({
      state: baseState(),
      provider: fakeProvider({
        getVPS: vi.fn().mockResolvedValue(liveVps({ publicIPv4: '198.51.100.1' })),
      }),
      ssh: null,
    })
    expect(checks[0]?.severity).toBe('drift')
    expect(checks[0]?.id).toBe('provider.vps-ip')
  })

  it('drift when the VPS was resized externally', async () => {
    const checks = await collectDrift({
      state: baseState(),
      provider: fakeProvider({
        getVPS: vi.fn().mockResolvedValue(liveVps({ size: 's-2vcpu-4gb' })),
      }),
      ssh: null,
    })
    expect(checks[0]?.severity).toBe('drift')
    expect(checks[0]?.id).toBe('provider.vps-size')
  })

  it('warn when provider API errors out (treat as non-fatal)', async () => {
    const checks = await collectDrift({
      state: baseState(),
      provider: fakeProvider({
        getVPS: vi.fn().mockRejectedValue(new Error('503 upstream')),
      }),
      ssh: null,
    })
    expect(checks[0]?.severity).toBe('warn')
    expect(checks[0]?.detail).toMatch(/503 upstream/)
  })

  it('skips provider category when provider is null', async () => {
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh: null,
    })
    expect(checks).toEqual([])
  })
})

// ─── dns category ──────────────────────────────────────────────────

describe('collectDrift — dns category', () => {
  it('ok when domain resolves to the recorded VPS IP', async () => {
    const checks = await collectDrift({
      state: baseState(),
      domain: 'demo.example.com',
      provider: null,
      ssh: null,
      resolveDns: async () => ['203.0.113.10'],
    })
    expect(checks[0]?.category).toBe('dns')
    expect(checks[0]?.severity).toBe('ok')
  })

  it('drift when DNS resolves to a different IP', async () => {
    const checks = await collectDrift({
      state: baseState(),
      domain: 'demo.example.com',
      provider: null,
      ssh: null,
      resolveDns: async () => ['198.51.100.9'],
    })
    expect(checks[0]?.severity).toBe('drift')
    expect(checks[0]?.detail).toMatch(/198\.51\.100\.9/)
  })

  it('drift when the domain has no A records', async () => {
    const checks = await collectDrift({
      state: baseState(),
      domain: 'demo.example.com',
      provider: null,
      ssh: null,
      resolveDns: async () => [],
    })
    expect(checks[0]?.severity).toBe('drift')
    expect(checks[0]?.detail).toMatch(/no A records/)
  })

  it('warn when DNS lookup throws (network/NXDOMAIN treated as transient)', async () => {
    const checks = await collectDrift({
      state: baseState(),
      domain: 'demo.example.com',
      provider: null,
      ssh: null,
      resolveDns: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    expect(checks[0]?.severity).toBe('warn')
  })

  it('accepts URL-shaped domain values and extracts the hostname', async () => {
    const checks = await collectDrift({
      state: baseState(),
      domain: 'https://demo.example.com/',
      provider: null,
      ssh: null,
      resolveDns: async (hostname) => {
        expect(hostname).toBe('demo.example.com')
        return ['203.0.113.10']
      },
    })
    expect(checks[0]?.severity).toBe('ok')
  })

  it('skipped entirely when no domain is configured', async () => {
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh: null,
      resolveDns: async () => ['203.0.113.10'],
    })
    expect(checks.filter((c) => c.category === 'dns')).toEqual([])
  })
})

// ─── systemd category ──────────────────────────────────────────────

describe('collectDrift — systemd category', () => {
  it('ok when every required unit reports active', async () => {
    const ssh = fakeSsh([
      { match: /is-active/, result: { exitCode: 0, stdout: 'active\n' } },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const systemd = checks.filter((c) => c.category === 'systemd')
    expect(systemd).toHaveLength(3)
    expect(systemd.every((c) => c.severity === 'ok')).toBe(true)
  })

  it('drift when the worker unit is not active', async () => {
    const ssh = fakeSsh([
      {
        match: /groundflare-worker\.service/,
        result: { exitCode: 3, stdout: 'failed\n' },
      },
      { match: /is-active/, result: { exitCode: 0, stdout: 'active\n' } },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const worker = checks.find((c) => c.id === 'systemd.groundflare-worker.service')
    expect(worker?.severity).toBe('drift')
    expect(worker?.detail).toMatch(/failed/)
  })

  it('tolerates an inactive R2 sidecar (Bun-only VPSes skip it)', async () => {
    const ssh = fakeSsh([
      {
        match: /groundflare-r2\.service/,
        result: { exitCode: 3, stdout: 'inactive\n' },
      },
      { match: /is-active/, result: { exitCode: 0, stdout: 'active\n' } },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const r2 = checks.find((c) => c.id === 'systemd.groundflare-r2.service')
    expect(r2?.severity).toBe('ok')
    expect(r2?.detail).toMatch(/optional/)
  })

  it('warn when the SSH probe itself errors out', async () => {
    const ssh: SshClient = {
      ping: vi.fn(),
      upload: vi.fn(),
      stream: vi.fn(),
      run: vi.fn().mockRejectedValue(new Error('connection reset')),
    } as unknown as SshClient
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const systemd = checks.filter((c) => c.category === 'systemd')
    expect(systemd.every((c) => c.severity === 'warn')).toBe(true)
  })
})

// ─── files category ────────────────────────────────────────────────

describe('collectDrift — files category', () => {
  it('ok when every artefact stats to a non-zero size', async () => {
    const ssh = fakeSsh([
      { match: /stat -c/, result: { exitCode: 0, stdout: 'root 2048\n' } },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const files = checks.filter((c) => c.category === 'files')
    expect(files).toHaveLength(2)
    expect(files.every((c) => c.severity === 'ok')).toBe(true)
    // formatBytes should have kicked in and produced KB/MB units:
    expect(files[0]?.detail).toMatch(/2\.0 KB/)
  })

  it('drift when an artefact is missing (stat exits non-zero)', async () => {
    const ssh = fakeSsh([
      {
        match: /worker\.capnp/,
        result: { exitCode: 1, stdout: '', stderr: 'No such file' },
      },
      { match: /stat -c/, result: { exitCode: 0, stdout: 'root 2048\n' } },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const capnp = checks.find((c) => c.id.includes('worker.capnp'))
    expect(capnp?.severity).toBe('drift')
    expect(capnp?.detail).toMatch(/missing/)
  })

  it('drift when an artefact is present but empty', async () => {
    const ssh = fakeSsh([
      {
        match: /Caddyfile/,
        result: { exitCode: 0, stdout: 'caddy 0\n' },
      },
      { match: /stat -c/, result: { exitCode: 0, stdout: 'root 2048\n' } },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const caddyfile = checks.find((c) => c.id.includes('Caddyfile'))
    expect(caddyfile?.severity).toBe('drift')
    expect(caddyfile?.detail).toMatch(/empty/)
  })
})

// ─── hash category (deployed marker + capnp sha) ──────────────────

describe('collectDrift — hash category', () => {
  const knownHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00'
  const marker = JSON.stringify({
    marker: 1,
    workspace: 'demo',
    capnpSha256: knownHash,
    deployedAt: '2026-04-17T00:00:00.000Z',
  })

  it('ok when sha256sum output matches the marker', async () => {
    const ssh = fakeSsh([
      { match: /stat -c/, result: { exitCode: 0, stdout: 'root 2048\n' } },
      {
        match: /__SHA_SEP__/,
        result: {
          exitCode: 0,
          stdout: `${marker}\n__SHA_SEP__\n${knownHash}\n`,
        },
      },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const hash = checks.find((c) => c.category === 'hash')
    expect(hash?.severity).toBe('ok')
    expect(hash?.detail).toMatch(/matches marker/)
  })

  it('drift when the live sha differs from the marker', async () => {
    const wrongHash = 'ff'.repeat(32)
    const ssh = fakeSsh([
      { match: /stat -c/, result: { exitCode: 0, stdout: 'root 2048\n' } },
      {
        match: /__SHA_SEP__/,
        result: {
          exitCode: 0,
          stdout: `${marker}\n__SHA_SEP__\n${wrongHash}\n`,
        },
      },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const hash = checks.find((c) => c.category === 'hash')
    expect(hash?.severity).toBe('drift')
    expect(hash?.detail).toMatch(/mismatch/)
    expect(hash?.detail).toMatch(/edited out-of-band/)
  })

  it('warn when the marker is absent (pre-v0.5.4 deploy)', async () => {
    const ssh = fakeSsh([
      { match: /stat -c/, result: { exitCode: 0, stdout: 'root 2048\n' } },
      {
        match: /__SHA_SEP__/,
        result: { exitCode: 0, stdout: `\n__SHA_SEP__\n${knownHash}\n` },
      },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const hash = checks.find((c) => c.category === 'hash')
    expect(hash?.severity).toBe('warn')
    expect(hash?.detail).toMatch(/pre-v0\.5\.4/)
  })

  it('warn when the marker is unparseable JSON', async () => {
    const ssh = fakeSsh([
      { match: /stat -c/, result: { exitCode: 0, stdout: 'root 2048\n' } },
      {
        match: /__SHA_SEP__/,
        result: { exitCode: 0, stdout: `not-json\n__SHA_SEP__\n${knownHash}\n` },
      },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    const hash = checks.find((c) => c.category === 'hash')
    expect(hash?.severity).toBe('warn')
    expect(hash?.detail).toMatch(/not valid JSON/)
  })

  it('suppresses hash check when worker.capnp itself is missing', async () => {
    // `files` already flagged the absent capnp; no need to double-report.
    const ssh = fakeSsh([
      { match: /stat -c/, result: { exitCode: 0, stdout: 'root 2048\n' } },
      {
        match: /__SHA_SEP__/,
        result: { exitCode: 0, stdout: `${marker}\n__SHA_SEP__\n\n` },
      },
    ])
    const checks = await collectDrift({
      state: baseState(),
      provider: null,
      ssh,
    })
    expect(checks.filter((c) => c.category === 'hash')).toEqual([])
  })
})

// ─── rendering / summary helpers ───────────────────────────────────

describe('renderDriftChecks', () => {
  it('renders a placeholder when no checks ran', () => {
    expect(renderDriftChecks([])).toMatch(/no drift checks ran/)
  })

  it('prefixes each line with category + severity glyph', () => {
    const checks: DriftCheck[] = [
      { id: 'provider.x', category: 'provider', severity: 'ok', detail: 'fine' },
      { id: 'dns.x', category: 'dns', severity: 'drift', detail: 'moved' },
      { id: 'systemd.x', category: 'systemd', severity: 'warn', detail: 'flaky' },
    ]
    const out = renderDriftChecks(checks)
    expect(out).toMatch(/\[provider\]\s+✓ fine/)
    expect(out).toMatch(/\[dns\]\s+✗ moved/)
    expect(out).toMatch(/\[systemd\]\s+⚠ flaky/)
  })
})

describe('summarizeDrift', () => {
  it('reports "No drift detected." when every check is ok', () => {
    const checks: DriftCheck[] = [
      { id: 'x', category: 'provider', severity: 'ok', detail: '' },
    ]
    expect(summarizeDrift(checks)).toBe('No drift detected.')
  })

  it('counts drift + warn separately', () => {
    const checks: DriftCheck[] = [
      { id: 'a', category: 'dns', severity: 'drift', detail: '' },
      { id: 'b', category: 'dns', severity: 'drift', detail: '' },
      { id: 'c', category: 'systemd', severity: 'warn', detail: '' },
    ]
    expect(summarizeDrift(checks)).toBe('2 drift issues, 1 warning.')
  })
})

describe('hasDrift', () => {
  it('true iff any check has severity=drift', () => {
    expect(
      hasDrift([
        { id: 'a', category: 'dns', severity: 'warn', detail: '' },
        { id: 'b', category: 'dns', severity: 'drift', detail: '' },
      ]),
    ).toBe(true)
    expect(
      hasDrift([{ id: 'a', category: 'dns', severity: 'warn', detail: '' }]),
    ).toBe(false)
  })
})
