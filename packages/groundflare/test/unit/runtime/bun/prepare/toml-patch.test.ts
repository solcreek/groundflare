import { describe, it, expect } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import {
  patchRuntimeInWranglerToml,
  TomlPatchError,
} from '../../../../../src/runtime/bun/prepare/toml-patch.js'

describe('patchRuntimeInWranglerToml — replace existing value', () => {
  it('flips runtime = "workerd" to "bun"', () => {
    const src = `name = "demo"
[groundflare]
provider = "hetzner"
runtime = "workerd"
`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.kind).toBe('replaced')
    expect(r.previous).toBe('workerd')
    expect(r.content).toContain('runtime = "bun"')
    expect(r.content).not.toContain('"workerd"')
    // Everything else untouched byte-for-byte.
    expect(r.content.replace('runtime = "bun"', 'runtime = "workerd"')).toBe(src)
  })

  it('is a no-op when already "bun" (kind=replaced, previous=bun)', () => {
    const src = `[groundflare]
runtime = "bun"
`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.kind).toBe('replaced')
    expect(r.previous).toBe('bun')
    expect(r.content).toBe(src)
  })

  it('preserves trailing comments on the runtime line', () => {
    const src = `[groundflare]
runtime = "workerd"  # keep this comment
`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.content).toContain('runtime = "bun"  # keep this comment')
  })

  it('handles single-quoted strings', () => {
    const src = `[groundflare]
runtime = 'workerd'
`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.previous).toBe('workerd')
    expect(r.content).toContain('runtime = "bun"')
  })
})

describe('patchRuntimeInWranglerToml — insert into existing section', () => {
  it('inserts runtime line right after the [groundflare] header', () => {
    const src = `name = "demo"
[groundflare]
provider = "hetzner"
`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.kind).toBe('inserted')
    expect(r.previous).toBe(null)
    // Parse-round-trip to confirm the result is still valid TOML and
    // carries the new value under the right section.
    const parsed = parseToml(r.content) as {
      groundflare: { runtime: string; provider: string }
    }
    expect(parsed.groundflare.runtime).toBe('bun')
    expect(parsed.groundflare.provider).toBe('hetzner')
  })

  it('does not touch [groundflare.env.staging] subtables', () => {
    const src = `[groundflare]
provider = "hetzner"

[groundflare.env.staging]
domain = "staging.example.com"
`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.kind).toBe('inserted')
    const parsed = parseToml(r.content) as {
      groundflare: { runtime: string; env?: { staging?: { domain: string } } }
    }
    expect(parsed.groundflare.runtime).toBe('bun')
    expect(parsed.groundflare.env?.staging?.domain).toBe('staging.example.com')
  })

  it('inserts before a [groundflare.bun] subtable, not after', () => {
    const src = `[groundflare]
provider = "hetzner"

[groundflare.bun]
main = "server.ts"
`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    const runtimeIdx = r.content.indexOf('runtime = "bun"')
    const subTableIdx = r.content.indexOf('[groundflare.bun]')
    expect(runtimeIdx).toBeLessThan(subTableIdx)
  })
})

describe('patchRuntimeInWranglerToml — append new section', () => {
  it('appends [groundflare] section when none exists', () => {
    const src = `name = "demo"
main = "src/index.ts"
`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.kind).toBe('appended')
    expect(r.previous).toBe(null)
    const parsed = parseToml(r.content) as {
      groundflare: { runtime: string }
    }
    expect(parsed.groundflare.runtime).toBe('bun')
  })

  it('keeps original content intact', () => {
    const src = `name = "demo"

[[kv_namespaces]]
binding = "CACHE"
id = "abc"
`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.content.startsWith(src)).toBe(true)
  })

  it('ensures a trailing newline when the source file lacks one', () => {
    const src = `name = "demo"`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.content.endsWith('\n')).toBe(true)
  })
})

describe('patchRuntimeInWranglerToml — newline handling', () => {
  it('preserves CRLF line endings', () => {
    const src = `name = "demo"\r\n[groundflare]\r\nprovider = "hetzner"\r\n`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.content).toContain('\r\n')
    expect(r.content).not.toMatch(/(?<!\r)\n/)
  })
})

describe('patchRuntimeInWranglerToml — error cases', () => {
  it('rejects inline-table form `groundflare = { ... }`', () => {
    const src = `groundflare = { runtime = "workerd" }\n`
    expect(() => patchRuntimeInWranglerToml(src, 'bun')).toThrow(TomlPatchError)
    expect(() => patchRuntimeInWranglerToml(src, 'bun')).toThrow(/inline-table/)
  })

  it('rejects when target runtime is not "workerd" or "bun" is irrelevant — only the value written is validated by schema', () => {
    // Present as a smoke test for the simpler case; the function itself
    // accepts only the 'workerd' | 'bun' union at the type level.
    const src = `[groundflare]\nruntime = "workerd"\n`
    const r = patchRuntimeInWranglerToml(src, 'bun')
    expect(r.content).toContain('runtime = "bun"')
  })
})
