/**
 * Unit tests for the preview-hostname derivation helpers.
 *
 * Kept in its own file (not smushed into run.test.ts) because it's a
 * pure function with no SSH / state / mock machinery around it. Fast
 * to run, easy to audit.
 */

import { describe, expect, it } from 'vitest'

import {
  derivePreviewHostname,
  resolvePreviewProvider,
} from '../../../src/deploy/preview.js'

describe('derivePreviewHostname', () => {
  it('dash-separates an IPv4 for sslip.io', () => {
    expect(derivePreviewHostname({ ipv4: '203.0.113.10' })).toBe(
      '203-0-113-10.sslip.io',
    )
  })

  it('honours an explicit nip.io provider', () => {
    expect(
      derivePreviewHostname({ ipv4: '203.0.113.10', provider: 'nip.io' }),
    ).toBe('203-0-113-10.nip.io')
  })

  it('prepends an optional subdomain prefix (multi-worker workspaces)', () => {
    expect(
      derivePreviewHostname({ ipv4: '203.0.113.10', prefix: 'api' }),
    ).toBe('api.203-0-113-10.sslip.io')
  })

  it('rejects non-IPv4 input rather than emit a broken hostname', () => {
    expect(() => derivePreviewHostname({ ipv4: '::1' })).toThrow(/IPv4/)
    expect(() => derivePreviewHostname({ ipv4: '192.168.1' })).toThrow(/IPv4/)
    expect(() => derivePreviewHostname({ ipv4: 'example.com' })).toThrow()
  })

  it('rejects out-of-range octets', () => {
    expect(() => derivePreviewHostname({ ipv4: '10.0.0.999' })).toThrow(
      /out of range/,
    )
    expect(() => derivePreviewHostname({ ipv4: '300.0.0.1' })).toThrow(
      /out of range/,
    )
  })

  it('rejects non-numeric octets', () => {
    expect(() => derivePreviewHostname({ ipv4: '10.0.a.1' })).toThrow(/numeric/)
  })
})

describe('resolvePreviewProvider', () => {
  it('undefined → default sslip.io', () => {
    expect(resolvePreviewProvider(undefined)).toBe('sslip.io')
  })
  it('true → default sslip.io', () => {
    expect(resolvePreviewProvider(true)).toBe('sslip.io')
  })
  it('false → null (opt out)', () => {
    expect(resolvePreviewProvider(false)).toBeNull()
  })
  it('explicit "nip.io" passes through', () => {
    expect(resolvePreviewProvider('nip.io')).toBe('nip.io')
  })
  it('explicit "sslip.io" passes through', () => {
    expect(resolvePreviewProvider('sslip.io')).toBe('sslip.io')
  })
})
