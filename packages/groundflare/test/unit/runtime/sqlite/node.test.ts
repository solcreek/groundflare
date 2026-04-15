import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import {
  applyPrelude,
  assertPrelude,
  openSqlite,
  readState,
} from '../../../../src/runtime/sqlite/node.js'
import { PreludeAssertionError } from '../../../../src/runtime/sqlite/prelude.js'

describe('openSqlite — file-backed', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gf-sqlite-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('opens a fresh database with WAL mode active', () => {
    const db = openSqlite(join(tmp, 'kv.sqlite'))
    try {
      const state = readState(db)
      expect(state.journal_mode).toBe('wal')
      expect(state.synchronous).toBe(1) // NORMAL
      expect(state.busy_timeout).toBe(5000)
      expect(state.cache_size).toBe(-64000)
      expect(state.mmap_size).toBe(268435456)
      expect(state.temp_store).toBe(2) // MEMORY
      expect(state.foreign_keys).toBe(1)
    } finally {
      db.close()
    }
  })

  it('creates the .db-wal sidecar after the first write commits', () => {
    const dbPath = join(tmp, 'kv.sqlite')
    const db = openSqlite(dbPath)
    try {
      db.exec('CREATE TABLE t(x TEXT)')
      db.prepare('INSERT INTO t(x) VALUES(?)').run('hello')
      // WAL file appears alongside the main db file
      expect(existsSync(`${dbPath}-wal`)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('assertPrelude passes on a freshly-opened file-backed DB', () => {
    const db = openSqlite(join(tmp, 'kv.sqlite'))
    try {
      expect(() => assertPrelude(db)).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('honours custom busyTimeoutMs', () => {
    const db = openSqlite(join(tmp, 'kv.sqlite'), { busyTimeoutMs: 12345 })
    try {
      expect(readState(db).busy_timeout).toBe(12345)
      expect(() => assertPrelude(db, { busyTimeoutMs: 12345 })).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('honours custom cacheSizeKb (encoded as negative value)', () => {
    const db = openSqlite(join(tmp, 'kv.sqlite'), { cacheSizeKb: 32_000 })
    try {
      expect(readState(db).cache_size).toBe(-32000)
    } finally {
      db.close()
    }
  })

  it('honours custom mmapSizeBytes = 0 to disable mmap', () => {
    const db = openSqlite(join(tmp, 'kv.sqlite'), { mmapSizeBytes: 0 })
    try {
      expect(readState(db).mmap_size).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('openSqlite — :memory:', () => {
  it('falls back to `memory` journal mode (WAL unsupported for :memory:)', () => {
    const db = openSqlite(':memory:')
    try {
      expect(readState(db).journal_mode).toBe('memory')
    } finally {
      db.close()
    }
  })

  it('strict assertPrelude rejects :memory: journal', () => {
    const db = openSqlite(':memory:')
    try {
      expect(() => assertPrelude(db)).toThrow(PreludeAssertionError)
    } finally {
      db.close()
    }
  })

  it('assertPrelude with allowMemoryJournal passes on :memory:', () => {
    const db = openSqlite(':memory:')
    try {
      expect(() => assertPrelude(db, { allowMemoryJournal: true })).not.toThrow()
    } finally {
      db.close()
    }
  })
})

describe('applyPrelude on an externally-opened connection', () => {
  it('applies all PRAGMAs and returns observed state', () => {
    // Open the connection ourselves to exercise the "caller already has a
    // connection" path that applyPrelude supports.
    const db = new BetterSqlite3(':memory:')
    try {
      const state = applyPrelude(db)
      expect(state.busy_timeout).toBe(5000)
      expect(state.synchronous).toBe(1)
      expect(state.foreign_keys).toBe(1)
    } finally {
      db.close()
    }
  })
})
