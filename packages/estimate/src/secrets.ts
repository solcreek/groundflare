/**
 * Minimal secret-reading surface.
 *
 * refreshPrices() needs exactly one thing from any secret backend: the
 * ability to look up a token by name. We define a lean `SecretReader`
 * interface locally so the estimate package doesn't depend on the main
 * groundflare CLI (the CLI's FileSecretStore satisfies this by
 * structural typing — same `get(key)` shape).
 *
 * Two implementations ship with the package:
 *   - EnvSecretReader  — reads well-known env vars (HCLOUD_TOKEN, ...)
 *   - MemorySecretReader — static map, useful for tests and programmatic use
 *
 * Upstream consumers can pass any object satisfying the interface.
 */

export interface SecretReader {
  /** Returns the secret or null if the key is unset. */
  get(key: string): Promise<string | null>
}

/**
 * Env-var-backed reader. Standalone `groundflare-estimate` uses this so
 * users can `HCLOUD_TOKEN=... npx groundflare-estimate` without
 * configuring a file-backed store. Keys map to conventional env var
 * names per provider.
 */
export class EnvSecretReader implements SecretReader {
  async get(key: string): Promise<string | null> {
    const mapped = ENV_KEY_MAP[key]
    if (mapped === undefined) return null
    for (const envName of mapped) {
      const value = process.env[envName]
      if (value !== undefined && value.length > 0) return value
    }
    return null
  }
}

/**
 * Static-map reader for tests and library callers that want to inject
 * known values without touching the environment or filesystem.
 */
export class MemorySecretReader implements SecretReader {
  private readonly store: Map<string, string>

  constructor(initial: Readonly<Record<string, string>> = {}) {
    this.store = new Map(Object.entries(initial))
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  set(key: string, value: string): void {
    this.store.set(key, value)
  }
}

const ENV_KEY_MAP: Readonly<Record<string, readonly string[]>> = {
  'provider.hetzner.token': ['HCLOUD_TOKEN', 'GROUNDFLARE_HETZNER_TOKEN'],
}
