/**
 * runDeploy — the top-level deploy function invoked by
 * `groundflare deploy` and by `groundflare up`'s deploy phase.
 *
 * Flow:
 *   1. Read wrangler.toml + [groundflare] via the config resolver.
 *   2. Bundle the Worker entry with esbuild.
 *   3. Convert wrangler config → workspace manifest (single tenant for v0.2).
 *   4. Render capnp + Caddyfile.
 *   5. Upload bundle + capnp + Caddyfile to the VPS (skipping in dryRun).
 *   6. systemctl daemon-reload + restart workerd + reload caddy.
 *   7. Probe /health via curl from the VPS's loopback.
 *
 * Tests inject a mock SshClient to avoid needing a live VPS.
 */

import { execSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { randomBytes } from 'node:crypto'

import { resolveConfig } from '../config/index.js'
import {
  generateCaddyfile,
  type CaddySite,
} from '../runtime/bootstrap/index.js'
import { buildBunArtifact } from '../runtime/bun/build.js'
import {
  buildCapnpFromWorkspace,
  detectUnsupportedBindings,
  workspaceWorkerFromConfig,
  type WorkspaceManifest,
} from '../runtime/workspace/index.js'
import { renderCapnpConfig } from '../runtime/workerd/capnp/index.js'
import { OpenSshClient, type SshClient } from '../ssh/index.js'

import { bundleWorker } from './bundle.js'
import { stageBunArtifact } from './bun-track.js'
import {
  DeployError,
  type DeployResult,
  type RunDeployOptions,
  type TenantDeployResult,
} from './types.js'

const CAPNP_REMOTE_PATH = '/var/lib/groundflare/worker.capnp'
const CADDYFILE_REMOTE_PATH = '/etc/caddy/Caddyfile'
const LISTEN_ADDRESS = '127.0.0.1:8080'
const HEALTH_TIMEOUT_MS = 30_000

export async function runDeploy(opts: RunDeployOptions): Promise<DeployResult> {
  const log = opts.log ?? ((level, m) => process.stderr.write(`[${level}] ${m}\n`))
  const cwd = opts.workingDirectory ?? process.cwd()

  // ─── 1. Read config ────────────────────────────────────────────
  let wranglerRead
  try {
    wranglerRead = await resolveConfig({ cwd })
  } catch (err) {
    throw new DeployError(
      `failed to read wrangler config from ${cwd}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      'config_missing',
      { cause: err },
    )
  }
  const { wrangler, groundflare, source } = wranglerRead
  log('info', `deploying from ${source.file}`)

  // ─── 2. Build + Bundle ─────────────────────────────────────────
  if (wrangler.main === undefined) {
    throw new DeployError(
      `wrangler config has no \`main\` entry; add \`main = "src/index.ts"\` and retry`,
      'config_missing',
    )
  }

  // If [build].command is set, run it first (like wrangler deploy does).
  // The build command produces output at the `main` path; esbuild then
  // re-bundles it into a single ES module. This handles frameworks like
  // Astro that produce multi-file output (dist/_worker.js/ with chunks/).
  const hasCustomBuild = wrangler.build?.command !== undefined && wrangler.build.command.length > 0

  if (hasCustomBuild) {
    const buildCmd = wrangler.build!.command!
    const buildCwd = wrangler.build!.cwd
      ? resolvePath(cwd, wrangler.build!.cwd)
      : cwd
    log('info', `running build command: ${buildCmd}`)
    try {
      execSync(buildCmd, {
        cwd: buildCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5 * 60_000,
        env: { ...process.env, WRANGLER_COMMAND: 'deploy' },
      })
    } catch (err) {
      const stderr = err instanceof Error && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr).slice(0, 2000)
        : ''
      throw new DeployError(
        `build command failed: ${buildCmd}\n${stderr}`,
        'bundle_failed',
        { cause: err },
      )
    }
    log('info', 'build complete; re-bundling output via esbuild')
  }

  const entry = resolvePath(cwd, wrangler.main)
  log('info', `bundling ${entry}`)
  const bundle = await bundleWorker({ entry })
  log('info', `bundle: ${bundle.bytes} bytes, ${bundle.warnings.length} warnings`)
  for (const w of bundle.warnings) log('warn', `esbuild: ${w}`)

  // ─── 2b. Unsupported binding warnings ──────────────────────────
  const unsupported = detectUnsupportedBindings(wrangler)
  for (const w of unsupported) log('warn', `unsupported: ${w}`)

  // ─── 3. Manifest ───────────────────────────────────────────────
  const worker = workspaceWorkerFromConfig(wrangler, groundflare)
  const manifest: WorkspaceManifest = {
    name: opts.workspace,
    workers: [worker],
    ...(groundflare.runtime !== undefined ? { runtime: groundflare.runtime } : {}),
  }
  const isBunTrack = manifest.runtime === 'bun'

  // ─── 4. Render ─────────────────────────────────────────────────
  //
  // Both tracks share the Caddy reverse-proxy config (same listen
  // address, same Host-based routing). The runtime-specific config is
  // either the workerd capnp or the Bun artifact — never both, so the
  // unused side stays 0 bytes in the DeployResult.
  let capnpText: string | null = null
  let bunArtifact: ReturnType<typeof buildBunArtifact> | null = null
  if (isBunTrack) {
    bunArtifact = buildBunArtifact(manifest, {
      listenAddress: LISTEN_ADDRESS,
    })
  } else {
    const capnpConfig = buildCapnpFromWorkspace(manifest, {
      listenAddress: LISTEN_ADDRESS,
      stateBaseDir: 'do-state',
    })
    capnpText = renderCapnpConfig(capnpConfig)
  }

  // Resolve assets directory for each worker (from wrangler [assets]).
  // On the VPS: /var/lib/groundflare/workers/<name>/assets/
  const hasAssets = wrangler.assets?.directory !== undefined
  const assetsLocalDir = hasAssets
    ? resolvePath(cwd, wrangler.assets!.directory!)
    : undefined

  const caddySites: CaddySite[] = manifest.workers
    .filter((w) => w.domain !== undefined)
    .map((w) => ({
      hostname: w.domain!,
      upstream: LISTEN_ADDRESS,
      ...(hasAssets
        ? { assetsPath: `/var/lib/groundflare/workers/${w.name}/assets` }
        : {}),
    }))
  const caddyfile = generateCaddyfile({
    email: opts.acmeEmail,
    sites: caddySites,
  })

  const tenants: TenantDeployResult[] = manifest.workers.map((w) => ({
    name: w.name,
    domain: w.domain,
    bundleBytes: bundle.bytes,
  }))

  if (opts.dryRun === true) {
    log('info', 'dry-run complete; no SSH operations performed')
    return {
      workspace: opts.workspace,
      runtime: isBunTrack ? 'bun' : 'workerd',
      tenants,
      capnpBytes: capnpText ? Buffer.byteLength(capnpText, 'utf-8') : 0,
      bunArtifactBytes: bunArtifact
        ? Buffer.byteLength(bunArtifact.serverSource, 'utf-8') +
          Object.values(bunArtifact.adapterSources).reduce(
            (n, s) => n + Buffer.byteLength(s, 'utf-8'),
            0,
          )
        : 0,
      caddyfileBytes: Buffer.byteLength(caddyfile, 'utf-8'),
      dryRun: true,
    }
  }

  // ─── 5. SSH + upload ───────────────────────────────────────────
  if (opts.bootstrapState.vps === undefined) {
    throw new DeployError(
      `workspace ${JSON.stringify(opts.workspace)} has no VPS state — run \`groundflare up\` first`,
      'not_bootstrapped',
    )
  }
  if (opts.bootstrapState.sshKey === undefined) {
    throw new DeployError(
      `workspace ${JSON.stringify(opts.workspace)} has no SSH key state — run \`groundflare up\` first`,
      'not_bootstrapped',
    )
  }

  const ssh: SshClient =
    opts.ssh ??
    new OpenSshClient({
      target: {
        host: opts.bootstrapState.vps.ipv4,
        user: opts.bootstrapState.vps.user,
        privateKeyPath: opts.bootstrapState.sshKey.localPath,
        ...(opts.bootstrapState.vps.port !== undefined
          ? { port: opts.bootstrapState.vps.port }
          : {}),
      },
    })

  let bunStage: Awaited<ReturnType<typeof stageBunArtifact>> | null = null
  if (isBunTrack && bunArtifact) {
    log('info', `uploading Bun artifact to ${opts.bootstrapState.vps.ipv4}`)
    bunStage = await stageBunArtifact({
      ssh,
      artifact: bunArtifact,
      userBundle: bundle.code,
      log,
    })
  } else if (capnpText !== null) {
    log('info', `uploading bundle + capnp to ${opts.bootstrapState.vps.ipv4}`)
    for (const w of manifest.workers) {
      const remotePath = `/var/lib/groundflare/workers/${w.name}/code/current/index.js`
      await ensureRemoteDir(ssh, `/var/lib/groundflare/workers/${w.name}/code/current`)
      await uploadAsUser(ssh, bundle.code, remotePath, 'groundflare', '0644')
    }
    await uploadAsUser(ssh, capnpText, CAPNP_REMOTE_PATH, 'groundflare', '0644')
  }
  await uploadAsRoot(ssh, caddyfile, CADDYFILE_REMOTE_PATH, '0644')

  // ─── 5b. Upload static assets ─────────────────────────────────
  if (hasAssets && assetsLocalDir !== undefined) {
    for (const w of manifest.workers) {
      const remoteAssetsDir = `/var/lib/groundflare/workers/${w.name}/assets`
      await ensureRemoteDir(ssh, remoteAssetsDir)
      log('info', `uploading static assets from ${assetsLocalDir} to ${remoteAssetsDir}`)
      await ssh.upload(assetsLocalDir, remoteAssetsDir, { recursive: true })
      // Ensure correct ownership
      const chown = await ssh.run(
        `sudo chown -R groundflare:groundflare ${remoteAssetsDir}`,
        { timeoutMs: 30_000 },
      )
      if (chown.exitCode !== 0) {
        log('warn', `chown on assets failed: ${chown.stderr}`)
      }
    }
  }

  // ─── 6. Restart services ───────────────────────────────────────
  log('info', 'restarting groundflare-worker + reloading caddy')
  const restart = await ssh.run(
    'sudo systemctl daemon-reload && ' +
      'sudo systemctl restart groundflare-worker.service && ' +
      'sudo systemctl reload caddy.service',
    { timeoutMs: 60_000 },
  )
  if (restart.exitCode !== 0) {
    throw new DeployError(
      `systemctl restart failed: ${restart.stderr || restart.stdout}`,
      'restart_failed',
    )
  }

  // ─── 7. Health probe ───────────────────────────────────────────
  // Probe via loopback on the VPS (bypasses Caddy/DNS). We pick the
  // first tenant's domain for the Host header — if no tenant has a
  // domain, we send a literal localhost which the router will 404 (still
  // a valid response, proving workerd is listening).
  const probeHost = tenants.find((t) => t.domain !== undefined)?.domain ?? 'localhost'
  log('info', `probing http://${LISTEN_ADDRESS}/ as Host: ${probeHost}`)
  const started = Date.now()
  const probe = await ssh.run(
    `curl -o /dev/null -s -w "%{http_code}" --max-time 10 -H "Host: ${probeHost}" http://${LISTEN_ADDRESS}/`,
    { timeoutMs: HEALTH_TIMEOUT_MS },
  )
  const probeDuration = Date.now() - started
  if (probe.exitCode !== 0) {
    throw new DeployError(
      `health probe failed: curl exited ${probe.exitCode}: ${probe.stderr}`,
      'health_failed',
    )
  }
  const status = Number.parseInt(probe.stdout.trim(), 10)
  if (Number.isNaN(status)) {
    throw new DeployError(
      `health probe returned unparsable status: ${JSON.stringify(probe.stdout)}`,
      'health_failed',
    )
  }
  if (status >= 500) {
    throw new DeployError(
      `health probe returned ${status} — workerd is running but erroring`,
      'health_failed',
    )
  }

  log('info', `health ok: ${status} in ${probeDuration}ms`)

  return {
    workspace: opts.workspace,
    runtime: isBunTrack ? 'bun' : 'workerd',
    tenants,
    capnpBytes: capnpText ? Buffer.byteLength(capnpText, 'utf-8') : 0,
    bunArtifactBytes: bunStage?.artifactBytes ?? 0,
    caddyfileBytes: Buffer.byteLength(caddyfile, 'utf-8'),
    healthCheck: { status, durationMs: probeDuration },
    dryRun: false,
  }
}

// ─── SSH helpers ───────────────────────────────────────────────────

async function uploadAsUser(
  ssh: SshClient,
  content: string,
  remoteFinalPath: string,
  owner: string,
  mode: string,
): Promise<void> {
  const tmpPath = `/tmp/groundflare-upload-${randomBytes(6).toString('hex')}`
  await uploadContent(ssh, content, tmpPath)
  const installResult = await ssh.run(
    `sudo install -m ${mode} -o ${owner} -g ${owner} ${tmpPath} ${remoteFinalPath} && rm -f ${tmpPath}`,
    { timeoutMs: 30_000 },
  )
  if (installResult.exitCode !== 0) {
    throw new DeployError(
      `failed to install ${remoteFinalPath}: ${installResult.stderr || installResult.stdout}`,
      'upload_failed',
    )
  }
}

async function uploadAsRoot(
  ssh: SshClient,
  content: string,
  remoteFinalPath: string,
  mode: string,
): Promise<void> {
  const tmpPath = `/tmp/groundflare-upload-${randomBytes(6).toString('hex')}`
  await uploadContent(ssh, content, tmpPath)
  const installResult = await ssh.run(
    `sudo install -m ${mode} -o root -g root ${tmpPath} ${remoteFinalPath} && rm -f ${tmpPath}`,
    { timeoutMs: 30_000 },
  )
  if (installResult.exitCode !== 0) {
    throw new DeployError(
      `failed to install ${remoteFinalPath}: ${installResult.stderr || installResult.stdout}`,
      'upload_failed',
    )
  }
}

async function uploadContent(ssh: SshClient, content: string, remotePath: string): Promise<void> {
  const localDir = await mkdtemp(join(tmpdir(), 'gf-upload-'))
  const localPath = join(localDir, 'payload')
  try {
    await writeFile(localPath, content, 'utf-8')
    await ssh.upload(localPath, remotePath)
  } catch (err) {
    throw new DeployError(
      `scp ${remotePath} failed: ${err instanceof Error ? err.message : String(err)}`,
      'upload_failed',
      { cause: err },
    )
  } finally {
    await rm(localDir, { recursive: true, force: true })
  }
}

async function ensureRemoteDir(ssh: SshClient, remoteDir: string): Promise<void> {
  const result = await ssh.run(
    `sudo mkdir -p ${remoteDir} && sudo chown groundflare:groundflare ${remoteDir}`,
    { timeoutMs: 10_000 },
  )
  if (result.exitCode !== 0) {
    throw new DeployError(
      `failed to create ${remoteDir}: ${result.stderr || result.stdout}`,
      'upload_failed',
    )
  }
}

// Unused import silencer — `readFile` is there for future config ingestion
// paths (e.g. reading a local static-assets manifest).
void readFile
