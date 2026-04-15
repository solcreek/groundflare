/**
 * Tier 3 e2e helper: build + control a fake-vps Docker container.
 *
 * Uses the `docker` CLI directly via child_process rather than adding a
 * dockerode dependency. Scope is intentionally small — just what our
 * bootstrap + deploy tests need:
 *
 *   - buildFakeVPSImage()  — build once per test run (cached by Docker)
 *   - startFakeVPS()       — run the image, inject SSH pubkey, wait for sshd
 *   - the returned StartedVPS knows its host+port and how to stop itself
 *
 * Privileged mode is required so systemd inside the container can
 * manage cgroups/dbus. This is a test-only concession, not a pattern
 * we'd use in production.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCKERFILE_DIR = resolve(HERE, '..', 'fixtures', 'fake-vps')

export const DEFAULT_IMAGE_TAG = 'groundflare/fake-vps:test'

export interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

async function runDocker(
  args: readonly string[],
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')))
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`docker ${args.join(' ')} timed out after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      : null
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ stdout, stderr, exitCode: code ?? -1 })
    })
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin)
    }
    child.stdin.end()
  })
}

/** Throws a helpful error if the Docker daemon isn't reachable. */
export async function ensureDockerAvailable(): Promise<void> {
  const result = await runDocker(['info', '--format', '{{.ServerVersion}}'], {
    timeoutMs: 5_000,
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `docker daemon is not reachable. Is Docker Desktop running?\n${result.stderr.trim()}`,
    )
  }
}

/**
 * Build the fake-vps image. Idempotent; relies on Docker's layer cache
 * so repeated calls are fast.
 */
export async function buildFakeVPSImage(tag: string = DEFAULT_IMAGE_TAG): Promise<void> {
  const result = await runDocker(
    ['build', '-t', tag, '-f', resolve(DOCKERFILE_DIR, 'Dockerfile'), DOCKERFILE_DIR],
    { timeoutMs: 300_000 },
  )
  if (result.exitCode !== 0) {
    throw new Error(`docker build failed (exit ${result.exitCode}):\n${result.stderr}`)
  }
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        server.close()
        reject(new Error('failed to allocate port'))
        return
      }
      const { port } = addr
      server.close(() => resolvePromise(port))
    })
  })
}

export interface StartFakeVPSOptions {
  /** OpenSSH-format public key to drop into /home/groundflare/.ssh/authorized_keys. */
  readonly publicKey: string
  /** Image tag to run. Defaults to the one built by buildFakeVPSImage(). */
  readonly imageTag?: string
  /** Container name. Defaults to a random suffix for isolation. */
  readonly containerName?: string
  /** How long to wait for sshd to accept TCP connections. */
  readonly sshReadyTimeoutMs?: number
}

export interface StartedVPS {
  readonly containerId: string
  readonly containerName: string
  readonly host: string
  readonly sshPort: number
  stop(): Promise<void>
  exec(command: string, user?: string): Promise<RunResult>
}

/**
 * Start a fresh fake-vps container and wait for sshd to accept
 * connections on the forwarded host port.
 */
export async function startFakeVPS(opts: StartFakeVPSOptions): Promise<StartedVPS> {
  const imageTag = opts.imageTag ?? DEFAULT_IMAGE_TAG
  const containerName =
    opts.containerName ?? `groundflare-fake-vps-${randomBytes(4).toString('hex')}`
  const hostPort = await findFreePort()

  const runResult = await runDocker(
    [
      'run',
      '-d',
      '--rm',
      '--privileged',
      '--name',
      containerName,
      '-p',
      `${hostPort}:22`,
      // systemd inside the container wants these tmpfs mounts.
      '--tmpfs',
      '/run',
      '--tmpfs',
      '/run/lock',
      imageTag,
    ],
    { timeoutMs: 30_000 },
  )
  if (runResult.exitCode !== 0) {
    throw new Error(`docker run failed: ${runResult.stderr.trim()}`)
  }
  const containerId = runResult.stdout.trim()

  const started: StartedVPS = {
    containerId,
    containerName,
    host: '127.0.0.1',
    sshPort: hostPort,
    async stop() {
      await runDocker(['stop', '-t', '2', containerName], { timeoutMs: 15_000 })
    },
    async exec(command: string, user = 'root') {
      return await runDocker(['exec', '-u', user, containerName, 'sh', '-c', command], {
        timeoutMs: 30_000,
      })
    },
  }

  try {
    await injectAuthorizedKey(started, opts.publicKey)
    await waitForSshReady(started, opts.sshReadyTimeoutMs ?? 30_000)
    return started
  } catch (err) {
    await started.stop().catch(() => {})
    throw err
  }
}

async function injectAuthorizedKey(vps: StartedVPS, publicKey: string): Promise<void> {
  const trimmed = publicKey.trimEnd() + '\n'
  // Use base64 + stdin to avoid quoting hazards.
  const encoded = Buffer.from(trimmed, 'utf-8').toString('base64')
  const cmd =
    `mkdir -p /home/groundflare/.ssh && ` +
    `echo '${encoded}' | base64 -d > /home/groundflare/.ssh/authorized_keys && ` +
    `chown -R groundflare:groundflare /home/groundflare/.ssh && ` +
    `chmod 700 /home/groundflare/.ssh && ` +
    `chmod 600 /home/groundflare/.ssh/authorized_keys`
  const result = await vps.exec(cmd)
  if (result.exitCode !== 0) {
    throw new Error(`failed to inject authorized_keys: ${result.stderr.trim()}`)
  }
}

async function waitForSshReady(vps: StartedVPS, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  // Two gates: (1) sshd is listening inside the container, and
  // (2) the host-side forwarded port actually accepts a TCP connection.
  // Only passing both avoids races where docker's port-forward lags.
  while (Date.now() < deadline) {
    const inside = await vps.exec(
      `systemctl is-active ssh >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':22 '`,
    )
    if (inside.exitCode === 0) {
      const reachable = await tcpProbe(vps.host, vps.sshPort, 1_500)
      if (reachable) return
      lastError = `host:${vps.sshPort} refused connection`
    } else {
      lastError = inside.stderr.trim() || `sshd not yet listening (exit ${inside.exitCode})`
    }
    await sleep(500)
  }
  throw new Error(`sshd did not become ready within ${timeoutMs}ms: ${lastError}`)
}

async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const { createConnection } = await import('node:net')
  return await new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host, port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolvePromise(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      done(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      done(false)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
