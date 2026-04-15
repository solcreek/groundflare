import { findWranglerConfig, readConfigFile, ConfigNotFoundError } from './reader.js'
import { STATIC_DEFAULTS } from './defaults.js'
import type {
  GroundflareSection,
  ProviderName,
  ReadConfigResult,
  RuntimeKind,
} from './schema.js'

export interface ResolveOptions {
  /** Directory to search upward from for wrangler.{toml,jsonc,json}. Defaults to process.cwd(). */
  cwd?: string
  /** Skip disk I/O; use this pre-read config result instead. */
  preRead?: ReadConfigResult
  /** Overrides applied after the file's `[groundflare]` section, before env vars. */
  cliOverrides?: Partial<GroundflareSection>
  /** process.env-shaped map used for `GROUNDFLARE_*` extraction. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** When set, merges `[groundflare.env.<name>]` on top of the base section. */
  envName?: string
}

export interface ResolvedConfig extends ReadConfigResult {
  /** Final merged groundflare section after defaults + file + env-override + CLI + env-vars. */
  resolved: GroundflareSection
}

/**
 * Resolution order (later overrides earlier):
 *   1. STATIC_DEFAULTS
 *   2. file `[groundflare]` section
 *   3. file `[groundflare.env.<envName>]` section (if envName provided)
 *   4. cliOverrides argument
 *   5. GROUNDFLARE_* environment variables
 */
export async function resolveConfig(opts: ResolveOptions = {}): Promise<ResolvedConfig> {
  const read = opts.preRead ?? (await readFromDisk(opts.cwd ?? process.cwd()))

  // Strip `env` from the base groundflare section before merging — it's a
  // namespace for per-env overrides, not a runtime setting.
  const { env: envOverrides, ...base } = read.groundflare

  let resolved: GroundflareSection = deepMerge(STATIC_DEFAULTS, base)

  if (opts.envName && envOverrides?.[opts.envName]) {
    resolved = deepMerge(resolved, envOverrides[opts.envName] as GroundflareSection)
  }

  if (opts.cliOverrides) {
    resolved = deepMerge(resolved, opts.cliOverrides)
  }

  const envPatch = extractEnvOverrides(opts.env ?? process.env)
  resolved = deepMerge(resolved, envPatch)

  return { ...read, resolved }
}

async function readFromDisk(startDir: string): Promise<ReadConfigResult> {
  const path = findWranglerConfig(startDir)
  if (!path) throw new ConfigNotFoundError(startDir)
  return readConfigFile(path)
}

/**
 * Deep merge: later source wins. Plain objects are merged recursively;
 * arrays are replaced wholesale (not concatenated); primitives/null replace.
 * Never mutates input; produces a new object.
 */
export function deepMerge<A extends object, B extends object>(a: A, b: B): A & B {
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
  for (const [key, bValue] of Object.entries(b)) {
    if (bValue === undefined) continue
    const aValue = (a as Record<string, unknown>)[key]
    if (isPlainObject(aValue) && isPlainObject(bValue)) {
      out[key] = deepMerge(aValue, bValue)
    } else {
      out[key] = bValue
    }
  }
  return out as A & B
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─── env-var mapping ───────────────────────────────────────────────

const VALID_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  'hetzner',
  'digitalocean',
  'linode',
  'vultr',
  'contabo',
])

const VALID_RUNTIMES: ReadonlySet<RuntimeKind> = new Set(['workerd', 'bun'])

/**
 * Extract GROUNDFLARE_* variables and return a sparse GroundflareSection.
 * Invalid enum values are silently ignored (we'd rather fall back to the
 * file / default than crash). Future: structured error-reporting pathway.
 */
export function extractEnvOverrides(env: NodeJS.ProcessEnv): Partial<GroundflareSection> {
  const out: Partial<GroundflareSection> = {}

  const provider = env.GROUNDFLARE_PROVIDER
  if (provider && VALID_PROVIDERS.has(provider as ProviderName)) {
    out.provider = provider as ProviderName
  }

  const runtime = env.GROUNDFLARE_RUNTIME
  if (runtime && VALID_RUNTIMES.has(runtime as RuntimeKind)) {
    out.runtime = runtime as RuntimeKind
  }

  if (env.GROUNDFLARE_REGION) out.region = env.GROUNDFLARE_REGION
  if (env.GROUNDFLARE_SIZE) out.size = env.GROUNDFLARE_SIZE
  if (env.GROUNDFLARE_DOMAIN) out.domain = env.GROUNDFLARE_DOMAIN
  if (env.GROUNDFLARE_EMAIL) out.email = env.GROUNDFLARE_EMAIL
  if (env.GROUNDFLARE_BACKUP) out.backup = env.GROUNDFLARE_BACKUP

  return out
}
