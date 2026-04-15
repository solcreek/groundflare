/**
 * Stage 3 — Wait for SSH to become reachable, then attach an SshClient
 * to the orchestration context for downstream stages.
 *
 * Two probes:
 *   1. TCP-level via waitForSshTcpReady (port 22 accepts connections).
 *   2. SSH-level via SshClient.ping (handshake + auth + remote `true`).
 *
 * The TCP probe alone isn't enough: cloud-init may briefly accept TCP
 * before sshd is fully serving keys. The ping confirms our keypair is
 * recognised and the user account is provisioned.
 */

import { OpenSshClient, waitForSshTcpReady } from '../../ssh/index.js'
import type { SshClient, SshTarget } from '../../ssh/index.js'
import { BootstrapError, type Stage } from '../types.js'

const STAGE_ID = 'provider.wait-ssh'

export interface WaitSshStageOptions {
  /** Total time to wait for SSH. Default 5 minutes. */
  readonly maxWaitMs?: number
  /** Per-attempt TCP probe timeout. Default 5s. */
  readonly perAttemptTimeoutMs?: number
  /**
   * Allow tests to inject custom SshClient construction. Production code
   * uses the default OpenSshClient.
   */
  readonly sshClientFactory?: (target: SshTarget) => SshClient
}

export function waitSshStage(opts: WaitSshStageOptions = {}): Stage {
  return {
    id: STAGE_ID,
    description: 'Wait for SSH to become reachable on the new VPS',

    async run(ctx) {
      if (ctx.state.vps === undefined) {
        throw new BootstrapError(
          'wait-ssh requires the provision stage to have completed first',
          'prerequisite',
          STAGE_ID,
        )
      }
      if (ctx.state.sshKey === undefined) {
        throw new BootstrapError(
          'wait-ssh requires the ssh-key stage to have completed first',
          'prerequisite',
          STAGE_ID,
        )
      }

      const port = ctx.state.vps.port ?? 22
      ctx.log('info', `polling TCP ${ctx.state.vps.ipv4}:${port} …`)
      await waitForSshTcpReady({
        host: ctx.state.vps.ipv4,
        port,
        maxWaitMs: opts.maxWaitMs ?? 5 * 60_000,
        ...(opts.perAttemptTimeoutMs !== undefined
          ? { perAttemptTimeoutMs: opts.perAttemptTimeoutMs }
          : {}),
      })
      ctx.log('info', 'TCP reachable; verifying SSH handshake')

      const target: SshTarget = {
        host: ctx.state.vps.ipv4,
        user: ctx.state.vps.user,
        privateKeyPath: ctx.state.sshKey.localPath,
        ...(ctx.state.vps.port !== undefined ? { port: ctx.state.vps.port } : {}),
      }
      const client = opts.sshClientFactory
        ? opts.sshClientFactory(target)
        : new OpenSshClient({ target })

      // SSH handshake / auth / minimal command; throws SshError on failure.
      await client.ping()

      ctx.ssh = client
      ctx.log('info', `SSH ready as ${ctx.state.vps.user}@${ctx.state.vps.ipv4}`)
    },
  }
}
