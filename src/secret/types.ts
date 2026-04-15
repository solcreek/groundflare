/**
 * Secret storage abstraction.
 *
 * Keeps API tokens and other credentials out of process env vars and out
 * of users' shell history. The default implementation is a plain JSON
 * file at ~/.config/groundflare/secrets.json with mode 0600 — the same
 * convention AWS CLI, GitHub CLI, Docker, and friends use.
 *
 * Why not OS keychain (keytar / @napi-rs/keyring)?
 *   - Both ship native add-ons. We just removed sharp from devDeps to
 *     avoid the same node-gyp install fragility on contributors' machines.
 *   - The threat model for groundflare's CLI is "compromised local
 *     account already loses everything" — OS keychain protects against
 *     other-user access (which 0600 also does) and adds a UX prompt
 *     (TouchID on macOS) but doesn't change the security boundary.
 *   - The interface here keeps the door open: a future
 *     KeychainSecretStore satisfying the same SecretStore contract can
 *     drop in for users who prefer it.
 *
 * Naming convention (suggested, not enforced):
 *   provider.hetzner.token
 *   provider.digitalocean.token
 *   workspace.<name>.restic_password
 *   workspace.<name>.acme_account_key
 */

export interface SecretStore {
  /** Returns the secret, or null if the key is not set. */
  get(key: string): Promise<string | null>

  /** Stores (or overwrites) the secret under `key`. */
  set(key: string, value: string): Promise<void>

  /** Removes the secret. No-op if it didn't exist. */
  delete(key: string): Promise<void>

  /** Lists all known secret names (not values). */
  list(): Promise<readonly string[]>
}

export class SecretStoreError extends Error {
  constructor(
    message: string,
    /**
     * Stable code:
     *   - `not_found` (rarely thrown — most APIs return null instead)
     *   - `corrupt`   (file exists but contents won't parse)
     *   - `denied`    (filesystem permission error)
     *   - `io`        (other I/O failure)
     *   - `invalid`   (caller passed a bad key/value)
     */
    public readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'SecretStoreError'
  }
}
