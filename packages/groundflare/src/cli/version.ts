/**
 * Read the CLI's own package.json `version` field. Both `deploy` and
 * `up` bake it into the Router Worker's `/__health` response so
 * operators can confirm which CLI last deployed. Returns `"unknown"`
 * when the file can't be read — not worth aborting a deploy over.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export async function resolveCliVersion(): Promise<string> {
  try {
    const pkgPath = fileURLToPath(
      new URL('../../package.json', import.meta.url),
    )
    const raw = await readFile(pkgPath, 'utf-8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version
    }
  } catch {
    // fall through
  }
  return 'unknown'
}
