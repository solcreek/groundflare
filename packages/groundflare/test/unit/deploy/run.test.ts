/**
 * runDeploy tests with esbuild + a mocked SshClient. Covers the full
 * command sequence the CLI will trigger and surfaces the expected
 * DeployError codes for each failure mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runDeploy, DeployError } from '../../../src/deploy/index.js'
import type { BootstrapState } from '../../../src/bootstrap/index.js'
import type { RunOptions, RunResult, SshClient } from '../../../src/ssh/index.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gf-rundeploy-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

interface MockSshOptions {
  runs?: readonly Partial<RunResult>[]
  uploadShouldThrow?: Error
}

interface MockSshSetup {
  client: SshClient
  runCalls: Array<{ command: string; opts?: RunOptions }>
  uploads: Array<{ local: string; remote: string }>
}

function mockSsh(opts: MockSshOptions = {}): MockSshSetup {
  const queue = [...(opts.runs ?? [])]
  const runCalls: MockSshSetup['runCalls'] = []
  const uploads: MockSshSetup['uploads'] = []
  const client: SshClient = {
    ping: vi.fn(async () => {}),
    run: vi.fn(async (command: string, runOpts?: RunOptions) => {
      runCalls.push({ command, opts: runOpts })
      const next = queue.shift() ?? {}
      return {
        exitCode: next.exitCode ?? 0,
        stdout: next.stdout ?? '',
        stderr: next.stderr ?? '',
        durationMs: next.durationMs ?? 1,
      }
    }),
    stream: vi.fn(),
    upload: vi.fn(async (local: string, remote: string) => {
      uploads.push({ local, remote })
      if (opts.uploadShouldThrow) throw opts.uploadShouldThrow
    }),
    download: vi.fn(),
  }
  return { client, runCalls, uploads }
}

async function scaffoldWorker(
  wranglerBody: string,
  indexBody = `export default { async fetch() { return new Response('ok') } }`,
): Promise<void> {
  await writeFile(join(tmp, 'wrangler.toml'), wranglerBody, 'utf-8')
  await mkdir(join(tmp, 'src'), { recursive: true })
  await writeFile(join(tmp, 'src/index.ts'), indexBody, 'utf-8')
}

function baseState(): BootstrapState {
  return {
    workspace: 'demo',
    provider: 'hetzner',
    completedStages: [],
    startedAt: '2026-04-14T00:00:00Z',
    updatedAt: '2026-04-14T00:00:00Z',
    sshKey: {
      providerId: 'sshk-1',
      fingerprint: 'f',
      localPath: '/keys/id',
      localPublicPath: '/keys/id.pub',
    },
    vps: {
      id: 'vps-1',
      ipv4: '203.0.113.10',
      size: 'cx22',
      region: 'hel1',
      user: 'groundflare',
    },
  }
}

describe('runDeploy', () => {
  it('throws config_missing when no wrangler file is present', async () => {
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'config_missing' })
  })

  it('throws config_missing when wrangler has no main', async () => {
    await scaffoldWorker(`name = "api"\n`)
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'config_missing' })
  })

  it('throws not_bootstrapped when state has no VPS', async () => {
    await scaffoldWorker(
      `name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2026-04-01"\n`,
    )
    const state = baseState()
    delete (state as unknown as { vps?: unknown }).vps
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: state,
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'not_bootstrapped' })
  })

  it('dryRun bundles + renders without any SSH calls', async () => {
    await scaffoldWorker(
      [
        `name = "api"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[groundflare]`,
        `domain = "api.example.com"`,
      ].join('\n'),
    )
    const { client, runCalls, uploads } = mockSsh()
    const result = await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      dryRun: true,
      log: () => {},
    })
    expect(result.dryRun).toBe(true)
    expect(result.tenants).toHaveLength(1)
    expect(result.tenants[0]?.name).toBe('api')
    expect(result.tenants[0]?.domain).toBe('api.example.com')
    expect(result.tenants[0]?.bundleBytes).toBeGreaterThan(0)
    expect(result.capnpBytes).toBeGreaterThan(0)
    expect(result.caddyfileBytes).toBeGreaterThan(0)
    expect(runCalls).toHaveLength(0)
    expect(uploads).toHaveLength(0)
  })

  it('full deploy uploads bundle + capnp + Caddyfile and restarts services', async () => {
    await scaffoldWorker(
      [
        `name = "api"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[groundflare]`,
        `domain = "api.example.com"`,
      ].join('\n'),
    )
    // Run-call sequence in order:
    //   1. ensureRemoteDir for the worker's code dir → mkdir+chown
    //   2. install bundle
    //   3. install capnp
    //   4. install Caddyfile (root)
    //   5. systemctl daemon-reload + restart workerd + reload caddy
    //   6. curl health probe (200)
    const { client, runCalls, uploads } = mockSsh({
      runs: [
        { exitCode: 0 }, // ensureRemoteDir
        { exitCode: 0 }, // install bundle
        { exitCode: 0 }, // install capnp
        { exitCode: 0 }, // install Caddyfile
        { exitCode: 0 }, // systemctl restart
        { exitCode: 0, stdout: '200' }, // health probe
      ],
    })
    const result = await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      log: () => {},
    })
    expect(result.dryRun).toBe(false)
    expect(result.healthCheck?.status).toBe(200)
    // Three uploads: bundle, capnp, Caddyfile
    expect(uploads).toHaveLength(3)
    // ensure-dir + 3 installs + systemctl + health = 6 run calls
    expect(runCalls).toHaveLength(6)
    expect(runCalls[4]?.command).toContain('systemctl restart groundflare-worker.service')
    expect(runCalls[4]?.command).toContain('systemctl reload caddy.service')
    expect(runCalls[5]?.command).toContain('curl -o /dev/null')
    expect(runCalls[5]?.command).toContain('Host: api.example.com')
  })

  it('propagates upload_failed when sudo install fails', async () => {
    await scaffoldWorker(
      `name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2026-04-01"\n`,
    )
    const { client } = mockSsh({
      runs: [
        { exitCode: 0 }, // ensureRemoteDir
        { exitCode: 1, stderr: 'permission denied' }, // install bundle fails
      ],
    })
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        ssh: client,
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'upload_failed' })
  })

  it('propagates restart_failed when systemctl exits non-zero', async () => {
    await scaffoldWorker(
      `name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2026-04-01"\n`,
    )
    const { client } = mockSsh({
      runs: [
        { exitCode: 0 }, // ensureRemoteDir
        { exitCode: 0 }, // install bundle
        { exitCode: 0 }, // install capnp
        { exitCode: 0 }, // install Caddyfile
        { exitCode: 1, stderr: 'Job failed.' },
      ],
    })
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        ssh: client,
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'restart_failed' })
  })

  it('propagates health_failed when probe returns 500', async () => {
    await scaffoldWorker(
      `name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2026-04-01"\n`,
    )
    const { client } = mockSsh({
      runs: [
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0, stdout: '503' },
      ],
    })
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        ssh: client,
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'health_failed' })
  })

  it('propagates health_failed on curl non-zero exit (transport failure)', async () => {
    await scaffoldWorker(
      `name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2026-04-01"\n`,
    )
    const { client } = mockSsh({
      runs: [
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 7, stderr: 'connection refused' },
      ],
    })
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        ssh: client,
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'health_failed' })
  })

  it('throws DeployError (not a different error type) for bundle failures', async () => {
    await writeFile(
      join(tmp, 'wrangler.toml'),
      `name = "api"\nmain = "src/index.ts"\n`,
      'utf-8',
    )
    await mkdir(join(tmp, 'src'), { recursive: true })
    // Syntactically broken TypeScript
    await writeFile(join(tmp, 'src/index.ts'), 'const x = {{{', 'utf-8')
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(DeployError)
  })
})

function okRuns(n: number): Partial<RunResult>[] {
  const out: Partial<RunResult>[] = []
  for (let i = 0; i < n; i++) out.push({ exitCode: 0 })
  return out
}

describe('runDeploy — Bun track', () => {
  function bunWrangler(): string {
    return [
      `name = "api"`,
      `main = "src/index.ts"`,
      `compatibility_date = "2026-04-01"`,
      ``,
      `[groundflare]`,
      `domain = "api.example.com"`,
      `runtime = "bun"`,
      ``,
      `[[kv_namespaces]]`,
      `binding = "CACHE"`,
      `id = "abc"`,
    ].join('\n')
  }

  it('dry-run reports runtime=bun and bunArtifactBytes>0', async () => {
    await scaffoldWorker(bunWrangler())
    const { client, runCalls, uploads } = mockSsh()
    const result = await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      dryRun: true,
      log: () => {},
    })
    expect(result.runtime).toBe('bun')
    expect(result.bunArtifactBytes).toBeGreaterThan(0)
    expect(result.capnpBytes).toBe(0)
    expect(runCalls).toHaveLength(0)
    expect(uploads).toHaveLength(0)
  })

  it('uploads server.ts + adapters + user bundle + systemd unit + Caddyfile', async () => {
    await scaffoldWorker(bunWrangler())
    // Expected run-call sequence:
    //   1. ensureRemoteDir (deployRoot)
    //   2. ensureRemoteDir (kv)
    //   3. ensureRemoteDir (adapters)
    //   4. install server.ts
    //   5-8. install 4 adapter sources (kv, d1, r2, sigv4)
    //   9. install user.js
    //   10. install systemd unit (as root)
    //   11. install Caddyfile (as root)
    //   12. systemctl restart
    //   13. curl health probe
    const { client, runCalls, uploads } = mockSsh({
      runs: okRuns(12).concat([{ exitCode: 0, stdout: '200' }]),
    })
    const result = await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      log: () => {},
    })
    expect(result.runtime).toBe('bun')
    expect(result.healthCheck?.status).toBe(200)
    expect(result.bunArtifactBytes).toBeGreaterThan(0)
    // 1 user bundle + 1 server.ts + 4 adapter sources + 1 unit + 1 Caddyfile = 8
    expect(uploads).toHaveLength(8)
    const restartCall = runCalls.find((c) =>
      c.command.includes('systemctl restart groundflare-worker.service'),
    )
    expect(restartCall).toBeDefined()
    expect(restartCall?.command).toContain('systemctl reload caddy.service')
  })

  it('installs the Bun systemd unit at /etc/systemd/system/groundflare-worker.service', async () => {
    await scaffoldWorker(bunWrangler())
    const { client, runCalls } = mockSsh({
      runs: okRuns(12).concat([{ exitCode: 0, stdout: '200' }]),
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      log: () => {},
    })
    const unitInstall = runCalls.find(
      (c) =>
        c.command.includes('install') &&
        c.command.includes('/etc/systemd/system/groundflare-worker.service'),
    )
    expect(unitInstall).toBeDefined()
    // Unit must be installed as root (sudo install -o root -g root).
    expect(unitInstall?.command).toContain('-o root -g root')
  })

  it('creates kv/d1/r2 state dirs when bindings demand them', async () => {
    await scaffoldWorker(
      [
        `name = "api"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[groundflare]`,
        `runtime = "bun"`,
        ``,
        `[[kv_namespaces]]`,
        `binding = "CACHE"`,
        `id = "1"`,
        ``,
        `[[d1_databases]]`,
        `binding = "DB"`,
        `database_name = "app"`,
        ``,
        `[[r2_buckets]]`,
        `binding = "ASSETS"`,
        `bucket_name = "a"`,
      ].join('\n'),
    )
    // 1 deployRoot + 3 state dirs + 1 adapters dir = 5 mkdir calls
    // + 1 server.ts + 4 adapters + 1 user.js + 1 unit + 1 caddyfile = 8 installs
    // + 1 restart + 1 health = 15 run calls total
    const { client, runCalls } = mockSsh({
      runs: okRuns(14).concat([{ exitCode: 0, stdout: '200' }]),
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      log: () => {},
    })
    const mkdirs = runCalls
      .filter((c) => c.command.startsWith('sudo mkdir -p'))
      .map((c) => c.command)
    expect(mkdirs.some((m) => m.includes('/var/lib/groundflare/kv'))).toBe(true)
    expect(mkdirs.some((m) => m.includes('/var/lib/groundflare/d1'))).toBe(true)
    expect(mkdirs.some((m) => m.includes('/var/lib/groundflare/r2'))).toBe(true)
    expect(mkdirs.some((m) => m.includes('/var/lib/groundflare/adapters'))).toBe(
      true,
    )
  })

  it('propagates upload_failed when an adapter install fails', async () => {
    await scaffoldWorker(bunWrangler())
    const { client } = mockSsh({
      runs: [
        { exitCode: 0 }, // mkdir deployRoot
        { exitCode: 0 }, // mkdir kv state dir
        { exitCode: 0 }, // mkdir adapters
        { exitCode: 0 }, // install server.ts
        { exitCode: 1, stderr: 'disk full' }, // install first adapter fails
      ],
    })
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        ssh: client,
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'upload_failed' })
  })
})
