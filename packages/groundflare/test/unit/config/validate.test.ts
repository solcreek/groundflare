import { describe, it, expect } from 'vitest'

import {
  ConfigValidationError,
  validateGroundflareSection,
} from '../../../src/config/index.js'

const FILE = '/tmp/wrangler.toml'

describe('validateGroundflareSection — happy path', () => {
  it('accepts an empty section', () => {
    expect(validateGroundflareSection({}, FILE)).toEqual({})
  })

  it('accepts a typical workerd-track config', () => {
    const result = validateGroundflareSection(
      {
        provider: 'hetzner',
        region: 'hel1',
        size: 'cx22',
        domain: 'api.example.com',
        email: 'ops@example.com',
      },
      FILE,
    )
    expect(result.provider).toBe('hetzner')
    expect(result.domain).toBe('api.example.com')
  })

  it('accepts a Bun-track config with [groundflare.bun]', () => {
    const result = validateGroundflareSection(
      {
        runtime: 'bun',
        bun: { main: 'src/server.ts' },
      },
      FILE,
    )
    expect(result.runtime).toBe('bun')
    expect(result.bun?.main).toBe('src/server.ts')
  })

  it('accepts nested bindings + adapter + backend', () => {
    const result = validateGroundflareSection(
      {
        bindings: {
          CACHE: { adapter: 'sqlite', path: '/var/lib/groundflare/kv/CACHE.sqlite' },
          MEDIA: { adapter: 'passthrough', backend: 'aws-s3', endpoint: 's3://bucket' },
        },
      },
      FILE,
    )
    expect(result.bindings?.CACHE?.adapter).toBe('sqlite')
    expect(result.bindings?.MEDIA?.backend).toBe('aws-s3')
  })

  it('accepts observability + alerts nesting', () => {
    const result = validateGroundflareSection(
      {
        observability: {
          metrics: 'prometheus',
          logs: 'json',
          alerts: { email: 'alerts@example.com' },
        },
      },
      FILE,
    )
    expect(result.observability?.metrics).toBe('prometheus')
    expect(result.observability?.alerts?.email).toBe('alerts@example.com')
  })

  it('accepts env-level overrides', () => {
    const result = validateGroundflareSection(
      {
        provider: 'hetzner',
        env: {
          production: { size: 'cx42', domain: 'prod.example.com' },
          staging: { size: 'cx11' },
        },
      },
      FILE,
    )
    expect(result.env?.production?.size).toBe('cx42')
    expect(result.env?.staging?.size).toBe('cx11')
  })
})

describe('validateGroundflareSection — unknown keys', () => {
  it('rejects a typo at the top level', () => {
    expect(() =>
      validateGroundflareSection({ provder: 'hetzner' }, FILE),
    ).toThrow(ConfigValidationError)
    try {
      validateGroundflareSection({ provder: 'hetzner' }, FILE)
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError)
      expect((err as Error).message).toContain('provder')
      expect((err as Error).message).toContain(FILE)
    }
  })

  it('rejects a typo inside observability', () => {
    try {
      validateGroundflareSection(
        { observability: { alrts: { email: 'x@y.com' } } },
        FILE,
      )
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError)
      expect((err as ConfigValidationError).configPath.join('.')).toContain('observability')
      expect((err as Error).message).toContain('alrts')
    }
  })

  it('rejects a typo inside bindings.<name>', () => {
    expect(() =>
      validateGroundflareSection(
        { bindings: { CACHE: { adaptr: 'sqlite' } } },
        FILE,
      ),
    ).toThrow(/adaptr/)
  })

  it('rejects `env` inside an env child', () => {
    expect(() =>
      validateGroundflareSection(
        { env: { production: { env: { nested: {} } } } },
        FILE,
      ),
    ).toThrow(ConfigValidationError)
  })
})

describe('validateGroundflareSection — enum values', () => {
  it('rejects an unknown provider value and lists valid ones', () => {
    try {
      validateGroundflareSection({ provider: 'linodee' }, FILE)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError)
      const msg = (err as Error).message
      expect(msg).toContain('linodee')
      expect(msg).toMatch(/hetzner|digitalocean|linode|vultr|contabo/)
    }
  })

  it('rejects an unknown runtime', () => {
    expect(() => validateGroundflareSection({ runtime: 'node' }, FILE)).toThrow(
      /node/,
    )
  })

  it('rejects an unknown adapter in a binding', () => {
    expect(() =>
      validateGroundflareSection(
        { bindings: { DB: { adapter: 'mongo' } } },
        FILE,
      ),
    ).toThrow(/mongo/)
  })

  it('rejects an unknown observability.metrics value', () => {
    expect(() =>
      validateGroundflareSection(
        { observability: { metrics: 'datadog' } },
        FILE,
      ),
    ).toThrow(/datadog/)
  })
})

describe('validateGroundflareSection — cross-field bun/runtime', () => {
  it('rejects [groundflare.bun] when runtime is unset', () => {
    expect(() =>
      validateGroundflareSection({ bun: { main: 's.ts' } }, FILE),
    ).toThrow(/runtime.*"bun"/)
  })

  it('rejects [groundflare.bun] when runtime = "workerd"', () => {
    expect(() =>
      validateGroundflareSection(
        { runtime: 'workerd', bun: { main: 's.ts' } },
        FILE,
      ),
    ).toThrow(ConfigValidationError)
  })

  it('accepts [groundflare.bun] when runtime = "bun" in the same section', () => {
    expect(() =>
      validateGroundflareSection(
        { runtime: 'bun', bun: { main: 's.ts' } },
        FILE,
      ),
    ).not.toThrow()
  })

  it('accepts [groundflare.env.X.bun] when env-level runtime = "bun"', () => {
    expect(() =>
      validateGroundflareSection(
        {
          env: {
            production: { runtime: 'bun', bun: { main: 's.ts' } },
          },
        },
        FILE,
      ),
    ).not.toThrow()
  })

  it('accepts [groundflare.env.X.bun] when parent runtime = "bun" (inherited)', () => {
    expect(() =>
      validateGroundflareSection(
        {
          runtime: 'bun',
          env: { production: { bun: { main: 's.ts' } } },
        },
        FILE,
      ),
    ).not.toThrow()
  })

  it('rejects [groundflare.env.X.bun] when parent runtime is workerd and env has no override', () => {
    expect(() =>
      validateGroundflareSection(
        {
          runtime: 'workerd',
          env: { production: { bun: { main: 's.ts' } } },
        },
        FILE,
      ),
    ).toThrow(ConfigValidationError)
  })
})

describe('validateGroundflareSection — type mismatches', () => {
  it('rejects a non-string domain', () => {
    expect(() => validateGroundflareSection({ domain: 42 }, FILE)).toThrow(
      ConfigValidationError,
    )
  })

  it('rejects a negative memory_mb', () => {
    expect(() =>
      validateGroundflareSection({ limits: { memory_mb: -1 } }, FILE),
    ).toThrow(ConfigValidationError)
  })

  it('rejects a non-object groundflare section', () => {
    expect(() => validateGroundflareSection('oops', FILE)).toThrow(
      ConfigValidationError,
    )
  })
})
