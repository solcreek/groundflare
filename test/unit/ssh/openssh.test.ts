import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Writable, Readable } from 'node:stream'
import {
  OpenSshClient,
  shellSingleQuote,
  type SpawnFn,
  type SshTarget,
} from '../../../src/ssh/index.js'

// ─── Mock spawn helper ─────────────────────────────────────────────

interface MockSpawnConfig {
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  stdoutChunks?: readonly (string | Buffer)[]
  stderrChunks?: readonly (string | Buffer)[]
  /** Throw synchronously (e.g. ENOENT for missing binary). */
  spawnError?: Error
  /** Hold the process open until manually exited. */
  hold?: boolean
}

interface MockSpawnInvocation {
  command: string
  args: readonly string[]
}

function mockSpawn(configs: readonly MockSpawnConfig[] | MockSpawnConfig): {
  spawnImpl: SpawnFn
  calls: MockSpawnInvocation[]
} {
  const queue = Array.isArray(configs) ? [...configs] : [configs]
  const calls: MockSpawnInvocation[] = []

  const spawnImpl: SpawnFn = (command, args) => {
    calls.push({ command, args })
    const config = queue.shift() ?? {}

    if (config.spawnError) {
      const child = new EventEmitter() as EventEmitter & {
        stdin: Writable
        stdout: Readable
        stderr: Readable
        kill: () => void
      }
      child.stdin = new Writable({ write: (_c, _e, cb) => cb() })
      child.stdout = Readable.from([])
      child.stderr = Readable.from([])
      child.kill = vi.fn()
      // Emit error asynchronously to mimic the real spawn behaviour.
      queueMicrotask(() => child.emit('error', config.spawnError))
      return child as unknown as ReturnType<SpawnFn>
    }

    const stdout = Readable.from(config.stdoutChunks ?? [])
    const stderr = Readable.from(config.stderrChunks ?? [])
    const stdin = new Writable({ write: (_c, _e, cb) => cb() })

    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable
      stdout: Readable
      stderr: Readable
      kill: (sig?: NodeJS.Signals) => void
    }
    child.stdin = stdin
    child.stdout = stdout
    child.stderr = stderr
    let killed = false
    child.kill = (sig?: NodeJS.Signals) => {
      if (killed) return
      killed = true
      queueMicrotask(() => child.emit('exit', null, sig ?? 'SIGTERM'))
    }

    if (!config.hold) {
      // Wait for the consumer to drain stdout/stderr before exiting so
      // the test sees all the data. Note: `exitCode ?? 0` would clobber
      // an intentional null (signal-only exit), so we check for property
      // presence using `'exitCode' in config`.
      const exitCode = 'exitCode' in config ? (config.exitCode ?? null) : 0
      const signal = config.signal ?? null
      queueMicrotask(() => {
        Promise.all([
          new Promise<void>((r) => stdout.on('end', () => r())),
          new Promise<void>((r) => stderr.on('end', () => r())),
        ]).then(() => {
          child.emit('exit', exitCode, signal)
        })
      })
    }
    return child as unknown as ReturnType<SpawnFn>
  }

  return { spawnImpl, calls }
}

const baseTarget: SshTarget = {
  host: '203.0.113.10',
  user: 'groundflare',
  privateKeyPath: '/keys/id_ed25519',
}

function makeClient(
  spawnImpl: SpawnFn,
  overrides: Partial<SshTarget> = {},
): OpenSshClient {
  return new OpenSshClient({
    target: { ...baseTarget, ...overrides },
    spawnImpl,
  })
}

// ─── shellSingleQuote ──────────────────────────────────────────────

describe('shellSingleQuote', () => {
  it('wraps simple strings', () => {
    expect(shellSingleQuote('hello')).toBe(`'hello'`)
  })

  it('escapes embedded single quotes via the standard sequence', () => {
    expect(shellSingleQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('handles whitespace and metachars verbatim inside quotes', () => {
    expect(shellSingleQuote('a b; c & d')).toBe(`'a b; c & d'`)
  })
})

// ─── ssh argument construction ─────────────────────────────────────

describe('OpenSshClient: ssh option set', () => {
  it('includes identity, IdentitiesOnly, BatchMode, accept-new, ConnectTimeout', async () => {
    const { spawnImpl, calls } = mockSpawn({ exitCode: 0 })
    await makeClient(spawnImpl).ping()
    const args = calls[0]?.args ?? []
    expect(args).toContain('-i')
    expect(args).toContain('/keys/id_ed25519')
    expect(args).toContain('IdentitiesOnly=yes')
    expect(args).toContain('StrictHostKeyChecking=accept-new')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('ConnectTimeout=10')
    expect(args).toContain('LogLevel=ERROR')
  })

  it('omits the port flag when port is the default 22', async () => {
    const { spawnImpl, calls } = mockSpawn({ exitCode: 0 })
    await makeClient(spawnImpl).ping()
    expect(calls[0]?.args).not.toContain('-p')
  })

  it('passes -p when port differs from 22', async () => {
    const { spawnImpl, calls } = mockSpawn({ exitCode: 0 })
    await makeClient(spawnImpl, { port: 2222 }).ping()
    const args = calls[0]?.args ?? []
    const idx = args.indexOf('-p')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('2222')
  })

  it('honours strictHostKeyChecking override', async () => {
    const { spawnImpl, calls } = mockSpawn({ exitCode: 0 })
    await makeClient(spawnImpl, { strictHostKeyChecking: 'yes' }).ping()
    expect(calls[0]?.args).toContain('StrictHostKeyChecking=yes')
  })

  it('passes UserKnownHostsFile when supplied', async () => {
    const { spawnImpl, calls } = mockSpawn({ exitCode: 0 })
    await makeClient(spawnImpl, { knownHostsPath: '/etc/known_hosts' }).ping()
    expect(calls[0]?.args).toContain('UserKnownHostsFile=/etc/known_hosts')
  })

  it('targets <user>@<host> as the second-to-last positional', async () => {
    const { spawnImpl, calls } = mockSpawn({ exitCode: 0 })
    await makeClient(spawnImpl).ping()
    const args = calls[0]?.args ?? []
    const idx = args.indexOf('groundflare@203.0.113.10')
    expect(idx).toBeGreaterThan(-1)
  })

  it('uses the configured ssh binary', async () => {
    const { spawnImpl, calls } = mockSpawn({ exitCode: 0 })
    const client = new OpenSshClient({
      target: baseTarget,
      spawnImpl,
      sshBinary: '/opt/ssh',
    })
    await client.ping()
    expect(calls[0]?.command).toBe('/opt/ssh')
  })
})

// ─── run() exit + stdio ────────────────────────────────────────────

describe('OpenSshClient: run', () => {
  it('returns exit code 0 + collected stdout/stderr', async () => {
    const { spawnImpl } = mockSpawn({
      exitCode: 0,
      stdoutChunks: ['hello\n', 'world\n'],
      stderrChunks: ['warn\n'],
    })
    const result = await makeClient(spawnImpl).run('echo hi')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello\nworld\n')
    expect(result.stderr).toBe('warn\n')
    expect(typeof result.durationMs).toBe('number')
  })

  it('propagates non-zero exit codes', async () => {
    const { spawnImpl } = mockSpawn({ exitCode: 17, stderrChunks: ['boom\n'] })
    const result = await makeClient(spawnImpl).run('false')
    expect(result.exitCode).toBe(17)
    expect(result.stderr).toBe('boom\n')
  })

  it('treats signal-only exits as exit code 128', async () => {
    const { spawnImpl } = mockSpawn({ exitCode: null, signal: 'SIGKILL' })
    const result = await makeClient(spawnImpl).run('sleep 100')
    expect(result.exitCode).toBe(128)
  })

  it('throws SshError(connect_failed) when spawn fails', async () => {
    const { spawnImpl } = mockSpawn({ spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
    await expect(makeClient(spawnImpl).run('echo')).rejects.toMatchObject({
      name: 'SshError',
      code: 'connect_failed',
    })
  })

  it('wraps the command with cwd + env when provided', async () => {
    const { spawnImpl, calls } = mockSpawn({ exitCode: 0 })
    await makeClient(spawnImpl).run('do-thing', {
      cwd: '/var/lib/groundflare',
      env: { FOO: 'bar', BAR: 'baz qux' },
    })
    const wrapped = calls[0]?.args[calls[0].args.length - 1] as string
    expect(wrapped).toContain(`export FOO='bar'`)
    expect(wrapped).toContain(`export BAR='baz qux'`)
    expect(wrapped).toContain(`cd '/var/lib/groundflare'`)
    expect(wrapped).toContain('do-thing')
    expect(wrapped.startsWith('export ') || wrapped.startsWith('cd ')).toBe(true)
  })

  it('rejects malformed env var names', async () => {
    const { spawnImpl } = mockSpawn({ exitCode: 0 })
    await expect(
      makeClient(spawnImpl).run('echo', { env: { '1bad': 'x' } }),
    ).rejects.toMatchObject({ code: 'command_failed' })
  })
})

// ─── ping() ────────────────────────────────────────────────────────

describe('OpenSshClient: ping', () => {
  it('throws SshError(connect_failed) when remote returns non-zero', async () => {
    const { spawnImpl } = mockSpawn({ exitCode: 255, stderrChunks: ['perm denied\n'] })
    await expect(makeClient(spawnImpl).ping()).rejects.toMatchObject({
      name: 'SshError',
      code: 'connect_failed',
    })
  })
})

// ─── stream() line splitting ───────────────────────────────────────

describe('OpenSshClient: stream', () => {
  it('emits one onLine call per newline-terminated chunk', async () => {
    const { spawnImpl } = mockSpawn({
      exitCode: 0,
      stdoutChunks: ['line1\nline2\n', 'line3\n'],
    })
    const lines: Array<{ line: string; source: string }> = []
    const result = await makeClient(spawnImpl).stream(
      'tail -F log',
      (line, source) => lines.push({ line, source }),
    )
    expect(lines).toEqual([
      { line: 'line1', source: 'stdout' },
      { line: 'line2', source: 'stdout' },
      { line: 'line3', source: 'stdout' },
    ])
    expect(result.exitCode).toBe(0)
  })

  it('handles partial lines split across chunks', async () => {
    const { spawnImpl } = mockSpawn({
      exitCode: 0,
      stdoutChunks: ['part-', 'one\npart-two\n'],
    })
    const lines: string[] = []
    await makeClient(spawnImpl).stream('cat', (line) => lines.push(line))
    expect(lines).toEqual(['part-one', 'part-two'])
  })

  it('flushes the trailing partial line on exit', async () => {
    const { spawnImpl } = mockSpawn({
      exitCode: 0,
      stdoutChunks: ['no-newline-at-end'],
    })
    const lines: string[] = []
    await makeClient(spawnImpl).stream('cat', (line) => lines.push(line))
    expect(lines).toEqual(['no-newline-at-end'])
  })

  it('separates stdout and stderr', async () => {
    const { spawnImpl } = mockSpawn({
      exitCode: 0,
      stdoutChunks: ['out\n'],
      stderrChunks: ['err\n'],
    })
    const lines: Array<{ line: string; source: string }> = []
    await makeClient(spawnImpl).stream('mixed', (line, source) =>
      lines.push({ line, source }),
    )
    expect(lines).toContainEqual({ line: 'out', source: 'stdout' })
    expect(lines).toContainEqual({ line: 'err', source: 'stderr' })
  })
})

// ─── upload / download (scp argv shape) ────────────────────────────

describe('OpenSshClient: upload', () => {
  it('builds scp args with -P (capital P) for non-default port and supports -r/-p flags', async () => {
    const { spawnImpl, calls } = mockSpawn({ exitCode: 0 })
    const client = makeClient(spawnImpl, { port: 2222 })
    await client.upload('./local-dir', '/tmp/remote-dir', {
      recursive: true,
      preservePermissions: true,
    })
    const args = calls[0]?.args ?? []
    expect(calls[0]?.command).toBe('scp')
    expect(args).toContain('-r')
    expect(args).toContain('-p')
    const pIdx = args.indexOf('-P')
    expect(pIdx).toBeGreaterThan(-1)
    expect(args[pIdx + 1]).toBe('2222')
    expect(args).toContain('./local-dir')
    expect(args).toContain('groundflare@203.0.113.10:/tmp/remote-dir')
  })

  it('throws SshError(transfer_failed) on non-zero exit', async () => {
    const { spawnImpl } = mockSpawn({ exitCode: 1, stderrChunks: ['nope\n'] })
    await expect(
      makeClient(spawnImpl).upload('a', 'b'),
    ).rejects.toMatchObject({ code: 'transfer_failed' })
  })
})

describe('OpenSshClient: download', () => {
  it('reverses the source/destination ordering', async () => {
    const { spawnImpl, calls } = mockSpawn({ exitCode: 0 })
    await makeClient(spawnImpl).download('/var/log/journal.log', './local.log')
    const args = calls[0]?.args ?? []
    expect(args).toContain('groundflare@203.0.113.10:/var/log/journal.log')
    expect(args).toContain('./local.log')
  })
})

// ─── timeout handling ─────────────────────────────────────────────

describe('OpenSshClient: timeouts', () => {
  it('throws SshError(timeout) when the command exceeds timeoutMs', async () => {
    const { spawnImpl } = mockSpawn({ hold: true })
    await expect(
      makeClient(spawnImpl).run('sleep 10', { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'timeout' })
  })
})
