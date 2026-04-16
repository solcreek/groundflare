/**
 * Stage 2 — Provision a VPS.
 *
 * Calls provider.createVPS with cloud-init user-data so the box arrives
 * with the groundflare user, packages, and hardening already applied
 * (Stages 3 + 4 in the design doc are absorbed into the cloud-init pass
 * because everything cloud-init does is part of the same request to the
 * provider — splitting them would add SSH ceremony for nothing).
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { generateCloudInit } from '../../runtime/bootstrap/index.js'
import { BootstrapError, type Stage } from '../types.js'

const STAGE_ID = 'provider.provision'

export interface ProvisionStageOptions {
  /** VPS size to request, e.g. `cx22`. Required at run time. */
  readonly size: string
  /** Region/datacenter, e.g. `hel1`. Required. */
  readonly region: string
  /** Public-facing label for the VPS. Default: `gf-<workspace>`. */
  readonly hostnameOverride?: string
  /** Override the OS image (provider-specific). */
  readonly image?: string
  /** Optional contact email passed into cloud-init's unattended-upgrades. */
  readonly notifyEmail?: string
  /**
   * Runtime track the workspace targets. When `"bun"`, cloud-init
   * installs Bun + skips workerd. Default `"workerd"`.
   */
  readonly runtime?: 'workerd' | 'bun'
  /** workerd version for cloud-init to download (e.g. "1.20260415.1"). */
  readonly workerdVersion?: string
  /** Max time to wait for a public IPv4 to appear (some providers assign
   *  it asynchronously). Default 120s. */
  readonly ipv4PollTimeoutMs?: number
}

export function provisionStage(opts: ProvisionStageOptions): Stage {
  return {
    id: STAGE_ID,
    description: `Provision a ${opts.size} VPS in ${opts.region}`,

    async isComplete(ctx) {
      const recorded = ctx.state.vps
      if (recorded === undefined) return false
      // Confirm the VPS still exists on the provider — the operator
      // might have deleted it manually outside groundflare.
      try {
        const live = await ctx.provider.getVPS(recorded.id)
        return live !== null
      } catch {
        return false
      }
    },

    async run(ctx) {
      if (ctx.state.sshKey === undefined) {
        throw new BootstrapError(
          'provisioning requires the ssh-key stage to have completed first',
          'prerequisite',
          STAGE_ID,
        )
      }

      const fs = await import('node:fs/promises')
      const publicKey = (await fs.readFile(ctx.state.sshKey.localPublicPath, 'utf-8')).trim()
      if (publicKey.length === 0) {
        throw new BootstrapError(
          `local public key file is empty: ${ctx.state.sshKey.localPublicPath}`,
          'prerequisite',
          STAGE_ID,
        )
      }

      const isBun = opts.runtime === 'bun'
      const userData = generateCloudInit({
        sshAuthorizedKeys: [publicKey],
        ...(opts.notifyEmail !== undefined ? { notifyEmail: opts.notifyEmail } : {}),
        ...(isBun ? { installBun: true, installWorkerd: false } : {}),
        ...(!isBun && opts.workerdVersion !== undefined
          ? { workerdVersion: opts.workerdVersion }
          : {}),
      })

      const hostname = opts.hostnameOverride ?? `gf-${ctx.workspace}`
      let vps = await ctx.provider.createVPS({
        name: hostname,
        size: opts.size,
        region: opts.region,
        sshKeyIds: [ctx.state.sshKey.providerId],
        userData,
        labels: {
          'managed-by': 'groundflare',
          workspace: ctx.workspace,
        },
        ...(opts.image !== undefined ? { image: opts.image } : {}),
      })

      // Some providers (DigitalOcean) assign the public IPv4 asynchronously
      // after the create call returns. Poll until it appears.
      if (vps.publicIPv4 === undefined || vps.publicIPv4.length === 0) {
        ctx.log('info', `waiting for public IPv4 on ${vps.id}…`)
        const deadline = Date.now() + (opts.ipv4PollTimeoutMs ?? 120_000)
        while (Date.now() < deadline) {
          await sleep(3_000)
          const refreshed = await ctx.provider.getVPS(vps.id)
          if (refreshed?.publicIPv4 !== undefined && refreshed.publicIPv4.length > 0) {
            vps = refreshed
            break
          }
        }
        if (vps.publicIPv4 === undefined || vps.publicIPv4.length === 0) {
          throw new BootstrapError(
            `VPS ${vps.id} never received a public IPv4 within ${(opts.ipv4PollTimeoutMs ?? 120_000) / 1000}s`,
            'stage_failed',
            STAGE_ID,
          )
        }
      }

      const stateVps: NonNullable<typeof ctx.state.vps> = {
        id: vps.id,
        ipv4: vps.publicIPv4,
        size: vps.size,
        region: vps.region,
        // cloud-init creates the `groundflare` user; we always SSH in as that.
        user: 'groundflare',
      }
      if (vps.publicIPv6 !== undefined) {
        stateVps.ipv6 = vps.publicIPv6
      }
      if (vps.sshPort !== undefined) {
        stateVps.port = vps.sshPort
      }
      ctx.state.vps = stateVps

      ctx.log('info', `provisioned ${vps.id} at ${vps.publicIPv4} (${vps.size}/${vps.region})`)
    },
  }
}
