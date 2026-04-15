/**
 * Tier 3 Phase D: Bun-track end-to-end.
 *
 * Mirrors test/e2e/deploy.test.ts for the Bun track. beforeAll bootstraps
 * the fake VPS with `runtime: 'bun'`, then the single `it` scaffolds a
 * wrangler project with `[groundflare] runtime = "bun"` and invokes
 * runDeploy. Success criterion: the health probe runDeploy itself makes
 * returns 200 — proof that Bun.serve came up and the user fetch handler
 * ran.
 *
 * What this exercises that the workerd deploy test doesn't:
 *   - runBootstrap threads `runtime: 'bun'` into cloud-init
 *     (fake-vps already has /usr/local/bin/bun baked in, matching what
 *      cloud-init's installBun path would produce in production)
 *   - runDeploy detects `manifest.runtime === 'bun'` and drives the
 *     Bun-track stage: buildBunArtifact + stageBunArtifact instead of
 *     capnp + bundle upload
 *   - the Bun systemd unit installed at deploy time starts cleanly and
 *     the user's fetch() handler is reachable via Caddy
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BootstrapStateStore,
  runBootstrap,
  type BootstrapState,
} from '../../src/bootstrap/index.js'
import { runDeploy } from '../../src/deploy/index.js'
import { MemorySecretStore } from '../../src/secret/index.js'

import { ensureDockerAvailable } from './helpers/docker-vps.js'
import { DockerTestProvider } from './helpers/docker-test-provider.js'

let dockerAvailable = false

try {
  await ensureDockerAvailable()
  dockerAvailable = true
} catch {
  // skip when docker isn't around
}

describe.skipIf(!dockerAvailable)('e2e: runDeploy end-to-end (Bun track)', () => {
  let tmp: string
  let provider: DockerTestProvider
  let state: BootstrapState

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-e2e-bun-'))
    provider = new DockerTestProvider()
    await provider.ensureImage()
    const secrets = new MemorySecretStore({ 'provider.hetzner.token': 'fake-token' })
    const stateStore = new BootstrapStateStore({ directory: join(tmp, 'state') })
    state = await runBootstrap({
      workspace: 'e2ebun',
      provider: 'hetzner',
      region: 'hel1',
      size: 'cx22',
      acmeEmail: 'ops@example.com',
      placeholderDomain: 'demo.local',
      sshKeyDirectory: join(tmp, 'keys'),
      runtime: 'bun',
      providerOverride: provider,
      secretStoreOverride: secrets,
      stateStoreOverride: stateStore,
      log: () => {},
    })
  }, 360_000)

  afterAll(async () => {
    if (provider) await provider.destroyAll()
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it('deploys a Bun-track worker and the health probe returns 200', async () => {
    const workerDir = join(tmp, 'worker')
    await mkdir(join(workerDir, 'src'), { recursive: true })
    await writeFile(
      join(workerDir, 'wrangler.toml'),
      [
        `name = "bundemo"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[groundflare]`,
        `domain = "demo.local"`,
        `runtime = "bun"`,
      ].join('\n'),
      'utf-8',
    )
    await writeFile(
      join(workerDir, 'src/index.ts'),
      `export default {
         async fetch(_req) {
           return new Response('hello from Bun e2e', { status: 200 })
         }
       }`,
      'utf-8',
    )

    const result = await runDeploy({
      workspace: 'e2ebun',
      workingDirectory: workerDir,
      bootstrapState: state,
      acmeEmail: 'ops@example.com',
      log: () => {},
    })

    expect(result.runtime).toBe('bun')
    expect(result.dryRun).toBe(false)
    expect(result.tenants).toHaveLength(1)
    expect(result.tenants[0]!.name).toBe('bundemo')
    expect(result.tenants[0]!.domain).toBe('demo.local')
    expect(result.bunArtifactBytes).toBeGreaterThan(0)
    expect(result.capnpBytes).toBe(0)
    expect(result.healthCheck).toBeDefined()
    expect(result.healthCheck!.status).toBe(200)
  }, 180_000)
})
