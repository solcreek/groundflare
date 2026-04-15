/**
 * CLI update check against the npm registry.
 *
 * Ships in the background on every invocation so users learn about new
 * versions without blocking their command. Source of truth is npm (not
 * GitHub) because that's where all installation paths resolve:
 *   - `npm i -g groundflare`
 *   - `pnpm add -g groundflare`
 *   - `yarn global add groundflare`
 *   - `npx groundflare`
 *
 * Defers to `update-notifier` for the check, caching, and CI detection.
 *
 * Opt-out:
 *   GROUNDFLARE_DISABLE_UPDATE_CHECK=1
 *   NO_UPDATE_NOTIFIER=1           (update-notifier's convention)
 *   CI=...                          (auto-detected by update-notifier)
 *   --no-update-check               (CLI flag)
 */

import updateNotifier from 'update-notifier'
import type { Package } from 'update-notifier'

const CHECK_INTERVAL_MS = 1000 * 60 * 60 * 24 // once per day

export function shouldSkipUpdateCheck(argv: readonly string[] = process.argv): boolean {
  if (process.env.GROUNDFLARE_DISABLE_UPDATE_CHECK === '1') return true
  if (argv.includes('--no-update-check')) return true
  return false
}

export function checkForUpdates(pkg: Package): void {
  if (shouldSkipUpdateCheck()) return

  // update-notifier handles CI auto-detection and persistent daily caching;
  // we just wire it up and call notify() after the command completes.
  const notifier = updateNotifier({
    pkg,
    updateCheckInterval: CHECK_INTERVAL_MS,
    shouldNotifyInNpmScript: false,
  })

  // Register the notice to fire after the command — otherwise it prints
  // before the user sees their result. update-notifier uses process.on('exit').
  notifier.notify({ defer: true, isGlobal: true })
}
