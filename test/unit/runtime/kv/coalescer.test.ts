import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  IMMEDIATE,
  WriteCoalescer,
  type PendingOp,
} from '../../../../src/runtime/kv/coalescer.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function put(key: string, value = 'v'): PendingOp {
  return {
    kind: 'put',
    key,
    value: new TextEncoder().encode(value),
    metadata: null,
    expiresAt: null,
  }
}

function del(key: string): PendingOp {
  return { kind: 'delete', key }
}

describe('WriteCoalescer — window-based flush', () => {
  it('flushes after windowMs and resolves awaiters', async () => {
    const batches: PendingOp[][] = []
    const c = new WriteCoalescer((batch) => {
      batches.push([...batch])
    })

    const p1 = c.enqueue(put('a'))
    const p2 = c.enqueue(put('b'))
    expect(batches).toHaveLength(0)

    vi.advanceTimersByTime(5)
    await Promise.all([p1, p2])

    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((op) => op.key)).toEqual(['a', 'b'])
  })

  it('does not fire the timer more than once per batch', async () => {
    const commits = vi.fn()
    const c = new WriteCoalescer(commits)

    await Promise.all([
      c.enqueue(put('a')).then(() => vi.advanceTimersByTime(0)),
      c.enqueue(put('b')),
      (async () => {
        vi.advanceTimersByTime(5)
      })(),
    ])

    expect(commits).toHaveBeenCalledTimes(1)
  })

  it('starts a new batch after a flush', async () => {
    const batches: PendingOp[][] = []
    const c = new WriteCoalescer((b) => batches.push([...b]))

    const p1 = c.enqueue(put('a'))
    vi.advanceTimersByTime(5)
    await p1

    const p2 = c.enqueue(put('b'))
    vi.advanceTimersByTime(5)
    await p2

    expect(batches.map((b) => b.map((op) => op.key))).toEqual([['a'], ['b']])
  })
})

describe('WriteCoalescer — size-cap flush', () => {
  it('flushes immediately when queue hits maxBatch', async () => {
    const batches: PendingOp[][] = []
    const c = new WriteCoalescer((b) => batches.push([...b]), { maxBatch: 3 })

    const p1 = c.enqueue(put('a'))
    const p2 = c.enqueue(put('b'))
    // not yet
    expect(batches).toHaveLength(0)

    const p3 = c.enqueue(put('c'))
    // at the cap — flush is synchronous
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((op) => op.key)).toEqual(['a', 'b', 'c'])

    await Promise.all([p1, p2, p3])
  })

  it('windowMs=0 or maxBatch=1 means per-op transactions', async () => {
    const batches: PendingOp[][] = []
    const c = new WriteCoalescer((b) => batches.push([...b]), IMMEDIATE)

    await c.enqueue(put('a'))
    await c.enqueue(put('b'))

    expect(batches.map((b) => b.length)).toEqual([1, 1])
  })
})

describe('WriteCoalescer — latestFor (read-after-write)', () => {
  it('returns the most recently enqueued op for a key', () => {
    const c = new WriteCoalescer(() => {})
    c.enqueue(put('a', '1'))
    c.enqueue(put('a', '2'))
    c.enqueue(put('b', 'x'))

    const latestA = c.latestFor('a')
    expect(latestA?.kind).toBe('put')
    if (latestA?.kind === 'put') {
      expect(new TextDecoder().decode(latestA.value)).toBe('2')
    }

    expect(c.latestFor('missing')).toBeNull()
  })

  it('returns a pending delete, not the stale put', () => {
    const c = new WriteCoalescer(() => {})
    c.enqueue(put('a', '1'))
    c.enqueue(del('a'))

    expect(c.latestFor('a')?.kind).toBe('delete')
  })

  it('clears the index on flush', async () => {
    const c = new WriteCoalescer(() => {})
    c.enqueue(put('a'))
    vi.advanceTimersByTime(5)
    // give the timer microtask a chance to run
    await Promise.resolve()

    expect(c.latestFor('a')).toBeNull()
  })
})

describe('WriteCoalescer — error propagation', () => {
  it('rejects every awaiter when the commit throws', async () => {
    const boom = new Error('disk full')
    const c = new WriteCoalescer(() => {
      throw boom
    })

    const p1 = c.enqueue(put('a'))
    const p2 = c.enqueue(put('b'))
    vi.advanceTimersByTime(5)

    await expect(p1).rejects.toThrow('disk full')
    await expect(p2).rejects.toThrow('disk full')
  })

  it('continues accepting new ops after a failed batch', async () => {
    let throwOnce = true
    const batches: PendingOp[][] = []
    const c = new WriteCoalescer((b) => {
      if (throwOnce) {
        throwOnce = false
        throw new Error('transient')
      }
      batches.push([...b])
    })

    const failing = c.enqueue(put('a'))
    vi.advanceTimersByTime(5)
    await expect(failing).rejects.toThrow('transient')

    const recovering = c.enqueue(put('b'))
    vi.advanceTimersByTime(5)
    await recovering

    expect(batches).toHaveLength(1)
    expect(batches[0]![0]!.key).toBe('b')
  })
})

describe('WriteCoalescer — close', () => {
  it('flushes remaining ops', async () => {
    const batches: PendingOp[][] = []
    const c = new WriteCoalescer((b) => batches.push([...b]))

    const p = c.enqueue(put('a'))
    c.close()
    await p

    expect(batches).toHaveLength(1)
  })

  it('rejects new enqueues after close', async () => {
    const c = new WriteCoalescer(() => {})
    c.close()
    await expect(c.enqueue(put('a'))).rejects.toThrow('closed')
  })
})

describe('WriteCoalescer — depth', () => {
  it('tracks in-flight ops', () => {
    const c = new WriteCoalescer(() => {})
    expect(c.depth).toBe(0)
    c.enqueue(put('a'))
    c.enqueue(put('b'))
    expect(c.depth).toBe(2)
  })
})
