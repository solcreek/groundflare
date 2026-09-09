/**
 * Persists BootstrapState across CLI invocations so a crashed/aborted
 * `groundflare up` can resume from the last successful stage.
 *
 * Layout (one file per workspace):
 *   $XDG_CONFIG_HOME/groundflare/state/<workspace>.json
 *   ~/.config/groundflare/state/<workspace>.json (fallback)
 *
 * Atomic write via temp + rename, mode 0600. Same pattern as the secret
 * store but a separate file because state is much more volatile (rewritten
 * after every stage) and isn't strictly secret.
 */

import { mkdir, readFile, rename, writeFile, chmod, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { BootstrapError, type BootstrapState } from './types.js'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
const WORKSPACE_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

export interface BootstrapStateStoreOptions {
  /** Override the directory. Defaults to ~/.config/groundflare/state. */
  readonly directory?: string
}

export class BootstrapStateStore {
  readonly directory: string

  constructor(opts: BootstrapStateStoreOptions = {}) {
    this.directory = opts.directory ?? BootstrapStateStore.defaultDirectory()
  }

  static defaultDirectory(): string {
    const xdg = process.env.XDG_CONFIG_HOME
    if (xdg) return join(xdg, 'groundflare', 'state')
    return join(homedir(), '.config', 'groundflare', 'state')
  }

  pathFor(workspace: string): string {
    validateWorkspace(workspace)
    return join(this.directory, `${workspace}.json`)
  }

  async load(workspace: string): Promise<BootstrapState | null> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(workspace), 'utf-8')
    } catch (err) {
      if (isNotFound(err)) return null
      throw new BootstrapError(
        `failed to read bootstrap state for ${workspace}`,
        'state_io',
        undefined,
        { cause: err },
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new BootstrapError(
        `state file for ${workspace} is not valid JSON`,
        'state_corrupt',
        undefined,
        { cause: err },
      )
    }
    if (!isBootstrapState(parsed)) {
      throw new BootstrapError(
        `state file for ${workspace} does not match the expected schema`,
        'state_corrupt',
      )
    }
    return parsed
  }

  async save(state: BootstrapState): Promise<void> {
    const path = this.pathFor(state.workspace)
    const dir = dirname(path)

    try {
      await mkdir(dir, { recursive: true, mode: DIR_MODE })
    } catch (err) {
      throw new BootstrapError(
        `failed to create state directory ${dir}`,
        'state_io',
        undefined,
        { cause: err },
      )
    }
    try {
      await chmod(dir, DIR_MODE)
    } catch {
      // best-effort
    }

    const serialized = JSON.stringify(state, null, 2) + '\n'
    const tempPath = `${path}.${randomBytes(6).toString('hex')}.tmp`

    try {
      await writeFile(tempPath, serialized, { mode: FILE_MODE, encoding: 'utf-8' })
    } catch (err) {
      throw new BootstrapError(
        `failed to write ${tempPath}`,
        'state_io',
        undefined,
        { cause: err },
      )
    }

    try {
      await rename(tempPath, path)
    } catch (err) {
      throw new BootstrapError(
        `failed to rename ${tempPath} -> ${path}`,
        'state_io',
        undefined,
        { cause: err },
      )
    }

    try {
      await chmod(path, FILE_MODE)
    } catch {
      // best-effort
    }
  }

  async list(): Promise<readonly string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.directory)
    } catch (err) {
      if (isNotFound(err)) return []
      throw new BootstrapError(
        `failed to list state directory ${this.directory}`,
        'state_io',
        undefined,
        { cause: err },
      )
    }
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => e.slice(0, -'.json'.length))
      .sort()
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function validateWorkspace(name: string): void {
  if (!WORKSPACE_PATTERN.test(name)) {
    throw new BootstrapError(
      `invalid workspace name ${JSON.stringify(name)}: ` +
        `must match /${WORKSPACE_PATTERN.source}/`,
      'state_io',
    )
  }
}

function isBootstrapState(value: unknown): value is BootstrapState {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.workspace === 'string' &&
    typeof o.provider === 'string' &&
    Array.isArray(o.completedStages) &&
    typeof o.startedAt === 'string' &&
    typeof o.updatedAt === 'string'
  )
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  )
}
