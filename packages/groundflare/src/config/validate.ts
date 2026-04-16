/**
 * Strict schema validation for the `[groundflare]` section.
 *
 * Wrangler's own surface is passed through untouched — Cloudflare owns
 * that shape and we don't want to break on new CF fields we haven't
 * learned about yet. But the `[groundflare]` extension is ours, and
 * silently ignoring typos like `provder = "hetzner"` wastes users'
 * time on a failed deploy before they see the mistake.
 *
 * zod gives us, in ~100 lines:
 *   - `.strict()` on every object rejects unknown keys with a precise
 *     path (`[groundflare.observability.alrts]` rather than a vague
 *     `check your config`).
 *   - `.enum()` for provider, runtime, adapter, backend, metrics, logs.
 *     Error messages list valid values for free.
 *   - `superRefine` for the cross-field rule — `[groundflare.bun]`
 *     only parses when the effective runtime (same section or an
 *     enclosing one) is `"bun"`. Previously silent, now loud.
 *
 * Errors surface as `ConfigValidationError` with `{file, configPath}`
 * so the caller can render them however it likes.
 */

import { z } from 'zod'

import type {
  GroundflareSection,
} from './schema.js'

export class ConfigValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly configPath: readonly string[],
    message: string,
  ) {
    const loc =
      configPath.length > 0
        ? `groundflare.${configPath.join('.')}`
        : 'groundflare'
    super(`${file}: [${loc}] ${message}`)
    this.name = 'ConfigValidationError'
  }
}

// ─── leaf schemas ─────────────────────────────────────────────────

const bindingConfigSchema = z
  .object({
    adapter: z
      .enum([
        'sqlite',
        'redis',
        'memory',
        'libsql',
        'postgres',
        'passthrough',
        's3',
      ])
      .optional(),
    backend: z
      .enum(['seaweedfs', 'rustfs', 'aws-s3', 'b2', 'custom'])
      .optional(),
    path: z.string().optional(),
    url: z.string().optional(),
    endpoint: z.string().optional(),
  })
  .strict()

const limitsSchema = z
  .object({
    memory_mb: z.number().nonnegative().optional(),
    cpu_pct: z.number().nonnegative().optional(),
  })
  .strict()

const alertsSchema = z
  .object({
    email: z.string().optional(),
    webhook: z.string().optional(),
  })
  .strict()

const observabilitySchema = z
  .object({
    metrics: z.enum(['prometheus', 'none']).optional(),
    logs: z.enum(['json', 'text']).optional(),
    alerts: alertsSchema.optional(),
  })
  .strict()

const bunBlockSchema = z
  .object({
    main: z.string().optional(),
    bindings: z.record(z.string(), bindingConfigSchema).optional(),
  })
  .strict()

// ─── section shape (shared between top-level and [groundflare.env.*]) ──

const sectionFields = {
  provider: z
    .enum(['hetzner', 'digitalocean', 'linode', 'vultr', 'contabo'])
    .optional(),
  region: z.string().optional(),
  size: z.string().optional(),
  domain: z.string().optional(),
  email: z.string().optional(),
  backup: z.string().optional(),
  runtime: z.enum(['workerd', 'bun']).optional(),
  bindings: z.record(z.string(), bindingConfigSchema).optional(),
  limits: limitsSchema.optional(),
  observability: observabilitySchema.optional(),
  bun: bunBlockSchema.optional(),
}

// env children can't declare env themselves.
const envChildSchema = z.object(sectionFields).strict()

// top-level allows `env`, plus cross-field checks for `bun` → `runtime`.
const topLevelSchema = z
  .object({
    ...sectionFields,
    env: z.record(z.string(), envChildSchema).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const topRuntime = data.runtime
    if (data.bun && topRuntime !== 'bun') {
      ctx.addIssue({
        code: 'custom',
        path: ['bun'],
        message:
          '`[groundflare.bun]` is only valid when `runtime = "bun"` is set in the same section or an enclosing one',
      })
    }
    if (data.env) {
      for (const [envName, section] of Object.entries(data.env)) {
        const effective = section.runtime ?? topRuntime
        if (section.bun && effective !== 'bun') {
          ctx.addIssue({
            code: 'custom',
            path: ['env', envName, 'bun'],
            message:
              '`[groundflare.bun]` is only valid when `runtime = "bun"` is set in the same section or an enclosing one',
          })
        }
      }
    }
  })

// ─── entry point ──────────────────────────────────────────────────

// Zod's default messages for enum/type mismatches don't echo the
// offending input, which is most of the DX value ("you wrote X but
// only Y,Z are valid"). Supply a custom error map so the issues end up
// with messages that include the received value.
const errorMap: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.map((k) => `\`${k}\``).join(', ')
    return `unknown key${issue.keys.length > 1 ? 's' : ''}: ${keys}`
  }
  if (issue.code === 'invalid_value') {
    const valid = issue.values.map((v) => JSON.stringify(v)).join(', ')
    const got =
      issue.input === undefined ? '' : ` ${JSON.stringify(issue.input)}`
    return `invalid value${got}; valid: ${valid}`
  }
  if (issue.code === 'invalid_type') {
    const got =
      issue.input === undefined
        ? ''
        : ` (received ${describeInput(issue.input)})`
    return `expected ${issue.expected}${got}`
  }
  return undefined
}

export function validateGroundflareSection(
  raw: unknown,
  file: string,
): GroundflareSection {
  const result = topLevelSchema.safeParse(raw, { error: errorMap })
  if (!result.success) {
    const first = result.error.issues[0]!
    throw new ConfigValidationError(
      file,
      first.path.map((p) => String(p)),
      first.message,
    )
  }
  return result.data as GroundflareSection
}

function describeInput(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return `${typeof value} ${JSON.stringify(value)}`
}
