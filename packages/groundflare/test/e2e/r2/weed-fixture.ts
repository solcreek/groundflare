/**
 * SeaweedFS test fixture.
 *
 * Downloads the SeaweedFS binary for the current platform on first
 * invocation, caches it under .cache/weed-<version>/, and exposes
 * `startWeed` / `stopWeed` for tests. This avoids requiring weed in
 * developer PATH while keeping CI runs deterministic (same version
 * everywhere).
 *
 * The binary is ~30 MB compressed; once cached, startup is just a
 * spawn + readiness probe (~3 s). Cache lives in repo .cache/ so
 * `git clean -fdx` clears it but normal CI / dev runs hit it.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { pickFreePort } from '../../integration/spawn-workerd.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../../..')
const CACHE_DIR = join(REPO_ROOT, '.cache')

/**
 * Pinned weed version. Bumping is a deliberate decision (the L3 suite
 * is what catches version-related S3 wire regressions).
 */
const WEED_VERSION = '4.20'

/** Mapping from process.platform/arch → release asset filename. */
const ASSET_TABLE: Record<string, string> = {
  'darwin-arm64': 'darwin_arm64.tar.gz',
  'darwin-x64': 'darwin_amd64.tar.gz',
  'linux-arm64': 'linux_arm64.tar.gz',
  'linux-x64': 'linux_amd64.tar.gz',
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the path to the weed binary for the current platform,
 * downloading + extracting it once and caching for subsequent runs.
 */
export async function resolveWeedBinary(): Promise<string> {
  const key = platformKey()
  const asset = ASSET_TABLE[key]
  if (!asset) {
    throw new Error(
      `SeaweedFS test fixture: no release asset mapping for ${key}. ` +
        `Add it to ASSET_TABLE in test/e2e/r2/weed-fixture.ts.`,
    )
  }

  const versionDir = join(CACHE_DIR, `weed-${WEED_VERSION}-${key}`)
  const binPath = join(versionDir, 'weed')
  if (await exists(binPath)) return binPath

  await mkdir(versionDir, { recursive: true })
  const url = `https://github.com/seaweedfs/seaweedfs/releases/download/${WEED_VERSION}/${asset}`
  const tarballPath = join(versionDir, asset)

  await downloadFile(url, tarballPath)
  await extractTarball(tarballPath, versionDir)
  await chmod(binPath, 0o755)

  if (!(await exists(binPath))) {
    throw new Error(
      `SeaweedFS extract failed: ${binPath} missing after extracting ${tarballPath}`,
    )
  }
  return binPath
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || res.body === null) {
    throw new Error(`Download failed (${res.status}) for ${url}`)
  }
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    createWriteStream(destPath),
  )
}

async function extractTarball(tarballPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolveFn, rejectFn) => {
    const proc = spawn('tar', ['xzf', tarballPath, '-C', destDir], { stdio: 'pipe' })
    proc.on('error', rejectFn)
    proc.on('exit', (code) => {
      if (code === 0) resolveFn()
      else rejectFn(new Error(`tar exited with code ${code}`))
    })
  })
}

// ─── lifecycle ─────────────────────────────────────────────────────

export interface StartedWeed {
  /** Port serving the S3 API (e.g. http://127.0.0.1:<port>). */
  readonly s3Port: number
  /** Endpoint URL for use in adapter config. */
  readonly endpoint: string
  /** On-disk data directory (for assertions about persistence). */
  readonly dataDir: string
  stop(): Promise<void>
}

export interface StartWeedOptions {
  /** Pre-create these bucket names before returning. */
  readonly buckets?: readonly string[]
  /** Override the data directory (default: tmpdir mkdtemp). */
  readonly dataDir?: string
}

export async function startWeed(opts: StartWeedOptions = {}): Promise<StartedWeed> {
  const bin = await resolveWeedBinary()
  const dataDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), 'gf-weed-')))
  // weed defaults each service's grpc port to <http port>+10000, which
  // overflows when the OS hands us an ephemeral above 55535. We pick
  // free ports for BOTH the HTTP and grpc sides explicitly to break
  // that derivation.
  const s3Port = await pickFreePort()
  const s3GrpcPort = await pickFreePort()
  const masterPort = await pickFreePort()
  const masterGrpcPort = await pickFreePort()
  const volumePort = await pickFreePort()
  const volumeGrpcPort = await pickFreePort()
  const filerPort = await pickFreePort()
  const filerGrpcPort = await pickFreePort()
  const args = [
    'server',
    `-dir=${dataDir}`,
    '-s3',
    `-s3.port=${s3Port}`,
    `-s3.port.grpc=${s3GrpcPort}`,
    '-ip=127.0.0.1',
    `-master.port=${masterPort}`,
    `-master.port.grpc=${masterGrpcPort}`,
    `-volume.port=${volumePort}`,
    `-volume.port.grpc=${volumeGrpcPort}`,
    `-filer.port=${filerPort}`,
    `-filer.port.grpc=${filerGrpcPort}`,
  ]

  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const stderr: string[] = []
  proc.stderr?.on('data', (c: Buffer) => stderr.push(c.toString()))

  let exited = false
  proc.on('exit', () => {
    exited = true
  })

  const endpoint = `http://127.0.0.1:${s3Port}`

  // Probe until S3 endpoint responds (or proc dies).
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `weed exited early. stderr (last 2KB):\n${stderr.join('').slice(-2000)}`,
      )
    }
    try {
      const r = await fetch(endpoint + '/', { signal: AbortSignal.timeout(500) })
      // Listing buckets succeeds with HTTP 200 even on empty cluster.
      if (r.ok || r.status === 404) break
    } catch {
      // not ready
    }
    await sleep(200)
  }

  // Pre-create requested buckets.
  for (const bucket of opts.buckets ?? []) {
    const r = await fetch(`${endpoint}/${bucket}`, { method: 'PUT' })
    if (!r.ok && r.status !== 409) {
      throw new Error(`weed: failed to pre-create bucket "${bucket}" (${r.status})`)
    }
  }

  return {
    s3Port,
    endpoint,
    dataDir,
    async stop() {
      if (!exited) {
        proc.kill('SIGTERM')
        await Promise.race([
          new Promise<void>((r) => proc.once('exit', () => r())),
          sleep(3_000).then(() => {
            proc.kill('SIGKILL')
          }),
        ])
      }
      // Clean up the temp data dir if WE created it.
      if (opts.dataDir === undefined) {
        await rm(dataDir, { recursive: true, force: true })
      }
    },
  }
}

/**
 * Hash an object key for verification — used in tests that check the
 * deterministic blob layout on disk.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const h = createHash('sha256')
  h.update(input)
  return h.digest('hex')
}

