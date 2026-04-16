import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectBuildCommand } from '../../../src/deploy/detect-pm.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gf-detect-pm-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('detectBuildCommand', () => {
  it('returns null when no package.json exists', () => {
    expect(detectBuildCommand(tmp)).toBeNull()
  })

  it('detects npm (no lockfile) with build script', async () => {
    await writeFile(
      join(tmp, 'package.json'),
      JSON.stringify({ scripts: { build: 'astro build' } }),
    )
    const result = detectBuildCommand(tmp)!
    expect(result.pm).toBe('npm')
    expect(result.command).toBe('npm install && npm run build')
    expect(result.hasBuildScript).toBe(true)
  })

  it('detects pnpm from pnpm-lock.yaml', async () => {
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }))
    await writeFile(join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const result = detectBuildCommand(tmp)!
    expect(result.pm).toBe('pnpm')
    expect(result.command).toBe('pnpm install && pnpm build')
  })

  it('detects yarn from yarn.lock', async () => {
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }))
    await writeFile(join(tmp, 'yarn.lock'), '')
    const result = detectBuildCommand(tmp)!
    expect(result.pm).toBe('yarn')
    expect(result.command).toBe('yarn install && yarn build')
  })

  it('detects bun from bun.lockb', async () => {
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }))
    await writeFile(join(tmp, 'bun.lockb'), '')
    const result = detectBuildCommand(tmp)!
    expect(result.pm).toBe('bun')
    expect(result.command).toBe('bun install && bun build')
  })

  it('detects bun from bun.lock (text format)', async () => {
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }))
    await writeFile(join(tmp, 'bun.lock'), '')
    const result = detectBuildCommand(tmp)!
    expect(result.pm).toBe('bun')
  })

  it('returns install-only command when no build script', async () => {
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ scripts: { dev: 'x' } }))
    const result = detectBuildCommand(tmp)!
    expect(result.pm).toBe('npm')
    expect(result.command).toBe('npm install')
    expect(result.hasBuildScript).toBe(false)
  })

  it('pnpm takes precedence over npm lockfile', async () => {
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }))
    await writeFile(join(tmp, 'pnpm-lock.yaml'), '')
    await writeFile(join(tmp, 'package-lock.json'), '')
    expect(detectBuildCommand(tmp)!.pm).toBe('pnpm')
  })
})
