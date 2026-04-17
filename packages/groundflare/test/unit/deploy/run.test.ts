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
  uploads: Array<{ local: string; remote: string; content?: string }>
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
      // Read the file content before atomicInstall's post-script rm can
      // delete it — tests that assert on capnp content need a snapshot.
      let content: string | undefined
      try {
        const fs = await import('node:fs/promises')
        content = await fs.readFile(local, 'utf-8')
      } catch {
        // Not all uploads are text files (assets can be dirs); ignore.
      }
      const entry: { local: string; remote: string; content?: string } = {
        local,
        remote,
      }
      if (content !== undefined) entry.content = content
      uploads.push(entry)
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
    //   1. atomic install script (mkdir+chown + install bundle+capnp+caddyfile + rm)
    //   2. systemctl daemon-reload + restart workerd + reload caddy
    //   3. curl health probe (200)
    const { client, runCalls, uploads } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
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
    // Three scp uploads: bundle, capnp, Caddyfile — all staged under /tmp.
    expect(uploads).toHaveLength(3)
    for (const u of uploads) expect(u.remote).toMatch(/^\/tmp\/gf-stage-/)
    // atomic install + systemctl + health = 3 run calls
    expect(runCalls).toHaveLength(3)
    expect(runCalls[0]?.command).toBe('sudo sh -s')
    expect(runCalls[0]?.opts?.stdin).toContain('set -e')
    expect(runCalls[0]?.opts?.stdin).toContain('install -m 0644 -o groundflare -g groundflare')
    expect(runCalls[0]?.opts?.stdin).toContain('install -m 0644 -o root -g root')
    expect(runCalls[0]?.opts?.stdin).toContain('/var/lib/groundflare/worker.capnp')
    expect(runCalls[0]?.opts?.stdin).toContain('/etc/caddy/Caddyfile')
    expect(runCalls[1]?.command).toContain('systemctl restart groundflare-worker.service')
    expect(runCalls[1]?.command).toContain('systemctl reload caddy.service')
    expect(runCalls[2]?.command).toContain('curl -o /dev/null')
    expect(runCalls[2]?.command).toContain('Host: api.example.com')
  })

  it('atomic install leaves destinations untouched when staging scp fails', async () => {
    await scaffoldWorker(
      `name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2026-04-01"\n`,
    )
    const { client, runCalls, uploads } = mockSsh({
      uploadShouldThrow: new Error('scp: connection reset'),
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
    // First scp threw → we should see exactly one upload attempt (no
    // sudo install ran), then a best-effort rm for cleanup.
    expect(uploads).toHaveLength(1)
    const installCalls = runCalls.filter((c) => c.command === 'sudo sh -s')
    expect(installCalls).toHaveLength(0)
    const cleanupCalls = runCalls.filter((c) => c.command.startsWith('rm -f /tmp/gf-stage-'))
    expect(cleanupCalls).toHaveLength(1)
  })

  it('propagates upload_failed when the atomic install script fails', async () => {
    await scaffoldWorker(
      `name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2026-04-01"\n`,
    )
    const { client } = mockSsh({
      runs: [{ exitCode: 1, stderr: 'permission denied' }], // atomic install fails
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
        { exitCode: 0 }, // atomic install
        { exitCode: 1, stderr: 'Job failed.' }, // systemctl
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
        { exitCode: 0 }, // atomic install
        { exitCode: 0 }, // systemctl
        { exitCode: 0, stdout: '503' }, // probe
      ],
    })
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        ssh: client,
        healthProbe: { maxAttempts: 1, sleep: () => Promise.resolve() },
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
        { exitCode: 0 }, // atomic install
        { exitCode: 0 }, // systemctl
        { exitCode: 7, stderr: 'connection refused' }, // probe
      ],
    })
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        ssh: client,
        healthProbe: { maxAttempts: 1, sleep: () => Promise.resolve() },
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'health_failed' })
  })

  it('health probe retries through transient 5xx / ECONNREFUSED until workerd is ready', async () => {
    // workerd cold-start: first two probes see ECONNREFUSED and 502,
    // third probe succeeds with 200. Deploy should succeed.
    await scaffoldWorker(
      `name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2026-04-01"\n`,
    )
    const { client, runCalls } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        { exitCode: 0 }, // systemctl restart
        { exitCode: 7, stderr: 'connection refused' }, // probe 1: ECONNREFUSED
        { exitCode: 0, stdout: '502' }, // probe 2: bad gateway
        { exitCode: 0, stdout: '200' }, // probe 3: ready
      ],
    })
    const result = await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      healthProbe: { maxAttempts: 6, sleep: () => Promise.resolve() },
      log: () => {},
    })
    expect(result.healthCheck?.status).toBe(200)
    // Three curl calls for the three probe attempts.
    const probes = runCalls.filter((c) => c.command.startsWith('curl'))
    expect(probes).toHaveLength(3)
  })

  it('health probe exhausts attempts when 5xx never clears', async () => {
    await scaffoldWorker(
      `name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2026-04-01"\n`,
    )
    const { client, runCalls } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        { exitCode: 0 }, // systemctl
        { exitCode: 0, stdout: '503' },
        { exitCode: 0, stdout: '503' },
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
        healthProbe: { maxAttempts: 3, sleep: () => Promise.resolve() },
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'health_failed' })
    const probes = runCalls.filter((c) => c.command.startsWith('curl'))
    expect(probes).toHaveLength(3)
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

  it('runs [build].command and reads pre-built output instead of esbuild', async () => {
    // [build].command writes a file to dist/; main points at that output
    await writeFile(
      join(tmp, 'wrangler.toml'),
      [
        `name = "astro-app"`,
        `main = "dist/worker.js"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[build]`,
        `command = "mkdir -p dist && echo 'export default { async fetch() { return new Response(\\"built\\") } }' > dist/worker.js"`,
        ``,
        `[[routes]]`,
        `pattern = "app.example.com"`,
        `custom_domain = true`,
      ].join('\n'),
      'utf-8',
    )
    const { client } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
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
    expect(result.tenants[0]?.name).toBe('astro-app')
    expect(result.healthCheck?.status).toBe(200)
  })

  it('throws bundle_failed when [build].command exits non-zero', async () => {
    await writeFile(
      join(tmp, 'wrangler.toml'),
      [
        `name = "broken"`,
        `main = "dist/worker.js"`,
        ``,
        `[build]`,
        `command = "exit 1"`,
      ].join('\n'),
      'utf-8',
    )
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'bundle_failed' })
  })

  it('throws bundle_failed when [build] runs but main output missing', async () => {
    await writeFile(
      join(tmp, 'wrangler.toml'),
      [
        `name = "missing"`,
        `main = "dist/does-not-exist.js"`,
        ``,
        `[build]`,
        `command = "echo noop"`,
      ].join('\n'),
      'utf-8',
    )
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'bundle_failed' })
  })
})


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

  it('uploads server.ts + adapters + user bundle + systemd unit + Caddyfile via single atomic install', async () => {
    await scaffoldWorker(bunWrangler())
    // Expected run-call sequence:
    //   1. atomic install (sudo sh -s via stdin, covers mkdir + 8 files + cleanup)
    //   2. systemctl restart
    //   3. curl health probe
    const { client, runCalls, uploads } = mockSsh({
      runs: [
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0, stdout: '200' },
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
    expect(result.runtime).toBe('bun')
    expect(result.healthCheck?.status).toBe(200)
    expect(result.bunArtifactBytes).toBeGreaterThan(0)
    // 8 scp uploads, all staged under /tmp:
    // 1 server.ts + 4 adapters + 1 user.js + 1 systemd unit + 1 Caddyfile.
    expect(uploads).toHaveLength(8)
    for (const u of uploads) expect(u.remote).toMatch(/^\/tmp\/gf-stage-/)
    expect(runCalls).toHaveLength(3)
    expect(runCalls[0]?.command).toBe('sudo sh -s')
    const restartCall = runCalls.find((c) =>
      c.command.includes('systemctl restart groundflare-worker.service'),
    )
    expect(restartCall).toBeDefined()
    expect(restartCall?.command).toContain('systemctl reload caddy.service')
  })

  it('installs the Bun systemd unit at /etc/systemd/system/groundflare-worker.service as root', async () => {
    await scaffoldWorker(bunWrangler())
    const { client, runCalls } = mockSsh({
      runs: [
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0, stdout: '200' },
      ],
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      log: () => {},
    })
    const script = runCalls[0]?.opts?.stdin ?? ''
    // The script must install the unit into /etc/systemd/system as root,
    // distinct from the groundflare-owned files installed in the same
    // transaction.
    expect(script).toMatch(
      /install -m 0644 -o root -g root \/tmp\/gf-stage-\S+ \/etc\/systemd\/system\/groundflare-worker\.service/,
    )
    // Caddyfile also root-owned in the same transaction.
    expect(script).toMatch(
      /install -m 0644 -o root -g root \/tmp\/gf-stage-\S+ \/etc\/caddy\/Caddyfile/,
    )
  })

  it('mkdirs deployRoot + kv/d1/r2 + adapters inside the atomic script', async () => {
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
    const { client, runCalls } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        { exitCode: 0, stdout: '200' }, // R2 bucket pre-create (Bun track now uses the local SeaweedFS sidecar by default)
        { exitCode: 0 }, // systemctl restart
        { exitCode: 0, stdout: '200' }, // health probe
      ],
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      log: () => {},
    })
    const script = runCalls[0]?.opts?.stdin ?? ''
    expect(script).toContain('set -e')
    expect(script).toContain('mkdir -p /var/lib/groundflare/kv')
    expect(script).toContain('chown groundflare:groundflare /var/lib/groundflare/kv')
    expect(script).toContain('mkdir -p /var/lib/groundflare/d1')
    expect(script).toContain('mkdir -p /var/lib/groundflare/r2')
    expect(script).toContain('mkdir -p /var/lib/groundflare/adapters')
  })

  it('propagates upload_failed when the atomic install script fails', async () => {
    await scaffoldWorker(bunWrangler())
    const { client } = mockSsh({
      runs: [{ exitCode: 1, stderr: 'disk full' }], // atomic install fails
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

  it('Bun track: scp failure leaves destinations untouched (no install runs)', async () => {
    await scaffoldWorker(bunWrangler())
    const { client, runCalls, uploads } = mockSsh({
      uploadShouldThrow: new Error('scp: connection reset'),
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
    // First scp attempt throws → no `sudo sh -s` ran, only the cleanup rm.
    expect(uploads).toHaveLength(1)
    const installCalls = runCalls.filter((c) => c.command === 'sudo sh -s')
    expect(installCalls).toHaveLength(0)
  })
})

// ─── R2 binding integration ─────────────────────────────────────────

describe('runDeploy — R2 bindings (workerd track)', () => {
  // r2 wrangler with one binding pointing at the local SeaweedFS sidecar
  // (no `groundflare` block → default endpoint, no SigV4).
  function r2Wrangler(): string {
    return [
      `name = "api"`,
      `main = "src/index.ts"`,
      `compatibility_date = "2026-04-01"`,
      ``,
      `[[r2_buckets]]`,
      `binding = "MEDIA"`,
      `bucket_name = "media"`,
      ``,
      `[groundflare]`,
      `domain = "api.example.com"`,
    ].join('\n')
  }

  // Helper: scrape the uploaded capnp content. atomicInstall uploads
  // each file via scp with a text copy we can re-read.
  function capnpOf(uploads: MockSshSetup['uploads']): string {
    const capnp = uploads.find((u) => u.content?.includes('using Workerd'))
    expect(capnp, 'expected a capnp upload with "using Workerd"').toBeDefined()
    return capnp!.content!
  }

  it('bundles adapter, pre-creates bucket, restarts services', async () => {
    await scaffoldWorker(r2Wrangler())
    // SSH command sequence with one R2 binding:
    //   1. sudo sh -s (atomic install: bundle + capnp + Caddyfile)
    //   2. curl -X PUT http://127.0.0.1:8333/media (bucket pre-create)
    //   3. systemctl daemon-reload + restart workerd + reload caddy
    //   4. curl health probe (200)
    const { client, runCalls, uploads } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        { exitCode: 0, stdout: '200' }, // bucket curl PUT
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

    // Capnp content (scraped from the scp'd file before install) should
    // mention the per-binding R2 adapter service + shared outbound network.
    const capnp = capnpOf(uploads)
    expect(capnp).toContain('adapter-r2-api-MEDIA')
    expect(capnp).toContain('r2-internet')
    expect(capnp).toContain('BUCKET_NAME')
    expect(capnp).toContain('http://127.0.0.1:8333')

    // Bucket curl PUT — second SSH command, idempotent against weed.
    expect(runCalls[1]?.command).toContain('curl')
    expect(runCalls[1]?.command).toContain('-X PUT')
    expect(runCalls[1]?.command).toContain('http://127.0.0.1:8333/media')
  })

  it('skips local bucket pre-creation when groundflare.endpoint is set', async () => {
    await scaffoldWorker(
      [
        `name = "api"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[[r2_buckets]]`,
        `binding = "MEDIA"`,
        `bucket_name = "media"`,
        `[r2_buckets.groundflare]`,
        `endpoint = "https://s3.example.com"`,
        ``,
        `[groundflare]`,
        `domain = "api.example.com"`,
      ].join('\n'),
    )
    const { client, runCalls, uploads } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        { exitCode: 0 }, // systemctl restart (NOT bucket PUT)
        { exitCode: 0, stdout: '200' }, // health probe
      ],
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      log: () => {},
    })
    // No curl PUT to weed — external endpoints are not our problem.
    const bucketCalls = runCalls.filter((c) =>
      c.command.includes('curl') && c.command.includes('http://127.0.0.1:8333'),
    )
    expect(bucketCalls).toHaveLength(0)
    // Capnp should still emit the adapter service, just pointed elsewhere.
    expect(capnpOf(uploads)).toContain('https://s3.example.com')
  })

  it('throws config_missing with remediation when an R2 secret is missing', async () => {
    await scaffoldWorker(
      [
        `name = "api"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[[r2_buckets]]`,
        `binding = "MEDIA"`,
        `bucket_name = "media"`,
        `[r2_buckets.groundflare]`,
        `endpoint = "https://s3.example.com"`,
        `access_key_id_secret = "S3_KEY"`,
        `secret_access_key_secret = "S3_SECRET"`,
        ``,
        `[groundflare]`,
        `domain = "api.example.com"`,
      ].join('\n'),
    )
    const { MemorySecretStore } = await import('../../../src/secret/index.js')
    const secretStore = new MemorySecretStore() // empty — both secrets missing
    const { client } = mockSsh()
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        ssh: client,
        secretStore,
        log: () => {},
      }),
    ).rejects.toThrowError(/secret "S3_KEY" not found.*groundflare secret set S3_KEY/s)
  })

  it('passes resolved credentials through to the capnp adapter bindings', async () => {
    await scaffoldWorker(
      [
        `name = "api"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[[r2_buckets]]`,
        `binding = "MEDIA"`,
        `bucket_name = "media"`,
        `[r2_buckets.groundflare]`,
        `endpoint = "https://s3.example.com"`,
        `region = "us-east-1"`,
        `access_key_id_secret = "S3_KEY"`,
        `secret_access_key_secret = "S3_SECRET"`,
        ``,
        `[groundflare]`,
        `domain = "api.example.com"`,
      ].join('\n'),
    )
    const { MemorySecretStore } = await import('../../../src/secret/index.js')
    const secretStore = new MemorySecretStore()
    await secretStore.set('S3_KEY', 'AKIAFAKEKEY')
    await secretStore.set('S3_SECRET', 'fake-secret-value')
    const { client, uploads } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        { exitCode: 0 }, // systemctl restart (no bucket — external endpoint)
        { exitCode: 0, stdout: '200' }, // health probe
      ],
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      secretStore,
      log: () => {},
    })
    // Capnp embeds the resolved values, NOT the secret names.
    const capnp = capnpOf(uploads)
    expect(capnp).toContain('AKIAFAKEKEY')
    expect(capnp).toContain('fake-secret-value')
    expect(capnp).not.toContain('"S3_KEY"')
    expect(capnp).not.toContain('"S3_SECRET"')
  })

  it('deduplicates bucket pre-creation when several bindings share a bucket', async () => {
    await scaffoldWorker(
      [
        `name = "api"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[[r2_buckets]]`,
        `binding = "MEDIA"`,
        `bucket_name = "shared"`,
        ``,
        `[[r2_buckets]]`,
        `binding = "ALIAS"`,
        `bucket_name = "shared"`,
        ``,
        `[groundflare]`,
        `domain = "api.example.com"`,
      ].join('\n'),
    )
    const { client, runCalls } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        { exitCode: 0, stdout: '200' }, // bucket curl PUT (single, not per binding)
        { exitCode: 0 }, // systemctl restart
        { exitCode: 0, stdout: '200' }, // health probe
      ],
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      log: () => {},
    })
    const bucketCalls = runCalls.filter((c) =>
      c.command.includes('curl') && c.command.includes('http://127.0.0.1:8333'),
    )
    expect(bucketCalls).toHaveLength(1)
    expect(bucketCalls[0]?.command).toContain('http://127.0.0.1:8333/shared')
  })
})

// ─── Bun track R2 external endpoint (env file sync) ────────────────

describe('runDeploy — Bun track R2 external endpoint', () => {
  function capnpOf(uploads: MockSshSetup['uploads']): string | undefined {
    return uploads.find((u) => u.content?.includes('using Workerd'))?.content
  }
  function envFileOf(uploads: MockSshSetup['uploads']): string | undefined {
    // Caddyfile + env file both banner "# GENERATED by groundflare".
    // Only the env file contains R2_ KEY=VALUE lines, so anchor on that.
    return uploads.find(
      (u) => u.content?.startsWith('# GENERATED') && /^R2_/m.test(u.content),
    )?.content
  }

  function bunWranglerWithR2(overrides: string[] = []): string {
    return [
      `name = "api"`,
      `main = "src/index.ts"`,
      `compatibility_date = "2026-04-01"`,
      ``,
      `[groundflare]`,
      `runtime = "bun"`,
      ``,
      `[[r2_buckets]]`,
      `binding = "MEDIA"`,
      `bucket_name = "media"`,
      ...overrides,
    ].join('\n')
  }

  it('does NOT write an env file when the only R2 binding uses local weed', async () => {
    await scaffoldWorker(bunWranglerWithR2())
    const { client, uploads } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        { exitCode: 0, stdout: '200' }, // R2 bucket pre-create
        { exitCode: 0 }, // systemctl restart
        { exitCode: 0, stdout: '200' }, // health probe
      ],
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      log: () => {},
    })
    expect(envFileOf(uploads)).toBeUndefined()
    // Workerd capnp isn't emitted for a Bun-track deploy either.
    expect(capnpOf(uploads)).toBeUndefined()
  })

  it('writes /etc/groundflare/environment with resolved credentials when endpoint is external', async () => {
    await scaffoldWorker(
      bunWranglerWithR2([
        `[r2_buckets.groundflare]`,
        `endpoint = "https://s3.us-west-002.backblazeb2.com"`,
        `region = "us-west-002"`,
        `access_key_id_secret = "B2_KEY"`,
        `secret_access_key_secret = "B2_SECRET"`,
      ]),
    )
    const { MemorySecretStore } = await import('../../../src/secret/index.js')
    const store = new MemorySecretStore()
    await store.set('B2_KEY', 'AKIAFAKE')
    await store.set('B2_SECRET', 'very-secret-value')

    const { client, uploads } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        // No bucket pre-create here — external endpoint skips it.
        { exitCode: 0 }, // systemctl restart
        { exitCode: 0, stdout: '200' }, // health probe
      ],
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      secretStore: store,
      log: () => {},
    })
    const env = envFileOf(uploads)
    expect(env).toBeDefined()
    expect(env).toContain('R2_MEDIA_ENDPOINT=https://s3.us-west-002.backblazeb2.com')
    expect(env).toContain('R2_MEDIA_REGION=us-west-002')
    expect(env).toContain('R2_MEDIA_ACCESS_KEY_ID=AKIAFAKE')
    expect(env).toContain('R2_MEDIA_SECRET_ACCESS_KEY=very-secret-value')
    // Banner comment warns operators before they edit by hand.
    expect(env).toMatch(/# GENERATED by groundflare/)
  })

  it('installs the env file at /etc/groundflare/environment with root:root 0600 perms', async () => {
    await scaffoldWorker(
      bunWranglerWithR2([
        `[r2_buckets.groundflare]`,
        `endpoint = "https://s3.example.com"`,
        `access_key_id_secret = "K"`,
        `secret_access_key_secret = "S"`,
      ]),
    )
    const { MemorySecretStore } = await import('../../../src/secret/index.js')
    const store = new MemorySecretStore()
    await store.set('K', 'a')
    await store.set('S', 'b')
    const { client, runCalls } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        { exitCode: 0 }, // systemctl restart
        { exitCode: 0, stdout: '200' }, // health probe
      ],
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      secretStore: store,
      log: () => {},
    })
    // atomicInstall embeds install-m mode + owner in the single sh
    // script it runs under sudo. Look for the env file line.
    expect(runCalls[0]?.opts?.stdin).toContain(
      'install -m 0600 -o root -g root',
    )
    expect(runCalls[0]?.opts?.stdin).toContain('/etc/groundflare/environment')
  })

  it('throws config_missing when an external-endpoint binding references a missing secret', async () => {
    await scaffoldWorker(
      bunWranglerWithR2([
        `[r2_buckets.groundflare]`,
        `endpoint = "https://s3.example.com"`,
        `access_key_id_secret = "NO_SUCH"`,
        `secret_access_key_secret = "STILL_MISSING"`,
      ]),
    )
    const { MemorySecretStore } = await import('../../../src/secret/index.js')
    const store = new MemorySecretStore()
    // Intentionally empty.
    const { client } = mockSsh()
    await expect(
      runDeploy({
        workspace: 'demo',
        workingDirectory: tmp,
        acmeEmail: 'ops@example.com',
        bootstrapState: baseState(),
        ssh: client,
        secretStore: store,
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: 'config_missing' })
  })

  it('combines multiple R2 bindings — each gets its own R2_<BINDING>_* lines', async () => {
    await scaffoldWorker(
      [
        `name = "api"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[groundflare]`,
        `runtime = "bun"`,
        ``,
        `[[r2_buckets]]`,
        `binding = "PHOTOS"`,
        `bucket_name = "photos"`,
        `[r2_buckets.groundflare]`,
        `endpoint = "https://photos.example.com"`,
        `access_key_id_secret = "PHOTO_KEY"`,
        `secret_access_key_secret = "PHOTO_SECRET"`,
        ``,
        `[[r2_buckets]]`,
        `binding = "VIDEOS"`,
        `bucket_name = "videos"`,
        `[r2_buckets.groundflare]`,
        `endpoint = "https://videos.example.com"`,
        `access_key_id_secret = "VIDEO_KEY"`,
        `secret_access_key_secret = "VIDEO_SECRET"`,
      ].join('\n'),
    )
    const { MemorySecretStore } = await import('../../../src/secret/index.js')
    const store = new MemorySecretStore()
    await store.set('PHOTO_KEY', 'p-key')
    await store.set('PHOTO_SECRET', 'p-secret')
    await store.set('VIDEO_KEY', 'v-key')
    await store.set('VIDEO_SECRET', 'v-secret')
    const { client, uploads } = mockSsh({
      runs: [
        { exitCode: 0 }, // atomic install
        { exitCode: 0 }, // systemctl restart
        { exitCode: 0, stdout: '200' }, // health probe
      ],
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      secretStore: store,
      log: () => {},
    })
    const env = envFileOf(uploads)!
    expect(env).toContain('R2_PHOTOS_ENDPOINT=https://photos.example.com')
    expect(env).toContain('R2_PHOTOS_ACCESS_KEY_ID=p-key')
    expect(env).toContain('R2_VIDEOS_ENDPOINT=https://videos.example.com')
    expect(env).toContain('R2_VIDEOS_ACCESS_KEY_ID=v-key')
  })

  it('quotes env values containing whitespace or special chars', async () => {
    await scaffoldWorker(
      bunWranglerWithR2([
        `[r2_buckets.groundflare]`,
        `endpoint = "https://example.com"`,
        `access_key_id_secret = "AK"`,
        `secret_access_key_secret = "SK"`,
      ]),
    )
    const { MemorySecretStore } = await import('../../../src/secret/index.js')
    const store = new MemorySecretStore()
    await store.set('AK', 'key with spaces')
    await store.set('SK', 'secret"with"quotes')
    const { client, uploads } = mockSsh({
      runs: [
        { exitCode: 0 },
        { exitCode: 0 },
        { exitCode: 0, stdout: '200' },
      ],
    })
    await runDeploy({
      workspace: 'demo',
      workingDirectory: tmp,
      acmeEmail: 'ops@example.com',
      bootstrapState: baseState(),
      ssh: client,
      secretStore: store,
      log: () => {},
    })
    const env = envFileOf(uploads)!
    expect(env).toContain('R2_MEDIA_ACCESS_KEY_ID="key with spaces"')
    expect(env).toContain('R2_MEDIA_SECRET_ACCESS_KEY="secret\\"with\\"quotes"')
  })
})
