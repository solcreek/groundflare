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
  generateSeaweedfsSystemdUnit,
  generateWorkerSystemdUnit,
} from '../../runtime/bootstrap/index.js'
import { BootstrapError, type Stage } from '../types.js'

const STAGE_ID = 'system.install-services'
const UNIT_REMOTE_PATH = '/etc/systemd/system/groundflare-worker.service'
const SEAWEEDFS_UNIT_REMOTE_PATH = '/etc/systemd/system/groundflare-r2.service'
// NOTE: the capnp file lives directly under /var/lib/groundflare/ (NOT
// under /system/) so the `embed` paths it contains — e.g.
// `workers/<name>/code/current/index.js` — resolve against
// /var/lib/groundflare/workers/ where runDeploy lays out tenant bundles.
// Putting the capnp in a sibling directory would break those resolves.
const CAPNP_REMOTE_PATH = '/var/lib/groundflare/worker.capnp'
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

      // ─── SeaweedFS sidecar unit (skipped on Bun track) ────────────
      // cloud-init dropped the weed binary at /usr/local/bin/weed when
      // installSeaweedfs=true (see stages/02-provision.ts). Probe for it;
      // if absent, skip the unit install (Bun-track VPSes won't have it).
      const weedProbe = await ctx.ssh.run('test -x /usr/local/bin/weed', {
        timeoutMs: 5_000,
      })
      if (weedProbe.exitCode === 0) {
        const r2Unit = generateSeaweedfsSystemdUnit()
        await uploadAsRoot(
          ctx,
          r2Unit,
          '/tmp/groundflare-r2.service.upload',
          SEAWEEDFS_UNIT_REMOTE_PATH,
        )
        ctx.log('info', `installed ${SEAWEEDFS_UNIT_REMOTE_PATH}`)
      } else {
        ctx.log('info', 'weed binary not present, skipping R2 sidecar unit')
      }

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
      // R2 sidecar (when installed) starts now — workerd will need it
      // running before deploy lands the first capnp config that uses
      // an R2 binding. weed without traffic uses ~50 MB so the cost is
      // bounded.
      const enableR2 =
        weedProbe.exitCode === 0
          ? 'sudo systemctl enable --now groundflare-r2.service && '
          : ''
      const reload = await ctx.ssh.run(
        'sudo systemctl daemon-reload && ' +
          'sudo systemctl enable groundflare-worker.service && ' +
          enableR2 +
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
