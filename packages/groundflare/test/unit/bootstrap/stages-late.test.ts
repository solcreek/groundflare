/**
 * Tests for the post-SSH bootstrap stages (4-6). Each is exercised with
 * a fully mocked SshClient so we can assert exact remote command shape
 * without spawning real ssh processes.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  BootstrapError,
  cloudInitStage,
  installRuntimeStage,
  installServicesStage,
  type BootstrapContext,
  type BootstrapState,
} from '../../../src/bootstrap/index.js'
import type { RunResult, SshClient, RunOptions } from '../../../src/ssh/index.js'

function freshState(): BootstrapState {
  return {
    workspace: 'demo',
    provider: 'hetzner',
    completedStages: [],
    startedAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
  }
}

interface MockedRun {
  /** Return value of the next ssh.run call (FIFO). */
  result?: Partial<RunResult>
}

interface MockSshOptions {
  runs?: readonly MockedRun[]
  uploadShouldThrow?: Error
}

interface MockSshSetup {
  client: SshClient
  runCalls: Array<{ command: string; opts?: RunOptions }>
  uploadCalls: Array<{ local: string; remote: string }>
}

function mockSshClient(opts: MockSshOptions = {}): MockSshSetup {
  const runQueue = [...(opts.runs ?? [])]
  const runCalls: MockSshSetup['runCalls'] = []
  const uploadCalls: MockSshSetup['uploadCalls'] = []
  const client: SshClient = {
    ping: vi.fn(async () => {}),
    run: vi.fn(async (command: string, runOpts?: RunOptions) => {
      runCalls.push({ command, opts: runOpts })
      const next = runQueue.shift() ?? {}
      return {
        exitCode: next.result?.exitCode ?? 0,
        stdout: next.result?.stdout ?? '',
        stderr: next.result?.stderr ?? '',
        durationMs: next.result?.durationMs ?? 1,
      }
    }),
    stream: vi.fn(),
    upload: vi.fn(async (local: string, remote: string) => {
      uploadCalls.push({ local, remote })
      if (opts.uploadShouldThrow) throw opts.uploadShouldThrow
    }),
    download: vi.fn(),
  }
  return { client, runCalls, uploadCalls }
}

function makeContext(opts: { ssh?: SshClient; state?: BootstrapState } = {}): BootstrapContext {
  return {
    workspace: 'demo',
    provider: {} as never,
    secrets: {} as never,
    state: opts.state ?? freshState(),
    log: vi.fn() as unknown as BootstrapContext['log'],
    ...(opts.ssh ? { ssh: opts.ssh } : {}),
  }
}

// ─── Stage 4: cloud-init wait ──────────────────────────────────────

describe('Stage: system.cloud-init', () => {
  it('throws prerequisite when no SSH client is attached', async () => {
    const ctx = makeContext()
    await expect(cloudInitStage().run(ctx)).rejects.toMatchObject({
      name: 'BootstrapError',
      code: 'prerequisite',
    })
  })

  it('runs `sudo cloud-init status --wait` and resolves on exit 0', async () => {
    const { client, runCalls } = mockSshClient({
      runs: [{ result: { exitCode: 0, stdout: 'status: done\n', durationMs: 42 } }],
    })
    const ctx = makeContext({ ssh: client })
    await cloudInitStage().run(ctx)
    expect(runCalls).toHaveLength(1)
    expect(runCalls[0]?.command).toBe('sudo cloud-init status --wait')
  })

  it('throws BootstrapError(stage_failed) when cloud-init exits non-zero', async () => {
    const { client } = mockSshClient({
      runs: [{ result: { exitCode: 1, stderr: 'cloud-init failed\n' } }],
    })
    const ctx = makeContext({ ssh: client })
    await expect(cloudInitStage().run(ctx)).rejects.toMatchObject({
      code: 'stage_failed',
      stageId: 'system.cloud-init',
    })
  })

  it('respects the timeoutMs option on the underlying ssh.run', async () => {
    const { client, runCalls } = mockSshClient({ runs: [{ result: { exitCode: 0 } }] })
    const ctx = makeContext({ ssh: client })
    await cloudInitStage({ timeoutMs: 7_777 }).run(ctx)
    expect(runCalls[0]?.opts?.timeoutMs).toBe(7_777)
  })
})

// ─── Stage 5: install runtime ─────────────────────────────────────

describe('Stage: system.install-runtime', () => {
  it('verifies workerd + creates state dirs + checks caddy when binary already present', async () => {
    const { client, runCalls } = mockSshClient({
      runs: [
        { result: { exitCode: 0 } }, // test -x (binary present)
        { result: { exitCode: 0, stdout: 'workerd 2026-04-14\n' } }, // version
        { result: { exitCode: 0 } }, // mkdir
        { result: { exitCode: 0, stdout: '/usr/bin/caddy\nv2.10.0\n' } }, // caddy verify
      ],
    })
    const ctx = makeContext({ ssh: client })
    await installRuntimeStage().run(ctx)

    expect(runCalls[0]?.command).toContain('test -x /usr/local/bin/workerd')
    expect(runCalls[1]?.command).toBe('/usr/local/bin/workerd --version')
    expect(runCalls[2]?.command).toContain('chown -R groundflare:groundflare /var/lib/groundflare')
    expect(runCalls[3]?.command).toBe('which caddy && caddy version')
  })

  it('attempts recovery download when workerd binary is missing', async () => {
    const { client, runCalls } = mockSshClient({
      runs: [
        { result: { exitCode: 1 } }, // test -x (not found)
        { result: { exitCode: 0 } }, // curl download
        { result: { exitCode: 0, stdout: 'workerd 2026-04-14\n' } }, // version
        { result: { exitCode: 0 } }, // mkdir
        { result: { exitCode: 0, stdout: '/usr/bin/caddy\nv2.10.0\n' } }, // caddy
      ],
    })
    const ctx = makeContext({ ssh: client })
    await installRuntimeStage().run(ctx)

    // Second call is the recovery curl
    expect(runCalls[1]?.command).toContain('curl -fsSL')
    expect(runCalls[1]?.command).toContain('registry.npmjs.org')
  })

  it('aborts with stage_failed if recovery download fails', async () => {
    const { client } = mockSshClient({
      runs: [
        { result: { exitCode: 1 } }, // test -x
        { result: { exitCode: 1, stderr: 'download failed' } }, // curl fails
      ],
    })
    const ctx = makeContext({ ssh: client })
    await expect(installRuntimeStage().run(ctx)).rejects.toMatchObject({
      code: 'stage_failed',
    })
  })

  it('aborts when Caddy is missing (cloud-init likely failed)', async () => {
    const { client } = mockSshClient({
      runs: [
        { result: { exitCode: 0 } }, // test -x
        { result: { exitCode: 0, stdout: 'workerd v1' } }, // version
        { result: { exitCode: 0 } }, // mkdir
        { result: { exitCode: 1, stderr: 'caddy: command not found' } }, // caddy
      ],
    })
    const ctx = makeContext({ ssh: client })
    await expect(installRuntimeStage().run(ctx)).rejects.toThrow(/Caddy not installed/)
  })

  it('isComplete returns true when the binary already exists', async () => {
    const { client } = mockSshClient({ runs: [{ result: { exitCode: 0 } }] })
    const ctx = makeContext({ ssh: client })
    expect(await installRuntimeStage().isComplete!(ctx)).toBe(true)
  })

  it('isComplete returns false when the test command exits non-zero', async () => {
    const { client } = mockSshClient({ runs: [{ result: { exitCode: 1 } }] })
    const ctx = makeContext({ ssh: client })
    expect(await installRuntimeStage().isComplete!(ctx)).toBe(false)
  })
})

// ─── Stage 6: install services ─────────────────────────────────────

describe('Stage: system.install-services', () => {
  it('uploads systemd unit + Caddyfile and reloads', async () => {
    const { client, runCalls, uploadCalls } = mockSshClient({
      runs: [
        { result: { exitCode: 0 } }, // install systemd unit
        { result: { exitCode: 0 } }, // install Caddyfile
        { result: { exitCode: 0 } }, // daemon-reload + enable + restart caddy
      ],
    })
    const ctx = makeContext({ ssh: client })
    await installServicesStage({
      acmeEmail: 'ops@example.com',
      placeholderDomain: 'demo.groundflare.app',
    }).run(ctx)

    expect(uploadCalls).toHaveLength(2)
    expect(uploadCalls[0]?.remote).toBe('/tmp/groundflare-worker.service.upload')
    expect(uploadCalls[1]?.remote).toBe('/tmp/Caddyfile.upload')

    expect(runCalls[0]?.command).toContain(
      'sudo install -m 0644 -o root -g root /tmp/groundflare-worker.service.upload /etc/systemd/system/groundflare-worker.service',
    )
    expect(runCalls[1]?.command).toContain(
      'sudo install -m 0644 -o root -g root /tmp/Caddyfile.upload /etc/caddy/Caddyfile',
    )
    expect(runCalls[2]?.command).toContain('sudo systemctl daemon-reload')
    expect(runCalls[2]?.command).toContain('sudo systemctl enable groundflare-worker.service')
    expect(runCalls[2]?.command).toContain('sudo systemctl enable caddy.service')
    expect(runCalls[2]?.command).toContain('sudo systemctl restart caddy.service')
  })

  it('throws when the systemctl reload fails', async () => {
    const { client } = mockSshClient({
      runs: [
        { result: { exitCode: 0 } },
        { result: { exitCode: 0 } },
        { result: { exitCode: 1, stderr: 'unit dependency cycle' } },
      ],
    })
    const ctx = makeContext({ ssh: client })
    await expect(
      installServicesStage({
        acmeEmail: 'ops@example.com',
        placeholderDomain: 'demo.groundflare.app',
      }).run(ctx),
    ).rejects.toMatchObject({ code: 'stage_failed' })
  })

  it('throws prerequisite when no SSH client is attached', async () => {
    const ctx = makeContext()
    await expect(
      installServicesStage({
        acmeEmail: 'ops@example.com',
        placeholderDomain: 'demo.groundflare.app',
      }).run(ctx),
    ).rejects.toMatchObject({ code: 'prerequisite' })
  })

  it('isComplete returns true when the systemd unit file exists', async () => {
    const { client } = mockSshClient({ runs: [{ result: { exitCode: 0 } }] })
    const ctx = makeContext({ ssh: client })
    expect(
      await installServicesStage({
        acmeEmail: 'ops@example.com',
        placeholderDomain: 'demo.groundflare.app',
      }).isComplete!(ctx),
    ).toBe(true)
  })
})

// ─── BootstrapError marker (sanity) ────────────────────────────────

describe('BootstrapError', () => {
  it('is the error type thrown by all late-stage prerequisite failures', () => {
    const err = new BootstrapError('x', 'prerequisite', 'system.install-runtime')
    expect(err.name).toBe('BootstrapError')
    expect(err.stageId).toBe('system.install-runtime')
  })
})
