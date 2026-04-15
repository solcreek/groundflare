/**
 * `create-groundflare-app` — CLI entry point.
 *
 * Used via `npm create groundflare-app@latest <project-name>` or
 * `npx create-groundflare-app <project-name>`.
 *
 * Wires the production filesystem adapter to the pure scaffoldProject
 * function in ./scaffold.ts. All the interesting logic lives there.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ScaffoldError,
  scaffoldProject,
  type ScaffoldFs,
} from './scaffold.js'

const log = consola.withTag('create-groundflare-app')

// templates/ ships alongside the compiled dist (see package.json
// `files`). This resolves the same whether we're running from src via
// tsx (import.meta.url = src/cli.ts) or from dist/cli.js after build.
function locateTemplatesDir(): string {
  // From dist/cli.js: ../templates/
  // From src/cli.ts: ../templates/
  return resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'templates')
}

const AVAILABLE_TEMPLATES = ['minimal'] as const
type TemplateName = (typeof AVAILABLE_TEMPLATES)[number]

function isTemplate(x: string): x is TemplateName {
  return (AVAILABLE_TEMPLATES as readonly string[]).includes(x)
}

function makeNodeFs(templatesDir: string): ScaffoldFs {
  return {
    async listTemplate(template) {
      const root = resolvePath(templatesDir, template)
      const out: string[] = []
      async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const abs = resolvePath(dir, entry.name)
          if (entry.isDirectory()) {
            await walk(abs)
          } else if (entry.isFile()) {
            out.push(toPosix(relative(root, abs)))
          }
        }
      }
      await walk(root)
      return out.sort()
    },
    async readTemplate(template, relPath) {
      return readFile(resolvePath(templatesDir, template, relPath))
    },
    async targetExists(absPath) {
      try {
        await stat(absPath)
        return true
      } catch {
        return false
      }
    },
    async ensureDir(absDirPath) {
      await mkdir(absDirPath, { recursive: true })
    },
    async writeTarget(absPath, contents) {
      await writeFile(absPath, contents)
    },
  }
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join('/')
}

const main = defineCommand({
  meta: {
    name: 'create-groundflare-app',
    description:
      'Scaffold a new groundflare-ready Cloudflare Worker project.',
  },
  args: {
    name: {
      type: 'positional',
      required: false,
      description: 'Project directory name (default: groundflare-worker)',
    },
    template: {
      type: 'string',
      default: 'minimal',
      description: `Template to use (${AVAILABLE_TEMPLATES.join(', ')})`,
    },
    force: {
      type: 'boolean',
      description: 'Overwrite target directory if it already exists',
    },
  },
  async run({ args }) {
    const name = args.name ?? 'groundflare-worker'
    if (!isTemplate(args.template)) {
      log.error(
        `unknown template ${JSON.stringify(args.template)} — available: ${AVAILABLE_TEMPLATES.join(', ')}`,
      )
      process.exit(1)
    }

    const targetDir = resolvePath(process.cwd(), name)
    const templatesDir = locateTemplatesDir()
    const fs = makeNodeFs(templatesDir)

    try {
      const result = await scaffoldProject({
        projectName: name,
        targetDir,
        template: args.template,
        fs,
        ...(args.force === true ? { force: true } : {}),
      })
      log.success(
        `created ${result.projectName} from template ${JSON.stringify(result.template)} (${result.files.length} files)`,
      )
      log.info(``)
      log.info(`Next:`)
      log.info(`  cd ${name}`)
      log.info(`  npx groundflare bun analyze   # see what's compatible`)
      log.info(`  npx groundflare up            # provision + deploy`)
    } catch (err) {
      if (err instanceof ScaffoldError) {
        log.error(`${err.message} (${err.code})`)
        process.exit(1)
      }
      throw err
    }
  },
})

export async function run(): Promise<void> {
  await runMain(main)
}
