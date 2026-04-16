import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname, isAbsolute } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type {
  ConfigFormat,
  ConfigSource,
  GroundflareSection,
  ReadConfigResult,
  WranglerConfig,
} from './schema.js'

const CANDIDATE_FILENAMES = ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'] as const

export class ConfigNotFoundError extends Error {
  constructor(public readonly searchedFrom: string) {
    super(
      `No wrangler config found. Looked for ${CANDIDATE_FILENAMES.join(' / ')} ` +
        `starting from ${searchedFrom} up to the filesystem root.`,
    )
    this.name = 'ConfigNotFoundError'
  }
}

export class ConfigParseError extends Error {
  constructor(
    public readonly file: string,
    cause: unknown,
  ) {
    super(`Failed to parse ${file}: ${errorMessage(cause)}`, { cause })
    this.name = 'ConfigParseError'
  }
}

/**
 * Walk up from `startDir` toward the filesystem root, returning the first
 * wrangler.{toml,jsonc,json} found. Returns null if nothing is found.
 */
export function findWranglerConfig(startDir: string): string | null {
  let dir = isAbsolute(startDir) ? startDir : resolve(startDir)
  while (true) {
    for (const name of CANDIDATE_FILENAMES) {
      const candidate = resolve(dir, name)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Read and parse a wrangler config file, splitting out the `[groundflare]`
 * extensions into its own object. Throws ConfigParseError on malformed input.
 */
export async function readConfigFile(path: string): Promise<ReadConfigResult> {
  const format = detectFormat(path)
  const raw = await readFile(path, 'utf-8')

  let parsed: Record<string, unknown>
  try {
    parsed = parseRaw(raw, format)
  } catch (err) {
    throw new ConfigParseError(path, err)
  }

  const groundflareRaw = parsed.groundflare
  const groundflare: GroundflareSection = isRecord(groundflareRaw) ? (groundflareRaw as GroundflareSection) : {}

  // Strip the extension key so the wrangler view only sees fields wrangler
  // itself would recognize.
  const wranglerOnly: Record<string, unknown> = { ...parsed }
  delete wranglerOnly.groundflare

  const wrangler = validateWranglerShape(wranglerOnly, path)
  const source: ConfigSource = { file: path, format }

  return { wrangler, groundflare, source }
}

// ─── internals ─────────────────────────────────────────────────────

function detectFormat(path: string): ConfigFormat {
  if (path.endsWith('.toml')) return 'toml'
  if (path.endsWith('.jsonc')) return 'jsonc'
  return 'json'
}

function parseRaw(raw: string, format: ConfigFormat): Record<string, unknown> {
  if (format === 'toml') {
    return parseToml(raw) as Record<string, unknown>
  }
  let source = format === 'jsonc' ? stripJsonComments(raw) : raw
  if (format === 'jsonc') {
    // Strip trailing commas — common in JSONC but rejected by JSON.parse.
    source = source.replace(/,\s*([}\]])/g, '$1')
  }
  return JSON.parse(source)
}

function validateWranglerShape(obj: Record<string, unknown>, path: string): WranglerConfig {
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new ConfigParseError(path, new Error('missing required field `name` (string)'))
  }
  return obj as unknown as WranglerConfig
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Strip `// line` and `/* block *\/` comments from a JSONC source, respecting
 * string literals. Small and zero-dep; sufficient for wrangler.jsonc files
 * which are plain JSON-with-comments, not full JSON5.
 */
export function stripJsonComments(src: string): string {
  let out = ''
  let i = 0
  let inString = false
  let stringChar = ''
  while (i < src.length) {
    const ch = src[i]!
    const next = i + 1 < src.length ? src[i + 1]! : ''

    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next
        i += 2
        continue
      }
      if (ch === stringChar) inString = false
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      stringChar = ch
      out += ch
      i++
      continue
    }

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }

    if (ch === '/' && next === '*') {
      i += 2
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }

    out += ch
    i++
  }
  return out
}
