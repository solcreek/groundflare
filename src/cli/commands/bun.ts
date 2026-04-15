/**
 * `groundflare bun` — Bun-track migration tooling.
 *
 * Subcommands:
 *   analyze   Read wrangler.toml + worker source, classify each binding
 *             and feature against the Bun-track compatibility matrix,
 *             print a human report (or JSON with `--json`). Exit 1 if
 *             any blockers are found so CI can gate on it.
 *   prepare   (Phase 3b — not implemented yet)
 *
 * Design contract: see `design/tracks.md` §`bun analyze`.
 */

import { defineCommand } from 'citty'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path'
import {
  ConfigNotFoundError,
  ConfigParseError,
  resolveConfig,
} from '../../config/index.js'
import {
  analyzeWorkspace,
  renderHuman,
  renderJson,
  type AnalyzeFs,
} from '../../runtime/bun/analyze/index.js'
import { log, notImplemented } from '../log.js'

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
    const cwd = resolve(args.cwd ?? process.cwd())
    let resolved
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
    const sourceRoot = await pickSourceRoot({
      cliOverride: args.src,
      mainPath: resolved.wrangler.main,
      projectRoot,
    })

    const fs: AnalyzeFs = {
      async listSourceFiles(root) {
        const absRoot = resolveAgainst(projectRoot, root)
        const absFiles = await walkSources(absRoot)
        // Report relative to projectRoot for nicer locations.
        return absFiles
          .map((abs) => toPosix(relative(projectRoot, abs)))
          .sort()
      },
      async readSource(rel) {
        return readFile(resolve(projectRoot, rel), 'utf-8')
      },
    }

    const report = await analyzeWorkspace({
      wrangler: resolved.wrangler,
      sourceRoot: toPosix(relative(projectRoot, sourceRoot) || '.'),
      fs,
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
      'Generate a Bun-runtime entry + binding facades from a workerd-style worker (Phase 3b)',
  },
  async run() {
    notImplemented(
      'bun prepare',
      'Phase 3b. Run `groundflare bun analyze --json` today to inspect your worker against the Bun-track compatibility matrix.',
    )
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
