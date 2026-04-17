/**
 * esbuild-based bundler for the R2 adapter Worker.
 *
 * Produces a single ES module string ready to embed in capnp via
 * `embed "adapter.worker.js"`. Used by:
 *   - capnp render at deploy time (one bundle per deploy is cheap;
 *     the source rarely changes)
 *   - L2 integration tests at test time
 *
 * The adapter.worker.ts entry imports r2-codec, s3-codec, and the
 * Bun-runtime sigv4. esbuild inlines all three into a single
 * self-contained ESM. Result is < 25 KB minified.
 *
 * Why not `tsc`: adapter.worker.ts targets workerd's runtime, which
 * exposes Web APIs (Request/Response/ReadableStream/etc.) and supports
 * ES2022 modules natively. esbuild's bundle step handles the imports
 * we care about (relative + bun/adapters/sigv4) without dragging in
 * Node typings or workerd-types.
 */

import { build as esbuild } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(HERE, 'adapter.worker.ts')

export interface BundleR2AdapterOptions {
  /** Override the entry path (tests). Defaults to the shipped source. */
  readonly entry?: string
  /** Minify the output. Default false (keeps stack traces readable). */
  readonly minify?: boolean
}

export interface BundleR2AdapterResult {
  /** ES module source ready to embed. */
  readonly code: string
  /** Byte length of the bundle (informational). */
  readonly bytes: number
}

/**
 * Bundle the R2 adapter Worker into a single ES module.
 * Throws on bundle failure with the esbuild error message.
 */
export async function bundleR2Adapter(
  opts: BundleR2AdapterOptions = {},
): Promise<BundleR2AdapterResult> {
  const entry = opts.entry ?? ENTRY
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    write: false,
    sourcemap: false,
    minify: opts.minify ?? false,
    // workerd built-ins / virtual modules — never bundle these.
    external: ['cloudflare:*', 'node:*'],
    conditions: ['workerd', 'worker', 'browser'],
  })
  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => e.text).join('\n')
    throw new Error(`R2 adapter bundle failed:\n${messages}`)
  }
  const file = result.outputFiles?.[0]
  if (!file) {
    throw new Error('R2 adapter bundle produced no output')
  }
  return { code: file.text, bytes: Buffer.byteLength(file.text, 'utf-8') }
}
