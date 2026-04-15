/**
 * Load the Bun-runtime adapter sources as strings.
 *
 * The .ts files in this directory are the canonical source: they're
 * type-checked by tsc, executed by `bun test` for behavioural tests,
 * and shipped verbatim to the VPS where `bun run` executes them.
 *
 * This file gives the CLI (running on Node) a way to read those
 * sources at build-time without duplicating them into String.raw
 * constants — a drift hazard we explicitly avoided in favour of a
 * single source of truth.
 *
 * Published package invariant: `src/runtime/bun/adapters/*.ts` must
 * ship in the npm tarball. package.json `files` enforces this.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function readAdapterSource(name: string): string {
  const url = new URL(`./${name}`, import.meta.url)
  return readFileSync(fileURLToPath(url), 'utf-8')
}

export const BUN_KV_ADAPTER_SOURCE = readAdapterSource('kv.ts')
