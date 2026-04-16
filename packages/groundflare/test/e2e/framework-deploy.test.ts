/**
 * Tier 3 Phase E: framework-shaped deploy end-to-end.
 *
 * Models the real projects groundflare needs to support (Astro, Next on
 * Workers, Remix + workerd, …) which differ from the tiny
 * `export default { fetch }` shape in three ways that have each broken
 * in production and been patched reactively:
 *
 *   1. `[build].command` runs a real tool that emits multi-file output
 *      under `dist/_worker.js/` (index + chunks). The deploy pipeline
 *      re-bundles that into a single ES module before uploading.
 *   2. The Worker imports from `node:*` builtins. esbuild must treat
 *      them as external so `nodejs_compat` at workerd runtime can
 *      resolve them.
 *   3. `[assets].directory` points at the framework's output root
 *      (e.g. `./dist`) which also contains `_worker.js/` — the Worker
 *      source itself. That subdirectory must NOT be uploaded to the
 *      public assets path, or Caddy's file_server would happily serve
 *      the entire Worker bundle as text.
 *
 * Each of those has an upstream fix commit attached
 * (2602d79 / 0f0c20b / 7cf988c / 6259be9). This test exercises all four
 * paths in a single round-trip so future regressions hit CI before they
 * hit a user.
 *
 * Probes go through SSH → workerd loopback (same machinery as the
 * `healthCheck` in runDeploy). Caddy's Host-routed HTTPS frontend is
 * not probed here — auto-HTTPS for a local `.local` hostname inside a
 * sealed container is too flaky to assert against cleanly, and the
 * Caddy generator's static-routing logic is already unit-covered in
 * `caddy.test.ts`.
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

describe.skipIf(!dockerAvailable)('e2e: framework-shaped deploy', () => {
  let tmp: string
  let provider: DockerTestProvider
  let state: BootstrapState

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-e2e-framework-'))
    provider = new DockerTestProvider()
    await provider.ensureImage()
    const secrets = new MemorySecretStore({ 'provider.hetzner.token': 'fake-token' })
    const stateStore = new BootstrapStateStore({ directory: join(tmp, 'state') })
    state = await runBootstrap({
      workspace: 'e2eframework',
      provider: 'hetzner',
      region: 'hel1',
      size: 'cx22',
      acmeEmail: 'ops@example.com',
      placeholderDomain: 'fw.local',
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

  it('deploys Astro-shaped output (multi-file _worker.js + node:* import + [assets])', async () => {
    const workerDir = join(tmp, 'framework-app')
    await mkdir(workerDir, { recursive: true })

    // build.sh — stands in for `astro build` / `next build` / etc.
    // Emits:
    //   dist/_worker.js/index.js       (main entry; imports a sibling chunk)
    //   dist/_worker.js/chunks/greet.js (the sibling — multi-file re-bundle)
    //   dist/style.css                 (static asset, next to _worker.js)
    //   dist/index.html                (static asset)
    //
    // The entry uses `node:crypto` with `compatibility_flags = ["nodejs_compat"]`.
    // esbuild must treat `node:*` as external; workerd resolves at runtime.
    await writeFile(
      join(workerDir, 'build.sh'),
      [
        '#!/bin/sh',
        'set -e',
        'rm -rf dist',
        'mkdir -p dist/_worker.js/chunks',
        '',
        'cat > dist/_worker.js/chunks/greet.js <<"EOF"',
        'export function greet(name) { return `hello, ${name}` }',
        'EOF',
        '',
        'cat > dist/_worker.js/index.js <<"EOF"',
        'import { createHash } from "node:crypto"',
        'import { greet } from "./chunks/greet.js"',
        'export default {',
        '  async fetch() {',
        '    const hash = createHash("sha256").update("groundflare").digest("hex").slice(0, 12)',
        '    return new Response(`${greet("framework")} sha=${hash}`, { status: 200 })',
        '  }',
        '}',
        'EOF',
        '',
        'echo "body { color: rebeccapurple; }" > dist/style.css',
        'echo "<!doctype html><title>fw</title>" > dist/index.html',
      ].join('\n'),
      'utf-8',
    )

    await writeFile(
      join(workerDir, 'wrangler.toml'),
      [
        `name = "framework-demo"`,
        `main = "dist/_worker.js/index.js"`,
        `compatibility_date = "2026-04-01"`,
        `compatibility_flags = ["nodejs_compat"]`,
        ``,
        `[build]`,
        `command = "sh build.sh"`,
        ``,
        `[assets]`,
        `directory = "./dist"`,
        ``,
        `[[routes]]`,
        `pattern = "fw.local"`,
        `custom_domain = true`,
      ].join('\n'),
      'utf-8',
    )

    // ─── Deploy ─────────────────────────────────────────────────
    const result = await runDeploy({
      workspace: 'e2eframework',
      workingDirectory: workerDir,
      bootstrapState: state,
      acmeEmail: 'ops@example.com',
      log: () => {},
    })

    expect(result.dryRun).toBe(false)
    expect(result.tenants).toHaveLength(1)
    expect(result.tenants[0]!.name).toBe('framework-demo')
    expect(result.tenants[0]!.domain).toBe('fw.local')
    // Health probe hits workerd via loopback. 200 here already proves
    // (a) esbuild didn't bomb on `node:crypto`, (b) multi-file
    // re-bundle succeeded, (c) workerd booted with the rendered capnp.
    expect(result.healthCheck).toBeDefined()
    expect(result.healthCheck!.status).toBe(200)

    // ─── Body probe ─────────────────────────────────────────────
    // Confirm the Worker actually ran node:crypto (not just booted),
    // and the imported chunk resolved. Probe inside the container so
    // we bypass Caddy's auto-HTTPS quirks for local hostnames.
    const container = provider.getContainer(state.vps!.id)
    expect(container).toBeDefined()
    const body = await container!.exec(
      `curl -s --max-time 5 -H "Host: fw.local" http://127.0.0.1:8080/`,
    )
    expect(body.exitCode).toBe(0)
    // `greet("framework")` from the sibling chunk
    expect(body.stdout).toContain('hello, framework')
    // `createHash('sha256')...slice(0, 12)` — stable for input "groundflare".
    // If node:crypto wasn't resolved at runtime this assertion would
    // either return "sha=undefined" or 500 before we got here.
    expect(body.stdout).toMatch(/sha=[0-9a-f]{12}/)

    // ─── Assets filter probe ────────────────────────────────────
    // `[assets].directory = "./dist"` but dist contains both the
    // Worker source tree (dist/_worker.js/) AND the public statics
    // (dist/style.css, dist/index.html). The deploy pipeline must
    // upload the statics while filtering out _worker.js — otherwise
    // Caddy's file_server would serve the Worker source as text.
    const remoteAssets = `/var/lib/groundflare/workers/framework-demo/assets`
    const lsAssets = await container!.exec(`ls ${remoteAssets}`)
    expect(lsAssets.exitCode).toBe(0)
    expect(lsAssets.stdout).toContain('style.css')
    expect(lsAssets.stdout).toContain('index.html')
    expect(lsAssets.stdout).not.toContain('_worker.js')

    // Double-check: the _worker.js directory must not exist at all
    // under the assets tree (a previous regression was to upload
    // then `rm -rf` it — fine for the final state but racy during
    // the window, and leaky if the rm silently failed).
    const lsWorkerJs = await container!.exec(
      `test -d ${remoteAssets}/_worker.js && echo LEAK || echo clean`,
    )
    expect(lsWorkerJs.stdout.trim()).toBe('clean')
  }, 240_000)
})
