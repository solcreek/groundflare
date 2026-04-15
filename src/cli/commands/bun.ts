/**
 * `groundflare bun` — Bun-track migration tooling.
 *
 * Subcommands:
 *   analyze   Read wrangler.toml + worker source, classify each binding
 *             and feature against the Bun-track compatibility matrix,
 *             print a human report (or JSON with `--json`). Exit 1 if
 *             any blockers are found so CI can gate on it.
 *   prepare   Run analyze; if clean, flip `[groundflare] runtime = "bun"`
 *             in wrangler.toml and print next-steps. Source stays
 *             unchanged — Phase 2 adapters present the CF API surface,
 *             so no codemod is needed for the common case.
 *
 * Design contract: see `design/tracks.md` §`bun analyze` / `bun prepare`.
 */

import { defineCommand } from 'citty'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path'
import {
  ConfigNotFoundError,
  ConfigParseError,
  resolveConfig,
} from '../../config/index.js'
import type { ResolvedConfig } from '../../config/index.js'
import {
  renderHuman,
  renderJson,
  type AnalyzeFs,
} from '../../runtime/bun/analyze/index.js'
import {
  prepareWorkspace,
  type PrepareAction,
  type PrepareFs,
  type PrepareResult,
} from '../../runtime/bun/prepare/index.js'
import { analyzeWorkspace } from '../../runtime/bun/analyze/index.js'
import { log } from '../log.js'

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.wrangler',
  '.groundflare',
  '.git',
])

const analyzeCmd = defineCommand({
  meta: {
    name: 'analyze',
    description:
      'Classify wrangler.toml bindings + worker source against the Bun-track compatibility matrix',
  },
  args: {
    cwd: {
      type: 'string',
      description: 'Directory containing wrangler.toml (default: cwd)',
    },
    src: {
      type: 'string',
      description:
        'Source root to scan (default: directory of wrangler `main`, else `src/`)',
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON instead of a human report',
    },
  },
  async run({ args }) {
    const ctx = await loadContext({ cwd: args.cwd, srcOverride: args.src })
    const report = await analyzeWorkspace({
      wrangler: ctx.resolved.wrangler,
      sourceRoot: ctx.sourceRootRel,
      fs: ctx.analyzeFs,
    })
    process.stdout.write(
      args.json ? `${renderJson(report)}\n` : `${renderHuman(report)}\n`,
    )
    if (report.summary.blockers > 0) process.exit(1)
  },
})

const prepareCmd = defineCommand({
  meta: {
    name: 'prepare',
    description:
      'Flip `[groundflare] runtime = "bun"` in wrangler.toml after a clean analyze',
  },
  args: {
    cwd: {
      type: 'string',
      description: 'Directory containing wrangler.toml (default: cwd)',
    },
    src: {
      type: 'string',
      description:
        'Source root to scan (default: directory of wrangler `main`, else `src/`)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report what prepare would do without writing',
    },
  },
  async run({ args }) {
    const ctx = await loadContext({ cwd: args.cwd, srcOverride: args.src })
    const result = await prepareWorkspace({
      wrangler: ctx.resolved.wrangler,
      sourceRoot: ctx.sourceRootRel,
      wranglerPath: ctx.resolved.source.file,
      wranglerFormat: ctx.resolved.source.format,
      fs: ctx.prepareFs,
      dryRun: Boolean(args['dry-run']),
    })
    renderPrepareReport(result)
    if (!result.ok) process.exit(1)
  },
})

export default defineCommand({
  meta: {
    name: 'bun',
    description: 'Bun-track tooling: analyze + prepare worker migrations',
  },
  subCommands: {
    analyze: analyzeCmd,
    prepare: prepareCmd,
  },
})

// ─── helpers ───────────────────────────────────────────────────────

interface BunCommandContext {
  resolved: ResolvedConfig
  /** Absolute path to the project root (= directory of the wrangler file). */
  projectRoot: string
  /** Project-root-relative source root (posix-style) for the report. */
  sourceRootRel: string
  analyzeFs: AnalyzeFs
  prepareFs: PrepareFs
}

async function loadContext(opts: {
  cwd?: string
  srcOverride?: string
}): Promise<BunCommandContext> {
  const cwd = resolve(opts.cwd ?? process.cwd())
  let resolved: ResolvedConfig
  try {
    resolved = await resolveConfig({ cwd })
  } catch (err) {
    if (err instanceof ConfigNotFoundError || err instanceof ConfigParseError) {
      log.error(err.message)
      process.exit(1)
    }
    throw err
  }
  const projectRoot = dirname(resolved.source.file)
  const sourceRootAbs = await pickSourceRoot({
    cliOverride: opts.srcOverride,
    mainPath: resolved.wrangler.main,
    projectRoot,
  })
  const sourceRootRel = toPosix(relative(projectRoot, sourceRootAbs) || '.')

  const analyzeFs: AnalyzeFs = {
    async listSourceFiles(root) {
      const absRoot = resolveAgainst(projectRoot, root)
      const absFiles = await walkSources(absRoot)
      return absFiles
        .map((abs) => toPosix(relative(projectRoot, abs)))
        .sort()
    },
    async readSource(rel) {
      return readFile(resolve(projectRoot, rel), 'utf-8')
    },
  }

  const prepareFs: PrepareFs = {
    ...analyzeFs,
    async readWranglerSource() {
      return readFile(resolved.source.file, 'utf-8')
    },
    async writeWranglerSource(content) {
      await writeFile(resolved.source.file, content, 'utf-8')
    },
  }

  return { resolved, projectRoot, sourceRootRel, analyzeFs, prepareFs }
}

function renderPrepareReport(result: PrepareResult): void {
  if (!result.ok) {
    log.error(result.bailReason ?? 'prepare failed')
    return
  }
  for (const action of result.actions) {
    log.success(formatPrepareAction(action))
  }
  log.info(
    `Source is unchanged — Bun adapters present the Cloudflare API surface for KV / D1 / R2.`,
  )
  log.info(`Next: \`groundflare up\` to deploy on the Bun track.`)
}

function formatPrepareAction(action: PrepareAction): string {
  return `${action.message} (${action.file})`
}

function resolveAgainst(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p)
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join(posix.sep)
}

async function pickSourceRoot(opts: {
  cliOverride: string | undefined
  mainPath: string | undefined
  projectRoot: string
}): Promise<string> {
  if (opts.cliOverride) {
    return resolveAgainst(opts.projectRoot, opts.cliOverride)
  }
  if (opts.mainPath) {
    const dir = dirname(resolveAgainst(opts.projectRoot, opts.mainPath))
    if (await isDir(dir)) return dir
  }
  const guessed = resolve(opts.projectRoot, 'src')
  if (await isDir(guessed)) return guessed
  return opts.projectRoot
}

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

/**
 * Recursive source walker — yields absolute paths of TS/JS files under
 * `absRoot`, skipping tracked-out directories and *.test.*. Stops at
 * symlinks to avoid following node_modules cross-links into infinity.
 * Missing roots yield [] (not an error — the CLI already picked the
 * root and a missing dir just means "nothing to analyze").
 */
async function walkSources(absRoot: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue
        await visit(resolve(dir, name))
      } else if (entry.isFile()) {
        if (!SOURCE_EXT.test(name)) continue
        if (TEST_FILE.test(name)) continue
        out.push(resolve(dir, name))
      }
    }
  }
  await visit(absRoot)
  return out
}
