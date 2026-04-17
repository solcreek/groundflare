#!/usr/bin/env node
/**
 * Copy the workerd R2 adapter .ts source into dist/ after tsc runs.
 *
 * `src/runtime/workerd/r2/adapter.worker.ts` is excluded from tsc
 * (it references DOM types like BodyInit that don't fit a Node-only
 * tsconfig — see comments in tsconfig.json). At deploy time, the CLI's
 * `bundleR2Adapter()` calls esbuild with the .ts source as the entry,
 * resolving the typed imports (r2-codec.ts, s3-codec.ts — both compiled
 * to .js by tsc) into a single ES module embedded in the worker capnp.
 *
 * For the published npm package this means we have to ship the .ts
 * file alongside the compiled .js siblings — esbuild reads it directly,
 * Node never executes it. This script is the bridge: copy verbatim into
 * dist/runtime/workerd/r2/ so the published tarball self-contains
 * everything `groundflare deploy` needs.
 *
 * Idempotent. Fails loudly if the source is missing — better to crash
 * the build than ship an incomplete dist/.
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = resolve(repoRoot, 'src/runtime/workerd/r2')
const distDir = resolve(repoRoot, 'dist/runtime/workerd/r2')

await mkdir(distDir, { recursive: true })

const FILES = ['adapter.worker.ts']
for (const name of FILES) {
  const from = resolve(srcDir, name)
  const to = resolve(distDir, name)
  await copyFile(from, to)
  process.stdout.write(`copied ${name} → dist/runtime/workerd/r2/\n`)
}
