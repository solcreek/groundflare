import { describe, it, expect, vi } from 'vitest'
import {
  BootstrapOrchestrator,
  BootstrapStateStore,
  BootstrapError,
  type BootstrapContext,
  type BootstrapState,
  type Stage,
} from '../../../src/bootstrap/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function freshState(): BootstrapState {
  return {
    workspace: 'demo',
    provider: 'hetzner',
    completedStages: [],
    startedAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
  }
}

function makeContext(state: BootstrapState = freshState()): BootstrapContext {
  return {
    workspace: 'demo',
    provider: {} as never,
    secrets: {} as never,
    state,
    log: vi.fn() as unknown as BootstrapContext['log'],
  }
}

describe('BootstrapOrchestrator: construction', () => {
  it('rejects an empty stage list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-orch-'))
    expect(
      () =>
        new BootstrapOrchestrator([], {
          stateStore: new BootstrapStateStore({ directory: dir }),
        }),
    ).toThrow(BootstrapError)
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects duplicate stage IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-orch-'))
    const a: Stage = { id: 'x', description: 'x', run: async () => {} }
    expect(
      () =>
        new BootstrapOrchestrator([a, a], {
          stateStore: new BootstrapStateStore({ directory: dir }),
        }),
    ).toThrow(/duplicate stage id/)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('BootstrapOrchestrator: happy path', () => {
  it('runs each stage in order, recording completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-orch-'))
    const order: string[] = []
    const stages: Stage[] = [
      { id: 'a', description: 'A', run: async () => { order.push('a') } },
      { id: 'b', description: 'B', run: async () => { order.push('b') } },
      { id: 'c', description: 'C', run: async () => { order.push('c') } },
    ]
    const orch = new BootstrapOrchestrator(stages, {
      stateStore: new BootstrapStateStore({ directory: dir }),
    })
    const ctx = makeContext()
    await orch.run(ctx)
    expect(order).toEqual(['a', 'b', 'c'])
    expect(ctx.state.completedStages).toEqual(['a', 'b', 'c'])
    await rm(dir, { recursive: true, force: true })
  })

  it('persists state after each successful stage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-orch-'))
    const store = new BootstrapStateStore({ directory: dir })
    const stages: Stage[] = [
      { id: 'one', description: '1', run: async () => {} },
      { id: 'two', description: '2', run: async () => {} },
    ]
    const orch = new BootstrapOrchestrator(stages, { stateStore: store })
    await orch.run(makeContext())
    const persisted = await store.load('demo')
    expect(persisted?.completedStages).toEqual(['one', 'two'])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('BootstrapOrchestrator: idempotent resume', () => {
  it('skips stages whose IDs are already in completedStages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-orch-'))
    const ran: string[] = []
    const stages: Stage[] = [
      { id: 'a', description: 'A', run: async () => { ran.push('a') } },
      { id: 'b', description: 'B', run: async () => { ran.push('b') } },
    ]
    const orch = new BootstrapOrchestrator(stages, {
      stateStore: new BootstrapStateStore({ directory: dir }),
    })
    const ctx = makeContext({ ...freshState(), completedStages: ['a'] })
    await orch.run(ctx)
    expect(ran).toEqual(['b'])
    expect(ctx.state.completedStages).toEqual(['a', 'b'])
    await rm(dir, { recursive: true, force: true })
  })

  it("honours a stage's custom isComplete check (true means skip)", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-orch-'))
    const ran: string[] = []
    const stages: Stage[] = [
      {
        id: 'check',
        description: 'C',
        isComplete: async () => true,
        run: async () => { ran.push('check') },
      },
    ]
    const orch = new BootstrapOrchestrator(stages, {
      stateStore: new BootstrapStateStore({ directory: dir }),
    })
    const ctx = makeContext()
    await orch.run(ctx)
    expect(ran).toEqual([])
    // Even though the stage skipped, it gets recorded so future runs
    // don't re-invoke isComplete unnecessarily.
    expect(ctx.state.completedStages).toEqual(['check'])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('BootstrapOrchestrator: failures', () => {
  it('wraps thrown errors in BootstrapError(stage_failed)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-orch-'))
    const orch = new BootstrapOrchestrator(
      [
        { id: 'a', description: 'A', run: async () => {} },
        {
          id: 'b',
          description: 'B',
          run: async () => {
            throw new Error('oops')
          },
        },
      ],
      { stateStore: new BootstrapStateStore({ directory: dir }) },
    )
    const ctx = makeContext()
    await expect(orch.run(ctx)).rejects.toMatchObject({
      name: 'BootstrapError',
      code: 'stage_failed',
      stageId: 'b',
    })
    // Stage `a` should still be marked complete in the state.
    expect(ctx.state.completedStages).toEqual(['a'])
    await rm(dir, { recursive: true, force: true })
  })

  it('persists state even on failure (so resume picks up progress)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-orch-'))
    const store = new BootstrapStateStore({ directory: dir })
    const orch = new BootstrapOrchestrator(
      [
        { id: 'a', description: 'A', run: async () => {} },
        {
          id: 'b',
          description: 'B',
          run: async () => {
            throw new Error('boom')
          },
        },
      ],
      { stateStore: store },
    )
    const ctx = makeContext()
    await expect(orch.run(ctx)).rejects.toBeInstanceOf(BootstrapError)
    const persisted = await store.load('demo')
    expect(persisted?.completedStages).toEqual(['a'])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('BootstrapOrchestrator: dryRun', () => {
  it('does not persist state when dryRun is true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gf-orch-'))
    const store = new BootstrapStateStore({ directory: dir })
    const orch = new BootstrapOrchestrator(
      [{ id: 'only', description: '.', run: async () => {} }],
      { stateStore: store, dryRun: true },
    )
    await orch.run(makeContext())
    expect(await store.load('demo')).toBe(null)
    await rm(dir, { recursive: true, force: true })
  })
})
