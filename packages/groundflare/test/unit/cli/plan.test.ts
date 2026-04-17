/**
 * Unit tests for the CLI plan builder + renderer.
 *
 * `confirmPlan` uses consola.prompt internally which is awkward to
 * mock; coverage there lives in the integration tests that spawn a
 * PTY (out of scope for v0.5.1). Here we pin the text output so
 * changes to the plan format are intentional.
 */

import { describe, expect, it } from 'vitest'

import {
  buildDestroyPlan,
  buildUpPlan,
  renderPlan,
} from '../../../src/cli/plan.js'
import type { WorkspaceWorker } from '../../../src/runtime/workspace/index.js'

function worker(
  name: string,
  overrides: Partial<WorkspaceWorker> = {},
): WorkspaceWorker {
  return {
    name,
    entryPath: `workers/${name}/code/current/index.js`,
    ...overrides,
  }
}

describe('buildUpPlan', () => {
  it('fresh provision enumerates VPS + SSH + cloud-init + deploy', () => {
    const plan = buildUpPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      region: 'sgp1',
      size: 's-1vcpu-1gb',
      domain: 'demo.example.com',
      preview: undefined,
      vpsExists: false,
      completedStages: [],
      workers: [worker('api')],
    })
    const kinds = plan.actions.map((a) => a.kind)
    expect(kinds).toContain('create')
    const resources = plan.actions.map((a) => a.resource)
    expect(resources).toContain('VPS')
    expect(resources).toContain('SSH keypair')
    expect(resources).toContain('cloud-init setup')
    expect(resources).toContain('deploy')
  })

  it('existing VPS collapses into skip + redeploy', () => {
    const plan = buildUpPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      region: 'sgp1',
      size: 's-1vcpu-1gb',
      domain: 'demo.example.com',
      preview: undefined,
      vpsExists: true,
      completedStages: [
        'provider.auth',
        'provider.ssh-key',
        'provider.provision',
        'provider.wait-ssh',
        'system.cloud-init',
        'system.install-runtime',
        'system.install-services',
      ],
      workers: [worker('api')],
    })
    const vpsAction = plan.actions.find((a) => a.resource === 'VPS')
    expect(vpsAction?.kind).toBe('skip')
    // No bootstrap resume when every stage is already complete.
    const hasBootstrap = plan.actions.some((a) => a.resource === 'bootstrap')
    expect(hasBootstrap).toBe(false)
    const deploy = plan.actions.find((a) => a.resource === 'deploy')
    expect(deploy?.kind).toBe('update')
  })

  it('resumes bootstrap when the VPS exists but stages are partial', () => {
    const plan = buildUpPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      region: 'sgp1',
      size: 's-1vcpu-1gb',
      domain: 'demo.example.com',
      preview: undefined,
      vpsExists: true,
      completedStages: ['provider.auth', 'provider.ssh-key'],
      workers: [worker('api')],
    })
    const bootstrap = plan.actions.find((a) => a.resource === 'bootstrap')
    expect(bootstrap).toBeDefined()
    expect(bootstrap!.detail).toContain('5 stage(s)')
    expect(bootstrap!.detail).toContain('provider.provision')
  })

  it('summarizes binding counts into the deploy action detail', () => {
    const plan = buildUpPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      region: 'sgp1',
      size: 's-1vcpu-1gb',
      domain: 'demo.example.com',
      preview: undefined,
      vpsExists: false,
      completedStages: [],
      workers: [
        worker('api', {
          d1Databases: [{ binding: 'DB', databaseName: 'd' }],
          kvNamespaces: [{ binding: 'CACHE' }],
          r2Buckets: [{ binding: 'MEDIA' }],
          workerLoaders: [{ binding: 'LOADER' }],
        }),
      ],
    })
    const deploy = plan.actions.find((a) => a.resource === 'deploy')!
    expect(deploy.detail).toContain('1 D1')
    expect(deploy.detail).toContain('1 KV')
    expect(deploy.detail).toContain('1 R2')
    expect(deploy.detail).toContain('1 WorkerLoader')
  })

  it('warns when no domain is configured', () => {
    const plan = buildUpPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      region: 'sgp1',
      size: 's-1vcpu-1gb',
      domain: undefined,
      preview: undefined,
      vpsExists: false,
      completedStages: [],
      workers: [worker('api')],
    })
    expect(plan.warnings?.some((w) => /domain/i.test(w))).toBe(true)
  })

  it('omits the domain warning when domain is set', () => {
    const plan = buildUpPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      region: 'sgp1',
      size: 's-1vcpu-1gb',
      domain: 'demo.example.com',
      preview: undefined,
      vpsExists: false,
      completedStages: [],
      workers: [worker('api')],
    })
    expect(plan.warnings ?? []).toEqual([])
  })

  it('mentions sslip.io preview in the warning when domain is unset + preview is default', () => {
    const plan = buildUpPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      region: 'sgp1',
      size: 's-1vcpu-1gb',
      domain: undefined,
      preview: undefined,
      vpsExists: false,
      completedStages: [],
      workers: [worker('api')],
    })
    expect(plan.warnings!.some((w) => /sslip\.io/.test(w))).toBe(true)
  })

  it('mentions nip.io when preview opts into a different provider', () => {
    const plan = buildUpPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      region: 'sgp1',
      size: 's-1vcpu-1gb',
      domain: undefined,
      preview: 'nip.io',
      vpsExists: false,
      completedStages: [],
      workers: [worker('api')],
    })
    expect(plan.warnings!.some((w) => /nip\.io/.test(w))).toBe(true)
  })

  it('warns more sharply when preview is disabled and no domain is set', () => {
    const plan = buildUpPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      region: 'sgp1',
      size: 's-1vcpu-1gb',
      domain: undefined,
      preview: false,
      vpsExists: false,
      completedStages: [],
      workers: [worker('api')],
    })
    expect(plan.warnings!.some((w) => /preview disabled/.test(w))).toBe(true)
  })
})

describe('buildDestroyPlan', () => {
  it('lists VPS + local state when both present', () => {
    const plan = buildDestroyPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      vps: { id: '1234', ipv4: '203.0.113.10' },
      workers: [],
    })
    const resources = plan.actions.map((a) => a.resource)
    expect(resources).toContain('VPS')
    expect(resources).toContain('local state file')
    const vps = plan.actions.find((a) => a.resource === 'VPS')!
    expect(vps.kind).toBe('destroy')
    expect(vps.detail).toContain('1234')
    expect(vps.detail).toContain('203.0.113.10')
  })

  it('skips VPS destroy when no VPS recorded', () => {
    const plan = buildDestroyPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      vps: null,
      workers: [],
    })
    const vps = plan.actions.find((a) => a.resource === 'VPS')!
    expect(vps.kind).toBe('skip')
  })

  it('emits a data-loss line when bindings would hold state', () => {
    const plan = buildDestroyPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      vps: { id: '1234', ipv4: '203.0.113.10' },
      workers: [
        worker('api', {
          d1Databases: [{ binding: 'DB', databaseName: 'main' }],
          r2Buckets: [{ binding: 'MEDIA' }],
        }),
      ],
    })
    const dataLoss = plan.actions.find((a) => a.kind === 'data-loss')
    expect(dataLoss).toBeDefined()
    expect(dataLoss!.detail).toContain('D1')
    expect(dataLoss!.detail).toContain('R2')
  })

  it('warns about irreversibility when a VPS is scheduled for destroy', () => {
    const plan = buildDestroyPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      vps: { id: '1234', ipv4: '203.0.113.10' },
      workers: [],
    })
    expect(plan.warnings?.some((w) => /permanent/i.test(w))).toBe(true)
  })

  it('omits the irreversibility warning when there is no VPS to destroy', () => {
    const plan = buildDestroyPlan({
      workspace: 'demo',
      provider: 'digitalocean',
      vps: null,
      workers: [],
    })
    expect(plan.warnings ?? []).toEqual([])
  })
})

describe('renderPlan', () => {
  it('renders each action kind with its symbol prefix', () => {
    const out = renderPlan({
      title: 'test',
      actions: [
        { kind: 'create', resource: 'A', detail: 'a detail' },
        { kind: 'update', resource: 'B', detail: 'b detail' },
        { kind: 'skip', resource: 'C', detail: 'c detail' },
        { kind: 'destroy', resource: 'D', detail: 'd detail' },
        { kind: 'data-loss', resource: 'E', detail: 'e detail' },
      ],
    })
    expect(out).toContain('+ A: a detail')
    expect(out).toContain('~ B: b detail')
    expect(out).toContain('= C: c detail')
    expect(out).toContain('- D: d detail')
    expect(out).toContain('! E: e detail')
  })

  it('indents the cost hint beneath the create action', () => {
    const out = renderPlan({
      title: 'test',
      actions: [
        {
          kind: 'create',
          resource: 'VPS',
          detail: 's-1vcpu-1gb',
          costHint: '~$6/mo',
        },
      ],
    })
    expect(out).toContain('cost: ~$6/mo')
  })

  it('renders warnings with a distinct glyph', () => {
    const out = renderPlan({
      title: 'test',
      actions: [],
      warnings: ['be careful'],
    })
    expect(out).toContain('⚠ be careful')
  })
})
