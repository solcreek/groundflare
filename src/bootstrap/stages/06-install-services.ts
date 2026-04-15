/**
 * Stage 6 — Install the systemd unit for the workerd runtime.
 *
 * Renders the unit using the template from src/runtime/bootstrap/systemd.ts,
 * SCPs it to /etc/systemd/system/, runs daemon-reload. Does NOT start the
 * unit — there's no capnp config yet (that's written by `groundflare
 * deploy` after this bootstrap completes). Starting workerd against a
 * missing config would fail and put the unit into a failed state.
 *
 * Caddy's systemd unit ships with the apt package; we just enable it
 * and write a placeholder Caddyfile so it can start without errors.
 */

import {
  generateCaddyfile,
  generateWorkerSystemdUnit,
} from '../../runtime/bootstrap/index.js'
import { BootstrapError, type Stage } from '../types.js'

const STAGE_ID = 'system.install-services'
const UNIT_REMOTE_PATH = '/etc/systemd/system/groundflare-worker.service'
const CAPNP_REMOTE_PATH = '/var/lib/groundflare/system/worker.capnp'
const CADDYFILE_REMOTE_PATH = '/etc/caddy/Caddyfile'

export interface InstallServicesStageOptions {
  /** Email used by Caddy for Let's Encrypt registration. */
  readonly acmeEmail: string
  /**
   * Initial domain placeholder. Required by Caddy to have at least one
   * site block; subsequent deploys regenerate the Caddyfile with the
   * tenant set. Use the box's wildcard domain or a synthetic
   * "<workspace>.groundflare.app" placeholder.
   */
  readonly placeholderDomain: string
  /**
   * Override the Caddyfile destination on the remote (for tests).
   */
  readonly caddyfileRemotePath?: string
  /**
   * Override the systemd unit destination on the remote (for tests).
   */
  readonly unitRemotePath?: string
}

export function installServicesStage(opts: InstallServicesStageOptions): Stage {
  const caddyfileTarget = opts.caddyfileRemotePath ?? CADDYFILE_REMOTE_PATH
  const unitTarget = opts.unitRemotePath ?? UNIT_REMOTE_PATH

  return {
    id: STAGE_ID,
    description: 'Install systemd unit + Caddy bootstrap config',

    async isComplete(ctx) {
      if (!ctx.ssh) return false
      try {
        const result = await ctx.ssh.run(`test -f ${unitTarget}`, { timeoutMs: 5_000 })
        return result.exitCode === 0
      } catch {
        return false
      }
    },

    async run(ctx) {
      if (!ctx.ssh) {
        throw new BootstrapError(
          'install-services requires the wait-ssh stage to have completed first',
          'prerequisite',
          STAGE_ID,
        )
      }

      // ─── systemd unit ─────────────────────────────────────────────
      const unit = generateWorkerSystemdUnit({
        capnpPath: CAPNP_REMOTE_PATH,
      })
      await uploadAsRoot(ctx, unit, '/tmp/groundflare-worker.service.upload', unitTarget)
      ctx.log('info', `installed ${unitTarget}`)

      // ─── Caddyfile placeholder ────────────────────────────────────
      // Generate with the placeholder site so Caddy's config validates;
      // deploy will overwrite this file with the real domain set.
      const caddyfile = generateCaddyfile({
        email: opts.acmeEmail,
        sites: [
          {
            hostname: opts.placeholderDomain,
            upstream: '127.0.0.1:8080',
          },
        ],
      })
      await uploadAsRoot(
        ctx,
        caddyfile,
        '/tmp/Caddyfile.upload',
        caddyfileTarget,
      )
      ctx.log('info', `installed ${caddyfileTarget}`)

      // ─── systemd: reload + enable (don't start workerd yet) ──────
      const reload = await ctx.ssh.run(
        'sudo systemctl daemon-reload && ' +
          'sudo systemctl enable groundflare-worker.service && ' +
          'sudo systemctl enable caddy.service && ' +
          'sudo systemctl restart caddy.service',
        { timeoutMs: 30_000 },
      )
      if (reload.exitCode !== 0) {
        throw new BootstrapError(
          `systemctl operation failed: ${reload.stderr || reload.stdout}`,
          'stage_failed',
          STAGE_ID,
        )
      }
      ctx.log('info', 'systemd reloaded; groundflare-worker enabled (not started yet)')
    },
  }
}

async function uploadAsRoot(
  ctx: Parameters<Stage['run']>[0],
  content: string,
  tmpPath: string,
  finalPath: string,
): Promise<void> {
  if (!ctx.ssh) {
    throw new BootstrapError('uploadAsRoot called without ssh', 'prerequisite')
  }

  // Write the content to a local temp file first; SshClient.upload
  // takes a path. Keeping the helper local avoids polluting the SSH
  // module with file-content semantics.
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const localTmp = path.join(os.tmpdir(), `gf-upload-${process.pid}-${Date.now()}.tmp`)
  await fs.writeFile(localTmp, content, 'utf-8')
  try {
    await ctx.ssh.upload(localTmp, tmpPath)
  } finally {
    await fs.rm(localTmp, { force: true })
  }

  const install = await ctx.ssh.run(
    `sudo install -m 0644 -o root -g root ${tmpPath} ${finalPath} && rm -f ${tmpPath}`,
    { timeoutMs: 30_000 },
  )
  if (install.exitCode !== 0) {
    throw new BootstrapError(
      `failed to install ${finalPath}: ${install.stderr || install.stdout}`,
      'stage_failed',
    )
  }
}
