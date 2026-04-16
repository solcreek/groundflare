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
import { setTimeout as sleep } from 'node:timers/promises'

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
import type { LogFn } from '../bootstrap/index.js'

import { bundleWorker } from './bundle.js'
import { detectBuildCommand } from './detect-pm.js'
import { resolveBuiltEntry } from './detect-built-entry.js'
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
const HEALTH_DEFAULT_MAX_ATTEMPTS = 6
const HEALTH_DEFAULT_INTERVAL_MS = 1_500
const HEALTH_CURL_MAX_TIME_S = 5

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

  // Resolve the build command: explicit [build].command takes precedence;
  // if absent AND `main` points to a path that doesn't exist yet (i.e.
  // a build output), auto-detect the package manager and generate one.
  let buildCmd = wrangler.build?.command
  if (buildCmd === undefined || buildCmd.length === 0) {
    const entryExists = await import('node:fs').then(
      (fs) => fs.existsSync(resolvePath(cwd, wrangler.main!)),
    )
    if (!entryExists) {
      const detected = detectBuildCommand(cwd)
      if (detected?.hasBuildScript) {
        buildCmd = detected.command
        log('info', `auto-detected ${detected.pm} project with build script`)
      }
    }
  }

  if (buildCmd !== undefined && buildCmd.length > 0) {
    const buildCwd = wrangler.build?.cwd
      ? resolvePath(cwd, wrangler.build.cwd)
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

  // After build, the actual deployable entry may live elsewhere than the
  // configured `main`. Astro keeps `main = "./src/worker.ts"` (source) so
  // its build pre-flight passes; the real built file lands at
  // `dist/server/entry.mjs` etc. Detect this and use the built entry.
  const resolved = resolveBuiltEntry({ cwd, main: wrangler.main })
  if (resolved.source === 'framework-detected') {
    log(
      'info',
      `detected ${resolved.framework} output: ${resolved.path}`,
    )
  }
  log('info', `bundling ${resolved.path}`)
  const bundle = await bundleWorker({ entry: resolved.path })
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
    // Bun track: Caddyfile is installed separately here. Atomicity
    // across the Bun artifact + Caddyfile is not yet enforced — the
    // risk window is smaller because bun-track.ts already reaches a
    // single systemd unit that's idempotent across content swaps.
    await uploadAsRoot(ssh, caddyfile, CADDYFILE_REMOTE_PATH, '0644')
  } else if (capnpText !== null) {
    // Workerd track: stage every destination under /tmp first, then
    // install them all in ONE sudo transaction. If staging fails, no
    // destination is touched. If the transaction fails, `set -e`
    // aborts on the first install error — at worst we leak half an
    // install just like the pre-atomic behavior, but the common
    // flaky-scp failure mode (where a mid-sequence upload fails after
    // an earlier one had already landed new content) is eliminated.
    log('info', `installing bundle + capnp + Caddyfile atomically on ${opts.bootstrapState.vps.ipv4}`)
    const filesToInstall: AtomicInstallFile[] = [
      ...manifest.workers.map((w) => ({
        content: bundle.code,
        remotePath: `/var/lib/groundflare/workers/${w.name}/code/current/index.js`,
        owner: 'groundflare' as const,
        mode: '0644',
      })),
      {
        content: capnpText,
        remotePath: CAPNP_REMOTE_PATH,
        owner: 'groundflare' as const,
        mode: '0644',
      },
      {
        content: caddyfile,
        remotePath: CADDYFILE_REMOTE_PATH,
        owner: 'root' as const,
        mode: '0644',
      },
    ]
    const groundflareOwnedDirs = manifest.workers.map(
      (w) => `/var/lib/groundflare/workers/${w.name}/code/current`,
    )
    await atomicInstall(ssh, { files: filesToInstall, groundflareOwnedDirs })
  }

  // ─── 5b. Upload static assets ─────────────────────────────────
  // Exclude _worker.js/ from the assets directory — the Worker bundle
  // was already uploaded via the capnp pipeline. Exposing it via Caddy's
  // file_server would leak Worker source code.
  if (hasAssets && assetsLocalDir !== undefined) {
    const { cpSync } = await import('node:fs')
    const assetsStagingDir = join(
      await mkdtemp(join(tmpdir(), 'gf-assets-')),
      'assets',
    )
    cpSync(assetsLocalDir, assetsStagingDir, {
      recursive: true,
      filter: (src) => !src.includes('_worker.js'),
    })

    for (const w of manifest.workers) {
      const remoteAssetsDir = `/var/lib/groundflare/workers/${w.name}/assets`
      await ensureRemoteDir(ssh, remoteAssetsDir)
      log('info', `uploading static assets to ${remoteAssetsDir}`)
      await ssh.upload(assetsStagingDir, remoteAssetsDir, { recursive: true })
      const chown = await ssh.run(
        `sudo chown -R groundflare:groundflare ${remoteAssetsDir}`,
        { timeoutMs: 30_000 },
      )
      if (chown.exitCode !== 0) {
        log('warn', `chown on assets failed: ${chown.stderr}`)
      }
    }
    await rm(assetsStagingDir, { recursive: true, force: true }).catch(() => {})
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
  const { status, durationMs: probeDuration, attempts } = await probeHealth({
    ssh,
    listenAddress: LISTEN_ADDRESS,
    probeHost,
    log,
    maxAttempts: opts.healthProbe?.maxAttempts ?? HEALTH_DEFAULT_MAX_ATTEMPTS,
    intervalMs: opts.healthProbe?.intervalMs ?? HEALTH_DEFAULT_INTERVAL_MS,
    sleep: opts.healthProbe?.sleep ?? ((ms) => sleep(ms)),
  })

  log('info', `health ok: ${status} in ${probeDuration}ms (${attempts} attempt${attempts === 1 ? '' : 's'})`)

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

// ─── Health probe ──────────────────────────────────────────────────
//
// workerd cold-starts in 10–15s after `systemctl restart`. A single
// probe immediately after restart races that window and often sees
// ECONNREFUSED (curl exit 7) or a 502 from Caddy. We poll up to
// `maxAttempts` times with `intervalMs` between attempts, treating both
// curl-level failures and HTTP 5xx as retryable. We stop on the first
// non-5xx response (200/302/404/etc — all prove workerd is listening).

interface ProbeHealthOptions {
  readonly ssh: SshClient
  readonly listenAddress: string
  readonly probeHost: string
  readonly log: LogFn
  readonly maxAttempts: number
  readonly intervalMs: number
  readonly sleep: (ms: number) => Promise<void>
}

async function probeHealth(
  opts: ProbeHealthOptions,
): Promise<{ status: number; durationMs: number; attempts: number }> {
  const { ssh, listenAddress, probeHost, log, maxAttempts, intervalMs } = opts
  const started = Date.now()
  const command =
    `curl -o /dev/null -s -w "%{http_code}" --max-time ${HEALTH_CURL_MAX_TIME_S} ` +
    `-H "Host: ${probeHost}" http://${listenAddress}/`

  log('info', `probing http://${listenAddress}/ as Host: ${probeHost} (up to ${maxAttempts} attempts)`)

  let lastExitCode = 0
  let lastStderr = ''
  let lastStdout = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const probe = await ssh.run(command, { timeoutMs: HEALTH_TIMEOUT_MS })
    lastExitCode = probe.exitCode
    lastStderr = probe.stderr
    lastStdout = probe.stdout

    if (probe.exitCode === 0) {
      const status = Number.parseInt(probe.stdout.trim(), 10)
      if (!Number.isNaN(status) && status < 500) {
        return { status, durationMs: Date.now() - started, attempts: attempt }
      }
    }

    if (attempt < maxAttempts) {
      const detail = probe.exitCode !== 0
        ? `curl exit ${probe.exitCode}`
        : `status ${probe.stdout.trim() || '?'}`
      log('info', `health probe attempt ${attempt}/${maxAttempts} not ready (${detail}); retrying in ${intervalMs}ms`)
      await opts.sleep(intervalMs)
    }
  }

  const durationMs = Date.now() - started
  if (lastExitCode !== 0) {
    throw new DeployError(
      `health probe failed after ${maxAttempts} attempts (${durationMs}ms): curl exited ${lastExitCode}: ${lastStderr}`,
      'health_failed',
    )
  }
  const status = Number.parseInt(lastStdout.trim(), 10)
  if (Number.isNaN(status)) {
    throw new DeployError(
      `health probe returned unparsable status after ${maxAttempts} attempts: ${JSON.stringify(lastStdout)}`,
      'health_failed',
    )
  }
  throw new DeployError(
    `health probe returned ${status} after ${maxAttempts} attempts — workerd is running but erroring`,
    'health_failed',
  )
}

// ─── Atomic multi-file install ────────────────────────────────────
//
// Given a list of {content, remotePath, owner, mode}, stages every file
// under /tmp first (destinations untouched on any scp failure), then
// runs ONE `sudo sh -s` script fed via stdin that:
//   1. mkdir+chown any groundflare-owned parent dirs
//   2. `install` each staged file into its final location
//   3. rm the /tmp staging files
//
// `set -e` aborts on the first install failure. Feeding the script via
// stdin sidesteps shell-quoting of the script body; the embedded paths
// still inherit the existing assumption that worker names are safe
// identifiers (Cloudflare only allows `[a-z0-9][a-z0-9-]*`, wrangler
// enforces this upstream).

interface AtomicInstallFile {
  readonly content: string
  readonly remotePath: string
  readonly owner: 'root' | 'groundflare'
  readonly mode: string
}

interface AtomicInstallOptions {
  readonly files: readonly AtomicInstallFile[]
  /** Dirs to mkdir + chown groundflare:groundflare before installing. */
  readonly groundflareOwnedDirs: readonly string[]
}

async function atomicInstall(
  ssh: SshClient,
  opts: AtomicInstallOptions,
): Promise<void> {
  const runId = randomBytes(6).toString('hex')
  const stagedPaths = opts.files.map((_, i) => `/tmp/gf-stage-${runId}-${i}`)

  try {
    for (let i = 0; i < opts.files.length; i++) {
      await uploadContent(ssh, opts.files[i]!.content, stagedPaths[i]!)
    }

    const lines: string[] = ['set -e']
    for (const dir of opts.groundflareOwnedDirs) {
      lines.push(`mkdir -p ${dir}`)
      lines.push(`chown groundflare:groundflare ${dir}`)
    }
    opts.files.forEach((f, i) => {
      lines.push(
        `install -m ${f.mode} -o ${f.owner} -g ${f.owner} ${stagedPaths[i]} ${f.remotePath}`,
      )
    })
    lines.push(`rm -f ${stagedPaths.join(' ')}`)
    const script = lines.join('\n') + '\n'

    const result = await ssh.run('sudo sh -s', {
      stdin: script,
      timeoutMs: 60_000,
    })
    if (result.exitCode !== 0) {
      throw new DeployError(
        `atomic install failed: ${result.stderr || result.stdout}`,
        'upload_failed',
      )
    }
  } catch (err) {
    // Best-effort cleanup of the staging area so repeated deploys
    // don't accumulate /tmp junk. Failures here are ignored.
    await ssh
      .run(`rm -f ${stagedPaths.join(' ')}`, { timeoutMs: 10_000 })
      .catch(() => {})
    throw err
  }
}

// ─── SSH helpers ───────────────────────────────────────────────────

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
    { timeoutMs: 30_000 },
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
