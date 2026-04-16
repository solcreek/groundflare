/**
 * Integration test: prove the Hono template runs on real workerd.
 *
 * This is the dual-target proof chain:
 *   1. Scaffold the hono template → tmp dir
 *   2. npm install (pulls hono)
 *   3. Bundle with esbuild (same pipeline as `groundflare deploy`)
 *   4. Analyze with oxc-parser (same pipeline as `groundflare bun analyze`)
 *   5. Spawn workerd → serve the bundled Worker
 *   6. Hit routes → verify responses
 *
 * If this passes, the same code runs on Cloudflare Workers (workerd IS
 * Cloudflare's runtime) AND on groundflare (same bundle path).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { bundleWorker } from '../../src/deploy/bundle.js'
import {
  analyzeWorkspace,
  type AnalyzeFs,
} from '../../src/runtime/bun/analyze/index.js'
import { scaffoldProject, type ScaffoldFs } from '../../../create-groundflare-app/src/scaffold.js'
import { readConfigFile } from '../../src/config/index.js'
import { buildCapnpFromWorkspace } from '../../src/runtime/workspace/index.js'
import { renderCapnpConfig } from '../../src/runtime/workerd/capnp/index.js'
import { pickFreePort, spawnWorkerd, type SpawnedWorkerd } from './spawn-workerd.js'

import { readdir, stat } from 'node:fs/promises'

function makeNodeScaffoldFs(templatesDir: string): ScaffoldFs {
  return {
    async listTemplate(template) {
      const root = resolve(templatesDir, template)
      const out: string[] = []
      async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const abs = resolve(dir, entry.name)
          if (entry.isDirectory()) await walk(abs)
          else if (entry.isFile()) {
            const rel = abs.slice(root.length + 1).split(/[\\/]/).join('/')
            out.push(rel)
          }
        }
      }
      await walk(root)
      return out.sort()
    },
    async readTemplate(template, relPath) {
      return readFile(resolve(templatesDir, template, relPath))
    },
    async targetExists(absPath) {
      try { await stat(absPath); return true } catch { return false }
    },
    async ensureDir(absDirPath) {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(absDirPath, { recursive: true })
    },
    async writeTarget(absPath, contents) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(absPath, contents)
    },
  }
}

const TEMPLATES_DIR = fileURLToPath(
  new URL('../../../create-groundflare-app/templates', import.meta.url),
)

describe(
  'Hono template — dual-target proof',
  () => {
    let tmp: string
    let projectDir: string
    let wd: SpawnedWorkerd | null = null

    beforeAll(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'gf-hono-proof-'))
      projectDir = join(tmp, 'my-api')

      // 1. Scaffold
      await scaffoldProject({
        projectName: 'my-api',
        targetDir: projectDir,
        template: 'hono',
        fs: makeNodeScaffoldFs(TEMPLATES_DIR),
        now: () => new Date('2026-04-16T00:00:00Z'),
      })

      // 2. npm install (pulls hono)
      execSync('npm install --ignore-scripts', {
        cwd: projectDir,
        stdio: 'pipe',
        timeout: 60_000,
      })
    }, 120_000)

    afterAll(async () => {
      if (wd) await wd.stop()
      if (tmp) await rm(tmp, { recursive: true, force: true })
    })

    it('scaffolds expected files', async () => {
      const wrangler = await readFile(
        join(projectDir, 'wrangler.toml'),
        'utf-8',
      )
      expect(wrangler).toContain('name = "my-api"')
      expect(wrangler).toContain('compatibility_date = "2026-04-16"')

      const index = await readFile(
        join(projectDir, 'src/index.ts'),
        'utf-8',
      )
      expect(index).toContain("name: 'my-api'")
      expect(index).not.toContain('{{name}}')
    })

    it('bundles successfully via esbuild (same as groundflare deploy)', async () => {
      const bundle = await bundleWorker({
        entry: join(projectDir, 'src/index.ts'),
      })
      expect(bundle.bytes).toBeGreaterThan(0)
      expect(bundle.code).toContain('my-api')
    })

    it('bun analyze reports "ready" (no blockers)', async () => {
      const config = await readConfigFile(
        join(projectDir, 'wrangler.toml'),
      )
      const fs: AnalyzeFs = {
        async listSourceFiles() {
          return ['src/index.ts']
        },
        async readSource(rel) {
          return readFile(join(projectDir, rel), 'utf-8')
        },
      }
      const report = await analyzeWorkspace({
        wrangler: config.wrangler,
        sourceRoot: 'src',
        fs,
      })
      expect(report.verdict).not.toBe('blocked')
    })

    it(
      'serves / and /health on real workerd (proof of CF compatibility)',
      async () => {
        const bundle = await bundleWorker({
          entry: join(projectDir, 'src/index.ts'),
        })

        const port = await pickFreePort()
        // entryPath must match the file name spawnWorkerd writes for
        // the bundle in its temp workdir. workspaceWorkerFromConfig
        // defaults to `workers/<name>/code/current/index.js`.
        const entryPath = 'workers/my-api/code/current/index.js'
        const config = buildCapnpFromWorkspace(
          {
            name: 'hono-proof',
            workers: [
              { name: 'my-api', domain: 'api.test', entryPath },
            ],
          },
          { listenAddress: `127.0.0.1:${port}`, stateBaseDir: 'in-memory' },
        )
        const capnp = renderCapnpConfig(config)

        wd = await spawnWorkerd({
          port,
          capnp,
          modules: { [entryPath]: bundle.code },
          healthTimeoutMs: 15_000,
        })

        // GET /
        const root = await wd.sendRequest({ host: 'api.test', path: '/' })
        expect(root.status).toBe(200)
        const rootBody = JSON.parse(root.body)
        expect(rootBody.name).toBe('my-api')
        expect(rootBody.status).toBe('running')

        // GET /health
        const health = await wd.sendRequest({
          host: 'api.test',
          path: '/health',
        })
        expect(health.status).toBe(200)
        expect(JSON.parse(health.body)).toEqual({ ok: true })

        // D1 routes return 501 (binding not configured — expected)
        const items = await wd.sendRequest({
          host: 'api.test',
          path: '/api/items',
        })
        expect(items.status).toBe(501)
        expect(JSON.parse(items.body).error).toContain('DB')
      },
      60_000,
    )
  },
  180_000,
)
