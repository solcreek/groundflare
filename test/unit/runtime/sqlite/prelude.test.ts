import { describe, it, expect } from 'vitest'
import {
  PRELUDE_DEFAULTS,
  PreludeAssertionError,
  assertPreludeApplied,
  preludeStatements,
  readPreludeState,
  type PragmaReader,
  type PreludeState,
} from '../../../../src/runtime/sqlite/prelude.js'

describe('preludeStatements', () => {
  it('emits WAL as the first data-plane PRAGMA', () => {
    const stmts = preludeStatements()
    expect(stmts[0]).toBe('PRAGMA journal_mode = WAL')
  })

  it('emits synchronous = NORMAL', () => {
    expect(preludeStatements()).toContain('PRAGMA synchronous = NORMAL')
  })

  it('uses default busy_timeout of 5000ms', () => {
    expect(preludeStatements()).toContain('PRAGMA busy_timeout = 5000')
  })

  it('accepts custom busy_timeout', () => {
    expect(preludeStatements({ busyTimeoutMs: 10000 })).toContain(
      'PRAGMA busy_timeout = 10000',
    )
  })

  it('encodes cache_size in negative KB form (default 64000 -> -64000)', () => {
    expect(preludeStatements()).toContain('PRAGMA cache_size = -64000')
  })

  it('encodes custom cacheSizeKb as negative', () => {
    expect(preludeStatements({ cacheSizeKb: 128_000 })).toContain(
      'PRAGMA cache_size = -128000',
    )
  })

  it('uses default mmap_size of 256 MB', () => {
    expect(preludeStatements()).toContain('PRAGMA mmap_size = 268435456')
  })

  it('accepts custom mmapSizeBytes', () => {
    expect(preludeStatements({ mmapSizeBytes: 0 })).toContain('PRAGMA mmap_size = 0')
  })

  it('emits temp_store = MEMORY and foreign_keys = ON', () => {
    const stmts = preludeStatements()
    expect(stmts).toContain('PRAGMA temp_store = MEMORY')
    expect(stmts).toContain('PRAGMA foreign_keys = ON')
  })

  it('returns a stable order: WAL → sync → busy → cache → mmap → temp → fk', () => {
    const stmts = preludeStatements()
    const subjects = stmts.map((s) => s.replace(/^PRAGMA\s+(\w+).*/, '$1'))
    expect(subjects).toEqual([
      'journal_mode',
      'synchronous',
      'busy_timeout',
      'cache_size',
      'mmap_size',
      'temp_store',
      'foreign_keys',
    ])
  })

  it('defaults are frozen constants', () => {
    expect(Object.isFrozen(PRELUDE_DEFAULTS)).toBe(true)
  })
})

describe('readPreludeState', () => {
  function fakeReader(values: Record<string, string | number>): PragmaReader {
    return {
      read: (name) => values[name] ?? 0,
    }
  }

  it('normalizes journal_mode to lowercase', () => {
    const state = readPreludeState(
      fakeReader({
        journal_mode: 'WAL',
        synchronous: 1,
        busy_timeout: 5000,
        cache_size: -64000,
        mmap_size: 268435456,
        temp_store: 2,
        foreign_keys: 1,
      }),
    )
    expect(state.journal_mode).toBe('wal')
  })

  it('coerces numeric pragmas to numbers', () => {
    const state = readPreludeState(
      fakeReader({
        journal_mode: 'wal',
        synchronous: '1',
        busy_timeout: '5000',
        cache_size: '-64000',
        mmap_size: '268435456',
        temp_store: '2',
        foreign_keys: '1',
      }),
    )
    expect(typeof state.synchronous).toBe('number')
    expect(typeof state.busy_timeout).toBe('number')
  })
})

describe('assertPreludeApplied', () => {
  const happy: PreludeState = {
    journal_mode: 'wal',
    synchronous: 1,
    busy_timeout: 5000,
    cache_size: -64000,
    mmap_size: 268435456,
    temp_store: 2,
    foreign_keys: 1,
  }

  it('passes on a correctly-prepared state', () => {
    expect(() => assertPreludeApplied(happy)).not.toThrow()
  })

  it('throws PreludeAssertionError when journal_mode is wrong', () => {
    const bad: PreludeState = { ...happy, journal_mode: 'delete' }
    expect(() => assertPreludeApplied(bad)).toThrow(PreludeAssertionError)
  })

  it('accepts memory journal when allowMemoryJournal is true', () => {
    const state: PreludeState = { ...happy, journal_mode: 'memory' }
    expect(() => assertPreludeApplied(state, { allowMemoryJournal: true })).not.toThrow()
  })

  it('rejects memory journal by default (strict)', () => {
    const state: PreludeState = { ...happy, journal_mode: 'memory' }
    expect(() => assertPreludeApplied(state)).toThrow(/journal_mode=memory/)
  })

  it('flags busy_timeout mismatch when options match', () => {
    const state: PreludeState = { ...happy, busy_timeout: 1000 }
    expect(() => assertPreludeApplied(state)).toThrow(/busy_timeout=1000/)
  })

  it('accepts busy_timeout mismatch when options explicitly set the expected value', () => {
    const state: PreludeState = { ...happy, busy_timeout: 10000 }
    expect(() => assertPreludeApplied(state, { busyTimeoutMs: 10000 })).not.toThrow()
  })

  it('flags synchronous != 1 (NORMAL)', () => {
    expect(() => assertPreludeApplied({ ...happy, synchronous: 2 })).toThrow(
      /synchronous=2/,
    )
  })

  it('flags cache_size mismatch using negative-KB convention', () => {
    expect(() => assertPreludeApplied({ ...happy, cache_size: -32000 })).toThrow(
      /cache_size=-32000/,
    )
  })

  it('flags mmap_size mismatch', () => {
    expect(() => assertPreludeApplied({ ...happy, mmap_size: 0 })).toThrow(/mmap_size=0/)
  })

  it('flags temp_store != 2', () => {
    expect(() => assertPreludeApplied({ ...happy, temp_store: 0 })).toThrow(/temp_store=0/)
  })

  it('flags foreign_keys off', () => {
    expect(() => assertPreludeApplied({ ...happy, foreign_keys: 0 })).toThrow(
      /foreign_keys=0/,
    )
  })

  it('reports all problems in one error, not just the first', () => {
    const bad: PreludeState = {
      journal_mode: 'delete',
      synchronous: 0,
      busy_timeout: 0,
      cache_size: 0,
      mmap_size: 0,
      temp_store: 0,
      foreign_keys: 0,
    }
    try {
      assertPreludeApplied(bad)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PreludeAssertionError)
      const problems = (err as PreludeAssertionError).problems
      expect(problems.length).toBe(7)
    }
  })
})
