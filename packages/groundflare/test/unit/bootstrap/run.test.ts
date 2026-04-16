/**
 * Tests for runBootstrap() — the top-level wiring used by the CLI's
 * `groundflare up` command. Verifies stage list construction, prerequisite
 * checks, state persistence, and provider-mismatch refusal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BootstrapStateStore,
  runBootstrap,
  type Stage,
} from '../../../src/bootstrap/index.js'
import { MemorySecretStore } from '../../../src/secret/index.js'
import type { Provider } from '../../../src/provider/index.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gf-runboot-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function makeProvider(): Provider {
  return {
    name: 'hetzner',
    displayName: 'Hetzner Cloud',
    authenticate: vi.fn(async () => ({ id: 'acct-1', name: 'Test' })),
    listSizes: vi.fn(async () => []),
    listRegions: vi.fn(async () => []),
    uploadSSHKey: vi.fn(),
    listSSHKeys: vi.fn(async () => []),
    deleteSSHKey: vi.fn(),
    createVPS: vi.fn(),
    getVPS: vi.fn(async () => null),
    listVPS: vi.fn(async () => []),
    destroyVPS: vi.fn(),
    estimateMonthlyCost: vi.fn(() => 0),
  } as Provider
}

describe('runBootstrap', () => {
  it('throws when the secret store has no provider token', async () => {
    await expect(
      runBootstrap({
        workspace: 'demo',
        provider: 'hetzner',
        size: 'cx22',
        region: 'hel1',
        acmeEmail: 'ops@example.com',
        placeholderDomain: 'demo.groundflare.app',
        secretStoreOverride: new MemorySecretStore(),
        stateStoreOverride: new BootstrapStateStore({ directory: tmp }),
        log: () => {},
      }),
    ).rejects.toMatchObject({
      name: 'BootstrapError',
      code: 'prerequisite',
    })
  })

  it('runs the supplied stages in order and persists state on success', async () => {
    const ran: string[] = []
    const stages: Stage[] = [
      { id: 'one', description: '1', run: async () => { ran.push('one') } },
      { id: 'two', description: '2', run: async () => { ran.push('two') } },
    ]
    const stateStore = new BootstrapStateStore({ directory: tmp })
    const result = await runBootstrap({
      workspace: 'demo',
      provider: 'hetzner',
      size: 'cx22',
      region: 'hel1',
      acmeEmail: 'ops@example.com',
      placeholderDomain: 'demo.groundflare.app',
      secretStoreOverride: new MemorySecretStore({
        'provider.hetzner.token': 'tok',
      }),
      providerOverride: makeProvider(),
      stateStoreOverride: stateStore,
      stagesOverride: stages,
      log: () => {},
    })
    expect(ran).toEqual(['one', 'two'])
    expect(result.completedStages).toEqual(['one', 'two'])
    const persisted = await stateStore.load('demo')
    expect(persisted?.completedStages).toEqual(['one', 'two'])
  })

  it('refuses to run when persisted state names a different provider', async () => {
    const stateStore = new BootstrapStateStore({ directory: tmp })
    await stateStore.save({
      workspace: 'demo',
      provider: 'digitalocean',
      completedStages: [],
      startedAt: '2026-04-14T00:00:00Z',
      updatedAt: '2026-04-14T00:00:00Z',
    })
    await expect(
      runBootstrap({
        workspace: 'demo',
        provider: 'hetzner',
        size: 'cx22',
        region: 'hel1',
        acmeEmail: 'ops@example.com',
        placeholderDomain: 'demo.groundflare.app',
        secretStoreOverride: new MemorySecretStore({
          'provider.hetzner.token': 'tok',
        }),
        providerOverride: makeProvider(),
        stateStoreOverride: stateStore,
        log: () => {},
      }),
    ).rejects.toMatchObject({
      code: 'prerequisite',
      message: expect.stringMatching(/digitalocean.*hetzner/),
    })
  })

  it('skips already-completed stages on resume', async () => {
    const stateStore = new BootstrapStateStore({ directory: tmp })
    await stateStore.save({
      workspace: 'demo',
      provider: 'hetzner',
      completedStages: ['done-already'],
      startedAt: '2026-04-14T00:00:00Z',
      updatedAt: '2026-04-14T00:00:00Z',
    })
    let ranSecond = false
    const stages: Stage[] = [
      {
        id: 'done-already',
        description: 'should be skipped',
        run: async () => {
          throw new Error('this stage should not have run')
        },
      },
      {
        id: 'fresh',
        description: 'should run',
        run: async () => {
          ranSecond = true
        },
      },
    ]
    await runBootstrap({
      workspace: 'demo',
      provider: 'hetzner',
      size: 'cx22',
      region: 'hel1',
      acmeEmail: 'ops@example.com',
      placeholderDomain: 'demo.groundflare.app',
      secretStoreOverride: new MemorySecretStore({ 'provider.hetzner.token': 'tok' }),
      providerOverride: makeProvider(),
      stateStoreOverride: stateStore,
      stagesOverride: stages,
      log: () => {},
    })
    expect(ranSecond).toBe(true)
  })

  it('rejects unknown providers with a clear error', async () => {
    await expect(
      runBootstrap({
        workspace: 'demo',
        // @ts-expect-error — runtime guard for unsupported providers
        provider: 'aws',
        size: 't3.nano',
        region: 'us-east-1',
        acmeEmail: 'ops@example.com',
        placeholderDomain: 'demo.groundflare.app',
        secretStoreOverride: new MemorySecretStore({ 'provider.aws.token': 'tok' }),
        stateStoreOverride: new BootstrapStateStore({ directory: tmp }),
        log: () => {},
      }),
    ).rejects.toThrow(/not implemented/)
  })
})
