/**
 * Self-test for the spawn-workerd harness: the temp workdir must be gone
 * after stop() and after a failed start.
 *
 * Every other integration file relies on that cleanup implicitly; this is
 * the one place it is asserted, and the only test that exercises the
 * Windows-specific pieces (native binary spawned directly, removeWorkdir
 * retrying on lingering file handles) in isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pickFreePort, spawnWorkerd } from './spawn-workerd.js'

const TEST_TIMEOUT_MS = 30_000

// spawnWorkerd derives its workdir from os.tmpdir(), which reads TMPDIR /
// TMP / TEMP on every call. Point all three at a private directory so the
// "nothing left behind" assertion cannot be disturbed by other test files
// spawning workerd concurrently.
const TMP_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const
let sandbox: string
let savedEnv: Record<string, string | undefined>

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'gf-spawn-test-'))
  savedEnv = Object.fromEntries(TMP_VARS.map((k) => [k, process.env[k]]))
  for (const k of TMP_VARS) process.env[k] = sandbox
})

afterEach(async () => {
  for (const k of TMP_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await rm(sandbox, { recursive: true, force: true })
})

function trivialCapnp(port: number): string {
  return `
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "worker.js", esModule = embed "worker.js")],
      compatibilityDate = "2024-09-01",
    )),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:${port}", http = (), service = "main"),
  ],
);
`
}

const TRIVIAL_MODULES = {
  'worker.js': 'export default { fetch() { return new Response("ok") } }',
}

describe('spawnWorkerd workdir lifecycle', () => {
  it(
    'creates the workdir under os.tmpdir() and removes it on stop()',
    async () => {
      const port = await pickFreePort()
      const wd = await spawnWorkerd({
        port,
        capnp: trivialCapnp(port),
        modules: TRIVIAL_MODULES,
        healthTimeoutMs: 10_000,
      })
      try {
        expect(wd.workdir.startsWith(sandbox)).toBe(true)
        const res = await wd.sendRequest({ host: 'anything.test', path: '/' })
        expect(res.status).toBe(200)
        expect(res.body).toBe('ok')
      } finally {
        await wd.stop()
      }
      expect(await readdir(sandbox)).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'removes the workdir when workerd rejects the config',
    async () => {
      const port = await pickFreePort()
      await expect(
        spawnWorkerd({
          port,
          capnp: 'this is not a capnp config',
          modules: {},
          healthTimeoutMs: 10_000,
        }),
      ).rejects.toThrow(/workerd failed to start/)
      expect(await readdir(sandbox)).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
