/**
 * Top-level entry point: `runBootstrap()` wires the provider, secret
 * store, state store, all stages, and the orchestrator into a single
 * call the CLI invokes from `groundflare up`.
 *
 * Designed to be self-contained — pass workspace + provider config and
 * it handles state load/save, stage construction, and progress logging.
 * For dependency injection (tests, alternative providers), every
 * collaborator is overridable via options.
 */

import { HetznerProvider, type Provider, type ProviderName } from '../provider/index.js'
import { FileSecretStore, type SecretStore } from '../secret/index.js'

import { BootstrapOrchestrator } from './orchestrator.js'
import { BootstrapStateStore } from './state-store.js'
import { authStage } from './stages/00-auth.js'
import { sshKeyStage } from './stages/01-ssh-key.js'
import { provisionStage } from './stages/02-provision.js'
import { waitSshStage } from './stages/03-wait-ssh.js'
import { cloudInitStage } from './stages/04-cloud-init.js'
import { installRuntimeStage } from './stages/05-install-runtime.js'
import { installServicesStage } from './stages/06-install-services.js'
import {
  BootstrapError,
  type BootstrapContext,
  type BootstrapState,
  type LogFn,
  type Stage,
} from './types.js'

export interface RunBootstrapOptions {
  readonly workspace: string
  readonly provider: ProviderName
  readonly size: string
  readonly region: string

  /** Email passed to Caddy's ACME registration + cloud-init mail config. */
  readonly acmeEmail: string

  /**
   * Initial site for the Caddyfile placeholder. Subsequent deploys
   * regenerate the Caddyfile with the actual tenant set.
   */
  readonly placeholderDomain: string

  /** Override hostname; default `gf-<workspace>`. */
  readonly hostnameOverride?: string

  /** Override OS image (provider-specific). */
  readonly image?: string

  /** Override SSH key directory. Default ~/.config/groundflare/keys. */
  readonly sshKeyDirectory?: string

  /** Override workerd binary path uploaded to the VPS. */
  readonly workerdBinaryPath?: string

  /** Inject a logger (defaults to a console-style stderr writer). */
  readonly log?: LogFn

  /** Skip persistence; useful for dry-runs. */
  readonly dryRun?: boolean

  // ─── Test injection points ───────────────────────────────────────
  readonly providerOverride?: Provider
  readonly secretStoreOverride?: SecretStore
  readonly stateStoreOverride?: BootstrapStateStore
  readonly stagesOverride?: readonly Stage[]
}

const DEFAULT_LOG: LogFn = (level, message) => {
  process.stderr.write(`[${level}] ${message}\n`)
}

/**
 * Run the full bootstrap pipeline. Returns the final BootstrapState on
 * success, or throws BootstrapError(stage_failed) with the offending
 * stage ID on failure (state is still persisted so a resume picks up).
 */
export async function runBootstrap(opts: RunBootstrapOptions): Promise<BootstrapState> {
  const log = opts.log ?? DEFAULT_LOG

  // Construct collaborators (or accept overrides for tests).
  const secrets = opts.secretStoreOverride ?? new FileSecretStore()
  const stateStore = opts.stateStoreOverride ?? new BootstrapStateStore()

  const provider = opts.providerOverride ?? (await constructProvider(opts.provider, secrets))

  // Load (or initialise) state.
  const existing = await stateStore.load(opts.workspace)
  const state: BootstrapState = existing ?? {
    workspace: opts.workspace,
    provider: opts.provider,
    completedStages: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  // Sanity: state file says it belongs to a different provider — refuse
  // rather than silently using the wrong API.
  if (existing && existing.provider !== opts.provider) {
    throw new BootstrapError(
      `workspace ${JSON.stringify(opts.workspace)} was bootstrapped against ` +
        `${existing.provider}; cannot continue against ${opts.provider}`,
      'prerequisite',
    )
  }

  // Build the stage list. Use spread + conditional to avoid setting
  // optional fields to undefined (the type defs reject `?: T` = undefined
  // assignment in some configurations).
  const stages: readonly Stage[] = opts.stagesOverride ?? [
    authStage,
    sshKeyStage({
      ...(opts.sshKeyDirectory !== undefined ? { directory: opts.sshKeyDirectory } : {}),
    }),
    provisionStage({
      size: opts.size,
      region: opts.region,
      ...(opts.hostnameOverride !== undefined
        ? { hostnameOverride: opts.hostnameOverride }
        : {}),
      ...(opts.image !== undefined ? { image: opts.image } : {}),
      notifyEmail: opts.acmeEmail,
    }),
    waitSshStage(),
    cloudInitStage(),
    installRuntimeStage({
      ...(opts.workerdBinaryPath !== undefined
        ? { workerdBinaryPath: opts.workerdBinaryPath }
        : {}),
    }),
    installServicesStage({
      acmeEmail: opts.acmeEmail,
      placeholderDomain: opts.placeholderDomain,
    }),
  ]

  const orchestrator = new BootstrapOrchestrator(stages, {
    stateStore,
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
  })

  const ctx: BootstrapContext = {
    workspace: opts.workspace,
    provider,
    secrets,
    state,
    log,
  }

  await orchestrator.run(ctx)
  return ctx.state
}

async function constructProvider(
  name: ProviderName,
  secrets: SecretStore,
): Promise<Provider> {
  const tokenKey = `provider.${name}.token`
  const token = await secrets.get(tokenKey)
  if (token === null || token.length === 0) {
    throw new BootstrapError(
      `no provider token found at secret ${JSON.stringify(tokenKey)}; ` +
        `run \`groundflare secret set ${tokenKey} <token>\` first`,
      'prerequisite',
    )
  }
  switch (name) {
    case 'hetzner':
      return new HetznerProvider({ token })
    default:
      throw new BootstrapError(
        `provider ${JSON.stringify(name)} not yet supported (Hetzner only in v0.1)`,
        'prerequisite',
      )
  }
}
