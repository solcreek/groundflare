/**
 * Drift detection — does the workspace's actual state still match
 * what groundflare expects?
 *
 * Four categories, cheapest → most expensive:
 *
 *   provider — cheap: one API call to confirm the VPS still exists,
 *             IP hasn't rotated, size hasn't changed. Catches the
 *             "operator deleted the droplet in the web console"
 *             scenario that would otherwise only surface on the next
 *             `up` (when things mysteriously fail).
 *
 *   dns     — DNS lookup for the configured domain; compare to
 *             state.vps.ipv4. Catches "DNS moved but VPS didn't",
 *             which silently serves the wrong origin to clients.
 *
 *   systemd — SSH probe for workerd/Caddy/SeaweedFS unit states.
 *             Already partly covered by `status`; we expand to
 *             include the R2 sidecar + treat anything non-active
 *             as drift.
 *
 *   files   — Key artefact presence: worker.capnp, Caddyfile. Doesn't
 *             verify hashes (that needs a `.deployed.json` marker we
 *             don't write yet — see Phase 3b). Catches wholesale
 *             deletion / permission breakage.
 *
 * Each check returns one DriftCheck; the caller decides how to
 * surface them (status renders a list, future plan integrations could
 * fold them into a unified command output).
 */

import { promises as dns } from 'node:dns'
import { URL } from 'node:url'

import type { BootstrapState } from '../bootstrap/index.js'
import type { Provider } from '../provider/index.js'
import type { SshClient } from '../ssh/index.js'

export type DriftSeverity = 'ok' | 'warn' | 'drift'

export interface DriftCheck {
  /** Short machine-readable id: "provider.vps-exists", "dns.a-record". */
  readonly id: string
  /** Human-readable label shown in the `[category] ✓` prefix. */
  readonly category: string
  /** One-sentence verdict. */
  readonly detail: string
  readonly severity: DriftSeverity
}

export interface CollectDriftOptions {
  readonly state: BootstrapState
  /** `[groundflare].domain` from wrangler.toml, when present. */
  readonly domain?: string
  /**
   * Live provider instance (with token loaded). Caller supplies so
   * we don't have to re-discover credentials here. Can be null when
   * the caller skips provider drift (offline mode, tests).
   */
  readonly provider: Provider | null
  /**
   * SSH client for in-VPS probes. Null → skip systemd + file checks.
   * `status` passes one; tests can pass null to exercise just the
   * offline categories.
   */
  readonly ssh: SshClient | null
  /**
   * Override DNS resolver. Tests inject a mock to avoid hitting real
   * DNS.
   */
  readonly resolveDns?: (hostname: string) => Promise<string[]>
}

/**
 * Collect every drift check that's applicable to the workspace's
 * current state. Order is stable so the rendered output is
 * deterministic.
 */
export async function collectDrift(
  opts: CollectDriftOptions,
): Promise<DriftCheck[]> {
  const checks: DriftCheck[] = []

  // ─── provider ──────────────────────────────────────────────────
  if (opts.state.vps !== undefined && opts.provider !== null) {
    checks.push(await checkProviderVps(opts.state.vps, opts.provider))
  }

  // ─── dns ───────────────────────────────────────────────────────
  if (opts.domain !== undefined && opts.state.vps !== undefined) {
    checks.push(
      await checkDnsMatchesVps(
        opts.domain,
        opts.state.vps.ipv4,
        opts.resolveDns ?? defaultResolver,
      ),
    )
  }

  // ─── systemd ───────────────────────────────────────────────────
  if (opts.ssh !== null) {
    const systemdChecks = await checkSystemdUnits(opts.ssh)
    checks.push(...systemdChecks)
  }

  // ─── files ─────────────────────────────────────────────────────
  if (opts.ssh !== null) {
    const fileChecks = await checkKeyArtefacts(opts.ssh)
    checks.push(...fileChecks)
  }

  return checks
}

// ─── Checks ────────────────────────────────────────────────────────

async function checkProviderVps(
  recorded: NonNullable<BootstrapState['vps']>,
  provider: Provider,
): Promise<DriftCheck> {
  let live
  try {
    live = await provider.getVPS(recorded.id)
  } catch (err) {
    return {
      id: 'provider.vps-exists',
      category: 'provider',
      severity: 'warn',
      detail: `provider getVPS failed: ${asMessage(err)}`,
    }
  }
  if (live === null) {
    return {
      id: 'provider.vps-exists',
      category: 'provider',
      severity: 'drift',
      detail: `VPS ${recorded.id} not found — destroyed outside groundflare?`,
    }
  }
  if (live.publicIPv4 !== recorded.ipv4) {
    return {
      id: 'provider.vps-ip',
      category: 'provider',
      severity: 'drift',
      detail: `IP changed: state=${recorded.ipv4} live=${live.publicIPv4 ?? '(none)'}`,
    }
  }
  if (live.size !== recorded.size) {
    return {
      id: 'provider.vps-size',
      category: 'provider',
      severity: 'drift',
      detail: `size changed: state=${recorded.size} live=${live.size} (resized externally)`,
    }
  }
  return {
    id: 'provider.vps-exists',
    category: 'provider',
    severity: 'ok',
    detail: `VPS ${recorded.id} present, IP + size match state`,
  }
}

async function checkDnsMatchesVps(
  domainOrUrl: string,
  vpsIp: string,
  resolver: (hostname: string) => Promise<string[]>,
): Promise<DriftCheck> {
  // Accept either bare hostname or a URL with scheme. URL parsing
  // extracts the hostname part so callers can paste whatever their
  // config has.
  let hostname = domainOrUrl
  try {
    if (domainOrUrl.includes('://')) hostname = new URL(domainOrUrl).hostname
  } catch {
    // Keep the raw string — DNS will fail visibly.
  }
  let addresses: string[]
  try {
    addresses = await resolver(hostname)
  } catch (err) {
    return {
      id: 'dns.a-record',
      category: 'dns',
      severity: 'warn',
      detail: `DNS lookup for ${hostname} failed: ${asMessage(err)}`,
    }
  }
  if (addresses.length === 0) {
    return {
      id: 'dns.a-record',
      category: 'dns',
      severity: 'drift',
      detail: `${hostname} has no A records`,
    }
  }
  if (addresses.includes(vpsIp)) {
    return {
      id: 'dns.a-record',
      category: 'dns',
      severity: 'ok',
      detail: `${hostname} → ${vpsIp} (matches VPS)`,
    }
  }
  return {
    id: 'dns.a-record',
    category: 'dns',
    severity: 'drift',
    detail: `${hostname} → ${addresses.join(', ')} (state says ${vpsIp})`,
  }
}

const SYSTEMD_UNITS: readonly string[] = [
  'groundflare-worker.service',
  'caddy.service',
  'groundflare-r2.service',
]

async function checkSystemdUnits(ssh: SshClient): Promise<DriftCheck[]> {
  const out: DriftCheck[] = []
  for (const unit of SYSTEMD_UNITS) {
    try {
      const probe = await ssh.run(`systemctl is-active ${unit}`, {
        timeoutMs: 10_000,
      })
      const active = probe.exitCode === 0 && probe.stdout.trim() === 'active'
      const stateText = probe.stdout.trim() || 'unknown'
      // Absent units (exit=4) are only drift for units we strictly
      // require — treat the R2 sidecar as optional because Bun-only
      // VPSes that don't declare R2 legitimately skip it.
      const optional = unit === 'groundflare-r2.service'
      if (active) {
        out.push({
          id: `systemd.${unit}`,
          category: 'systemd',
          severity: 'ok',
          detail: `${unit} active`,
        })
      } else if (stateText === 'inactive' && optional) {
        out.push({
          id: `systemd.${unit}`,
          category: 'systemd',
          severity: 'ok',
          detail: `${unit} inactive (optional; skipped on Bun-only VPSes)`,
        })
      } else {
        out.push({
          id: `systemd.${unit}`,
          category: 'systemd',
          severity: 'drift',
          detail: `${unit} ${stateText}`,
        })
      }
    } catch (err) {
      out.push({
        id: `systemd.${unit}`,
        category: 'systemd',
        severity: 'warn',
        detail: `probe failed: ${asMessage(err)}`,
      })
    }
  }
  return out
}

const KEY_ARTEFACTS: readonly string[] = [
  '/var/lib/groundflare/worker.capnp',
  '/etc/caddy/Caddyfile',
]

async function checkKeyArtefacts(ssh: SshClient): Promise<DriftCheck[]> {
  const out: DriftCheck[] = []
  for (const path of KEY_ARTEFACTS) {
    try {
      const probe = await ssh.run(
        // -c "%U %s" prints user + size; exit 1 if missing.
        `stat -c '%U %s' ${path} 2>/dev/null`,
        { timeoutMs: 10_000 },
      )
      if (probe.exitCode !== 0 || probe.stdout.trim() === '') {
        out.push({
          id: `files.${path}`,
          category: 'files',
          severity: 'drift',
          detail: `${path} missing`,
        })
        continue
      }
      const [owner, sizeStr] = probe.stdout.trim().split(/\s+/)
      const size = Number.parseInt(sizeStr ?? '0', 10)
      if (size === 0) {
        out.push({
          id: `files.${path}`,
          category: 'files',
          severity: 'drift',
          detail: `${path} exists but is empty`,
        })
      } else {
        out.push({
          id: `files.${path}`,
          category: 'files',
          severity: 'ok',
          detail: `${path} (owner: ${owner}, ${formatBytes(size)})`,
        })
      }
    } catch (err) {
      out.push({
        id: `files.${path}`,
        category: 'files',
        severity: 'warn',
        detail: `stat failed: ${asMessage(err)}`,
      })
    }
  }
  return out
}

// ─── Rendering ─────────────────────────────────────────────────────

const SEVERITY_GLYPH: Record<DriftSeverity, string> = {
  ok: '✓',
  warn: '⚠',
  drift: '✗',
}

/**
 * Render a list of drift checks to a terminal-friendly block.
 * Deterministic spacing: each check is `  [<category>] <glyph>
 * <detail>` with fixed-width category padding so the output columns
 * line up.
 */
export function renderDriftChecks(checks: readonly DriftCheck[]): string {
  if (checks.length === 0) return '  (no drift checks ran — pass --check-drift)\n'
  const categoryPad = Math.max(...checks.map((c) => c.category.length))
  const lines: string[] = []
  for (const c of checks) {
    const cat = `[${c.category}]`.padEnd(categoryPad + 2)
    lines.push(`  ${cat} ${SEVERITY_GLYPH[c.severity]} ${c.detail}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Summarise the checks into a single sentence for the status footer.
 * "No drift detected." / "X drift issue(s): …" / "… plus Y warning(s)".
 */
export function summarizeDrift(checks: readonly DriftCheck[]): string {
  const drift = checks.filter((c) => c.severity === 'drift').length
  const warn = checks.filter((c) => c.severity === 'warn').length
  if (drift === 0 && warn === 0) return 'No drift detected.'
  const parts: string[] = []
  if (drift > 0) parts.push(`${drift} drift issue${drift === 1 ? '' : 's'}`)
  if (warn > 0) parts.push(`${warn} warning${warn === 1 ? '' : 's'}`)
  return parts.join(', ') + '.'
}

export function hasDrift(checks: readonly DriftCheck[]): boolean {
  return checks.some((c) => c.severity === 'drift')
}

// ─── Helpers ───────────────────────────────────────────────────────

async function defaultResolver(hostname: string): Promise<string[]> {
  return dns.resolve4(hostname)
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
