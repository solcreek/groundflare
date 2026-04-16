/**
 * Tier 3 Phase C: full runBootstrap + runDeploy round-trip.
 *
 * beforeAll bootstraps the fake VPS (reuses Phase B's work). The `it` then:
 *   - scaffolds a tiny wrangler project (name=demo, main=src/index.ts,
 *     groundflare.domain=demo.local)
 *   - calls runDeploy
 *   - asserts the health probe runDeploy does against workerd returned 200
 *
 * The probe runs INSIDE the container via SSH
 * (`curl -H "Host: demo.local" http://127.0.0.1:8080/`) — so the end-to-end
 * path covered is: systemd → workerd → Router Worker → user fetch → 200.
 * Caddy is running too but not on the data path for this probe.
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

describe.skipIf(!dockerAvailable)('e2e: runDeploy end-to-end', () => {
  let tmp: string
  let provider: DockerTestProvider
  let state: BootstrapState

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-e2e-deploy-'))
    provider = new DockerTestProvider()
    await provider.ensureImage()
    const secrets = new MemorySecretStore({ 'provider.hetzner.token': 'fake-token' })
    const stateStore = new BootstrapStateStore({ directory: join(tmp, 'state') })
    state = await runBootstrap({
      workspace: 'e2edeploy',
      provider: 'hetzner',
      region: 'hel1',
      size: 'cx22',
      acmeEmail: 'ops@example.com',
      placeholderDomain: 'demo.local',
      sshKeyDirectory: join(tmp, 'keys'),
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

  it('deploys a tiny worker and the health probe returns 200', async () => {
    const workerDir = join(tmp, 'worker')
    await mkdir(join(workerDir, 'src'), { recursive: true })
    await writeFile(
      join(workerDir, 'wrangler.toml'),
      [
        `name = "demo"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[groundflare]`,
        `domain = "demo.local"`,
      ].join('\n'),
      'utf-8',
    )
    await writeFile(
      join(workerDir, 'src/index.ts'),
      `export default {
         async fetch(_req) {
           return new Response('hello from e2e', { status: 200 })
         }
       }`,
      'utf-8',
    )

    const result = await runDeploy({
      workspace: 'e2edeploy',
      workingDirectory: workerDir,
      bootstrapState: state,
      acmeEmail: 'ops@example.com',
      log: () => {},
    })

    expect(result.dryRun).toBe(false)
    expect(result.tenants).toHaveLength(1)
    expect(result.tenants[0]!.name).toBe('demo')
    expect(result.tenants[0]!.domain).toBe('demo.local')
    expect(result.healthCheck).toBeDefined()
    expect(result.healthCheck!.status).toBe(200)
  }, 180_000)

  it('deploys a worker that uses WorkerLoader to dynamically load a sub-worker', async () => {
    const workerDir = join(tmp, 'loader-worker')
    await mkdir(join(workerDir, 'src'), { recursive: true })
    await writeFile(
      join(workerDir, 'wrangler.toml'),
      [
        `name = "loader-test"`,
        `main = "src/index.ts"`,
        `compatibility_date = "2026-04-01"`,
        ``,
        `[[worker_loaders]]`,
        `binding = "LOADER"`,
        ``,
        `[groundflare]`,
        `domain = "loader.local"`,
      ].join('\n'),
      'utf-8',
    )
    await writeFile(
      join(workerDir, 'src/index.ts'),
      `export default {
         async fetch(req, env) {
           // Dynamically load a sub-worker using WorkerLoader
           const stub = env.LOADER.get('greeter', () => ({
             compatibilityDate: '2026-04-01',
             mainModule: 'greeter.js',
             modules: {
               'greeter.js': 'export default { async fetch() { return new Response("hello from dynamically loaded worker") } }'
             }
           }));
           const fetcher = stub.getEntrypoint();
           return fetcher.fetch(req);
         }
       }`,
      'utf-8',
    )

    const result = await runDeploy({
      workspace: 'e2edeploy',
      workingDirectory: workerDir,
      bootstrapState: state,
      acmeEmail: 'ops@example.com',
      log: () => {},
    })

    expect(result.dryRun).toBe(false)
    expect(result.tenants).toHaveLength(1)
    expect(result.tenants[0]!.name).toBe('loader-test')
    expect(result.healthCheck).toBeDefined()
    expect(result.healthCheck!.status).toBe(200)
  }, 180_000)
})
