import { defineCommand } from 'citty'
import { resolve } from 'node:path'
import { ConfigNotFoundError, resolveConfig } from '../../config/index.js'
import { log, notImplemented } from '../log.js'

const show = defineCommand({
  meta: {
    name: 'show',
    description: 'Print the resolved config (wrangler + [groundflare]) as JSON',
  },
  args: {
    cwd: {
      type: 'string',
      description: 'Directory to search from (default: current working dir)',
    },
    env: {
      type: 'string',
      description: 'Apply [groundflare.env.<name>] overrides',
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd())
    try {
      const { wrangler, groundflare, resolved, source } = await resolveConfig({
        cwd,
        envName: args.env,
      })
      process.stdout.write(
        JSON.stringify({ source, wrangler, groundflare, resolved }, null, 2) + '\n',
      )
    } catch (err) {
      if (err instanceof ConfigNotFoundError) {
        log.error(err.message)
        process.exit(1)
      }
      throw err
    }
  },
})

const set = defineCommand({
  meta: {
    name: 'set',
    description: 'Set a [groundflare] config value (writes to wrangler.toml)',
  },
  async run() {
    notImplemented('config set', 'TOML write path lands alongside `groundflare up` (v0.1 W3)')
  },
})

const resolveCmd = defineCommand({
  meta: {
    name: 'resolve',
    description: 'Dump the resolved config to .groundflare/resolved-config.json',
  },
  async run() {
    notImplemented(
      'config resolve',
      'will mirror `config show` but persist to disk for tooling (v0.1 W3)',
    )
  },
})

export default defineCommand({
  meta: {
    name: 'config',
    description: 'Inspect or modify the Worker + groundflare configuration',
  },
  subCommands: {
    show,
    set,
    resolve: resolveCmd,
  },
})
