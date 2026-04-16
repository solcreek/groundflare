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
  /**
   * Hard-fail threshold in bytes. Bundles over this throw
   * DeployError(bundle_too_large). Default 50 MB — well past any
   * legitimate Worker, so hitting it almost always means an unintended
   * node_modules leak or the wrong build output. Set to 0 to disable.
   */
  readonly maxBytes?: number
  /**
   * Soft-warning threshold in bytes. Bundles over this emit an advisory
   * into `BundleResult.warnings` (runDeploy surfaces these as `warn`
   * lines). Default 10 MB — Cloudflare's paid-plan compressed limit, so
   * dual-deploy users get a heads-up about CF-side rejection before they
   * push. Set to 0 to disable.
   */
  readonly warnBytes?: number
}

export interface BundleResult {
  readonly code: string
  readonly bytes: number
  /** Warnings from esbuild + our own size advisory. Errors throw. */
  readonly warnings: readonly string[]
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_WARN_BYTES = 10 * 1024 * 1024

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

  const bytes = Buffer.byteLength(outputFile.text, 'utf-8')
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const warnBytes = opts.warnBytes ?? DEFAULT_WARN_BYTES

  if (maxBytes > 0 && bytes > maxBytes) {
    throw new DeployError(
      `bundle is ${formatBytes(bytes)} — exceeds the ${formatBytes(maxBytes)} limit. ` +
        `This usually means a dependency got bundled that should be external ` +
        `(check \`external\` in wrangler.toml), or the wrong build output is being ` +
        `used as \`main\`. Pass \`maxBytes: N\` to override if this is intentional.`,
      'bundle_too_large',
    )
  }

  const warnings = result.warnings.map((w) => w.text)
  if (warnBytes > 0 && bytes > warnBytes) {
    warnings.push(
      `bundle is ${formatBytes(bytes)} — over the ${formatBytes(warnBytes)} ` +
        `advisory (Cloudflare's paid-plan compressed limit). Works on self-hosted workerd/Bun, ` +
        `but will be rejected if you also push to Cloudflare.`,
    )
  }

  return { code: outputFile.text, bytes, warnings }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${bytes} B`
}
