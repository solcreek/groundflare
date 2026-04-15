import { describe, it, expect } from 'vitest'
import {
  ScaffoldError,
  applySubstitutions,
  formatUtcDate,
  scaffoldProject,
  type ScaffoldFs,
} from '../../src/scaffold.js'

interface MemoryFixtureOptions {
  templates: Record<string, Record<string, string>>
  existing?: Set<string>
}

interface MemoryFixture {
  fs: ScaffoldFs
  writes: Map<string, Buffer>
  created: Set<string>
}

function memoryFixture(opts: MemoryFixtureOptions): MemoryFixture {
  const writes = new Map<string, Buffer>()
  const created = new Set<string>()
  const existing = new Set(opts.existing ?? [])
  const fs: ScaffoldFs = {
    async listTemplate(name) {
      const t = opts.templates[name]
      if (!t) return []
      return Object.keys(t).sort()
    },
    async readTemplate(name, relPath) {
      const t = opts.templates[name]
      if (!t || !(relPath in t)) {
        throw new Error(`no such template file: ${name}:${relPath}`)
      }
      return Buffer.from(t[relPath]!, 'utf-8')
    },
    async targetExists(abs) {
      return existing.has(abs) || writes.has(abs)
    },
    async ensureDir(abs) {
      created.add(abs)
    },
    async writeTarget(abs, contents) {
      writes.set(abs, contents)
    },
  }
  return { fs, writes, created }
}

describe('applySubstitutions', () => {
  it('replaces {{key}} tokens', () => {
    expect(applySubstitutions('hello {{name}}', { name: 'world' })).toBe(
      'hello world',
    )
  })

  it('leaves unknown tokens untouched', () => {
    expect(applySubstitutions('{{nope}}', {})).toBe('{{nope}}')
  })

  it('tolerates whitespace inside braces', () => {
    expect(applySubstitutions('{{  name  }}', { name: 'x' })).toBe('x')
  })

  it('is idempotent on source with no tokens', () => {
    const src = 'plain string, no template markers'
    expect(applySubstitutions(src, { name: 'x' })).toBe(src)
  })
})

describe('formatUtcDate', () => {
  it('formats a fixed UTC date', () => {
    expect(formatUtcDate(new Date('2026-04-15T12:34:56Z'))).toBe('2026-04-15')
  })

  it('pads month + day', () => {
    expect(formatUtcDate(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05')
  })
})

describe('scaffoldProject — happy path', () => {
  it('copies every template file with name + date substituted', async () => {
    const fx = memoryFixture({
      templates: {
        minimal: {
          'wrangler.toml': `name = "{{name}}"\ncompatibility_date = "{{compatibility_date}}"\n`,
          'src/index.ts': `export default { fetch: () => new Response('hi from {{name}}') }`,
          'README.md': `# {{name}}`,
        },
      },
    })

    const result = await scaffoldProject({
      projectName: 'my-worker',
      targetDir: '/tmp/my-worker',
      template: 'minimal',
      fs: fx.fs,
      now: () => new Date('2026-04-15T00:00:00Z'),
    })

    expect(result.projectName).toBe('my-worker')
    expect(result.compatibilityDate).toBe('2026-04-15')
    expect(result.files).toHaveLength(3)

    const wrangler = fx.writes.get('/tmp/my-worker/wrangler.toml')!.toString()
    expect(wrangler).toContain('name = "my-worker"')
    expect(wrangler).toContain('compatibility_date = "2026-04-15"')

    const index = fx.writes.get('/tmp/my-worker/src/index.ts')!.toString()
    expect(index).toContain("'hi from my-worker'")

    const readme = fx.writes.get('/tmp/my-worker/README.md')!.toString()
    expect(readme).toBe('# my-worker')
  })

  it('ensures parent directories before writing nested files', async () => {
    const fx = memoryFixture({
      templates: {
        minimal: { 'src/nested/deep/file.ts': 'x' },
      },
    })
    await scaffoldProject({
      projectName: 'demo',
      targetDir: '/tmp/demo',
      template: 'minimal',
      fs: fx.fs,
    })
    expect(fx.created.has('/tmp/demo')).toBe(true)
    expect(fx.created.has('/tmp/demo/src/nested/deep')).toBe(true)
  })

  it('rewrites _gitignore to .gitignore on write', async () => {
    const fx = memoryFixture({
      templates: {
        minimal: { _gitignore: 'node_modules/\n' },
      },
    })
    const result = await scaffoldProject({
      projectName: 'demo',
      targetDir: '/tmp/demo',
      template: 'minimal',
      fs: fx.fs,
    })
    expect(result.files[0]?.relPath).toBe('.gitignore')
    expect(fx.writes.get('/tmp/demo/.gitignore')?.toString()).toBe(
      'node_modules/\n',
    )
  })
})

describe('scaffoldProject — refusal conditions', () => {
  it('rejects an invalid project name', async () => {
    const fx = memoryFixture({ templates: { minimal: {} } })
    await expect(
      scaffoldProject({
        projectName: 'Bad Name With Spaces',
        targetDir: '/tmp/x',
        template: 'minimal',
        fs: fx.fs,
      }),
    ).rejects.toMatchObject({ code: 'invalid_name' })
  })

  it('refuses when the target directory already exists', async () => {
    const fx = memoryFixture({
      templates: { minimal: { 'file.txt': 'x' } },
      existing: new Set(['/tmp/taken']),
    })
    await expect(
      scaffoldProject({
        projectName: 'demo',
        targetDir: '/tmp/taken',
        template: 'minimal',
        fs: fx.fs,
      }),
    ).rejects.toMatchObject({ code: 'target_exists' })
    expect(fx.writes.size).toBe(0)
  })

  it('force: true overwrites an existing target', async () => {
    const fx = memoryFixture({
      templates: { minimal: { 'file.txt': 'new' } },
      existing: new Set(['/tmp/taken']),
    })
    const result = await scaffoldProject({
      projectName: 'demo',
      targetDir: '/tmp/taken',
      template: 'minimal',
      fs: fx.fs,
      force: true,
    })
    expect(result.files).toHaveLength(1)
    expect(fx.writes.get('/tmp/taken/file.txt')?.toString()).toBe('new')
  })

  it('throws when the template is empty', async () => {
    const fx = memoryFixture({ templates: { empty: {} } })
    await expect(
      scaffoldProject({
        projectName: 'demo',
        targetDir: '/tmp/demo',
        template: 'empty',
        fs: fx.fs,
      }),
    ).rejects.toMatchObject({ code: 'template_empty' })
  })

  it('is a ScaffoldError, not a plain Error', async () => {
    const fx = memoryFixture({ templates: { empty: {} } })
    await expect(
      scaffoldProject({
        projectName: 'demo',
        targetDir: '/tmp/demo',
        template: 'empty',
        fs: fx.fs,
      }),
    ).rejects.toBeInstanceOf(ScaffoldError)
  })
})

describe('scaffoldProject — binary pass-through', () => {
  it('does not substitute inside non-text extensions', async () => {
    // PNG-like header bytes — scaffold should NOT decode/re-encode.
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const fs: ScaffoldFs = {
      async listTemplate() {
        return ['favicon.png']
      },
      async readTemplate() {
        return pngBytes
      },
      async targetExists() {
        return false
      },
      async ensureDir() {},
      async writeTarget(abs, bytes) {
        expect(abs).toBe('/tmp/demo/favicon.png')
        expect(Array.from(bytes)).toEqual(Array.from(pngBytes))
      },
    }
    const result = await scaffoldProject({
      projectName: 'demo',
      targetDir: '/tmp/demo',
      template: 'binary',
      fs,
    })
    expect(result.files[0]?.substituted).toBe(false)
  })
})
