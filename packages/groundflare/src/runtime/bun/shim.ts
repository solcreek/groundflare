/**
 * Bun tenant shim generator.
 *
 * Emits a single `server.ts` string that `bun run` will execute on the
 * VPS. The shim:
 *   1. Imports the user's Worker entry module
 *   2. Constructs an `env` object from [vars] + per-binding facades
 *   3. Hosts it via `Bun.serve` with a single fetch handler
 *
 * Phase 1 scope (this file): single-tenant. Binding facades are stubs
 * that throw "not yet implemented" — the real `bun:sqlite` + S3 SDK
 * wiring lands in Phase 2 (task #19). The shim skeleton is stable; only
 * the `makeXxxFacade` bodies change between phases, so the generated
 * server.ts shape callers rely on is forward-compatible.
 *
 * Pure text producer — no I/O. The deploy flow writes the output to
 * `/var/lib/groundflare/server.ts` on the VPS; the systemd unit from
 * src/runtime/bun/systemd.ts points at that path.
 */

export interface BunKvBinding {
  readonly binding: string
  /**
   * Shard count; honoured by Phase 2 adapters. Phase 1 stubs accept it
   * but do not route differently. Default 1 — matches KV config default.
   */
  readonly shards?: number
}

export interface BunD1Binding {
  readonly binding: string
  readonly databaseName: string
}

export interface BunR2Binding {
  readonly binding: string
  readonly bucketName?: string
}

export interface BunShimOptions {
  /**
   * Path (relative to the emitted server file) to the user's entry
   * module. The shim does `import user from <entryModule>`, so this
   * must be a valid ESM import specifier — usually `'./user.js'`.
   */
  readonly entryModule: string

  /**
   * Bun.serve listen address. Default `0.0.0.0:8080` (matching the
   * workerd / Caddy reverse-proxy convention). Use the `port`
   * field form when passing to Bun.serve — we split host:port here.
   */
  readonly listenAddress?: string

  /**
   * `[vars]` from wrangler.toml. Stringified as `JSON.stringify` into
   * the shim source so the values are embedded at build time rather
   * than read from process.env at runtime — matches workerd behaviour
   * where [vars] are bundled into the capnp config, not env-time.
   *
   * Keys that need per-env flexibility should move to `groundflare
   * secret put` (lands in Phase 2) and be injected via
   * EnvironmentFile at systemd level.
   */
  readonly vars?: Record<string, string | number | boolean>

  readonly kvNamespaces?: readonly BunKvBinding[]
  readonly d1Databases?: readonly BunD1Binding[]
  readonly r2Buckets?: readonly BunR2Binding[]

  /**
   * Absolute directory on the VPS where SQLite-backed state lives.
   * The shim bakes per-binding file paths rooted here:
   *   KV: <stateBaseDir>/kv/<binding>.sqlite
   *   D1: <stateBaseDir>/d1/<databaseName>.sqlite (Phase 2c)
   *   R2: passthrough by default (Phase 2d)
   *
   * Default `/var/lib/groundflare` — matches the systemd unit's
   * WorkingDirectory and the Mirror track's layout.
   */
  readonly stateBaseDir?: string

  /**
   * Version string surfaced on the shim's `/__health` endpoint.
   * Mirrors `GenerateRouterOptions.version` on the workerd track so
   * both runtimes return the same response shape. Defaults to
   * "unknown" when not provided.
   */
  readonly version?: string
}

const DEFAULT_LISTEN = '0.0.0.0:8080'
const DEFAULT_STATE_BASE_DIR = '/var/lib/groundflare'

/**
 * Generate the full server.ts source that Bun executes. The string
 * begins with a provenance header, followed by imports, binding
 * configuration, facade stubs, and the Bun.serve entry.
 */
export function generateBunShim(opts: BunShimOptions): string {
  if (!opts.entryModule) {
    throw new TypeError('generateBunShim: entryModule is required')
  }
  const listen = opts.listenAddress ?? DEFAULT_LISTEN
  const { host, port } = parseListen(listen)
  const stateBaseDir = opts.stateBaseDir ?? DEFAULT_STATE_BASE_DIR
  const version = opts.version ?? 'unknown'
  const vars = opts.vars ?? {}
  const kv = opts.kvNamespaces ?? []
  const d1 = opts.d1Databases ?? []
  const r2 = opts.r2Buckets ?? []

  const kvLiteral = JSON.stringify(
    Object.fromEntries(
      [...kv]
        .sort((a, b) => a.binding.localeCompare(b.binding))
        .map((b) => [b.binding, { shards: b.shards ?? 1 }]),
    ),
  )
  const d1Literal = JSON.stringify(
    Object.fromEntries(
      [...d1]
        .sort((a, b) => a.binding.localeCompare(b.binding))
        .map((b) => [b.binding, { databaseName: b.databaseName }]),
    ),
  )
  const r2Literal = JSON.stringify(
    Object.fromEntries(
      [...r2]
        .sort((a, b) => a.binding.localeCompare(b.binding))
        .map((b) => [b.binding, { bucketName: b.bucketName ?? b.binding }]),
    ),
  )
  const varsLiteral = JSON.stringify(vars)

  return [
    HEADER,
    '',
    `import user from ${JSON.stringify(opts.entryModule)}`,
    `import { BunKVAdapter } from "./adapters/kv.ts"`,
    `import { BunD1Adapter } from "./adapters/d1.ts"`,
    `import { BunR2Adapter } from "./adapters/r2.ts"`,
    '',
    '// ── binding configuration (injected at build time) ─────────────',
    `const VARS = ${varsLiteral}`,
    `const KV_BINDINGS = ${kvLiteral}`,
    `const D1_BINDINGS = ${d1Literal}`,
    `const R2_BINDINGS = ${r2Literal}`,
    `const STATE_BASE_DIR = ${JSON.stringify(stateBaseDir)}`,
    `const VERSION = ${JSON.stringify(version)}`,
    'const BOOT_TIME_MS = Date.now()',
    '',
    '// ── binding facades ───────────────────────────────────────────',
    '// KV: bun:sqlite (adapters/kv.ts). One file per binding —',
    '//     `${STATE_BASE_DIR}/kv/<binding>.sqlite`.',
    '// D1: bun:sqlite (adapters/d1.ts). One file per database —',
    '//     `${STATE_BASE_DIR}/d1/<databaseName>.sqlite`.',
    '// R2: adapters/r2.ts. Endpoint + credentials come from env vars',
    '//     to keep secrets out of the compiled artifact:',
    '//       R2_<BINDING>_ENDPOINT        (optional — omit for local weed)',
    '//       R2_<BINDING>_ACCOUNT_ID      (optional — CF R2 shortcut)',
    '//       R2_<BINDING>_REGION          (optional — default auto/us-east-1)',
    '//       R2_<BINDING>_ACCESS_KEY_ID   (optional — required for signed endpoints)',
    '//       R2_<BINDING>_SECRET_ACCESS_KEY',
    '//     The systemd EnvironmentFile pulls these in from',
    '//     /etc/groundflare/environment. Default (no env set) → the',
    '//     local SeaweedFS sidecar at 127.0.0.1:8333 in anonymous mode,',
    '//     same as the Mirror track.',
    '',
    'function makeKvFacade(binding, _shards) {',
    '  return BunKVAdapter.open(`${STATE_BASE_DIR}/kv/${binding}.sqlite`)',
    '}',
    '',
    'function makeD1Facade(_binding, databaseName) {',
    '  return BunD1Adapter.open(`${STATE_BASE_DIR}/d1/${databaseName}.sqlite`)',
    '}',
    '',
    'function makeR2Facade(binding, bucketName) {',
    '  const envPrefix = "R2_" + binding.toUpperCase() + "_"',
    '  const endpoint = process.env[envPrefix + "ENDPOINT"]',
    '  const accountId = process.env[envPrefix + "ACCOUNT_ID"]',
    '  const region = process.env[envPrefix + "REGION"]',
    '  const accessKeyId = process.env[envPrefix + "ACCESS_KEY_ID"]',
    '  const secretAccessKey = process.env[envPrefix + "SECRET_ACCESS_KEY"]',
    '  const bucket = process.env[envPrefix + "BUCKET"] || bucketName',
    '  // Credential pairing is validated inside the adapter constructor.',
    '  // Missing both → anonymous (fine for local weed). One of the two',
    '  // missing → TypeError, caught on first request.',
    '  const adapterOpts = { bucket }',
    '  if (endpoint) adapterOpts.endpoint = endpoint',
    '  else if (accountId) adapterOpts.accountId = accountId',
    '  if (region) adapterOpts.region = region',
    '  if (accessKeyId) adapterOpts.accessKeyId = accessKeyId',
    '  if (secretAccessKey) adapterOpts.secretAccessKey = secretAccessKey',
    '  return new BunR2Adapter(adapterOpts)',
    '}',
    '',
    '// ── env construction ──────────────────────────────────────────',
    'function buildEnv() {',
    '  const env = { ...VARS }',
    '  for (const name of Object.keys(KV_BINDINGS)) {',
    '    env[name] = makeKvFacade(name, KV_BINDINGS[name].shards)',
    '  }',
    '  for (const name of Object.keys(D1_BINDINGS)) {',
    '    env[name] = makeD1Facade(name, D1_BINDINGS[name].databaseName)',
    '  }',
    '  for (const name of Object.keys(R2_BINDINGS)) {',
    '    env[name] = makeR2Facade(name, R2_BINDINGS[name].bucketName)',
    '  }',
    '  return env',
    '}',
    '',
    'const ENV = buildEnv()',
    '',
    '// ── Bun.serve entry ───────────────────────────────────────────',
    'const server = Bun.serve({',
    `  hostname: ${JSON.stringify(host)},`,
    `  port: ${port},`,
    '  development: false,',
    '  async fetch(request) {',
    '    // /__health — public liveness; intercepted before user code',
    '    // so the response shape matches the workerd Router (which has',
    '    // its own /__health handler upstream of tenant workers).',
    '    // Deploy probes parse this body, so it MUST stay JSON with',
    '    // `status: "ok"`.',
    '    const url = new URL(request.url)',
    '    if (url.pathname === "/__health") {',
    '      return new Response(',
    '        JSON.stringify({',
    '          status: "ok",',
    '          uptime_seconds: Math.floor((Date.now() - BOOT_TIME_MS) / 1000),',
    '          version: VERSION,',
    '        }),',
    '        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },',
    '      )',
    '    }',
    '    const ctx = {',
    '      waitUntil(promise) { promise.catch((err) => console.error("waitUntil:", err)) },',
    '      passThroughOnException() {},',
    '    }',
    '    return user.fetch(request, ENV, ctx)',
    '  },',
    '  error(err) {',
    '    console.error("groundflare Bun runtime error:", err)',
    '    return new Response("internal error", { status: 500 })',
    '  },',
    '})',
    '',
    'console.log(`groundflare Bun runtime listening on ${server.hostname}:${server.port}`)',
    '',
    '// Graceful shutdown so systemd stop drains in-flight requests',
    '// instead of SIGKILL-ing them.',
    'for (const sig of ["SIGTERM", "SIGINT"]) {',
    '  process.on(sig, async () => {',
    '    try {',
    '      await server.stop(false)',
    '      process.exit(0)',
    '    } catch (err) {',
    '      console.error("shutdown error:", err)',
    '      process.exit(1)',
    '    }',
    '  })',
    '}',
    '',
  ].join('\n')
}

const HEADER =
  '// GENERATED by groundflare — do not edit by hand.\n' +
  '// Regenerated on every `groundflare deploy`; local edits will be lost.\n' +
  '// Entry for the Bun runtime track. See design/tracks.md.'


function parseListen(address: string): { host: string; port: number } {
  // Accept `host:port` or `:port` (the latter is spelled `0.0.0.0:port`
  // when emitted — Bun requires a concrete hostname string).
  const idx = address.lastIndexOf(':')
  if (idx < 0) {
    throw new TypeError(
      `Bun shim: listenAddress must contain a port (got ${JSON.stringify(address)})`,
    )
  }
  const host = address.slice(0, idx) || '0.0.0.0'
  const portStr = address.slice(idx + 1)
  const port = Number(portStr)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(
      `Bun shim: port must be in [1, 65535] (got ${JSON.stringify(portStr)})`,
    )
  }
  return { host, port }
}
