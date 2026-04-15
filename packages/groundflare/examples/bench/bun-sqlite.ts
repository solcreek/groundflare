// Bun HTTP handler backed by bun:sqlite. Returns a count from a pre-seeded table
// to mirror a typical D1 read in a CF Worker.
import { Database } from 'bun:sqlite'

const port = Number(process.env.BUN_PORT ?? 8092)
const db = new Database(':memory:')

db.exec('CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL)')
const insert = db.prepare('INSERT INTO visits (ts) VALUES (?)')
const count = db.prepare('SELECT COUNT(*) as n FROM visits')

// Seed a few rows so SELECT is non-trivial.
for (let i = 0; i < 100; i++) insert.run(new Date().toISOString())

Bun.serve({
  port,
  fetch() {
    insert.run(new Date().toISOString())
    const row = count.get() as { n: number }
    return Response.json({ n: row.n })
  },
})

console.log(`bun-sqlite listening on :${port}`)
