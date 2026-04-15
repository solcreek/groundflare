import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { SshError, waitForSshTcpReady, type ConnectFn } from '../../../src/ssh/index.js'

interface MockSocketBehaviour {
  /** When set, emit 'connect' after this delay (ms). */
  connectAfterMs?: number
  /** When set, emit 'error' after this delay (ms). */
  errorAfterMs?: number
  /** Error to emit if errorAfterMs is set. */
  error?: Error
}

function mockSocket(behaviour: MockSocketBehaviour) {
  const socket = new EventEmitter() as EventEmitter & {
    end: () => void
    destroy: () => void
  }
  socket.end = vi.fn()
  socket.destroy = vi.fn()

  if (behaviour.connectAfterMs !== undefined) {
    setTimeout(() => socket.emit('connect'), behaviour.connectAfterMs)
  }
  if (behaviour.errorAfterMs !== undefined) {
    setTimeout(
      () => socket.emit('error', behaviour.error ?? new Error('ECONNREFUSED')),
      behaviour.errorAfterMs,
    )
  }
  return socket
}

function mockConnect(
  behaviours: readonly MockSocketBehaviour[] | MockSocketBehaviour,
): { connectImpl: ConnectFn } {
  const queue = Array.isArray(behaviours) ? [...behaviours] : [behaviours]
  // Default to "connection refused immediately" so tests that assert
  // exhaustion-style behaviour (deadline expiration) don't accidentally
  // succeed when the queue runs dry.
  const fallback: MockSocketBehaviour = {
    errorAfterMs: 0,
    error: new Error('mock: default ECONNREFUSED'),
  }
  const connectImpl: ConnectFn = (() => {
    const next = queue.shift() ?? fallback
    return mockSocket(next) as unknown as ReturnType<ConnectFn>
  }) as unknown as ConnectFn
  return { connectImpl }
}

describe('waitForSshTcpReady', () => {
  it('resolves on the first successful connect', async () => {
    const { connectImpl } = mockConnect({ connectAfterMs: 0 })
    await expect(
      waitForSshTcpReady({
        host: '1.2.3.4',
        connectImpl,
        sleepImpl: () => Promise.resolve(),
        nowMs: () => 0,
      }),
    ).resolves.toBeUndefined()
  })

  it('retries through transient connection errors and eventually succeeds', async () => {
    let now = 0
    const { connectImpl } = mockConnect([
      { errorAfterMs: 0, error: new Error('ECONNREFUSED') },
      { errorAfterMs: 0, error: new Error('ECONNREFUSED') },
      { connectAfterMs: 0 },
    ])
    await expect(
      waitForSshTcpReady({
        host: '1.2.3.4',
        intervalMs: 100,
        connectImpl,
        sleepImpl: async (ms) => {
          now += ms
        },
        nowMs: () => now,
      }),
    ).resolves.toBeUndefined()
  })

  it('throws SshError(not_ready) once the deadline expires', async () => {
    let now = 0
    const { connectImpl } = mockConnect({ errorAfterMs: 0, error: new Error('ECONNREFUSED') })
    await expect(
      waitForSshTcpReady({
        host: '1.2.3.4',
        maxWaitMs: 50,
        intervalMs: 10,
        connectImpl,
        sleepImpl: async (ms) => {
          now += ms
        },
        nowMs: () => now,
      }),
    ).rejects.toMatchObject({
      name: 'SshError',
      code: 'not_ready',
    })
  })

  it('treats a per-attempt timeout as a retryable failure, not a fatal one', async () => {
    // First attempt never resolves (simulates SYN drops); second succeeds.
    const { connectImpl } = mockConnect([
      {
        /* nothing — neither connect nor error emit */
      },
      { connectAfterMs: 0 },
    ])
    let now = 0
    await expect(
      waitForSshTcpReady({
        host: '1.2.3.4',
        maxWaitMs: 200,
        intervalMs: 10,
        perAttemptTimeoutMs: 5,
        connectImpl,
        sleepImpl: async (ms) => {
          now += ms
        },
        nowMs: () => now,
      }),
    ).resolves.toBeUndefined()
  })

  it('sleeps no more than necessary near the deadline', async () => {
    let now = 0
    const sleeps: number[] = []
    const { connectImpl } = mockConnect([
      { errorAfterMs: 0, error: new Error('refused') },
      { errorAfterMs: 0, error: new Error('refused') },
    ])
    await expect(
      waitForSshTcpReady({
        host: '1.2.3.4',
        maxWaitMs: 100,
        intervalMs: 30,
        connectImpl,
        sleepImpl: async (ms) => {
          sleeps.push(ms)
          now += ms
        },
        nowMs: () => now,
      }),
    ).rejects.toMatchObject({ code: 'not_ready' })
    // Each attempt is followed by a sleep — but the loop bails out when
    // the next sleep would push us past the deadline. Verify we didn't
    // do a runaway sleep beyond maxWait.
    expect(sleeps.every((s) => s === 30)).toBe(true)
    expect(now).toBeLessThanOrEqual(100)
  })

  it('preserves the underlying error message in the thrown SshError', async () => {
    const { connectImpl } = mockConnect({
      errorAfterMs: 0,
      error: new Error('host unreachable'),
    })
    let now = 0
    try {
      await waitForSshTcpReady({
        host: '1.2.3.4',
        maxWaitMs: 5,
        intervalMs: 10,
        connectImpl,
        sleepImpl: async (ms) => {
          now += ms
        },
        nowMs: () => now,
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(SshError)
      expect((err as SshError).message).toContain('host unreachable')
    }
  })
})
