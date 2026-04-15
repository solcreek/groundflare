/**
 * Tier 3 Phase A smoke test.
 *
 * Builds the fake-vps image, starts a container, and verifies that we
 * can SSH in as `groundflare` using our OpenSshClient and run `sudo`.
 *
 * Skipped automatically if Docker is not installed / not running.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildFakeVPSImage,
  ensureDockerAvailable,
  startFakeVPS,
  type StartedVPS,
} from './helpers/docker-vps.js'
import { generateEd25519Keypair } from '../../src/bootstrap/index.js'
import { OpenSshClient } from '../../src/ssh/index.js'

let dockerAvailable = false

try {
  await ensureDockerAvailable()
  dockerAvailable = true
} catch {
  // Leave dockerAvailable=false; the describe below will skip.
}

describe.skipIf(!dockerAvailable)('e2e: fake-vps smoke', () => {
  let vps: StartedVPS | undefined
  let tmp: string
  let keyPath: string

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-e2e-smoke-'))
    const kp = await generateEd25519Keypair('e2e-smoke')
    keyPath = join(tmp, 'id_ed25519')
    await writeFile(keyPath, kp.privateKeyPem, { mode: 0o600 })
    await buildFakeVPSImage()
    vps = await startFakeVPS({ publicKey: kp.publicKeyOpenSsh })
  }, 360_000)

  afterAll(async () => {
    if (vps) await vps.stop().catch(() => {})
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it('accepts SSH and runs a command', async () => {
    if (!vps) throw new Error('vps not started')
    const ssh = new OpenSshClient({
      target: {
        host: vps.host,
        port: vps.sshPort,
        user: 'groundflare',
        privateKeyPath: keyPath,
        strictHostKeyChecking: 'no',
        knownHostsPath: '/dev/null',
      },
    })
    const result = await ssh.run('whoami', { timeoutMs: 15_000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('groundflare')
  }, 60_000)

  it('passwordless sudo works', async () => {
    if (!vps) throw new Error('vps not started')
    const ssh = new OpenSshClient({
      target: {
        host: vps.host,
        port: vps.sshPort,
        user: 'groundflare',
        privateKeyPath: keyPath,
        strictHostKeyChecking: 'no',
        knownHostsPath: '/dev/null',
      },
    })
    const result = await ssh.run('sudo -n whoami', { timeoutMs: 15_000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('root')
  }, 60_000)

  it('systemd is PID 1 and ssh.service is active', async () => {
    if (!vps) throw new Error('vps not started')
    const ssh = new OpenSshClient({
      target: {
        host: vps.host,
        port: vps.sshPort,
        user: 'groundflare',
        privateKeyPath: keyPath,
        strictHostKeyChecking: 'no',
        knownHostsPath: '/dev/null',
      },
    })
    const pid1 = await ssh.run('cat /proc/1/comm', { timeoutMs: 10_000 })
    expect(pid1.stdout.trim()).toBe('systemd')

    const active = await ssh.run('systemctl is-active ssh', { timeoutMs: 10_000 })
    expect(active.stdout.trim()).toBe('active')
  }, 60_000)
})
