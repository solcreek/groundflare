/**
 * Project-wide logger. Wraps consola so we have a single import point
 * and can swap implementations later without churning every command.
 */

import { consola } from 'consola'

export const log = consola.withTag('groundflare')

/**
 * Utility for commands that are not yet implemented. Prints a warning
 * box and exits 0 so scripts that invoke `groundflare <cmd> --help`
 * don't interpret a stub as a hard failure.
 */
export function notImplemented(command: string, nextStep?: string): void {
  log.warn(`\`${command}\` is not implemented yet.`)
  if (nextStep) log.info(nextStep)
}
