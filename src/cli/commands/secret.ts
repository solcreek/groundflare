/**
 * `groundflare secret` — manage credentials in the FileSecretStore
 * (default: ~/.config/groundflare/secrets.json, mode 0600).
 *
 * Subcommands:
 *   set <key> <value>   — store/overwrite a secret
 *   get <key>           — print a secret to stdout (no trailing newline if piped)
 *   list                — list known keys (never values)
 *   delete <key>        — remove a secret (no-op if missing)
 *
 * Key naming convention (not enforced beyond the /[A-Za-z0-9._-]+/ regex):
 *   provider.<name>.token         — e.g. provider.hetzner.token
 *   workspace.<name>.<purpose>    — e.g. workspace.demo.restic_password
 */

import { defineCommand } from 'citty'
import { FileSecretStore, SecretStoreError } from '../../secret/index.js'
import { log } from '../log.js'

function die(message: string): never {
  log.error(message)
  process.exit(1)
}

async function withStore<T>(fn: (store: FileSecretStore) => Promise<T>): Promise<T> {
  try {
    return await fn(new FileSecretStore())
  } catch (err) {
    if (err instanceof SecretStoreError) die(`${err.message} (${err.code})`)
    throw err
  }
}

const setCmd = defineCommand({
  meta: {
    name: 'set',
    description: 'Store or overwrite a secret',
  },
  args: {
    key: { type: 'positional', required: true, description: 'Secret key' },
    value: { type: 'positional', required: true, description: 'Secret value' },
  },
  async run({ args }) {
    await withStore((store) => store.set(args.key, args.value))
    log.success(`stored secret ${args.key}`)
  },
})

const getCmd = defineCommand({
  meta: {
    name: 'get',
    description: 'Print a secret to stdout',
  },
  args: {
    key: { type: 'positional', required: true, description: 'Secret key' },
  },
  async run({ args }) {
    const value = await withStore((store) => store.get(args.key))
    if (value === null) die(`no secret stored for key ${JSON.stringify(args.key)}`)
    process.stdout.write(value)
    if (process.stdout.isTTY) process.stdout.write('\n')
  },
})

const listCmd = defineCommand({
  meta: {
    name: 'list',
    description: 'List stored secret keys (never prints values)',
  },
  async run() {
    const keys = await withStore((store) => store.list())
    if (keys.length === 0) {
      log.info('no secrets stored yet')
      return
    }
    for (const key of keys) process.stdout.write(`${key}\n`)
  },
})

const deleteCmd = defineCommand({
  meta: {
    name: 'delete',
    description: 'Remove a secret (no-op if missing)',
  },
  args: {
    key: { type: 'positional', required: true, description: 'Secret key' },
  },
  async run({ args }) {
    await withStore((store) => store.delete(args.key))
    log.success(`removed secret ${args.key}`)
  },
})

export default defineCommand({
  meta: {
    name: 'secret',
    description: 'Manage credentials (provider tokens, ACME keys, etc.)',
  },
  subCommands: {
    set: setCmd,
    get: getCmd,
    list: listCmd,
    delete: deleteCmd,
  },
})
