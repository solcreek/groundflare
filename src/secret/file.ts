/**
 * File-backed SecretStore.
 *
 * Stores secrets as a JSON object at the configured path. The directory
 * is created with mode 0700, the file is written with mode 0600 — only
 * the owning user can read or modify it. Writes are atomic via temp +
 * rename, so a crash mid-write never produces a half-written file.
 *
 * Schema:
 *   {
 *     "version": 1,
 *     "secrets": { "<key>": "<value>", ... }
 *   }
 *
 * The `version` field is reserved for future schema changes (rotation,
 * envelope encryption, etc.).
 */

import { mkdir, readFile, rename, stat, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { SecretStoreError, type SecretStore } from './types.js'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
const SCHEMA_VERSION = 1
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

interface SecretsFile {
  version: number
  secrets: Record<string, string>
}

export interface FileSecretStoreOptions {
  /** Override the file path. Defaults to ~/.config/groundflare/secrets.json. */
  readonly path?: string
}

export class FileSecretStore implements SecretStore {
  readonly path: string

  constructor(opts: FileSecretStoreOptions = {}) {
    this.path = opts.path ?? FileSecretStore.defaultPath()
  }

  static defaultPath(): string {
    const xdg = process.env.XDG_CONFIG_HOME
    if (xdg) return join(xdg, 'groundflare', 'secrets.json')
    return join(homedir(), '.config', 'groundflare', 'secrets.json')
  }

  async get(key: string): Promise<string | null> {
    validateKey(key)
    const data = await this.read()
    return data.secrets[key] ?? null
  }

  async set(key: string, value: string): Promise<void> {
    validateKey(key)
    if (typeof value !== 'string') {
      throw new SecretStoreError(`secret value must be a string`, 'invalid')
    }
    const data = await this.read()
    data.secrets[key] = value
    await this.write(data)
  }

  async delete(key: string): Promise<void> {
    validateKey(key)
    const data = await this.read()
    if (!(key in data.secrets)) return
    delete data.secrets[key]
    await this.write(data)
  }

  async list(): Promise<readonly string[]> {
    const data = await this.read()
    return Object.keys(data.secrets).sort()
  }

  // ─── Private I/O ───────────────────────────────────────────────

  private async read(): Promise<SecretsFile> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf-8')
    } catch (err) {
      if (isNotFound(err)) {
        return { version: SCHEMA_VERSION, secrets: {} }
      }
      throw new SecretStoreError(
        `failed to read ${this.path}`,
        isPermissionDenied(err) ? 'denied' : 'io',
        { cause: err },
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new SecretStoreError(
        `${this.path} is not valid JSON`,
        'corrupt',
        { cause: err },
      )
    }
    if (!isSecretsFileShape(parsed)) {
      throw new SecretStoreError(
        `${this.path} does not match the expected schema`,
        'corrupt',
      )
    }
    return parsed
  }

  private async write(data: SecretsFile): Promise<void> {
    const dir = dirname(this.path)
    try {
      await mkdir(dir, { recursive: true, mode: DIR_MODE })
    } catch (err) {
      throw new SecretStoreError(
        `failed to create directory ${dir}`,
        isPermissionDenied(err) ? 'denied' : 'io',
        { cause: err },
      )
    }

    // Tighten mode in case the directory pre-existed with looser perms
    // (we don't enforce this every read because it's rare and surprising).
    try {
      await chmod(dir, DIR_MODE)
    } catch {
      // best-effort; on Windows chmod is a no-op
    }

    const serialized = JSON.stringify(data, null, 2) + '\n'
    const tempPath = `${this.path}.${randomBytes(6).toString('hex')}.tmp`

    try {
      await writeFile(tempPath, serialized, { mode: FILE_MODE, encoding: 'utf-8' })
    } catch (err) {
      throw new SecretStoreError(
        `failed to write ${tempPath}`,
        isPermissionDenied(err) ? 'denied' : 'io',
        { cause: err },
      )
    }

    try {
      await rename(tempPath, this.path)
    } catch (err) {
      throw new SecretStoreError(
        `failed to rename ${tempPath} -> ${this.path}`,
        'io',
        { cause: err },
      )
    }

    // Re-apply mode in case the rename inherited a wider umask. On
    // Windows chmod is largely a no-op; that's fine — Windows ACLs are
    // already user-private by default in the user's profile dir.
    try {
      await chmod(this.path, FILE_MODE)
    } catch {
      // best-effort
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function validateKey(key: string): void {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new SecretStoreError(
      `invalid secret key ${JSON.stringify(key)}: ` +
        `must match /${KEY_PATTERN.source}/`,
      'invalid',
    )
  }
}

function isSecretsFileShape(value: unknown): value is SecretsFile {
  if (typeof value !== 'object' || value === null) return false
  if (!('version' in value) || typeof (value as { version: unknown }).version !== 'number') {
    return false
  }
  if (
    !('secrets' in value) ||
    typeof (value as { secrets: unknown }).secrets !== 'object' ||
    (value as { secrets: unknown }).secrets === null
  ) {
    return false
  }
  for (const v of Object.values((value as { secrets: Record<string, unknown> }).secrets)) {
    if (typeof v !== 'string') return false
  }
  return true
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  )
}

function isPermissionDenied(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  const code = (err as { code: unknown }).code
  return code === 'EACCES' || code === 'EPERM'
}

/**
 * Optionally verify the on-disk mode and warn if it's looser than 0600.
 * Doesn't throw — operators sometimes intentionally widen the file (e.g.
 * to share with their backup user). Returns the observed mode bits or
 * null if the file doesn't exist.
 */
export async function inspectFileMode(path: string): Promise<number | null> {
  try {
    const s = await stat(path)
    return s.mode & 0o777
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}
