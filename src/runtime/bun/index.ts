/**
 * Public API for the Bun runtime track. Mirrors the shape of
 * src/runtime/workspace/index.ts so callers wire both tracks through
 * parallel imports:
 *
 *   import { buildCapnpFromWorkspace } from "@/runtime/workspace"
 *   import { buildBunArtifact }         from "@/runtime/bun"
 *
 * The CLI dispatches on WorkspaceManifest.runtime (see isBunWorkspace).
 */

export { generateBunShim } from './shim.js'
export type {
  BunShimOptions,
  BunKvBinding,
  BunD1Binding,
  BunR2Binding,
} from './shim.js'

export { generateBunSystemdUnit } from './systemd.js'
export type { BunUnitOptions } from './systemd.js'

export { buildBunArtifact, isBunWorkspace } from './build.js'
export type { BuildBunOptions, BunArtifact } from './build.js'
