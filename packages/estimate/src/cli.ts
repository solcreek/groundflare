/**
 * Standalone entry for `npx groundflare-estimate`.
 *
 * Minimal argv parser — we don't need citty's full surface for one
 * command. Flags:
 *
 *   --no-live             Skip the live Hetzner refresh; use baked only.
 *   --json                Emit JSON instead of the ASCII box.
 *   -h, --help            Show usage.
 *
 * Token handling:
 *   HCLOUD_TOKEN or GROUNDFLARE_HETZNER_TOKEN env var → enables live
 *   refresh. Without a token we silently fall back to baked prices.
 */

import { consola } from 'consola'

import { computeEstimate } from './compute.js'
import { loadBakedPrices, priceAgeDays } from './prices.js'
import { promptUsage } from './prompts.js'
import { renderEstimate } from './render.js'
import { EnvSecretReader } from './secrets.js'
import { refreshPrices } from './live/index.js'

const STALE_AFTER_DAYS = 90

interface ParsedArgs {
  readonly noLive: boolean
  readonly json: boolean
  readonly help: boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let noLive = false
  let json = false
  let help = false
  for (const a of argv) {
    if (a === '--no-live') noLive = true
    else if (a === '--json') json = true
    else if (a === '-h' || a === '--help') help = true
  }
  return { noLive, json, help }
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: groundflare-estimate [--no-live] [--json]',
      '',
      'Compare your Cloudflare usage cost against a self-hosted VPS.',
      '',
      'Flags:',
      '  --no-live     Skip live pricing refresh; use the baked table only.',
      '  --json        Emit JSON to stdout instead of the ASCII summary.',
      '  -h, --help    Show this help.',
      '',
      'Environment:',
      '  HCLOUD_TOKEN  Hetzner Cloud API token (any project token works).',
      '                Enables live /v1/pricing refresh. Safe to omit.',
      '',
    ].join('\n'),
  )
}

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return 0
  }

  const baked = loadBakedPrices()
  const age = priceAgeDays(baked)
  if (age > STALE_AFTER_DAYS) {
    consola.warn(
      `pricing table is ${age} days old (updated ${baked.updated}); numbers may drift`,
    )
  }

  const { prices, sources } = await refreshPrices({
    baked,
    secrets: new EnvSecretReader(),
    ...(args.noLive ? { disableLive: true } : {}),
  })

  if (!args.json) {
    for (const src of sources) {
      if (src.kind === 'live') {
        consola.info(`${src.provider}: live prices fetched at ${src.fetchedAt}`)
      } else if (src.reason !== undefined) {
        consola.info(`${src.provider}: using baked prices (${src.reason})`)
      }
    }
  }

  const usage = await promptUsage()
  const estimate = computeEstimate(usage, prices, {
    confidence: 'low',
    priceSources: sources,
  })

  if (args.json) {
    process.stdout.write(JSON.stringify(estimate, null, 2) + '\n')
  } else {
    process.stdout.write(renderEstimate(estimate) + '\n')
  }

  return 0
}
