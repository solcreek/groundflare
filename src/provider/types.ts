/**
 * VPS provider abstraction.
 *
 * groundflare talks to Hetzner / DigitalOcean / Linode / etc. through a
 * single Provider interface, so the bootstrap orchestrator and the CLI
 * stay provider-agnostic. This file defines the shared types.
 *
 * Keep the surface minimal — anything that's provider-specific (custom
 * disk volumes, snapshots, private networking) lives outside this
 * interface and the operator can fall back to the provider's own CLI.
 *
 * See design/provider.md for the ADR explaining why we don't pull in
 * Pulumi / Terraform here.
 */

export type ProviderName =
  | 'hetzner'
  | 'digitalocean'
  | 'linode'
  | 'vultr'
  | 'contabo'

// ─── Errors ────────────────────────────────────────────────────────

/**
 * Normalized error type. Provider implementations translate their HTTP
 * errors into this shape so callers can branch on retryability without
 * sniffing per-provider error codes.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable code (e.g. `unauthorized`, `quota_exceeded`). */
    public readonly code: string,
    /** Underlying HTTP status, if applicable. */
    public readonly status: number | undefined,
    /** Whether the caller should retry after a backoff. */
    public readonly retryable: boolean,
    /** Optional underlying error (network failure, parse error, etc.). */
    options?: { cause?: unknown },
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'ProviderError'
  }
}

// ─── Discovery types ───────────────────────────────────────────────

export interface Account {
  /** Provider-assigned identifier, e.g. project ID. */
  readonly id: string
  /** Human-readable name shown in CLI output. */
  readonly name: string
  /** Optional contact email if the API exposes it. */
  readonly email?: string
}

export interface Size {
  /** Provider-specific size identifier, e.g. `cx22`. */
  readonly id: string
  readonly name: string
  readonly cpuCores: number
  readonly ramGiB: number
  readonly diskGiB: number
  /** Monthly list price in cents of the provider's primary currency (EUR for Hetzner, USD elsewhere). */
  readonly priceMonthlyCents: number
  /** Free included egress per month, if applicable. */
  readonly egressFreeTb?: number
  /** Region IDs in which this size is currently available. Empty = unknown. */
  readonly availableInRegions: readonly string[]
}

export interface Region {
  /** Provider-specific region identifier, e.g. `hel1`. */
  readonly id: string
  readonly name: string
  readonly country?: string
  readonly city?: string
}

// ─── SSH keys ──────────────────────────────────────────────────────

export interface SSHKey {
  readonly id: string
  readonly name: string
  /** SHA-256 fingerprint, lowercase hex with colons. */
  readonly fingerprint: string
}

export interface SSHKeyOptions {
  readonly name: string
  /** OpenSSH-format public key (`ssh-ed25519 ...` or similar). */
  readonly publicKey: string
}

// ─── VPS lifecycle ─────────────────────────────────────────────────

export interface ProvisionOptions {
  readonly name: string
  readonly size: string
  readonly region: string
  /** OS image identifier. Defaults to the provider's current Ubuntu LTS. */
  readonly image?: string
  /** SSH key IDs (from `uploadSSHKey`) to install on the new VPS. */
  readonly sshKeyIds: readonly string[]
  /** cloud-init user-data YAML applied at first boot. */
  readonly userData?: string
  /** Optional labels for tracking/auditing. */
  readonly labels?: Record<string, string>
}

export type VPSStatus =
  | 'initializing'
  | 'running'
  | 'stopped'
  | 'deleting'
  | 'unknown'

export interface VPS {
  readonly id: string
  readonly name: string
  readonly status: VPSStatus
  readonly publicIPv4?: string
  readonly publicIPv6?: string
  /** Size identifier (e.g. `cx22`). */
  readonly size: string
  /** Region identifier (e.g. `hel1`). */
  readonly region: string
  /** ISO 8601 timestamp from the provider. */
  readonly createdAt: string
  readonly labels?: Record<string, string>
}

// ─── Provider interface ────────────────────────────────────────────

export interface Provider {
  readonly name: ProviderName
  readonly displayName: string

  /**
   * Verify the token works. Returns a normalized Account for the project.
   * Throws ProviderError(`unauthorized`) on bad credentials.
   */
  authenticate(token: string): Promise<Account>

  // ─── Discovery ─────────────────────────────────────────────────
  listSizes(region?: string): Promise<readonly Size[]>
  listRegions(): Promise<readonly Region[]>

  // ─── SSH keys ──────────────────────────────────────────────────
  uploadSSHKey(opts: SSHKeyOptions): Promise<SSHKey>
  listSSHKeys(): Promise<readonly SSHKey[]>
  deleteSSHKey(id: string): Promise<void>

  // ─── VPS lifecycle ─────────────────────────────────────────────
  createVPS(opts: ProvisionOptions): Promise<VPS>
  /** Returns null if the VPS isn't found (vs. throwing for transport errors). */
  getVPS(id: string): Promise<VPS | null>
  listVPS(): Promise<readonly VPS[]>
  destroyVPS(id: string): Promise<void>

  /**
   * Synchronous price lookup using a baked-in price table. Returns 0 when
   * the size/region pair is unknown — callers should treat 0 as "no quote".
   */
  estimateMonthlyCost(opts: { size: string; region: string }): number
}
