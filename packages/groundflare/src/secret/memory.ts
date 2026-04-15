/**
 * In-memory SecretStore. Used by tests so they don't touch the user's
 * real ~/.config/groundflare/secrets.json. Also useful in CI where
 * secrets come from environment variables — wire them into a
 * MemorySecretStore at startup and the rest of the code is unchanged.
 */

import { SecretStoreError, type SecretStore } from './types.js'

const KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export class MemorySecretStore implements SecretStore {
  private readonly store = new Map<string, string>()

  constructor(initial?: Readonly<Record<string, string>>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        validate(k)
        if (typeof v !== 'string') {
          throw new SecretStoreError(`initial value for ${k} is not a string`, 'invalid')
        }
        this.store.set(k, v)
      }
    }
  }

  async get(key: string): Promise<string | null> {
    validate(key)
    return this.store.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    validate(key)
    if (typeof value !== 'string') {
      throw new SecretStoreError('value must be a string', 'invalid')
    }
    this.store.set(key, value)
  }

  async delete(key: string): Promise<void> {
    validate(key)
    this.store.delete(key)
  }

  async list(): Promise<readonly string[]> {
    return [...this.store.keys()].sort()
  }
}

function validate(key: string): void {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new SecretStoreError(
      `invalid secret key ${JSON.stringify(key)}: must match /${KEY_PATTERN.source}/`,
      'invalid',
    )
  }
}
