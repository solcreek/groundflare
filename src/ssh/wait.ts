/**
 * waitForSshTcpReady — polls a TCP port until it accepts connections, or
 * the deadline expires. Used right after `createVPS` to know when SSH is
 * up and we can proceed to bootstrap.
 *
 * Pure TCP probe — we don't try to authenticate. The SSH handshake itself
 * happens later when the bootstrap stage runs its first command.
 */

import { connect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

import { SshError, type WaitForSshOptions } from './types.js'

const DEFAULT_PORT = 22
const DEFAULT_MAX_WAIT_MS = 120_000
const DEFAULT_INTERVAL_MS = 3_000
const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 5_000

export type ConnectFn = typeof connect
export type SleepFn = (ms: number) => Promise<void>

export interface ProbeOptions extends WaitForSshOptions {
  /** Inject a connect function for testing. */
  readonly connectImpl?: ConnectFn
  /** Inject a sleep function for testing (skip real waits). */
  readonly sleepImpl?: SleepFn
  /** Inject a clock for testing. */
  readonly nowMs?: () => number
}

export async function waitForSshTcpReady(opts: ProbeOptions): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT
  const maxWait = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const perAttempt = opts.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS

  const connectImpl = opts.connectImpl ?? connect
  const sleepImpl = opts.sleepImpl ?? sleep
  const now = opts.nowMs ?? Date.now

  const deadline = now() + maxWait
  let attempts = 0
  let lastError: Error | undefined

  while (now() < deadline) {
    attempts++
    try {
      await tryConnect(connectImpl, opts.host, port, perAttempt)
      return
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
    if (now() + interval >= deadline) break
    await sleepImpl(interval)
  }

  throw new SshError(
    `SSH on ${opts.host}:${port} did not become reachable within ${maxWait}ms ` +
      `(${attempts} attempts, last error: ${lastError?.message ?? 'unknown'})`,
    'not_ready',
    lastError ? { cause: lastError } : undefined,
  )
}

function tryConnect(
  connectImpl: ConnectFn,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolveFn, rejectFn) => {
    const socket = connectImpl({ host, port })
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      rejectFn(new Error(`connect timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()

    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.end()
      resolveFn()
    })
    socket.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      rejectFn(err)
    })
  })
}
