/**
 * Surgical TOML patcher for `[groundflare] runtime = "<kind>"`.
 *
 * Why a hand-rolled patcher: `smol-toml` (our parser) has no round-trip
 * writer — serializing a parsed document loses comments and key order.
 * `@iarna/toml` has the same limitation. For a flip as small as
 * toggling one key, text-level surgery is both simpler and more
 * respectful of the user's file.
 *
 * Rules:
 *   1. `[groundflare]` header with `runtime = "x"` inside  → replace value
 *   2. `[groundflare]` header without `runtime` key        → insert line
 *      right after the header (inside the section body)
 *   3. No `[groundflare]` header at all                    → append
 *      `\n[groundflare]\nruntime = "<kind>"\n` to end of file
 *
 * Subtables (`[groundflare.env.staging]`, `[groundflare.bun]`, …) are
 * ignored; only the standalone `[groundflare]` header counts.
 *
 * Inline-table form `groundflare = { ... }` is rejected with a clear
 * error — it's valid TOML but rare in wrangler files, and rewriting it
 * inline-safely is not worth the complexity for an edge case.
 */

export type PatchKind = 'replaced' | 'inserted' | 'appended'

export interface PatchResult {
  content: string
  kind: PatchKind
  /** Previous value when kind === 'replaced'. */
  previous: string | null
}

export class TomlPatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TomlPatchError'
  }
}

export function patchRuntimeInWranglerToml(
  source: string,
  runtime: 'workerd' | 'bun',
): PatchResult {
  assertNoInlineGroundflareTable(source)

  const newline = detectNewline(source)
  const lines = source.split(/\r?\n/)

  const headerIdx = findGroundflareHeader(lines)
  if (headerIdx === -1) {
    const trailing = source.endsWith('\n') ? '' : newline
    const block =
      `${trailing}${newline}[groundflare]${newline}runtime = ${JSON.stringify(runtime)}${newline}`
    return { content: source + block, kind: 'appended', previous: null }
  }

  const sectionEnd = findSectionEnd(lines, headerIdx)
  const runtimeLine = findRuntimeLine(lines, headerIdx + 1, sectionEnd)

  if (runtimeLine !== null) {
    const before = lines[runtimeLine]!
    const match = before.match(/^(\s*runtime\s*=\s*)(.*?)(\s*(?:#.*)?)$/)
    if (!match) throw new TomlPatchError(`malformed runtime line: ${before}`)
    const [, prefix, value, suffix] = match
    const previous = extractStringValue(value ?? '')
    if (previous === runtime) {
      return { content: source, kind: 'replaced', previous }
    }
    lines[runtimeLine] = `${prefix}${JSON.stringify(runtime)}${suffix}`
    return {
      content: lines.join(newline),
      kind: 'replaced',
      previous,
    }
  }

  // Insert immediately after the header line (idiomatic placement).
  lines.splice(headerIdx + 1, 0, `runtime = ${JSON.stringify(runtime)}`)
  return { content: lines.join(newline), kind: 'inserted', previous: null }
}

// ─── helpers ───────────────────────────────────────────────────────

function detectNewline(source: string): string {
  return /\r\n/.test(source) ? '\r\n' : '\n'
}

function assertNoInlineGroundflareTable(source: string): void {
  // Strictly: `groundflare = { ... }` at line start (after optional whitespace)
  // that is not inside a quoted key. We use a line scan so string literals
  // elsewhere don't false-positive.
  const re = /^\s*groundflare\s*=\s*\{/m
  if (re.test(source)) {
    throw new TomlPatchError(
      'wrangler.toml uses the inline-table form `groundflare = { ... }`; ' +
        'convert it to a `[groundflare]` section and rerun `groundflare bun prepare`',
    )
  }
}

/**
 * Index of the standalone `[groundflare]` header line (not a subtable
 * like `[groundflare.env.prod]`), or -1 if absent.
 */
function findGroundflareHeader(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[groundflare\]\s*(#.*)?$/.test(lines[i]!)) return i
  }
  return -1
}

/**
 * End index (exclusive) of the section body that starts at `headerIdx`.
 * Stops at the next top-level table or subtable that isn't under
 * `[groundflare.*]` (since subtables are still part of the section).
 * Walks to EOF if nothing else follows.
 */
function findSectionEnd(lines: readonly string[], headerIdx: number): number {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!
    // Match any bracketed table header including `[[x]]` array-of-tables.
    const m = line.match(/^\s*\[\[?([^\]]+)\]?\]\s*(#.*)?$/)
    if (!m) continue
    const name = m[1]!.trim()
    if (name !== 'groundflare' && !name.startsWith('groundflare.')) {
      return i
    }
    // A `[groundflare]` line seen twice would be a malformed TOML file;
    // let the outer parser reject it later.
  }
  return lines.length
}

/** Index of the first `runtime = ...` line in a section body, or null. */
function findRuntimeLine(
  lines: readonly string[],
  startIdx: number,
  endIdx: number,
): number | null {
  for (let i = startIdx; i < endIdx; i++) {
    const line = lines[i]!
    if (/^\s*runtime\s*=/.test(line)) return i
  }
  return null
}

function extractStringValue(raw: string): string | null {
  const m = raw.trim().match(/^"([^"]*)"$|^'([^']*)'$/)
  if (!m) return null
  return m[1] ?? m[2] ?? null
}
