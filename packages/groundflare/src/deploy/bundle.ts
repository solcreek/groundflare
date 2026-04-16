/**
 * Bundle the user's Worker entry into a single ES module string via
 * esbuild. The output is what lands on the VPS at
 * /var/lib/groundflare/workers/<name>/code/current/index.js.
 *
 * esbuild is declared as a devDependency — it's invoked from the CLI
 * process, which runs on the operator's machine; the VPS never sees it.
 */

import { build as esbuild } from 'esbuild'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'

import { DeployError } from './types.js'

/** Node built-ins, both bare ("path") and prefixed ("node:path"). */
const NODE_BUILTINS = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

export interface BundleOptions {
  /** Absolute path to the Worker's entry file (TS/JS). */
  readonly entry: string
  /** Optional tsconfig for esbuild to honour. */
  readonly tsconfig?: string
  /** Inject additional externals. `cloudflare:workers` is always external. */
  readonly external?: readonly string[]
  /** Minify the output. Default false — keeps stack traces readable. */
  readonly minify?: boolean
}

export interface BundleResult {
  readonly code: string
  readonly bytes: number
  /** Warnings from esbuild. Errors throw DeployError before reaching here. */
  readonly warnings: readonly string[]
}

/**
 * Bundle the given entry file. Throws DeployError(bundle_failed) with
 * the esbuild error message on failure.
 */
export async function bundleWorker(opts: BundleOptions): Promise<BundleResult> {
  const entry = resolve(opts.entry)
  // workerd built-ins / virtual modules — never bundle these:
  //   - cloudflare:* (CF-namespaced runtime modules)
  //   - node:* (provided by workerd's nodejs_compat flag)
  //   - astro:* + virtual:astro:* (Astro's virtual modules; the Astro
  //     build resolves them and emits real chunks, but inline references
  //     to the virtual specifiers can survive into the built output)
  const externals = [
    'cloudflare:*',
    'astro:*',
    'virtual:astro:*',
    'virtual:astro-cloudflare:*',
    ...NODE_BUILTINS,
    ...(opts.external ?? []),
  ]

  const buildOpts: Parameters<typeof esbuild>[0] = {
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    write: false,
    sourcemap: false,
    minify: opts.minify ?? false,
    external: externals,
    conditions: ['workerd', 'worker', 'browser'],
  }
  if (opts.tsconfig !== undefined) buildOpts.tsconfig = opts.tsconfig

  let result: Awaited<ReturnType<typeof esbuild>>
  try {
    result = await esbuild(buildOpts)
  } catch (err) {
    throw new DeployError(
      `esbuild failed to bundle ${entry}: ${err instanceof Error ? err.message : String(err)}`,
      'bundle_failed',
      { cause: err },
    )
  }

  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => e.text).join('\n')
    throw new DeployError(
      `esbuild reported ${result.errors.length} error(s) bundling ${entry}:\n${messages}`,
      'bundle_failed',
    )
  }

  const outputFile = result.outputFiles?.[0]
  if (!outputFile) {
    throw new DeployError(
      `esbuild produced no output file for ${entry}`,
      'bundle_failed',
    )
  }

  return {
    code: outputFile.text,
    bytes: Buffer.byteLength(outputFile.text, 'utf-8'),
    warnings: result.warnings.map((w) => w.text),
  }
}
