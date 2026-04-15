/**
 * spawn-workerd — Tier 2.5 test harness.
 *
 * Spins up a real workerd process against a generated capnp config,
 * probes it for readiness, exposes a small HTTP client that sets the
 * Host header we want (Node's global fetch silently drops a custom
 * `host` header; we go through node:http to bypass that restriction).
 *
 * Every call returns a SpawnedWorkerd whose .stop() cleans up both
 * the child process and the temp working directory. Call it from a
 * try/finally so flaky tests don't leak processes.
 *
 * Used by test/integration/**; not part of the shipped CLI.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createServer } from 'node:net'
import { request as httpRequestRaw, type OutgoingHttpHeaders } from 'node:http'

const WORKERD_BIN = resolve(process.cwd(), 'node_modules', '.bin', 'workerd')

export interface SpawnWorkerdOptions {
  /** TCP port workerd will bind to (caller must have generated capnp pointing here). */
  readonly port: number
  /** Rendered capnp config source. */
  readonly capnp: string
  /**
   * Map of relative path → file content. Written into the temp work
   * directory before spawning, so `embed "foo.js"` in the capnp resolves.
   */
  readonly modules: Readonly<Record<string, string>>
  /**
   * Extra empty directories to create inside the workdir before spawning.
   * Needed when the capnp references disk services whose target dirs
   * must pre-exist (e.g. Durable Object storage roots).
   */
  readonly extraDirs?: readonly string[]
  /** Max ms to wait for workerd to become HTTP-responsive. Default 5000. */
  readonly healthTimeoutMs?: number
  /** If true, inherit stdio so workerd output reaches the test console. */
  readonly verbose?: boolean
}

export interface HttpRequestOptions {
  host: string
  path?: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface HttpResult {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}

export interface SpawnedWorkerd {
  readonly port: number
  readonly workdir: string
  sendRequest(opts: HttpRequestOptions): Promise<HttpResult>
  /** Tail of stderr collected while workerd was running (empty if verbose). */
  stderr(): string
  stop(): Promise<void>
}

/**
 * Ask the OS for a free ephemeral port. Returns the port number after
 * closing the listener — the caller then uses it when building the capnp
 * config before spawning workerd.
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const server = createServer()
    server.unref()
    server.on('error', rejectFn)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr !== null) {
        const { port } = addr
        server.close(() => resolveFn(port))
      } else {
        server.close(() => rejectFn(new Error('spawnWorkerd: could not resolve free port')))
      }
    })
  })
}

export async function spawnWorkerd(opts: SpawnWorkerdOptions): Promise<SpawnedWorkerd> {
  const workdir = await mkdtemp(join(tmpdir(), 'gf-workerd-'))

  try {
    await writeFile(join(workdir, 'worker.capnp'), opts.capnp)
    for (const [relPath, content] of Object.entries(opts.modules)) {
      const full = join(workdir, relPath)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, content)
    }
    for (const dir of opts.extraDirs ?? []) {
      await mkdir(join(workdir, dir), { recursive: true })
    }
  } catch (err) {
    await rm(workdir, { recursive: true, force: true })
    throw err
  }

  const proc: ChildProcess = spawn(WORKERD_BIN, ['serve', 'worker.capnp'], {
    cwd: workdir,
    stdio: opts.verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })

  const stderrChunks: string[] = []
  proc.stderr?.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
  })

  let exited = false
  let exitCode: number | null = null
  proc.on('exit', (code) => {
    exited = true
    exitCode = code
  })

  try {
    await waitForWorkerd(opts.port, opts.healthTimeoutMs ?? 5000, () => exited)
  } catch (err) {
    proc.kill('SIGKILL')
    await rm(workdir, { recursive: true, force: true })
    const reason = err instanceof Error ? err.message : String(err)
    const stderr = stderrChunks.join('').slice(-2000)
    throw new Error(
      `workerd failed to start (exitCode=${exitCode}): ${reason}\n` +
        `stderr (last 2KB):\n${stderr || '(empty — add verbose:true to see output)'}`,
    )
  }

  return {
    port: opts.port,
    workdir,
    async sendRequest(req) {
      return httpRequest({
        port: opts.port,
        host: req.host,
        path: req.path ?? '/',
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body,
      })
    },
    stderr() {
      return stderrChunks.join('')
    },
    async stop() {
      if (exited) {
        await rm(workdir, { recursive: true, force: true })
        return
      }
      proc.kill('SIGTERM')
      await Promise.race([
        new Promise<void>((r) => proc.once('exit', () => r())),
        sleep(2000).then(() => {
          proc.kill('SIGKILL')
        }),
      ])
      await rm(workdir, { recursive: true, force: true })
    },
  }
}

async function waitForWorkerd(
  port: number,
  timeoutMs: number,
  hasExited: () => boolean,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (hasExited()) throw new Error('workerd exited before becoming healthy')
    try {
      await httpRequest({
        port,
        host: 'groundflare-health-probe.internal',
        path: '/',
      })
      return
    } catch {
      // connection refused / timeout — try again
    }
    await sleep(50)
  }
  throw new Error(`workerd did not respond within ${timeoutMs}ms`)
}

async function httpRequest(opts: {
  port: number
  host: string
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<HttpResult> {
  return new Promise<HttpResult>((resolveFn, rejectFn) => {
    const headers: OutgoingHttpHeaders = { host: opts.host, ...opts.headers }
    if (opts.body !== undefined) {
      headers['content-length'] = Buffer.byteLength(opts.body).toString()
    }

    const req = httpRequestRaw(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolveFn({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers as HttpResult['headers'],
          })
        })
        res.on('error', rejectFn)
      },
    )

    req.on('error', rejectFn)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}
