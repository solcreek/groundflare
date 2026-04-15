/**
 * Copy a template tree into the target directory with placeholder
 * substitution.
 *
 * Pure function: takes a ScaffoldFs adapter so tests run entirely
 * in memory. The production CLI wires up a filesystem-backed adapter
 * in src/cli.ts.
 *
 * Substitution rules (keep minimal on purpose — "scaffold" should
 * resist scope creep into "build tool"):
 *
 *   {{name}}                 → projectName
 *   {{compatibility_date}}   → today's UTC date, yyyy-mm-dd
 *
 * Binary files are copied verbatim (Buffer passthrough). Only .txt-
 * like extensions get substitution. The extension list is explicit
 * rather than "all text files" so a future binary template asset
 * (favicon.ico, etc.) doesn't accidentally round-trip through
 * UTF-8 decode + encode.
 */

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.tsx',
  '.jsx',
  '.json',
  '.jsonc',
  '.toml',
  '.yaml',
  '.yml',
  '.md',
  '.txt',
  '.html',
  '.css',
  '.svg',
  '.gitignore',
])

export interface TemplateSpec {
  /** Template identifier (directory name under templates/). */
  readonly name: string
  /** Optional human-readable description (surfaced in interactive picks later). */
  readonly description?: string
}

/**
 * Filesystem abstraction used by scaffoldProject. Production adapter
 * wraps node:fs; tests pass in an in-memory one. Deliberately narrow —
 * only the primitives scaffolding needs.
 */
export interface ScaffoldFs {
  /** List all files in the template recursively. Paths are template-relative. */
  listTemplate(template: string): Promise<readonly string[]>
  /** Read a file from the template. */
  readTemplate(template: string, relPath: string): Promise<Buffer>
  /**
   * True iff `absTargetPath` already exists. If true, scaffoldProject
   * refuses to overwrite (unless `force`).
   */
  targetExists(absTargetPath: string): Promise<boolean>
  /** Create the target directory and any missing parents. */
  ensureDir(absDirPath: string): Promise<void>
  /** Write a file to the target. Callers guarantee parent dirs exist. */
  writeTarget(absPath: string, contents: Buffer): Promise<void>
}

export interface ScaffoldOptions {
  /** Final project name, used for the `name` field in package.json + substitutions. */
  readonly projectName: string
  /** Absolute path of the project root to create. */
  readonly targetDir: string
  /** Template identifier (e.g. 'minimal'). */
  readonly template: string
  /** Adapter for all filesystem I/O. */
  readonly fs: ScaffoldFs
  /**
   * Clock injection. Default `() => new Date()`. Tests pass a fixed
   * Date so substitutions are deterministic.
   */
  readonly now?: () => Date
  /** When true, overwrite existing target. Default false. */
  readonly force?: boolean
}

export interface ScaffoldFile {
  readonly relPath: string
  readonly bytes: number
  readonly substituted: boolean
}

export interface ScaffoldResult {
  readonly projectName: string
  readonly targetDir: string
  readonly template: string
  readonly files: readonly ScaffoldFile[]
  readonly compatibilityDate: string
}

export class ScaffoldError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'target_exists'
      | 'template_empty'
      | 'invalid_name',
  ) {
    super(message)
    this.name = 'ScaffoldError'
  }
}

const VALID_PROJECT_NAME = /^[a-z0-9][a-z0-9-_]*$/

export async function scaffoldProject(
  opts: ScaffoldOptions,
): Promise<ScaffoldResult> {
  if (!VALID_PROJECT_NAME.test(opts.projectName)) {
    throw new ScaffoldError(
      `project name must match /^[a-z0-9][a-z0-9-_]*$/ (got ${JSON.stringify(opts.projectName)})`,
      'invalid_name',
    )
  }

  const existed = await opts.fs.targetExists(opts.targetDir)
  if (existed && opts.force !== true) {
    throw new ScaffoldError(
      `target directory already exists: ${opts.targetDir} (pass force to overwrite)`,
      'target_exists',
    )
  }

  const files = await opts.fs.listTemplate(opts.template)
  if (files.length === 0) {
    throw new ScaffoldError(
      `template ${JSON.stringify(opts.template)} has no files`,
      'template_empty',
    )
  }

  const now = opts.now ? opts.now() : new Date()
  const compatibilityDate = formatUtcDate(now)

  const substitutions: Record<string, string> = {
    name: opts.projectName,
    compatibility_date: compatibilityDate,
  }

  await opts.fs.ensureDir(opts.targetDir)
  const written: ScaffoldFile[] = []
  for (const relPath of files) {
    const raw = await opts.fs.readTemplate(opts.template, relPath)
    const ext = extOf(relPath)
    const isText = TEXT_EXTENSIONS.has(ext)
    const finalRel = rewriteDotFile(relPath)
    const absPath = joinPath(opts.targetDir, finalRel)
    await opts.fs.ensureDir(dirOf(absPath))

    let contents: Buffer
    let substituted = false
    if (isText) {
      const before = raw.toString('utf-8')
      const after = applySubstitutions(before, substitutions)
      substituted = before !== after
      contents = Buffer.from(after, 'utf-8')
    } else {
      contents = raw
    }
    await opts.fs.writeTarget(absPath, contents)
    written.push({ relPath: finalRel, bytes: contents.byteLength, substituted })
  }

  return {
    projectName: opts.projectName,
    targetDir: opts.targetDir,
    template: opts.template,
    files: written,
    compatibilityDate,
  }
}

// ─── helpers ───────────────────────────────────────────────────────

export function applySubstitutions(
  source: string,
  substitutions: Record<string, string>,
): string {
  return source.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (match, key) => {
    if (typeof key === 'string' && key in substitutions) {
      return substitutions[key]!
    }
    return match
  })
}

export function formatUtcDate(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = d.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function extOf(p: string): string {
  const idx = p.lastIndexOf('.')
  if (idx < 0) return ''
  // Last-segment-only: don't confuse "foo.d/bar" with extension "d/bar".
  const slashIdx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (slashIdx > idx) return ''
  return p.slice(idx)
}

function dirOf(absPath: string): string {
  const idx = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'))
  return idx < 0 ? absPath : absPath.slice(0, idx)
}

function joinPath(a: string, b: string): string {
  if (a.endsWith('/') || a.endsWith('\\')) return a + b
  return a + '/' + b
}

/**
 * Template files named "_.gitignore", "_package.json" etc. are renamed
 * to the dotfile / real filename on write. npm publishes . filtering
 * rules (.npmignore, .gitignore) and the npm pack tarball walker both
 * get weird about real dotfiles at package.json `files` entries, so
 * the template stores them with an underscore prefix.
 */
function rewriteDotFile(relPath: string): string {
  return relPath.replace(/(^|\/)_(gitignore|npmignore|prettierrc|eslintrc)/g, '$1.$2')
}
