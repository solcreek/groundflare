/**
 * Classify raw `env.<binding>` accesses against the wrangler config to
 * produce kind-tagged findings. The scanner can't distinguish a KV
 * binding from a D1 binding by AST alone — only wrangler.toml knows.
 *
 * Bindings declared in wrangler.toml that are *never* accessed in source
 * still show up in the report (informational), so reviewers see the full
 * binding inventory rather than just the in-use slice.
 */

import type {
  WranglerConfig,
  WranglerD1Database,
  WranglerKVNamespace,
  WranglerR2Bucket,
} from '../../../config/schema.js'
import type { RawEnvAccess } from './scan-file.js'
import type { Finding, FindingKind, Severity } from './types.js'

/**
 * Compatibility table — single source of truth for binding-kind →
 * Bun-track severity. Service bindings ride alongside KV/D1/R2 in the
 * "compatible" pile because the Bun shim resolves them via direct
 * function calls into the same process (Phase 4 wires the multi-tenant
 * variant; Phase 1 single-tenant doesn't need them).
 */
const KIND_BY_BINDING_TYPE: Record<
  'kv' | 'd1' | 'r2' | 'do' | 'service' | 'vars',
  { kind: FindingKind; severity: Severity; describe: (name: string) => string }
> = {
  kv: {
    kind: 'kv-binding',
    severity: 'compatible',
    describe: (n) => `KV binding ${n} → bun:sqlite (one file per binding)`,
  },
  d1: {
    kind: 'd1-binding',
    severity: 'compatible',
    describe: (n) => `D1 binding ${n} → bun:sqlite (one file per database)`,
  },
  r2: {
    kind: 'r2-binding',
    severity: 'compatible',
    describe: (n) => `R2 binding ${n} → S3-compat passthrough to Cloudflare R2`,
  },
  vars: {
    kind: 'vars-binding',
    severity: 'compatible',
    describe: (n) => `var ${n} — embedded into server.ts at build time`,
  },
  service: {
    kind: 'service-binding',
    severity: 'review-needed',
    describe: (n) =>
      `service binding ${n} — Bun Phase 1 is single-tenant; multi-worker dispatch lands in Phase 4`,
  },
  do: {
    kind: 'durable-object-binding',
    severity: 'blocker',
    describe: (n) =>
      `Durable Object binding ${n} — no Bun equivalent; stay on the Mirror track`,
  },
}

export interface ClassifierInput {
  wrangler: WranglerConfig
  envAccesses: readonly RawEnvAccess[]
}

export function classifyBindings(input: ClassifierInput): Finding[] {
  const { wrangler, envAccesses } = input
  const findings: Finding[] = []

  // Build lookup table: binding name → ('kv' | 'd1' | 'r2' | ...).
  const bindingKind = new Map<
    string,
    'kv' | 'd1' | 'r2' | 'do' | 'service' | 'vars'
  >()
  for (const b of wrangler.kv_namespaces ?? [])
    bindingKind.set(b.binding, 'kv')
  for (const b of wrangler.d1_databases ?? [])
    bindingKind.set(b.binding, 'd1')
  for (const b of wrangler.r2_buckets ?? [])
    bindingKind.set(b.binding, 'r2')
  for (const b of wrangler.durable_objects?.bindings ?? [])
    bindingKind.set(b.name, 'do')
  for (const name of Object.keys(wrangler.vars ?? {}))
    bindingKind.set(name, 'vars')

  // ── inventory: every declared binding gets one finding ───────────
  // KV / D1 / R2 / DO with deterministic ordering for stable diffs.
  for (const b of sortByBinding(wrangler.kv_namespaces ?? [])) {
    findings.push(makeBindingFinding('kv', b.binding))
  }
  for (const b of sortByBinding(wrangler.d1_databases ?? [])) {
    findings.push(makeBindingFinding('d1', b.binding))
  }
  for (const b of sortByBinding(wrangler.r2_buckets ?? [])) {
    findings.push(makeBindingFinding('r2', b.binding))
  }
  for (const name of Object.keys(wrangler.vars ?? {}).sort()) {
    findings.push(makeBindingFinding('vars', name))
  }
  for (const b of sortByName(wrangler.durable_objects?.bindings ?? [])) {
    findings.push(makeBindingFinding('do', b.name))
  }

  // ── env.<unknown> accesses get one finding per unique binding name ─
  const seenUnknown = new Set<string>()
  for (const access of envAccesses) {
    if (bindingKind.has(access.binding)) continue
    if (seenUnknown.has(access.binding)) continue
    seenUnknown.add(access.binding)
    findings.push({
      kind: 'unknown-env-access',
      severity: 'review-needed',
      message: `env.${access.binding} is read by source but has no matching binding in wrangler.toml`,
      location: access.location,
      detail: access.binding,
    })
  }

  return findings
}

function makeBindingFinding(
  type: keyof typeof KIND_BY_BINDING_TYPE,
  name: string,
): Finding {
  const spec = KIND_BY_BINDING_TYPE[type]
  return {
    kind: spec.kind,
    severity: spec.severity,
    message: spec.describe(name),
    detail: name,
  }
}

function sortByBinding<
  T extends WranglerKVNamespace | WranglerD1Database | WranglerR2Bucket,
>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.binding.localeCompare(b.binding))
}

function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name))
}
