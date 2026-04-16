/**
 * Auto-detect the project's package manager from lockfile presence.
 *
 * Follows the same convention as Vercel, Netlify, and Railway:
 *   pnpm-lock.yaml → pnpm
 *   yarn.lock      → yarn
 *   bun.lockb      → bun
 *   (fallback)     → npm
 *
 * Also detects whether a build script exists in package.json.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

export interface DetectedBuild {
  readonly pm: PackageManager
  /** Full shell command: install + build. */
  readonly command: string
  /** Whether the project has a "build" script in package.json. */
  readonly hasBuildScript: boolean
}

/**
 * Detect package manager + build command for a project directory.
 * Returns null if no package.json exists (not a Node project).
 */
export function detectBuildCommand(cwd: string): DetectedBuild | null {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return null

  let hasBuildScript = false
  try {
    const raw = readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
    hasBuildScript = pkg.scripts?.build !== undefined
  } catch {
    // Malformed package.json — fall through with hasBuildScript=false
  }

  const pm = detectPackageManager(cwd)

  if (!hasBuildScript) {
    return { pm, command: `${pm} install`, hasBuildScript: false }
  }

  const run = pm === 'npm' ? 'npm run' : pm
  return {
    pm,
    command: `${pm} install && ${run} build`,
    hasBuildScript: true,
  }
}

function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun'
  return 'npm'
}
