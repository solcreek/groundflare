/**
 * Unit tests for the ssh-keygen -R wrapper used by `destroy` to purge
 * stale known_hosts entries when a provider recycles a public IP.
 *
 * The real binary isn't invoked — we inject a fake spawn that
 * reproduces the shape of a ChildProcess just enough for the
 * implementation's exit/error handling. Same mock scaffolding as
 * openssh.test.ts for consistency.
 */

import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  removeKnownHostsEntries,
  type SpawnFn,
} from '../../../src/ssh/known-hosts.js'

interface MockChildConfig {
  exitCode?: number
  signal?: NodeJS.Signals | null
  stderrChunks?: readonly string[]
  spawnError?: Error
}

interface SpawnCall {
  command: string
  args: readonly string[]
}

function mockSpawn(configs: readonly MockChildConfig[]): {
  spawnImpl: SpawnFn
  calls: SpawnCall[]
} {
  const queue = [...configs]
  const calls: SpawnCall[] = []
  const spawnImpl: SpawnFn = (command, args) => {
    calls.push({ command, args })
    const config = queue.shift() ?? {}
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable
      stdout: Readable
      stderr: Readable
      kill: () => void
    }
    child.stdin = new Writable({ write: (_c, _e, cb) => cb() })
    child.stdout = Readable.from([])
    child.stderr = Readable.from(config.stderrChunks ?? [])
    child.kill = vi.fn()

    if (config.spawnError !== undefined) {
      queueMicrotask(() => child.emit('error', config.spawnError))
      return child as unknown as ReturnType<SpawnFn>
    }

    queueMicrotask(() => {
      // Drain stderr before firing exit so the implementation sees the
      // full error text.
      child.stderr.on('end', () => {
        child.emit('exit', config.exitCode ?? 0, config.signal ?? null)
      })
      // Kick the stream so `end` actually fires on the empty Readable.
      child.stderr.resume()
    })
    return child as unknown as ReturnType<SpawnFn>
  }
  return { spawnImpl, calls }
}

describe('removeKnownHostsEntries', () => {
  it('passes each host through to `ssh-keygen -R <host>`', async () => {
    const { spawnImpl, calls } = mockSpawn([{}, {}])
    const result = await removeKnownHostsEntries(
      ['203.0.113.10', '2001:db8::1'],
      { spawnImpl },
    )
    expect(calls).toEqual([
      { command: 'ssh-keygen', args: ['-R', '203.0.113.10'] },
      { command: 'ssh-keygen', args: ['-R', '2001:db8::1'] },
    ])
    expect(result.removed).toEqual(['203.0.113.10', '2001:db8::1'])
    expect(result.errors).toEqual([])
  })

  it('no-ops when ssh-keygen exits 0 with no matching entry', async () => {
    // ssh-keygen returns 0 even when nothing was found; we just count
    // that as "removed" from the caller's perspective — same net effect.
    const { spawnImpl } = mockSpawn([{ exitCode: 0 }])
    const result = await removeKnownHostsEntries(['198.51.100.99'], { spawnImpl })
    expect(result.removed).toEqual(['198.51.100.99'])
    expect(result.errors).toEqual([])
  })

  it('records per-host errors instead of throwing', async () => {
    const { spawnImpl } = mockSpawn([
      { exitCode: 0 },
      {
        exitCode: 1,
        stderrChunks: ['Unable to read known_hosts: Permission denied\n'],
      },
    ])
    const result = await removeKnownHostsEntries(
      ['203.0.113.10', '203.0.113.20'],
      { spawnImpl },
    )
    expect(result.removed).toEqual(['203.0.113.10'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.host).toBe('203.0.113.20')
    expect(result.errors[0]?.message).toMatch(/Permission denied/)
  })

  it('captures spawn errors (ssh-keygen not installed)', async () => {
    const err = new Error('spawn ssh-keygen ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    const { spawnImpl } = mockSpawn([{ spawnError: err }])
    const result = await removeKnownHostsEntries(['203.0.113.10'], { spawnImpl })
    expect(result.removed).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toMatch(/ENOENT/)
  })

  it('deduplicates repeated hosts + skips empty strings', async () => {
    const { spawnImpl, calls } = mockSpawn([{}, {}])
    const result = await removeKnownHostsEntries(
      ['203.0.113.10', '', '203.0.113.10', '[203.0.113.10]:2222'],
      { spawnImpl },
    )
    expect(calls.map((c) => c.args[1])).toEqual([
      '203.0.113.10',
      '[203.0.113.10]:2222',
    ])
    expect(result.removed).toEqual(['203.0.113.10', '[203.0.113.10]:2222'])
  })

  it('accepts a custom binary path (honours $PATH overrides)', async () => {
    const { spawnImpl, calls } = mockSpawn([{}])
    await removeKnownHostsEntries(['203.0.113.10'], {
      spawnImpl,
      binary: '/opt/homebrew/bin/ssh-keygen',
    })
    expect(calls[0]?.command).toBe('/opt/homebrew/bin/ssh-keygen')
  })

  it('empty input resolves to a clean result (no side effects)', async () => {
    const { spawnImpl, calls } = mockSpawn([])
    const result = await removeKnownHostsEntries([], { spawnImpl })
    expect(calls).toEqual([])
    expect(result).toEqual({ removed: [], errors: [] })
  })
})
