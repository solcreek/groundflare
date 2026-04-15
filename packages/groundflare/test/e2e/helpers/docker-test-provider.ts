/**
 * Tier 3 e2e: a Provider implementation that drives a fake-vps Docker
 * container instead of a real cloud API.
 *
 * Bootstrap's provider hooks are straightforward:
 *   uploadSSHKey → record the pubkey (applied when createVPS runs)
 *   createVPS    → spawn the container, inject the authorized_keys, return
 *                  a VPS record whose sshPort is the host-forwarded port
 *   destroyVPS   → docker stop
 *
 * We skip niceties a real provider cares about (pricing, listing regions,
 * image catalogs) — tests don't exercise those code paths.
 */

import { randomBytes } from 'node:crypto'

import type {
  Account,
  Provider,
  ProviderName,
  ProvisionOptions,
  Region,
  SSHKey,
  SSHKeyOptions,
  Size,
  VPS,
} from '../../../src/provider/index.js'

import {
  DEFAULT_IMAGE_TAG,
  buildFakeVPSImage,
  startFakeVPS,
  type StartedVPS,
} from './docker-vps.js'

export class DockerTestProvider implements Provider {
  readonly name: ProviderName = 'hetzner' // masquerade — bootstrap only checks against this enum
  readonly displayName = 'Docker (test)'

  private readonly sshKeys = new Map<string, { fingerprint: string; publicKey: string }>()
  private readonly vpss = new Map<string, { vps: VPS; container: StartedVPS; sshKeyId: string }>()
  private imageTag: string
  private imageBuilt = false

  constructor(opts: { imageTag?: string } = {}) {
    this.imageTag = opts.imageTag ?? DEFAULT_IMAGE_TAG
  }

  async ensureImage(): Promise<void> {
    if (this.imageBuilt) return
    await buildFakeVPSImage(this.imageTag)
    this.imageBuilt = true
  }

  async authenticate(_token: string): Promise<Account> {
    return { id: 'test-project', name: 'docker-fake', email: 'test@example.com' }
  }

  async listSizes(): Promise<readonly Size[]> {
    return []
  }

  async listRegions(): Promise<readonly Region[]> {
    return []
  }

  async uploadSSHKey(opts: SSHKeyOptions): Promise<SSHKey> {
    const id = `key-${randomBytes(4).toString('hex')}`
    const fingerprint = `test:${randomBytes(8).toString('hex')}`
    this.sshKeys.set(id, { fingerprint, publicKey: opts.publicKey })
    return { id, name: opts.name, fingerprint }
  }

  async listSSHKeys(): Promise<readonly SSHKey[]> {
    return [...this.sshKeys.entries()].map(([id, v]) => ({
      id,
      name: `ssh-${id}`,
      fingerprint: v.fingerprint,
    }))
  }

  async deleteSSHKey(id: string): Promise<void> {
    this.sshKeys.delete(id)
  }

  async createVPS(opts: ProvisionOptions): Promise<VPS> {
    await this.ensureImage()

    const keyId = opts.sshKeyIds[0]
    if (keyId === undefined) {
      throw new Error('DockerTestProvider.createVPS requires at least one sshKeyId')
    }
    const key = this.sshKeys.get(keyId)
    if (key === undefined) {
      throw new Error(`sshKeyId ${keyId} was not uploaded via uploadSSHKey`)
    }

    const container = await startFakeVPS({
      publicKey: key.publicKey,
      imageTag: this.imageTag,
    })

    const id = `vps-${randomBytes(4).toString('hex')}`
    const vps: VPS = {
      id,
      name: opts.name,
      status: 'running',
      publicIPv4: container.host,
      sshPort: container.sshPort,
      size: opts.size,
      region: opts.region,
      createdAt: new Date().toISOString(),
      ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
    }
    this.vpss.set(id, { vps, container, sshKeyId: keyId })
    return vps
  }

  async getVPS(id: string): Promise<VPS | null> {
    return this.vpss.get(id)?.vps ?? null
  }

  async listVPS(): Promise<readonly VPS[]> {
    return [...this.vpss.values()].map((v) => v.vps)
  }

  async destroyVPS(id: string): Promise<void> {
    const entry = this.vpss.get(id)
    if (entry === undefined) return
    await entry.container.stop().catch(() => {})
    this.vpss.delete(id)
  }

  estimateMonthlyCost(): number {
    return 0
  }

  // ─── Test helpers ───────────────────────────────────────────────
  getContainer(vpsId: string): StartedVPS | undefined {
    return this.vpss.get(vpsId)?.container
  }

  async destroyAll(): Promise<void> {
    for (const { container } of this.vpss.values()) {
      await container.stop().catch(() => {})
    }
    this.vpss.clear()
  }
}
