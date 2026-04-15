/**
 * Runtime-agnostic SQLite PRAGMA prelude.
 *
 * Every SQLite-backed subsystem in groundflare (D1, KV, Durable Objects,
 * Queues) opens its database file through a driver and must apply this
 * exact sequence of PRAGMAs on a fresh connection before any user query.
 *
 * Without this prelude (specifically WAL + busy_timeout), concurrent
 * workerd request handlers serialize through SQLite's default EXCLUSIVE
 * locks and throughput collapses to the low hundreds of writes/second.
 * With it, a single SQLite file comfortably handles tens of thousands of
 * ops/s on commodity NVMe — see design/benchmarks.md Stage 2c.
 *
 * The `preludeStatements()` helper returns the raw SQL strings; each
 * driver (better-sqlite3 in Node tests, workerd's built-in SQLite in
 * production, bun:sqlite in the Bun track) wraps them through its own
 * execution API but runs the same text.
 *
 * See design/config.md#standard-sqlite-pragmas for rationale per PRAGMA.
 */

export interface SqlitePreludeOptions {
  /**
   * Page cache size in KB. Default 64_000 (64 MB). SQLite encodes the
   * value as a negative integer when the unit is KB; preludeStatements
   * handles that detail.
   */
  cacheSizeKb?: number

  /**
   * Memory-mapped I/O region size in bytes. Default 256 MB.
   * Set to 0 to disable mmap (reads fall back to read(2) syscalls).
   */
  mmapSizeBytes?: number

  /**
   * How long to wait on a writer lock before returning SQLITE_BUSY, in ms.
   * Default 5000. Critical under concurrent writes; without this set the
   * application layer has to implement retry itself.
   */
  busyTimeoutMs?: number

  /**
   * Threshold (in WAL frames / SQLite pages) at which the write path
   * triggers an auto-checkpoint. SQLite's default is 1000. We raise it
   * to 10000 so checkpoint pauses fire roughly 10× less often, reducing
   * the probability of any given request hitting a checkpoint stall.
   *
   * Trade-off: the WAL file grows larger between checkpoints
   * (~40 MB at 4 KB page size) — harmless for performance, matters only
   * for free disk calculation. See design/sqlite-performance.md §1.
   *
   * Only meaningful after journal_mode=WAL is active; the prelude emits
   * this PRAGMA immediately after the WAL statement.
   */
  walAutocheckpointPages?: number
}

export const PRELUDE_DEFAULTS = Object.freeze({
  cacheSizeKb: 64_000,
  mmapSizeBytes: 268_435_456, // 256 MB
  busyTimeoutMs: 5000,
  walAutocheckpointPages: 10_000,
})

/**
 * The canonical prelude, in the order it must be applied. WAL must be
 * set before any data-writing PRAGMA so the WAL file is used from the
 * first write forward.
 */
export function preludeStatements(opts: SqlitePreludeOptions = {}): string[] {
  const cacheSize = -(opts.cacheSizeKb ?? PRELUDE_DEFAULTS.cacheSizeKb)
  const mmapSize = opts.mmapSizeBytes ?? PRELUDE_DEFAULTS.mmapSizeBytes
  const busyTimeout = opts.busyTimeoutMs ?? PRELUDE_DEFAULTS.busyTimeoutMs
  const walCheckpoint =
    opts.walAutocheckpointPages ?? PRELUDE_DEFAULTS.walAutocheckpointPages

  return [
    'PRAGMA journal_mode = WAL',
    `PRAGMA wal_autocheckpoint = ${walCheckpoint}`,
    'PRAGMA synchronous = NORMAL',
    `PRAGMA busy_timeout = ${busyTimeout}`,
    `PRAGMA cache_size = ${cacheSize}`,
    `PRAGMA mmap_size = ${mmapSize}`,
    'PRAGMA temp_store = MEMORY',
    'PRAGMA foreign_keys = ON',
  ]
}

/**
 * Observed PRAGMA state after the prelude has been applied. Values use
 * SQLite's native encoding:
 *   journal_mode  — string like 'wal' (or 'memory' for :memory: DBs)
 *   synchronous   — 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
 *   busy_timeout  — milliseconds
 *   cache_size    — negative for KB, positive for pages
 *   mmap_size     — bytes
 *   temp_store    — 0=default, 1=FILE, 2=MEMORY
 *   foreign_keys  — 0 | 1
 */
export interface PreludeState {
  journal_mode: string
  wal_autocheckpoint: number
  synchronous: number
  busy_timeout: number
  cache_size: number
  mmap_size: number
  temp_store: number
  foreign_keys: number
}

/**
 * Adapter for whatever driver is in use. Each runtime (Node via
 * better-sqlite3, workerd, Bun) implements this shape by calling its
 * own `.pragma(name)` equivalent. The type deliberately takes only a
 * reader — it cannot mutate the connection, which makes assertion
 * safe to call from test harnesses.
 */
export interface PragmaReader {
  read(name: string): string | number | undefined
}

export function readPreludeState(reader: PragmaReader): PreludeState {
  return {
    journal_mode: String(reader.read('journal_mode')).toLowerCase(),
    wal_autocheckpoint: numberOrZero(reader.read('wal_autocheckpoint')),
    synchronous: Number(reader.read('synchronous')),
    busy_timeout: Number(reader.read('busy_timeout')),
    cache_size: Number(reader.read('cache_size')),
    // SQLite returns undefined for mmap_size on :memory: DBs; coerce to 0
    // so downstream code doesn't need to worry about NaN arithmetic.
    mmap_size: numberOrZero(reader.read('mmap_size')),
    temp_store: Number(reader.read('temp_store')),
    foreign_keys: Number(reader.read('foreign_keys')),
  }
}

function numberOrZero(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export class PreludeAssertionError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`SQLite prelude not properly applied:\n  ${problems.join('\n  ')}`)
    this.name = 'PreludeAssertionError'
  }
}

export interface AssertPreludeOptions extends SqlitePreludeOptions {
  /**
   * SQLite silently falls back to `memory` journal_mode for `:memory:`
   * databases — setting WAL there is a no-op. Conformance tests that
   * use in-memory DBs should pass `allowMemoryJournal: true`.
   */
  allowMemoryJournal?: boolean
}

/**
 * Throw if any PRAGMA is not at the expected value. Conformance tests
 * call this after adapter setup so a missing PRAGMA can't silently
 * cripple production throughput.
 */
export function assertPreludeApplied(
  state: PreludeState,
  opts: AssertPreludeOptions = {},
): void {
  const problems: string[] = []

  const validJournal = opts.allowMemoryJournal ? ['wal', 'memory'] : ['wal']
  if (!validJournal.includes(state.journal_mode)) {
    problems.push(`journal_mode=${state.journal_mode}, want ${validJournal.join('|')}`)
  }

  const expectedCheckpoint =
    opts.walAutocheckpointPages ?? PRELUDE_DEFAULTS.walAutocheckpointPages
  // wal_autocheckpoint reads back as 0 on :memory: DBs (no WAL file);
  // skip the check there for the same reason we skip mmap.
  const skipCheckpoint = opts.allowMemoryJournal === true && state.journal_mode === 'memory'
  if (!skipCheckpoint && state.wal_autocheckpoint !== expectedCheckpoint) {
    problems.push(
      `wal_autocheckpoint=${state.wal_autocheckpoint}, want ${expectedCheckpoint}`,
    )
  }

  if (state.synchronous !== 1) {
    problems.push(`synchronous=${state.synchronous}, want 1 (NORMAL)`)
  }

  const expectedBusy = opts.busyTimeoutMs ?? PRELUDE_DEFAULTS.busyTimeoutMs
  if (state.busy_timeout !== expectedBusy) {
    problems.push(`busy_timeout=${state.busy_timeout}, want ${expectedBusy}`)
  }

  const expectedCache = -(opts.cacheSizeKb ?? PRELUDE_DEFAULTS.cacheSizeKb)
  if (state.cache_size !== expectedCache) {
    problems.push(`cache_size=${state.cache_size}, want ${expectedCache}`)
  }

  const expectedMmap = opts.mmapSizeBytes ?? PRELUDE_DEFAULTS.mmapSizeBytes
  // mmap is meaningless for :memory: DBs (SQLite returns undefined -> 0);
  // skip the check when we're already accepting the memory journal mode.
  const skipMmap = opts.allowMemoryJournal === true && state.journal_mode === 'memory'
  if (!skipMmap && state.mmap_size !== expectedMmap) {
    problems.push(`mmap_size=${state.mmap_size}, want ${expectedMmap}`)
  }

  if (state.temp_store !== 2) {
    problems.push(`temp_store=${state.temp_store}, want 2 (MEMORY)`)
  }

  if (state.foreign_keys !== 1) {
    problems.push(`foreign_keys=${state.foreign_keys}, want 1`)
  }

  if (problems.length > 0) {
    throw new PreludeAssertionError(problems)
  }
}
