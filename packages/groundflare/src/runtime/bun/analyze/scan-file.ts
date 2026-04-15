/**
 * Scan a single source file for Bun-track compatibility findings.
 *
 * Pure function: takes a path label + source text, returns Finding[]
 * with file-relative line/column. The classifier in ./classify.ts
 * applies wrangler-config knowledge afterwards.
 *
 * Uses oxc-parser for AST. We only inspect a handful of node types
 * (MemberExpression, NewExpression, ClassDeclaration, ExportDefault,
 * ExportNamed) so a hand-rolled recursive walker is cheaper than
 * pulling in `acorn-walk` or `@babel/traverse`.
 */

import { parseSync } from 'oxc-parser'
import type { Finding, FindingLocation } from './types.js'

/** Identifiers we treat as Bun blockers when used as `new X()`. */
const NEW_BLOCKERS: Record<string, { kind: Finding['kind']; message: string }> = {
  HTMLRewriter: {
    kind: 'html-rewriter',
    message:
      'HTMLRewriter has no Bun equivalent (use linkedom or rewrite with cheerio)',
  },
  WebSocketPair: {
    kind: 'web-socket-pair',
    message:
      'WebSocketPair has no Bun equivalent (use Bun.serve websocket option)',
  },
}

/** Identifiers we treat as Bun blockers when subclassed. */
const CLASS_BLOCKERS: Record<string, { kind: Finding['kind']; message: string }> = {
  DurableObject: {
    kind: 'durable-object-class',
    message:
      'class extends DurableObject — no Bun equivalent; stay on the Mirror track',
  },
}

/**
 * Findings emitted for raw `env.<name>.*` accesses. The classifier later
 * upgrades these to kv/d1/r2/vars based on the wrangler manifest.
 */
export interface RawEnvAccess {
  binding: string
  location: FindingLocation
}

export interface ScanResult {
  findings: Finding[]
  /** env.<binding> accesses found in this file — classifier consumes these. */
  envAccesses: RawEnvAccess[]
  /** True iff parser hit a hard error (file is silently skipped in the report). */
  parseError: { message: string } | null
}

export function scanFile(filePath: string, source: string): ScanResult {
  const findings: Finding[] = []
  const envAccesses: RawEnvAccess[] = []

  let parsed: ReturnType<typeof parseSync>
  try {
    parsed = parseSync(filePath, source)
  } catch (err) {
    return {
      findings: [],
      envAccesses: [],
      parseError: { message: err instanceof Error ? err.message : String(err) },
    }
  }
  if (parsed.errors.length > 0) {
    return {
      findings: [],
      envAccesses: [],
      parseError: { message: parsed.errors[0]!.message ?? 'parse error' },
    }
  }

  const lineIndex = buildLineIndex(source)
  const loc = (start: number): FindingLocation =>
    locationOf(filePath, lineIndex, start)

  walk(parsed.program as unknown as Node, (node, parent) => {
    // ── env.<binding>.<method?>(...) — collect for classifier ───────
    if (
      node.type === 'MemberExpression' &&
      !(node as MemberExpr).computed &&
      isIdentifier((node as MemberExpr).object, 'env') &&
      isIdent((node as MemberExpr).property)
    ) {
      const binding = (((node as MemberExpr).property) as IdentNode).name
      envAccesses.push({ binding, location: loc((node as PosNode).start) })
    }

    // ── new HTMLRewriter() / new WebSocketPair() ────────────────────
    if (node.type === 'NewExpression') {
      const callee = (node as NewExpr).callee
      if (isIdent(callee)) {
        const blocker = NEW_BLOCKERS[(callee as IdentNode).name]
        if (blocker) {
          findings.push({
            kind: blocker.kind,
            severity: 'blocker',
            message: blocker.message,
            location: loc((node as PosNode).start),
          })
        }
      }
    }

    // ── class X extends DurableObject {} ────────────────────────────
    if (
      (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') &&
      (node as ClassNode).superClass &&
      isIdent((node as ClassNode).superClass!)
    ) {
      const superName = ((node as ClassNode).superClass as IdentNode).name
      const blocker = CLASS_BLOCKERS[superName]
      if (blocker) {
        findings.push({
          kind: blocker.kind,
          severity: 'blocker',
          message: blocker.message,
          location: loc((node as PosNode).start),
          detail:
            (node as ClassNode).id && isIdent((node as ClassNode).id!)
              ? ((node as ClassNode).id as IdentNode).name
              : undefined,
        })
      }
    }

    // ── caches.default — different shape on Bun ─────────────────────
    if (
      node.type === 'MemberExpression' &&
      !(node as MemberExpr).computed &&
      isIdentifier((node as MemberExpr).object, 'caches') &&
      isIdentifier((node as MemberExpr).property, 'default')
    ) {
      findings.push({
        kind: 'cache-api',
        severity: 'review-needed',
        message:
          'caches.default — Bun has no built-in cache; supply an in-process LRU or skip',
        location: loc((node as PosNode).start),
      })
    }

    // ── ctx.waitUntil(...) — fire-and-forget on Bun ─────────────────
    if (
      node.type === 'MemberExpression' &&
      !(node as MemberExpr).computed &&
      isIdent((node as MemberExpr).property) &&
      ((node as MemberExpr).property as IdentNode).name === 'waitUntil' &&
      // crude: any object named ctx, this, executionCtx
      isIdent((node as MemberExpr).object) &&
      ['ctx', 'executionCtx', 'context'].includes(
        ((node as MemberExpr).object as IdentNode).name,
      ) &&
      // only report when called, not when just accessed
      parent?.type === 'CallExpression'
    ) {
      findings.push({
        kind: 'wait-until',
        severity: 'review-needed',
        message:
          'ctx.waitUntil — runs as a fire-and-forget Promise on Bun (no edge-network deferral)',
        location: loc((node as PosNode).start),
      })
    }
  })

  return { findings, envAccesses, parseError: null }
}

// ─── tiny ESTree walker ────────────────────────────────────────────

interface Node {
  type: string
  [key: string]: unknown
}
interface PosNode extends Node {
  start: number
  end: number
}
interface IdentNode extends Node {
  type: 'Identifier'
  name: string
}
interface MemberExpr extends Node {
  type: 'MemberExpression'
  object: Node
  property: Node
  computed: boolean
}
interface NewExpr extends Node {
  type: 'NewExpression'
  callee: Node
}
interface ClassNode extends Node {
  type: 'ClassDeclaration' | 'ClassExpression'
  id: Node | null
  superClass: Node | null
}

function isIdent(node: unknown): node is IdentNode {
  return !!node && (node as Node).type === 'Identifier'
}
function isIdentifier(node: unknown, name: string): boolean {
  return isIdent(node) && (node as IdentNode).name === name
}

function walk(
  root: Node,
  visit: (node: Node, parent: Node | null) => void,
): void {
  const stack: Array<{ node: Node; parent: Node | null }> = [
    { node: root, parent: null },
  ]
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!
    visit(node, parent)
    for (const key of Object.keys(node)) {
      // Skip metadata fields oxc adds — they are not AST children.
      if (key === 'loc' || key === 'range' || key === 'parent') continue
      const value = (node as Record<string, unknown>)[key]
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && 'type' in child) {
            stack.push({ node: child as Node, parent: node })
          }
        }
      } else if (value && typeof value === 'object' && 'type' in value) {
        stack.push({ node: value as Node, parent: node })
      }
    }
  }
}

// ─── source location helpers ──────────────────────────────────────

/** Line-start offsets (0-indexed lines, byte offsets). lineIndex[0] = 0. */
function buildLineIndex(source: string): number[] {
  const offsets = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) offsets.push(i + 1)
  }
  return offsets
}

function locationOf(
  filePath: string,
  lineIndex: number[],
  offset: number,
): FindingLocation {
  // Binary search for the largest line-start <= offset.
  let lo = 0
  let hi = lineIndex.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (lineIndex[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return {
    file: filePath,
    line: lo + 1, // 1-indexed for human consumption
    column: offset - lineIndex[lo]! + 1,
  }
}
