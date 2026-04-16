/**
 * Data-driven provider registry.
 *
 * Two places in the codebase used to maintain their own
 * `switch (name)` statements on ProviderName: `bootstrap/run.ts`
 * (when spinning up a VPS) and `cli/commands/destroy.ts` (when tearing
 * one down). Adding a provider meant editing both plus this package's
 * `index.ts`. Missing one silently made the new provider unreachable
 * from that code path.
 *
 * Collect the {name → constructor} mapping in a single place so callers
 * go through `createProvider()`. Adding Linode/Vultr/Contabo is now one
 * map entry.
 */

import { DigitalOceanProvider } from './digitalocean.js'
import { HetznerProvider } from './hetzner.js'
import { LinodeProvider } from './linode.js'
import type { HttpProviderOptions } from './http-base.js'
import type { Provider, ProviderName } from './types.js'

export type ProviderFactory = (opts: HttpProviderOptions) => Provider

export const PROVIDER_REGISTRY: Readonly<Partial<Record<ProviderName, ProviderFactory>>> = {
  hetzner: (opts) => new HetznerProvider(opts),
  digitalocean: (opts) => new DigitalOceanProvider(opts),
  linode: (opts) => new LinodeProvider(opts),
  // vultr, contabo: not yet implemented — README lists them as planned.
  // ProviderName includes them so config validation and CLI help stay
  // consistent; attempting to use one throws the "not implemented" path
  // below.
}

export class UnknownProviderError extends Error {
  readonly providerName: string
  constructor(providerName: string) {
    const supported = Object.keys(PROVIDER_REGISTRY).sort().join(', ')
    super(
      `provider ${JSON.stringify(providerName)} is not implemented. ` +
        `Supported: ${supported}.`,
    )
    this.name = 'UnknownProviderError'
    this.providerName = providerName
  }
}

export function createProvider(
  name: ProviderName,
  opts: HttpProviderOptions,
): Provider {
  const factory = PROVIDER_REGISTRY[name]
  if (!factory) throw new UnknownProviderError(name)
  return factory(opts)
}

/** The provider names currently backed by an implementation. */
export function listImplementedProviders(): readonly ProviderName[] {
  return Object.keys(PROVIDER_REGISTRY) as ProviderName[]
}
