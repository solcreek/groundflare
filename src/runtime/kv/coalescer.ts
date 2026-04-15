/**
 * Write coalescer for SQLite-backed KV (and any other adapter that wants
 * to amortise fsync cost across many small writes).
 *
 * The pattern: pending put/delete operations queue in memory; when either
 * a short time window (default 5ms) elapses or a size cap is reached
 * (default 100 ops), the whole batch flushes inside a single SQLite
 * transaction — one BEGIN / COMMIT / fsync for all of them.
 *
 * Why this works without breaking durability: callers `await` the put()
 * promise. That promise only resolves after the batch has committed to
 * disk. So "ok" still means "on disk", same as before coalescing — we
 * just group many fsync-triggering commits into one.
 *
 * Why it helps: under burst load, each fsync is the dominant cost
 * (milliseconds on SSD, tens on spinning rust). Amortising across 10-100
 * ops cuts effective per-op fsync cost by that factor. See
 * design/sqlite-performance.md §3 for the analysis.
 *
 * Read-after-write consistency: callers that read a key they just wrote
 * (within the same batch window) must see the pending value, not the
 * stale SQL value. The coalescer exposes `latestFor(key)` so the adapter
 * can short-circuit its read path against the pending queue.
 */

export type PendingPut = {
  readonly kind: 'put'
  readonly key: string
  readonly value: Uint8Array
  readonly metadata: string | null
  readonly expiresAt: number | null
}

export type PendingDelete = {
  readonly kind: 'delete'
  readonly key: string
}

export type PendingOp = PendingPut | PendingDelete

type QueueEntry = {
  readonly op: PendingOp
  readonly resolve: () => void
  readonly reject: (err: Error) => void
}

export interface CoalescerOptions {
  /** Max wait before flushing a non-empty batch, in ms. Default 5. */
  windowMs?: number
  /** Max ops in one batch before forced flush. Default 100. */
  maxBatch?: number
}

/**
 * Options for a caller that wants to bypass coalescing — typically tests
 * or conformance checks that need deterministic per-op semantics.
 */
export const IMMEDIATE: Readonly<CoalescerOptions> = Object.freeze({
  windowMs: 0,
  maxBatch: 1,
})

/**
 * The commit callback is responsible for applying the whole batch inside
 * one atomic unit (e.g. `db.transaction(...)` on better-sqlite3, `BEGIN;
 * ... COMMIT;` on any other driver). If it throws, every op in the batch
 * rejects with the same error.
 */
export type CommitFn = (batch: readonly PendingOp[]) => void

export class WriteCoalescer {
  private queue: QueueEntry[] = []
  /**
   * Index of the latest pending op per key. Used by readers to short-
   * circuit against uncommitted writes. When flush empties the queue,
   * this index is cleared too.
   */
  private index = new Map<string, PendingOp>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly windowMs: number
  private readonly maxBatch: number

  constructor(
    private readonly commit: CommitFn,
    opts: CoalescerOptions = {},
  ) {
    this.windowMs = opts.windowMs ?? 5
    this.maxBatch = opts.maxBatch ?? 100
  }

  /**
   * Enqueue an op. Returns a promise that resolves once the batch
   * containing this op has committed to disk.
   */
  enqueue(op: PendingOp): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('WriteCoalescer: closed'))
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ op, resolve, reject })
      this.index.set(op.key, op)

      if (this.maxBatch <= 1 || this.queue.length >= this.maxBatch) {
        // Fast path: flush synchronously. Lets windowMs=0 callers get
        // per-op semantics (one transaction per op).
        this.flushNow()
        return
      }

      if (this.timer === null && this.windowMs > 0) {
        this.timer = setTimeout(() => this.flushNow(), this.windowMs)
      }
    })
  }

  /**
   * Return the most recent pending op for this key, if one is queued.
   * Readers call this before going to SQL to preserve read-after-write
   * consistency within the coalescing window.
   */
  latestFor(key: string): PendingOp | null {
    return this.index.get(key) ?? null
  }

  /**
   * Apply the whole batch atomically; resolve every awaiter on success
   * or reject every awaiter on failure. Synchronous — better-sqlite3's
   * transaction API is sync, and we rely on single-threaded event-loop
   * ordering here: nothing can enqueue during execution.
   */
  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) return

    const batch = this.queue
    this.queue = []
    this.index.clear()

    try {
      this.commit(batch.map((e) => e.op))
      for (const { resolve } of batch) resolve()
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      for (const { reject } of batch) reject(e)
    }
  }

  /**
   * Permanently stop accepting new ops and drain whatever's pending.
   * Safe to call more than once.
   */
  close(): void {
    if (this.closed) return
    this.flushNow()
    this.closed = true
  }

  /** Number of ops currently queued. For observability / tests. */
  get depth(): number {
    return this.queue.length
  }
}
