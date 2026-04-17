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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
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
import type { SecretStore } from '../secret/index.js'

import { bundleWorker } from './bundle.js'
import { detectBuildCommand } from './detect-pm.js'
import { resolveBuiltEntry } from './detect-built-entry.js'
import { planBunStaging } from './bun-track.js'
import {
  atomicInstall,
  type AtomicInstallFile,
} from './stage.js'
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
  // systemd EnvironmentFile content. Populated when any R2 binding has
  // credentials the runtime needs to read from env at boot — today that
  // means the Bun track with an external S3 endpoint (CF R2 / B2 /
  // Wasabi / …). Stays null when every binding uses the local
  // SeaweedFS sidecar in anonymous mode, so unchanged deploys don't
  // clobber operator-added env vars.
  let runtimeEnvFile: string | null = null
  if (isBunTrack) {
    // Bun track: shim reads credentials from process.env at runtime.
    // Walk every R2 binding; resolve *_secret references from the
    // secret store; render the KEY=VALUE pairs systemd loads via
    // EnvironmentFile. Skipped entirely when there's nothing to write.
    const hasR2 = manifest.workers.some((w) => (w.r2Buckets?.length ?? 0) > 0)
    if (hasR2) {
      await resolveR2Secrets(manifest, opts.secretStore)
      runtimeEnvFile = renderBunRuntimeEnvFile(manifest)
    }
    bunArtifact = buildBunArtifact(manifest, {
      listenAddress: LISTEN_ADDRESS,
    })
  } else {
    // R2 bindings need (a) the bundled adapter Worker source and (b)
    // resolved SigV4 credentials. Both are deferred until we know the
    // workspace actually uses R2 — bundle is ~200 ms, credential read
    // is async.
    const hasR2 = manifest.workers.some((w) => (w.r2Buckets?.length ?? 0) > 0)
    let r2AdapterSource: string | undefined
    if (hasR2) {
      const { bundleR2Adapter } = await import('../runtime/workerd/r2/bundle.js')
      r2AdapterSource = (await bundleR2Adapter()).code
      await resolveR2Secrets(manifest, opts.secretStore)
    }
    const capnpConfig = buildCapnpFromWorkspace(manifest, {
      listenAddress: LISTEN_ADDRESS,
      stateBaseDir: 'do-state',
      ...(r2AdapterSource !== undefined ? { r2AdapterSource } : {}),
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
    .map((w) => {
      // R2 buckets with a public_path + no external endpoint get a
      // Caddy handle_path block forwarding to the local SeaweedFS
      // sidecar. External endpoints skip Caddy — the app's own code is
      // responsible for serving / signing public URLs against them.
      const r2PublicRoutes = (w.r2Buckets ?? [])
        .filter((r2) => r2.publicPath !== undefined && r2.endpoint === undefined)
        .map((r2) => ({
          path: r2.publicPath!,
          bucketName: r2.bucketName ?? r2.binding.toLowerCase(),
        }))
      return {
        hostname: w.domain!,
        upstream: LISTEN_ADDRESS,
        ...(hasAssets
          ? { assetsPath: `/var/lib/groundflare/workers/${w.name}/assets` }
          : {}),
        ...(r2PublicRoutes.length > 0 ? { r2PublicRoutes } : {}),
      }
    })
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

  // Both tracks: stage every destination under /tmp first, then install
  // them all in ONE sudo transaction. If staging fails, no destination
  // is touched. If the transaction fails, `set -e` aborts on the first
  // install error — at worst we leak half an install, but the common
  // flaky-scp failure mode (a mid-sequence upload failing after an
  // earlier one had already landed new content) is eliminated.
  let bunStage: { artifactBytes: number; userBundleBytes: number; unitBytes: number } | null = null
  if (isBunTrack && bunArtifact) {
    log('info', `installing Bun artifact + Caddyfile atomically on ${opts.bootstrapState.vps.ipv4}`)
    const bunPlan = planBunStaging({
      artifact: bunArtifact,
      userBundle: bundle.code,
    })
    bunStage = {
      artifactBytes: bunPlan.artifactBytes,
      userBundleBytes: bunPlan.userBundleBytes,
      unitBytes: bunPlan.unitBytes,
    }
    const files: AtomicInstallFile[] = [
      ...bunPlan.files,
      {
        content: caddyfile,
        remotePath: CADDYFILE_REMOTE_PATH,
        owner: 'root' as const,
        mode: '0644',
      },
    ]
    if (runtimeEnvFile !== null) {
      // root:root 0600 — the secrets inside (SigV4 keys) shouldn't be
      // readable by the local `groundflare` service user. systemd loads
      // the file as root before dropping privileges, so the Bun process
      // still receives them as process.env.
      files.push({
        content: runtimeEnvFile,
        remotePath: '/etc/groundflare/environment',
        owner: 'root' as const,
        mode: '0600',
      })
    }
    await atomicInstall(ssh, {
      files,
      groundflareOwnedDirs: bunPlan.groundflareOwnedDirs,
    })
  } else if (capnpText !== null) {
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
    // groundflareOwnedDirs are mkdir'd + chowned inside the same atomic
    // install script. Per-binding state dirs (D1 sqlite roots, KV stores)
    // must exist before workerd starts — its localDisk services refuse
    // to load when the path is missing — so list them here too. mkdir -p
    // is idempotent; the dirs persist across deploys.
    const groundflareOwnedDirs: string[] = []
    for (const w of manifest.workers) {
      // The worker dir itself must be groundflare-owned so the assets
      // scp below (running as the groundflare user) can create / replace
      // the `assets/` subdirectory without sudo.
      groundflareOwnedDirs.push(`/var/lib/groundflare/workers/${w.name}`)
      groundflareOwnedDirs.push(`/var/lib/groundflare/workers/${w.name}/code/current`)
      for (const d1 of w.d1Databases ?? []) {
        groundflareOwnedDirs.push(
          `/var/lib/groundflare/do-state/${w.name}/d1/${d1.databaseName}`,
        )
      }
      for (const kv of w.kvNamespaces ?? []) {
        groundflareOwnedDirs.push(
          `/var/lib/groundflare/do-state/${w.name}/kv/${kv.binding}`,
        )
      }
    }
    await atomicInstall(ssh, { files: filesToInstall, groundflareOwnedDirs })
  }

  // ─── 5b. Upload static assets ─────────────────────────────────
  // Exclude _worker.js/ from the assets directory — the Worker bundle
  // was already uploaded via the capnp pipeline. Exposing it via Caddy's
  // file_server would leak Worker source code.
  //
  // Path layout: Caddy's `root * <workerDir>/assets` expects files at
  // `<workerDir>/assets/<file>`. scp recursive into an already-existing
  // dir nests the source AS a child of dest (`<workerDir>/assets/assets/
  // <file>`), so we must upload to the parent workerDir — not to an
  // ensured-empty assets dir — and let scp create `assets/` at the right
  // level. We also `rm -rf` any prior assets directory first, both to
  // avoid double-nesting on redeploys and to drop stale files that a
  // prior deploy shipped but the current build no longer emits.
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
      const workerDir = `/var/lib/groundflare/workers/${w.name}`
      log('info', `uploading static assets to ${workerDir}/assets`)
      const clear = await ssh.run(
        `rm -rf ${workerDir}/assets`,
        { timeoutMs: 30_000 },
      )
      if (clear.exitCode !== 0) {
        log('warn', `could not clear ${workerDir}/assets: ${clear.stderr}`)
      }
      await ssh.upload(assetsStagingDir, workerDir, { recursive: true })
    }
    await rm(assetsStagingDir, { recursive: true, force: true }).catch(() => {})
  }

  // ─── 5c. Pre-create R2 buckets in SeaweedFS ────────────────────
  // weed's anonymous mode does NOT auto-create buckets on first PUT;
  // it returns AccessDenied/NoSuchBucket. Idempotent PUT to the bucket
  // path creates it (HTTP 200 first time, ~409 thereafter — both fine).
  //
  // Both tracks go through the same sidecar by default. Bun bindings
  // that opt in to a remote endpoint (groundflare.endpoint set) skip
  // this step — there's nothing for us to bootstrap on external S3.
  {
    const r2BucketsToCreate = new Set<string>()
    for (const w of manifest.workers) {
      for (const r2 of w.r2Buckets ?? []) {
        if (r2.endpoint !== undefined) continue
        r2BucketsToCreate.add(r2.bucketName ?? r2.binding.toLowerCase())
      }
    }
    for (const bucket of r2BucketsToCreate) {
      const create = await ssh.run(
        `curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 -X PUT http://127.0.0.1:8333/${encodeURIComponent(bucket)} || true`,
        { timeoutMs: 15_000 },
      )
      log('info', `R2 bucket ${JSON.stringify(bucket)} ensured (HTTP ${create.stdout.trim()})`)
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

// Unused import silencer — `readFile` is there for future config ingestion
// paths (e.g. reading a local static-assets manifest).
void readFile

/**
 * Walk every R2 binding and swap secret *names* (parsed by from-config
 * from `access_key_id_secret` / `secret_access_key_secret`) for the
 * actual credential values. Mutates the manifest in place — buildCapnp
 * runs right after and reads the resolved values.
 *
 * Default secret source is FileSecretStore at the standard XDG path;
 * tests inject MemorySecretStore.
 */
async function resolveR2Secrets(
  manifest: WorkspaceManifest,
  injected: SecretStore | undefined,
): Promise<void> {
  let store = injected
  if (store === undefined) {
    const { FileSecretStore } = await import('../secret/index.js')
    store = new FileSecretStore()
  }
  for (const w of manifest.workers) {
    for (const r2 of w.r2Buckets ?? []) {
      const mut = r2 as { accessKeyId?: string; secretAccessKey?: string }
      if (mut.accessKeyId !== undefined) {
        mut.accessKeyId = await fetchSecret(store, mut.accessKeyId, r2.binding)
      }
      if (mut.secretAccessKey !== undefined) {
        mut.secretAccessKey = await fetchSecret(store, mut.secretAccessKey, r2.binding)
      }
    }
  }
}

/**
 * Render the systemd EnvironmentFile content for a Bun-track deploy.
 * Emits one `KEY=VALUE` line per R2 binding field that the runtime
 * adapter reads. Returns null when nothing is worth writing — keeps
 * unchanged deploys from clobbering operator-added env vars.
 *
 * Bindings with no external endpoint (default local SeaweedFS) are
 * skipped here: the adapter's own default (127.0.0.1:8333 + anonymous)
 * kicks in when these env vars are absent, so there's nothing to pin.
 */
function renderBunRuntimeEnvFile(manifest: WorkspaceManifest): string | null {
  const lines: string[] = []
  for (const w of manifest.workers) {
    for (const r2 of w.r2Buckets ?? []) {
      if (r2.endpoint === undefined) continue
      const prefix = `R2_${r2.binding.toUpperCase()}_`
      lines.push(`${prefix}ENDPOINT=${quoteEnvValue(r2.endpoint)}`)
      if (r2.region !== undefined) {
        lines.push(`${prefix}REGION=${quoteEnvValue(r2.region)}`)
      }
      if (r2.accessKeyId !== undefined) {
        lines.push(`${prefix}ACCESS_KEY_ID=${quoteEnvValue(r2.accessKeyId)}`)
      }
      if (r2.secretAccessKey !== undefined) {
        lines.push(
          `${prefix}SECRET_ACCESS_KEY=${quoteEnvValue(r2.secretAccessKey)}`,
        )
      }
    }
  }
  if (lines.length === 0) return null
  return (
    '# GENERATED by groundflare — regenerated on every deploy.\n' +
    '# Local edits will be overwritten. Use `groundflare secret set` +\n' +
    '# a `groundflare` block in wrangler.toml to manage credentials.\n' +
    lines.join('\n') +
    '\n'
  )
}

/**
 * systemd's EnvironmentFile parser accepts `KEY=value` with minimal
 * quoting. Plain alphanumerics + common separators go through bare;
 * anything with a space / quote / hash needs double-quoting with
 * backslash escapes. Values have no shell expansion.
 */
function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9._:/@+=-]*$/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function fetchSecret(
  store: SecretStore,
  name: string,
  bindingForError: string,
): Promise<string> {
  const v = await store.get(name)
  if (v === null || v.length === 0) {
    throw new DeployError(
      `r2_buckets[${bindingForError}]: secret ${JSON.stringify(name)} not found. ` +
        `Run \`groundflare secret set ${name} <value>\`.`,
      'config_missing',
    )
  }
  return v
}
