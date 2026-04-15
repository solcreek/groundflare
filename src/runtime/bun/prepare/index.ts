/**
 * `groundflare bun prepare` core — run analyze, and if there are no
 * blockers, flip `[groundflare] runtime = "bun"` in wrangler.toml.
 *
 * No codemod, no `src-bun/` copy: after Phase 2 the Bun adapters
 * present the Cloudflare API surface (env.DB.prepare().run(), env.KV.get(),
 * env.R2.put(), …) so the user's Worker source migrates verbatim. All
 * the "real" codegen lives in `src/runtime/bun/build.ts`, invoked at
 * deploy time, not at prepare time.
 *
 * Stays I/O-free in its hot path: callers pass in a `PrepareFs` adapter
 * so unit tests don't touch the filesystem.
 */

import {
  analyzeWorkspace,
  type AnalyzeFs,
} from '../analyze/index.js'
import type { WranglerConfig } from '../../../config/schema.js'
import { patchRuntimeInWranglerToml, TomlPatchError } from './toml-patch.js'
import type {
  PrepareAction,
  PrepareActionKind,
  PrepareResult,
} from './types.js'

export type { PrepareAction, PrepareActionKind, PrepareResult } from './types.js'
export {
  TomlPatchError,
  patchRuntimeInWranglerToml,
} from './toml-patch.js'

export interface PrepareFs extends AnalyzeFs {
  /** Read the wrangler config file as text (for TOML patching). */
  readWranglerSource(): Promise<string>
  /** Write the updated wrangler config file. Must be atomic-enough for tests. */
  writeWranglerSource(content: string): Promise<void>
}

export interface PrepareOptions {
  wrangler: WranglerConfig
  sourceRoot: string
  /** Absolute or repo-relative path that will appear in the report. */
  wranglerPath: string
  /** File format of the wrangler config. Phase 3b only supports 'toml'. */
  wranglerFormat: 'toml' | 'jsonc' | 'json'
  fs: PrepareFs
  /** When true: compute actions but skip writes. */
  dryRun?: boolean
}

export async function prepareWorkspace(
  opts: PrepareOptions,
): Promise<PrepareResult> {
  const analysis = await analyzeWorkspace({
    wrangler: opts.wrangler,
    sourceRoot: opts.sourceRoot,
    fs: opts.fs,
  })

  if (analysis.summary.blockers > 0) {
    return {
      analysis,
      ok: false,
      actions: [],
      bailReason:
        `Cannot prepare for the Bun track: ${analysis.summary.blockers} ` +
        `blocker${analysis.summary.blockers === 1 ? '' : 's'} found. ` +
        `Run \`groundflare bun analyze\` to see the list.`,
    }
  }

  if (opts.wranglerFormat !== 'toml') {
    return {
      analysis,
      ok: false,
      actions: [],
      bailReason:
        `Phase 3b only supports TOML wrangler files; ${opts.wranglerFormat} ` +
        `support lands alongside Phase 4. Convert wrangler.${opts.wranglerFormat} ` +
        `to wrangler.toml or set \`[groundflare] runtime = "bun"\` by hand.`,
    }
  }

  const source = await opts.fs.readWranglerSource()
  let patched
  try {
    patched = patchRuntimeInWranglerToml(source, 'bun')
  } catch (err) {
    if (err instanceof TomlPatchError) {
      return { analysis, ok: false, actions: [], bailReason: err.message }
    }
    throw err
  }

  const actionKind: PrepareActionKind = actionKindFor(patched)
  const action: PrepareAction = {
    kind: opts.dryRun ? 'dry-run' : actionKind,
    file: opts.wranglerPath,
    message: describeAction(actionKind, patched.previous, opts.dryRun ?? false),
  }

  if (!opts.dryRun && patched.content !== source) {
    await opts.fs.writeWranglerSource(patched.content)
  }

  return { analysis, ok: true, actions: [action] }
}

function actionKindFor(patched: {
  kind: 'replaced' | 'inserted' | 'appended'
  previous: string | null
}): ConcretePatchKind {
  if (patched.kind === 'replaced' && patched.previous === 'bun') {
    return 'runtime-already-bun'
  }
  if (patched.kind === 'appended') return 'runtime-appended'
  return 'runtime-set-bun'
}

type ConcretePatchKind = Exclude<PrepareActionKind, 'dry-run'>

function describeAction(
  kind: ConcretePatchKind,
  previous: string | null,
  dryRun: boolean,
): string {
  const prefix = dryRun ? '[dry-run] would ' : ''
  switch (kind) {
    case 'runtime-already-bun':
      return `wrangler.toml already targets the Bun track (no change)`
    case 'runtime-appended':
      return `${prefix}create [groundflare] section with runtime = "bun"`
    case 'runtime-set-bun':
      return `${prefix}set [groundflare].runtime = "bun"${
        previous && previous !== 'bun' ? ` (was "${previous}")` : ''
      }`
  }
}
