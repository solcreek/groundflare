/**
 * Unit tests for the SSH-key cleanup in `groundflare destroy`.
 *
 * The share check is the safety net: when the operator has configured
 * multiple workspaces to use the same provider-side SSH key (unusual
 * but legitimate), tearing one down must NOT delete the key those
 * other workspaces depend on. Bootstrap normally generates
 * per-workspace keys, but a manually-reused shared key is the reason
 * this logic exists.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import { cleanUpSshKey } from '../../../src/cli/commands/destroy.js'
import {
  BootstrapStateStore,
  type BootstrapState,
} from '../../../src/bootstrap/index.js'
import type { Provider, ProviderName } from '../../../src/provider/index.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gf-destroy-ssh-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

// Minimal Provider stub — we only exercise deleteSSHKey. Everything
// else throws if the system-under-test accidentally reaches for it.
function stubProvider(opts: {
  deleteSSHKey?: (id: string) => Promise<void>
} = {}): Provider {
  const guard = () => {
    throw new Error('stub: unexpected provider call in SSH-cleanup test')
  }
  return {
    name: 'hetzner',
    displayName: 'Stub',
    authenticate: guard,
    listSizes: guard,
    listRegions: guard,
    uploadSSHKey: guard,
    listSSHKeys: guard,
    deleteSSHKey:
      opts.deleteSSHKey ?? vi.fn(async () => {}) as Provider['deleteSSHKey'],
    createVPS: guard,
    getVPS: guard,
    listVPS: guard,
    destroyVPS: guard,
    estimateMonthlyCost: () => 0,
  } as Provider
}

async function writeWorkspaceState(
  store: BootstrapStateStore,
  state: BootstrapState,
): Promise<void> {
  await store.save(state)
}

function makeState(opts: {
  workspace: string
  provider: string
  providerId: string
  localDir: string
}): BootstrapState {
  return {
    workspace: opts.workspace,
    provider: opts.provider as ProviderName,
    completedStages: ['provider.ssh-key'],
    startedAt: '2026-04-17T00:00:00Z',
    updatedAt: '2026-04-17T00:00:00Z',
    sshKey: {
      providerId: opts.providerId,
      fingerprint: 'stub:fingerprint',
      localPath: join(opts.localDir, `${opts.workspace}_ed25519`),
      localPublicPath: join(opts.localDir, `${opts.workspace}_ed25519.pub`),
    },
  }
}

describe('destroy → cleanUpSshKey', () => {
  it('deletes the key at the provider + removes local files when nothing else shares it', async () => {
    const store = new BootstrapStateStore({ directory: join(tmp, 'state') })
    const keysDir = join(tmp, 'keys')
    await rm(keysDir, { recursive: true, force: true }).catch(() => {})
    await mkdtemp(keysDir).catch(async () => {
      // mkdtemp requires X's — just use mkdir.
      const { mkdir } = await import('node:fs/promises')
      await mkdir(keysDir, { recursive: true })
    })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(keysDir, { recursive: true })

    const state = makeState({
      workspace: 'alpha',
      provider: 'hetzner',
      providerId: 'key-alpha',
      localDir: keysDir,
    })
    await writeWorkspaceState(store, state)
    await writeFile(state.sshKey!.localPath, 'PRIVATE\n')
    await writeFile(state.sshKey!.localPublicPath, 'PUBLIC\n')

    const deleteSSHKey = vi.fn(async () => {})
    const provider = stubProvider({ deleteSSHKey })

    await cleanUpSshKey({
      provider,
      providerName: 'hetzner',
      sshKey: state.sshKey!,
      currentWorkspace: 'alpha',
      stateStore: store,
    })

    expect(deleteSSHKey).toHaveBeenCalledWith('key-alpha')
    expect(deleteSSHKey).toHaveBeenCalledTimes(1)
    expect(existsSync(state.sshKey!.localPath)).toBe(false)
    expect(existsSync(state.sshKey!.localPublicPath)).toBe(false)
  })

  it('skips the provider delete when another workspace on the same provider shares the key', async () => {
    const store = new BootstrapStateStore({ directory: join(tmp, 'state') })
    const keysDir = join(tmp, 'keys')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(keysDir, { recursive: true })

    // Two workspaces, same providerId.
    const alpha = makeState({
      workspace: 'alpha',
      provider: 'hetzner',
      providerId: 'key-shared',
      localDir: keysDir,
    })
    const beta = makeState({
      workspace: 'beta',
      provider: 'hetzner',
      providerId: 'key-shared',
      localDir: keysDir,
    })
    await writeWorkspaceState(store, alpha)
    await writeWorkspaceState(store, beta)
    await writeFile(alpha.sshKey!.localPath, 'PRIVATE\n')
    await writeFile(alpha.sshKey!.localPublicPath, 'PUBLIC\n')

    const deleteSSHKey = vi.fn(async () => {})
    const provider = stubProvider({ deleteSSHKey })

    await cleanUpSshKey({
      provider,
      providerName: 'hetzner',
      sshKey: alpha.sshKey!,
      currentWorkspace: 'alpha',
      stateStore: store,
    })

    // Provider-side delete skipped — beta still depends on the key.
    expect(deleteSSHKey).not.toHaveBeenCalled()
    // Local files ALSO not removed — beta's localPath points at them.
    // (In this fixture alpha and beta have different localPaths, but
    // we still skip all removals when the share check flags a sharer
    // — conservative by design.)
    expect(existsSync(alpha.sshKey!.localPath)).toBe(true)
    expect(existsSync(alpha.sshKey!.localPublicPath)).toBe(true)
  })

  it('does NOT treat same providerId on a different provider as a share', async () => {
    // Hetzner id 42 and DigitalOcean id 42 are unrelated. The check
    // must gate on (providerName, providerId) together.
    const store = new BootstrapStateStore({ directory: join(tmp, 'state') })
    const keysDir = join(tmp, 'keys')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(keysDir, { recursive: true })

    const hetznerWs = makeState({
      workspace: 'hetzner-ws',
      provider: 'hetzner',
      providerId: '42',
      localDir: keysDir,
    })
    const doWs = makeState({
      workspace: 'do-ws',
      provider: 'digitalocean',
      providerId: '42',
      localDir: keysDir,
    })
    await writeWorkspaceState(store, hetznerWs)
    await writeWorkspaceState(store, doWs)

    const deleteSSHKey = vi.fn(async () => {})
    const provider = stubProvider({ deleteSSHKey })

    await cleanUpSshKey({
      provider,
      providerName: 'hetzner',
      sshKey: hetznerWs.sshKey!,
      currentWorkspace: 'hetzner-ws',
      stateStore: store,
    })

    expect(deleteSSHKey).toHaveBeenCalledWith('42')
  })

  it('ignores the current workspace in the share check (self-match not a sharer)', async () => {
    const store = new BootstrapStateStore({ directory: join(tmp, 'state') })
    const keysDir = join(tmp, 'keys')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(keysDir, { recursive: true })

    const state = makeState({
      workspace: 'solo',
      provider: 'hetzner',
      providerId: 'only-key',
      localDir: keysDir,
    })
    await writeWorkspaceState(store, state)

    const deleteSSHKey = vi.fn(async () => {})
    const provider = stubProvider({ deleteSSHKey })

    await cleanUpSshKey({
      provider,
      providerName: 'hetzner',
      sshKey: state.sshKey!,
      currentWorkspace: 'solo',
      stateStore: store,
    })

    expect(deleteSSHKey).toHaveBeenCalledWith('only-key')
  })

  it('swallows provider.deleteSSHKey errors — never blocks destroy', async () => {
    const store = new BootstrapStateStore({ directory: join(tmp, 'state') })
    const keysDir = join(tmp, 'keys')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(keysDir, { recursive: true })

    const state = makeState({
      workspace: 'alpha',
      provider: 'hetzner',
      providerId: 'key-already-gone',
      localDir: keysDir,
    })
    await writeWorkspaceState(store, state)

    const deleteSSHKey = vi.fn(async () => {
      throw new Error('404 not found')
    })
    const provider = stubProvider({ deleteSSHKey })

    // Must not throw.
    await expect(
      cleanUpSshKey({
        provider,
        providerName: 'hetzner',
        sshKey: state.sshKey!,
        currentWorkspace: 'alpha',
        stateStore: store,
      }),
    ).resolves.toBeUndefined()

    expect(deleteSSHKey).toHaveBeenCalledOnce()
  })

  it('tolerates a corrupt sibling state file (skips it, continues)', async () => {
    // A manually-edited / truncated sibling state file shouldn't abort
    // the cleanup of an unrelated workspace.
    const store = new BootstrapStateStore({ directory: join(tmp, 'state') })
    const keysDir = join(tmp, 'keys')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(keysDir, { recursive: true })
    const alpha = makeState({
      workspace: 'alpha',
      provider: 'hetzner',
      providerId: 'alpha-key',
      localDir: keysDir,
    })
    await writeWorkspaceState(store, alpha)
    // Plant a malformed sibling.
    await writeFile(
      store.pathFor('broken'),
      '{not-json: true',
      'utf-8',
    )

    const deleteSSHKey = vi.fn(async () => {})
    const provider = stubProvider({ deleteSSHKey })

    await cleanUpSshKey({
      provider,
      providerName: 'hetzner',
      sshKey: alpha.sshKey!,
      currentWorkspace: 'alpha',
      stateStore: store,
    })

    // Corrupt sibling doesn't count as a sharer; delete proceeds.
    expect(deleteSSHKey).toHaveBeenCalledWith('alpha-key')
  })
})
