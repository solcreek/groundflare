/**
 * Render a CapnpWorkerdConfig to capnp text.
 *
 * Strategy: build a small intermediate AST (Scalar / List / Struct) then
 * serialize with consistent indentation. This keeps the rendering rules
 * in one place (`write()`) rather than scattered across every type-specific
 * helper, and makes it trivial to add new binding kinds later.
 *
 * The output is valid input for `workerd serve <file>`. Snapshot tests
 * in test/unit/runtime/workerd/capnp/render.test.ts pin the expected
 * format; end-to-end "workerd actually parses this" validation lives in
 * the Tier 2 conformance suite when the capnp spawn path lands.
 */

import type {
  CapnpBinding,
  CapnpDurableObjectNamespaceDecl,
  CapnpModule,
  CapnpService,
  CapnpSocket,
  CapnpWorker,
  CapnpWorkerdConfig,
} from './types.js'

// ─── Intermediate AST ──────────────────────────────────────────────

class Scalar {
  constructor(readonly text: string) {}
}

class List {
  constructor(readonly items: readonly CapnpNode[]) {}
}

class Struct {
  constructor(readonly fields: ReadonlyArray<readonly [string, CapnpNode]>) {}
}

type CapnpNode = Scalar | List | Struct

const scalar = (text: string): Scalar => new Scalar(text)
const str = (value: string): Scalar => new Scalar(quote(value))
const embed = (path: string): Scalar => new Scalar(`embed ${quote(path)}`)
const list = (items: readonly CapnpNode[]): List => new List(items)
const struct = (fields: ReadonlyArray<readonly [string, CapnpNode]>): Struct =>
  new Struct(fields)

// ─── Scalar escaping ───────────────────────────────────────────────

/**
 * Quote a string for capnp. capnp follows C-like string literal syntax:
 *   - Backslash escapes
 *   - `\n`, `\r`, `\t` for control chars
 *   - `\"` for embedded quotes
 */
export function quote(value: string): string {
  let out = '"'
  for (const ch of value) {
    const code = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  out += '"'
  return out
}

/**
 * Format a Uint8Array as a capnp `data` literal: 0x"<hex>".
 * workerd accepts either 0x"..." or raw hex; the 0x prefix is explicit.
 */
export function formatData(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `0x"${hex}"`
}

// ─── AST → string ──────────────────────────────────────────────────

const INDENT = '  '
const INLINE_THRESHOLD = 100

function write(node: CapnpNode, depth: number): string {
  if (node instanceof Scalar) return node.text

  if (node instanceof List) {
    if (node.items.length === 0) return '[]'
    const inline = '[' + node.items.map((i) => write(i, depth)).join(', ') + ']'
    if (!inline.includes('\n') && inline.length <= INLINE_THRESHOLD) return inline
    const childPad = INDENT.repeat(depth + 1)
    const closePad = INDENT.repeat(depth)
    const inner = node.items
      .map((item) => childPad + write(item, depth + 1))
      .join(',\n')
    return `[\n${inner}\n${closePad}]`
  }

  // Struct
  if (node.fields.length === 0) return '()'
  const inline =
    '(' +
    node.fields.map(([k, v]) => `${k} = ${write(v, depth)}`).join(', ') +
    ')'
  if (!inline.includes('\n') && inline.length <= INLINE_THRESHOLD) return inline

  const childPad = INDENT.repeat(depth + 1)
  const closePad = INDENT.repeat(depth)
  const inner = node.fields
    .map(([k, v]) => `${childPad}${k} = ${write(v, depth + 1)}`)
    .join(',\n')
  return `(\n${inner}\n${closePad})`
}

// ─── Domain → AST builders ─────────────────────────────────────────

function nodeForBinding(b: CapnpBinding): CapnpNode {
  const head: ReadonlyArray<readonly [string, CapnpNode]> = [['name', str(b.name)]]
  switch (b.kind) {
    case 'text':
      return struct([...head, ['text', str(b.value)]])
    case 'json':
      return struct([...head, ['json', str(b.value)]])
    case 'data':
      return struct([...head, ['data', scalar(formatData(b.value))]])
    case 'service':
      return struct([...head, ['service', str(b.service)]])
    case 'kvNamespace':
      return struct([...head, ['kvNamespace', str(b.service)]])
    case 'd1Database':
      return struct([...head, ['d1Database', str(b.service)]])
    case 'r2Bucket':
      return struct([...head, ['r2Bucket', str(b.service)]])
    case 'fromEnvironment':
      return struct([...head, ['fromEnvironment', str(b.envVar)]])
    case 'durableObjectNamespace': {
      const fields: Array<[string, CapnpNode]> = [['className', str(b.className)]]
      if (b.serviceName !== undefined) fields.push(['serviceName', str(b.serviceName)])
      return struct([...head, ['durableObjectNamespace', struct(fields)]])
    }
  }
}

function nodeForModule(m: CapnpModule): CapnpNode {
  const fields: Array<[string, CapnpNode]> = [['name', str(m.name)]]
  const src = m.source
  switch (src.kind) {
    case 'esModule':
      if ('inline' in src) fields.push(['esModule', str(src.inline)])
      else fields.push(['esModule', embed(src.embedPath)])
      break
    case 'commonJsModule':
      fields.push(['commonJsModule', embed(src.embedPath)])
      break
    case 'text':
      fields.push(['text', embed(src.embedPath)])
      break
    case 'data':
      fields.push(['data', embed(src.embedPath)])
      break
    case 'json':
      fields.push(['json', embed(src.embedPath)])
      break
  }
  return struct(fields)
}

function nodeForDONamespace(d: CapnpDurableObjectNamespaceDecl): CapnpNode {
  const fields: Array<[string, CapnpNode]> = [['className', str(d.className)]]
  if (d.uniqueKey !== undefined) fields.push(['uniqueKey', str(d.uniqueKey)])
  if (d.enableSql === true) fields.push(['enableSql', scalar('true')])
  return struct(fields)
}

function nodeForWorker(w: CapnpWorker): CapnpNode {
  const fields: Array<[string, CapnpNode]> = []
  fields.push(['modules', list(w.modules.map(nodeForModule))])

  if (w.compatibilityDate !== undefined) {
    fields.push(['compatibilityDate', str(w.compatibilityDate)])
  }

  if (w.compatibilityFlags && w.compatibilityFlags.length > 0) {
    fields.push(['compatibilityFlags', list(w.compatibilityFlags.map(str))])
  }

  if (w.bindings && w.bindings.length > 0) {
    fields.push(['bindings', list(w.bindings.map(nodeForBinding))])
  }

  if (w.durableObjectNamespaces && w.durableObjectNamespaces.length > 0) {
    fields.push([
      'durableObjectNamespaces',
      list(w.durableObjectNamespaces.map(nodeForDONamespace)),
    ])
  }

  if (w.durableObjectStorage !== undefined) {
    fields.push([
      'durableObjectStorage',
      struct([['localDisk', str(w.durableObjectStorage.localDiskPath)]]),
    ])
  }

  if (w.globalOutbound !== undefined) {
    fields.push(['globalOutbound', str(w.globalOutbound)])
  }

  return struct(fields)
}

function nodeForService(s: CapnpService): CapnpNode {
  switch (s.kind) {
    case 'worker':
      return struct([
        ['name', str(s.name)],
        ['worker', nodeForWorker(s.worker)],
      ])
    case 'external': {
      const ext: Array<[string, CapnpNode]> = [['address', str(s.address)]]
      if (s.http === true) ext.push(['http', struct([])])
      return struct([
        ['name', str(s.name)],
        ['external', struct(ext)],
      ])
    }
    case 'disk': {
      const disk: Array<[string, CapnpNode]> = [['path', str(s.path)]]
      if (s.writable === true) disk.push(['writable', scalar('true')])
      return struct([
        ['name', str(s.name)],
        ['disk', struct(disk)],
      ])
    }
    case 'network':
      return struct([
        ['name', str(s.name)],
        ['network', struct([])],
      ])
  }
}

function nodeForSocket(s: CapnpSocket): CapnpNode {
  const fields: Array<[string, CapnpNode]> = [
    ['name', str(s.name)],
    ['address', str(s.address)],
  ]
  // Default protocol = http if unspecified (workerd's default).
  if (s.protocol === 'https') {
    fields.push(['https', struct([])])
  } else {
    fields.push(['http', struct([])])
  }
  fields.push(['service', str(s.service)])
  return struct(fields)
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Render a full workerd configuration to capnp text. Output is ready to
 * write to disk and pass as the argument to `workerd serve`.
 */
export function renderCapnpConfig(config: CapnpWorkerdConfig): string {
  const body = struct([
    ['services', list(config.services.map(nodeForService))],
    ['sockets', list(config.sockets.map(nodeForSocket))],
  ])
  return (
    'using Workerd = import "/workerd/workerd.capnp";\n\n' +
    `const config :Workerd.Config = ${write(body, 0)};\n`
  )
}
