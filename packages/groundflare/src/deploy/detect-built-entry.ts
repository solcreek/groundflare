/**
 * Resolve the actual built Worker entry after a framework build runs.
 *
 * Frameworks like Astro require `main` in wrangler config to point at the
 * SOURCE entry (so the build's pre-flight checks pass). After the build,
 * the actual deployable entry lives somewhere else — discovered here by
 * checking known framework output conventions.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Known Worker entry paths produced by popular frameworks. Checked in
 * order; first existing path wins. Falls back to the user's configured
 * `main` so error messages reference what they wrote.
 */
const FRAMEWORK_ENTRY_CANDIDATES: readonly string[] = [
  // @astrojs/cloudflare v13+ (Astro 5+)
  'dist/server/entry.mjs',
  // @astrojs/cloudflare v12 (Astro 5)
  'dist/_worker.js/index.js',
  // @sveltejs/adapter-cloudflare
  '.svelte-kit/cloudflare/_worker.js',
  // OpenNext for Cloudflare
  '.open-next/worker.js',
  // Hono / vanilla Worker — main usually points directly at the source
  // and esbuild handles bundling.
]

export interface ResolveBuiltEntryOptions {
  readonly cwd: string
  /** The `main` field from wrangler config (source path). */
  readonly main: string
  /** When true, only return a built entry if it exists; never fall back. */
  readonly mustExist?: boolean
}

export interface ResolvedEntry {
  readonly path: string
  /** Where the resolved path came from (for logging). */
  readonly source: 'config' | 'framework-detected'
  /** Which framework convention matched (when source = 'framework-detected'). */
  readonly framework?: string
}

export function resolveBuiltEntry(opts: ResolveBuiltEntryOptions): ResolvedEntry {
  const configEntry = resolve(opts.cwd, opts.main)
  // If the configured main exists and is a built file (not source), use it.
  if (existsSync(configEntry) && !looksLikeSourceFile(configEntry)) {
    return { path: configEntry, source: 'config' }
  }

  // Look for framework-produced outputs.
  for (const candidate of FRAMEWORK_ENTRY_CANDIDATES) {
    const abs = resolve(opts.cwd, candidate)
    if (existsSync(abs)) {
      return {
        path: abs,
        source: 'framework-detected',
        framework: detectFramework(candidate),
      }
    }
  }

  // Nothing found. Return config entry so the downstream error refers to
  // what the user wrote.
  if (opts.mustExist === true && !existsSync(configEntry)) {
    throw new Error(
      `no built entry found at ${opts.main} or any known framework output (` +
        FRAMEWORK_ENTRY_CANDIDATES.join(', ') +
        ')',
    )
  }
  return { path: configEntry, source: 'config' }
}

function looksLikeSourceFile(path: string): boolean {
  // .ts / .tsx in a src/ folder is almost always source — frameworks
  // typically emit .js/.mjs to dist/.
  return /\.(ts|tsx)$/.test(path) && /[\\/]src[\\/]/.test(path)
}

function detectFramework(candidate: string): string {
  if (candidate.startsWith('dist/server/')) return '@astrojs/cloudflare v13+'
  if (candidate.startsWith('dist/_worker.js/')) return '@astrojs/cloudflare v12'
  if (candidate.startsWith('.svelte-kit/')) return '@sveltejs/adapter-cloudflare'
  if (candidate.startsWith('.open-next/')) return 'OpenNext for Cloudflare'
  return 'unknown'
}
