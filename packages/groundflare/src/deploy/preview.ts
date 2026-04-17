/**
 * Preview hostname derivation — gives `groundflare up` a valid public
 * HTTPS URL on the fresh VPS even when no custom domain is configured.
 *
 * sslip.io and nip.io are public DNS services that resolve
 * IP-in-hostname patterns (`1-2-3-4.sslip.io` → 1.2.3.4). Caddy can
 * then request a Let's Encrypt certificate for that hostname via
 * HTTP-01 — the challenge validator hits port 80 at the resolved IP,
 * which is the same VPS Caddy is running on. Zero DNS configuration
 * required from the user.
 *
 * Rate-limit caveat: all sslip.io / nip.io users share one LE
 * registered-domain budget. Fine for the occasional dev deploy;
 * unsuitable for per-commit CI that recreates droplets constantly.
 */

export type PreviewProvider = 'sslip.io' | 'nip.io'

export interface DerivePreviewHostnameOptions {
  /** IPv4 or IPv6 of the VPS. */
  readonly ipv4: string
  /** Magic-DNS provider. Default `'sslip.io'`. */
  readonly provider?: PreviewProvider
  /**
   * Optional subdomain prefix. When emitting a hostname per tenant on
   * a multi-worker workspace, prepend the worker name here to
   * disambiguate.
   */
  readonly prefix?: string
}

/**
 * Build the preview hostname for a VPS IP. Both sslip.io and nip.io
 * accept the dash-separated form for IPv4; that's the form we always
 * use. Dotted IPv4 (`1.2.3.4.sslip.io`) also works but blends into
 * real subdomain namespaces — the dash form is easier to read + less
 * ambiguous.
 *
 * Throws on malformed IP so we fail fast rather than emit a hostname
 * that won't resolve.
 */
export function derivePreviewHostname(
  opts: DerivePreviewHostnameOptions,
): string {
  const provider = opts.provider ?? 'sslip.io'
  const hyphenated = toHyphenatedIp(opts.ipv4)
  const base = `${hyphenated}.${provider}`
  return opts.prefix ? `${opts.prefix}.${base}` : base
}

/**
 * Normalise a config `preview` value (the wrangler `[groundflare]`
 * extension) into a concrete provider name, or null when the user
 * explicitly opted out.
 *
 *   undefined → default provider (sslip.io)
 *   true      → default provider (sslip.io)
 *   false     → null (skip preview)
 *   "sslip.io" / "nip.io" → that exact provider
 */
export function resolvePreviewProvider(
  value: boolean | PreviewProvider | undefined,
): PreviewProvider | null {
  if (value === false) return null
  if (value === undefined || value === true) return 'sslip.io'
  return value
}

function toHyphenatedIp(ip: string): string {
  // IPv4 dotted form → dash form. We reject anything else (IPv6,
  // hostnames, garbage) rather than emit a broken label — the DNS
  // service would NXDOMAIN and the LE challenge would fail silently.
  const parts = ip.split('.')
  if (parts.length !== 4) {
    throw new TypeError(
      `derivePreviewHostname: expected IPv4 dotted form, got ${JSON.stringify(ip)}`,
    )
  }
  for (const p of parts) {
    if (!/^\d+$/.test(p)) {
      throw new TypeError(
        `derivePreviewHostname: IPv4 octet ${JSON.stringify(p)} is not numeric`,
      )
    }
    const n = parseInt(p, 10)
    if (n < 0 || n > 255) {
      throw new TypeError(
        `derivePreviewHostname: IPv4 octet ${p} out of range (0-255)`,
      )
    }
  }
  return parts.join('-')
}
