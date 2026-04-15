// Bun.serve + bun:sqlite in the HN-burst pattern — matches the
// /hn-burst endpoint semantics used by bench-bindings.ts so the Bun
// track numbers are directly comparable with the workerd-DO stack.
//
// Each request:
//   1. generates a unique random key
//   2. writes a small JSON payload into an on-disk SQLite table
//   3. returns 'ok'
//
// On-disk (not :memory:) so fsync cost is represented realistically.
// WAL mode + the same PRAGMA prelude groundflare's Node adapter uses,
// so SQLite configuration is not the differentiator — the runtime is.

import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.BUN_PORT ?? 8092)
const dir = join(tmpdir(), `bun-burst-${process.pid}`)
mkdirSync(dir, { recursive: true })
const dbPath = join(dir, 'burst.sqlite')
const db = new Database(dbPath)

// Match src/runtime/sqlite/prelude.ts so the SQLite settings
// are identical between runtimes.
for (const stmt of [
  'PRAGMA journal_mode = WAL',
  'PRAGMA wal_autocheckpoint = 10000',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA cache_size = -64000',
  'PRAGMA mmap_size = 268435456',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA foreign_keys = ON',
]) db.exec(stmt)

db.exec(`CREATE TABLE IF NOT EXISTS signups (
  key        TEXT PRIMARY KEY,
  value      BLOB NOT NULL,
  created_at INTEGER NOT NULL
)`)

const insert = db.prepare(
  'INSERT OR REPLACE INTO signups (key, value, created_at) VALUES (?, ?, ?)',
)

process.on('exit', () => {
  try {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

Bun.serve({
  port,
  fetch() {
    const userId = Math.random().toString(36).slice(2, 12)
    const payload = JSON.stringify({
      at: Date.now(),
      email: userId + '@example.com',
      signup: true,
    })
    insert.run('signup:' + userId, new TextEncoder().encode(payload), Date.now())
    return new Response('ok')
  },
})

console.log(`bun-sqlite-burst listening on :${port}  (dir=${dir})`)
