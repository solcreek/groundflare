#!/usr/bin/env node
/**
 * Copy the Bun-runtime adapter .ts sources into dist/ after `tsc -p
 * tsconfig.build.json` runs.
 *
 * The `src/runtime/bun/adapters/*.ts` files are excluded from the
 * build tsconfig because they import `bun:sqlite` + reference BodyInit
 * / BufferSource from Bun's type surface — a Node tsc can't resolve
 * them. But `src/runtime/bun/adapters/sources.ts` (which tsc _does_
 * compile) reads them as raw text via `new URL('./kv.ts', …)` at
 * runtime, so they must exist next to the compiled sources.js in the
 * published npm tarball.
 *
 * This script is the minimal bridge: copy the four .ts files verbatim
 * into dist/runtime/bun/adapters/ so the published `groundflare deploy`
 * can embed them into the Bun shim it generates.
 *
 * Idempotent; safe to re-run. Fails loudly if any expected source is
 * missing, so a drift between the file list here and what sources.ts
 * reads is caught at build time rather than at deploy time.
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADAPTERS = ['kv.ts', 'd1.ts', 'r2.ts', 'sigv4.ts']

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = resolve(repoRoot, 'src/runtime/bun/adapters')
const distDir = resolve(repoRoot, 'dist/runtime/bun/adapters')

await mkdir(distDir, { recursive: true })

for (const name of ADAPTERS) {
  const from = resolve(srcDir, name)
  const to = resolve(distDir, name)
  await copyFile(from, to)
  process.stdout.write(`copied ${name} → dist/runtime/bun/adapters/\n`)
}
