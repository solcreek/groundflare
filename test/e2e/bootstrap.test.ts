/**
 * Tier 3 Phase B: full runBootstrap end-to-end against a fake Docker VPS.
 *
 * Exercises stages 0-6 in sequence. What each stage looks like here:
 *
 *   0 auth             — DockerTestProvider.authenticate (always succeeds)
 *   1 ssh-key          — real keypair generation + local save
 *   2 provision        — DockerTestProvider.createVPS spawns container
 *   3 wait-ssh         — real TCP probe + SSH ping on the forwarded port
 *   4 cloud-init       — container's cloud-init shim returns "done"
 *   5 install-runtime  — workerd is baked into the image → isComplete() → skip
 *   6 install-services — real systemd unit + Caddyfile installed by SSH
 *
 * Verifications after runBootstrap:
 *   - completedStages has all 7 stage ids
 *   - VPS record carries the forwarded port
 *   - systemctl: groundflare-worker.service is `enabled` (not started yet)
 *   - systemctl: caddy.service is `active` (was restarted with the new config)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BootstrapStateStore, runBootstrap } from '../../src/bootstrap/index.js'
import { MemorySecretStore } from '../../src/secret/index.js'
import { OpenSshClient } from '../../src/ssh/index.js'

import { ensureDockerAvailable } from './helpers/docker-vps.js'
import { DockerTestProvider } from './helpers/docker-test-provider.js'

let dockerAvailable = false

try {
  await ensureDockerAvailable()
  dockerAvailable = true
} catch {
  // leave false; describe.skipIf will suppress the suite
}

describe.skipIf(!dockerAvailable)('e2e: runBootstrap end-to-end', () => {
  let tmp: string
  let provider: DockerTestProvider

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-e2e-bootstrap-'))
    provider = new DockerTestProvider()
    await provider.ensureImage()
  }, 360_000)

  afterAll(async () => {
    if (provider) await provider.destroyAll()
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it('runs all 7 stages and leaves systemd in a healthy state', async () => {
    const secrets = new MemorySecretStore({ 'provider.hetzner.token': 'fake-token' })
    const stateStore = new BootstrapStateStore({ directory: join(tmp, 'state') })

    const finalState = await runBootstrap({
      workspace: 'e2etest',
      provider: 'hetzner',
      region: 'hel1',
      size: 'cx22',
      acmeEmail: 'ops@example.com',
      placeholderDomain: 'e2e.invalid',
      sshKeyDirectory: join(tmp, 'keys'),
      providerOverride: provider,
      secretStoreOverride: secrets,
      stateStoreOverride: stateStore,
      log: () => {},
    })

    // ─── Stage progression ──────────────────────────────────────────
    expect(finalState.completedStages).toEqual([
      'provider.auth',
      'provider.ssh-key',
      'provider.provision',
      'provider.wait-ssh',
      'system.cloud-init',
      'system.install-runtime',
      'system.install-services',
    ])

    // ─── VPS record carries the forwarded port ──────────────────────
    expect(finalState.vps).toBeDefined()
    expect(finalState.vps?.ipv4).toBe('127.0.0.1')
    expect(finalState.vps?.port).toBeGreaterThan(1024)

    // ─── Remote systemd state ───────────────────────────────────────
    const ssh = new OpenSshClient({
      target: {
        host: finalState.vps!.ipv4,
        port: finalState.vps!.port,
        user: finalState.vps!.user,
        privateKeyPath: finalState.sshKey!.localPath,
        strictHostKeyChecking: 'no',
        knownHostsPath: '/dev/null',
      },
    })

    const workerEnabled = await ssh.run(
      'systemctl is-enabled groundflare-worker.service',
      { timeoutMs: 10_000 },
    )
    expect(workerEnabled.stdout.trim()).toBe('enabled')

    // Caddy is expected to be active (it was restarted with the placeholder
    // Caddyfile at the end of stage 06). ACME against e2e.invalid will fail
    // in the background, but Caddy itself stays up.
    const caddyActive = await ssh.run('systemctl is-active caddy.service', {
      timeoutMs: 10_000,
    })
    expect(caddyActive.stdout.trim()).toBe('active')

    // Capnp state dir was created by install-runtime (baked workerd still
    // makes the stage run the `mkdir` half? no — isComplete skipped the
    // whole stage). We check for the systemd unit file instead, which
    // install-services definitely installed.
    const unitPresent = await ssh.run(
      'test -f /etc/systemd/system/groundflare-worker.service',
      { timeoutMs: 10_000 },
    )
    expect(unitPresent.exitCode).toBe(0)
  }, 300_000)
})
