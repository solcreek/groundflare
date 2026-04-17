/**
 * Plan — a short summary of what a command WILL do, rendered for a TTY
 * before destructive or cost-incurring work runs.
 *
 * Philosophy (see design/tracks.md §"Plan vs Apply"):
 *   - `up` and `destroy` surface a plan because they create / destroy a
 *     real VPS that costs real money. Users should see what's about
 *     to happen before pressing enter.
 *   - `deploy` does NOT plan by default — redeploys are cheap +
 *     reversible, and plan prompts would churn the iteration loop.
 *   - `groundflare plan` is a standalone command for on-demand dry
 *     runs + drift detection (Phase 3).
 *
 * We intentionally do NOT adopt terraform's resource-graph plan model.
 * groundflare's "resources" are a handful per workspace (one VPS, a
 * few bindings, a Caddyfile) — field-level diffs would be over-
 * engineering for a single-operator self-host tool.
 */

import { consola } from 'consola'

import type { ProviderName } from '../provider/index.js'
import type { WorkspaceWorker } from '../runtime/workspace/index.js'

export type PlanActionKind =
  | 'create'
  | 'update'
  | 'skip'
  | 'destroy'
  | 'data-loss'

export interface PlanAction {
  readonly kind: PlanActionKind
  /** Short resource label, e.g. "VPS", "SSH key", "R2 bucket". */
  readonly resource: string
  /** One-line human summary. */
  readonly detail: string
  /**
   * Optional per-action cost impact — only set on create actions that
   * incur running cost. Rendered alongside the action for visibility.
   */
  readonly costHint?: string
}

export interface Plan {
  /** Top-line command name (`up`, `destroy`, …) — used in the header. */
  readonly title: string
  readonly actions: readonly PlanAction[]
  /**
   * Warnings the user should see before confirming — data loss
   * reminders, ambient drift, cost surprises. Rendered separately
   * from the action list.
   */
  readonly warnings?: readonly string[]
}

// ─── Builders ──────────────────────────────────────────────────────

export interface UpPlanInput {
  readonly workspace: string
  readonly provider: ProviderName
  readonly region: string
  readonly size: string
  readonly domain: string | undefined
  /**
   * The `[groundflare].preview` config value — drives whether a
   * sslip.io / nip.io hostname will be auto-derived when `domain` is
   * unset. `undefined`/`true` = default sslip.io; `false` = no
   * preview; string = explicit provider. The plan's warnings depend
   * on which of these got picked.
   */
  readonly preview: boolean | 'sslip.io' | 'nip.io' | undefined
  /**
   * Existing bootstrap state. When non-null + vps is live on provider,
   * the plan becomes "redeploy only" rather than "fresh provision".
   */
  readonly vpsExists: boolean
  readonly completedStages: readonly string[]
  readonly workers: readonly WorkspaceWorker[]
}

/**
 * Build the plan for `groundflare up`. Distinguishes three shapes:
 *   - Fresh: no state → full provision + bootstrap + deploy
 *   - Resume: partial state → skip done stages, finish the rest
 *   - Redeploy: VPS healthy → just `deploy`
 *
 * We don't query the VPS for drift here — that's `plan` /
 * `status --check-drift` (Phase 3). The caller can pre-hit
 * provider.getVPS() and fold the result into `vpsExists`.
 */
export function buildUpPlan(input: UpPlanInput): Plan {
  const actions: PlanAction[] = []

  if (!input.vpsExists) {
    actions.push({
      kind: 'create',
      resource: 'VPS',
      detail: `${input.size} in ${input.region} via ${input.provider}`,
      costHint: 'running hourly, ~$6–12/mo for s-1vcpu-1gb tier',
    })
    actions.push({
      kind: 'create',
      resource: 'SSH keypair',
      detail: 'ed25519 generated locally + public half uploaded to provider',
    })
    actions.push({
      kind: 'create',
      resource: 'cloud-init setup',
      detail:
        'Caddy + workerd + SeaweedFS + systemd units (first boot ~2–5 min)',
    })
  } else {
    actions.push({
      kind: 'skip',
      resource: 'VPS',
      detail: 'reusing existing droplet + SSH key from prior bootstrap',
    })
    const pendingStages = BOOTSTRAP_STAGES.filter(
      (s) => !input.completedStages.includes(s),
    )
    if (pendingStages.length > 0) {
      actions.push({
        kind: 'update',
        resource: 'bootstrap',
        detail: `resume ${pendingStages.length} stage(s): ${pendingStages.join(', ')}`,
      })
    }
  }

  const bindingSummary = summarizeBindings(input.workers)
  actions.push({
    kind: input.vpsExists ? 'update' : 'create',
    resource: 'deploy',
    detail:
      input.workers.length === 1
        ? `1 tenant${bindingSummary ? ` (${bindingSummary})` : ''}`
        : `${input.workers.length} tenants${bindingSummary ? ` (${bindingSummary})` : ''}`,
  })

  const warnings: string[] = []
  if (!input.domain) {
    if (input.preview === false) {
      warnings.push(
        'no [groundflare].domain set AND preview disabled — Caddy will have no site; add a domain or re-enable preview',
      )
    } else {
      const provider =
        typeof input.preview === 'string' ? input.preview : 'sslip.io'
      warnings.push(
        `no [groundflare].domain — a ${provider} preview hostname will be derived from the VPS IP (set domain to override)`,
      )
    }
  }

  return {
    title: `groundflare up — ${input.workspace}`,
    actions,
    warnings,
  }
}

export interface DestroyPlanInput {
  readonly workspace: string
  readonly provider: ProviderName
  readonly vps: { readonly id: string; readonly ipv4: string } | null
  readonly workers: readonly WorkspaceWorker[]
}

export function buildDestroyPlan(input: DestroyPlanInput): Plan {
  const actions: PlanAction[] = []

  if (input.vps !== null) {
    actions.push({
      kind: 'destroy',
      resource: 'VPS',
      detail: `${input.vps.id} at ${input.vps.ipv4} (${input.provider})`,
    })
  } else {
    actions.push({
      kind: 'skip',
      resource: 'VPS',
      detail: 'no VPS recorded in state — nothing to destroy on the provider',
    })
  }

  // Data-loss warnings. We don't query the live VPS here to stay
  // fast + offline; the summary is conservative.
  const bindings = summarizeBindings(input.workers)
  if (bindings.length > 0) {
    actions.push({
      kind: 'data-loss',
      resource: 'persistent state',
      detail: `whatever's in ${bindings} will be lost`,
    })
  }

  actions.push({
    kind: 'destroy',
    resource: 'local state file',
    detail: '~/.config/groundflare/state/<workspace>.json removed',
  })

  const warnings: string[] = []
  if (input.vps !== null) {
    warnings.push(
      'the droplet will be deleted at the provider — this is permanent; there is no undo',
    )
  }

  return {
    title: `groundflare destroy — ${input.workspace}`,
    actions,
    warnings,
  }
}

// ─── Rendering ─────────────────────────────────────────────────────

const KIND_PREFIX: Record<PlanActionKind, string> = {
  create: '+',
  update: '~',
  skip: '=',
  destroy: '-',
  'data-loss': '!',
}

/**
 * Produce the text blob to print before the confirmation prompt.
 * Deliberately avoids colour — consola renders over this; we don't
 * want to double-style.
 */
export function renderPlan(plan: Plan): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`Plan: ${plan.title}`)
  lines.push('')
  for (const a of plan.actions) {
    const prefix = KIND_PREFIX[a.kind]
    const base = `  ${prefix} ${a.resource}: ${a.detail}`
    lines.push(a.costHint ? `${base}\n      cost: ${a.costHint}` : base)
  }
  if (plan.warnings && plan.warnings.length > 0) {
    lines.push('')
    for (const w of plan.warnings) {
      lines.push(`  ⚠ ${w}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

// ─── Confirmation ──────────────────────────────────────────────────

export interface ConfirmPlanOptions {
  /** Skip the prompt entirely — used by --yes / CI. */
  readonly skip?: boolean
  /**
   * Require typed confirmation of a specific string (the workspace
   * name is a common pattern) — raises the friction on destroy-style
   * actions.
   */
  readonly typeToConfirm?: string
  /**
   * Default answer when the user just hits enter. `false` for
   * destructive, `true` for benign (up on a fresh workspace).
   */
  readonly defaultAnswer?: boolean
}

/**
 * Render the plan and (unless skip=true) block on user confirmation.
 * Returns true if the user said yes; false to abort.
 */
export async function confirmPlan(
  plan: Plan,
  opts: ConfirmPlanOptions = {},
): Promise<boolean> {
  process.stdout.write(renderPlan(plan))
  if (opts.skip === true) {
    process.stdout.write('  (auto-approved via --yes)\n\n')
    return true
  }
  if (opts.typeToConfirm !== undefined && opts.typeToConfirm !== '') {
    const typed = await consola.prompt(
      `Type ${JSON.stringify(opts.typeToConfirm)} to confirm:`,
      { type: 'text' },
    )
    return typeof typed === 'string' && typed.trim() === opts.typeToConfirm
  }
  const answer = await consola.prompt('Proceed?', {
    type: 'confirm',
    initial: opts.defaultAnswer ?? true,
  })
  return answer === true
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Stage names the bootstrap pipeline runs in order. Mirrored for the
 * up plan's "resume" action. Kept as a const rather than imported
 * from bootstrap/stages/index to avoid pulling the whole stage
 * machinery into the CLI-only plan builder.
 */
const BOOTSTRAP_STAGES = Object.freeze([
  'provider.auth',
  'provider.ssh-key',
  'provider.provision',
  'provider.wait-ssh',
  'system.cloud-init',
  'system.install-runtime',
  'system.install-services',
])

function summarizeBindings(workers: readonly WorkspaceWorker[]): string {
  let d1 = 0
  let kv = 0
  let r2 = 0
  let loaders = 0
  for (const w of workers) {
    d1 += w.d1Databases?.length ?? 0
    kv += w.kvNamespaces?.length ?? 0
    r2 += w.r2Buckets?.length ?? 0
    loaders += w.workerLoaders?.length ?? 0
  }
  const parts: string[] = []
  if (d1 > 0) parts.push(`${d1} D1`)
  if (kv > 0) parts.push(`${kv} KV`)
  if (r2 > 0) parts.push(`${r2} R2`)
  if (loaders > 0) parts.push(`${loaders} WorkerLoader`)
  return parts.join(', ')
}
