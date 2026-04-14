import { defineCommand, runMain } from 'citty'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { checkForUpdates } from './update-check.js'

import upCommand from './commands/up.js'
import deployCommand from './commands/deploy.js'
import tailCommand from './commands/tail.js'
import estimateCommand from './commands/estimate.js'
import destroyCommand from './commands/destroy.js'
import statusCommand from './commands/status.js'
import configCommand from './commands/config.js'

interface PackageJsonShape {
  name: string
  version: string
  description?: string
}

async function loadPackageMeta(): Promise<PackageJsonShape> {
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
  const raw = await readFile(pkgPath, 'utf-8')
  return JSON.parse(raw) as PackageJsonShape
}

/**
 * Build the top-level command. Async because we read package.json at
 * startup for version + description.
 */
export async function buildMain() {
  const pkg = await loadPackageMeta()
  return defineCommand({
    meta: {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description ?? 'Run your Cloudflare Worker on your own hardware',
    },
    subCommands: {
      up: upCommand,
      deploy: deployCommand,
      tail: tailCommand,
      estimate: estimateCommand,
      destroy: destroyCommand,
      status: statusCommand,
      config: configCommand,
    },
  })
}

export async function run(): Promise<void> {
  const pkg = await loadPackageMeta()
  checkForUpdates({ name: pkg.name, version: pkg.version })

  const main = await buildMain()
  await runMain(main)
}
