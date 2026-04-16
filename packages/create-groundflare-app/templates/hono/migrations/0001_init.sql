-- Initial schema for the items CRUD example.
-- Apply via:
--   Cloudflare:  npx wrangler d1 execute <db-name> --file=migrations/0001_init.sql
--   groundflare: auto-applied on first deploy (the D1 adapter runs
--                migrations at startup — see design/config.md)

CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
