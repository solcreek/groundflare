/**
 * Stage 5 — Install the workerd binary + create the on-disk state layout.
 *
 * Idempotent flow:
 *   1. Resolve the workerd binary the CLI is using locally
 *      (node_modules/workerd/bin/workerd via require.resolve).
 *   2. SCP it to /usr/local/bin/workerd on the VPS, mode 0755.
 *   3. Verify the install with `workerd --version`.
 *   4. Create /var/lib/groundflare/{system,workers,do-state} owned by
 *      the groundflare user (created by cloud-init).
 *   5. Verify Caddy is installed (cloud-init was supposed to apt-install it).
 *
 * The binary is shipped from the operator's machine rather than fetched
 * from GitHub releases on the VPS so the version is guaranteed to match
 * whatever the local groundflare package bundled — no version drift
 * between dev and prod.
 */

import { createRequire } from 'node:module'

import { BootstrapError, type Stage } from '../types.js'

const STAGE_ID = 'system.install-runtime'
const REMOTE_WORKERD = '/usr/local/bin/workerd'
const STATE_BASE = '/var/lib/groundflare'

export interface InstallRuntimeStageOptions {
  /**
   * Override the local workerd binary path. Default: resolve via
   * require.resolve('workerd/bin/workerd') from the calling module.
   */
  readonly workerdBinaryPath?: string
}

export function installRuntimeStage(opts: InstallRuntimeStageOptions = {}): Stage {
  return {
    id: STAGE_ID,
    description: 'Install workerd binary and create state directory layout',

    async isComplete(ctx) {
      if (!ctx.ssh) return false
      // Check the binary exists; workerd version skew is intentional —
      // the operator can re-run with a newer CLI to push a new binary.
      try {
        const result = await ctx.ssh.run(`test -x ${REMOTE_WORKERD}`, { timeoutMs: 5_000 })
        return result.exitCode === 0
      } catch {
        return false
      }
    },

    async run(ctx) {
      if (!ctx.ssh) {
        throw new BootstrapError(
          'install-runtime requires the wait-ssh stage to have completed first',
          'prerequisite',
          STAGE_ID,
        )
      }

      const localBinary = opts.workerdBinaryPath ?? resolveLocalWorkerdBinary()
      ctx.log('info', `uploading ${localBinary} to ${REMOTE_WORKERD}`)
      // SCP to a tmp location then sudo mv into /usr/local/bin so the
      // SSH user (groundflare, non-root) can deposit it.
      const tmpPath = '/tmp/groundflare-workerd.upload'
      await ctx.ssh.upload(localBinary, tmpPath)

      const install = await ctx.ssh.run(
        `sudo install -m 0755 -o root -g root ${tmpPath} ${REMOTE_WORKERD} && rm -f ${tmpPath}`,
        { timeoutMs: 60_000 },
      )
      if (install.exitCode !== 0) {
        throw new BootstrapError(
          `failed to install workerd: ${install.stderr || install.stdout}`,
          'stage_failed',
          STAGE_ID,
        )
      }

      // Confirm the binary runs.
      const version = await ctx.ssh.run(`${REMOTE_WORKERD} --version`, { timeoutMs: 10_000 })
      if (version.exitCode !== 0) {
        throw new BootstrapError(
          `installed workerd binary failed to run: ${version.stderr}`,
          'stage_failed',
          STAGE_ID,
        )
      }
      ctx.log('info', `workerd ready: ${version.stdout.trim()}`)

      // Create the state tree owned by `groundflare:groundflare`. The
      // user was created by cloud-init.
      const layoutCmd = [
        `sudo mkdir -p ${STATE_BASE}/system`,
        `sudo mkdir -p ${STATE_BASE}/workers`,
        `sudo mkdir -p ${STATE_BASE}/do-state`,
        `sudo mkdir -p /etc/groundflare`,
        `sudo chown -R groundflare:groundflare ${STATE_BASE}`,
        `sudo chown -R groundflare:groundflare /etc/groundflare`,
        `sudo chmod 0755 ${STATE_BASE}`,
      ].join(' && ')
      const layout = await ctx.ssh.run(layoutCmd, { timeoutMs: 10_000 })
      if (layout.exitCode !== 0) {
        throw new BootstrapError(
          `failed to create state layout: ${layout.stderr}`,
          'stage_failed',
          STAGE_ID,
        )
      }
      ctx.log('info', `created state layout under ${STATE_BASE}`)

      // Verify Caddy is installed (cloud-init's apt step should have
      // handled it). If it's missing the operator hit a cloud-init
      // failure we missed earlier; surface it now rather than at start.
      const caddy = await ctx.ssh.run('which caddy && caddy version', {
        timeoutMs: 10_000,
      })
      if (caddy.exitCode !== 0) {
        throw new BootstrapError(
          `Caddy not installed (cloud-init may have failed): ${caddy.stderr || 'no caddy in PATH'}`,
          'stage_failed',
          STAGE_ID,
        )
      }
      ctx.log('info', `caddy: ${caddy.stdout.trim()}`)
    },
  }
}

/**
 * Resolve the workerd binary path the CLI itself is using. Walks up
 * from this module's URL via Node's module resolution.
 */
export function resolveLocalWorkerdBinary(): string {
  const require = createRequire(import.meta.url)
  try {
    const pkgPath = require.resolve('workerd/package.json')
    // workerd's bin entry is `bin/workerd` relative to the package root.
    const root = pkgPath.replace(/\/package\.json$/, '')
    return `${root}/bin/workerd`
  } catch (err) {
    throw new BootstrapError(
      `could not locate the workerd npm package on the operator machine`,
      'prerequisite',
      STAGE_ID,
      { cause: err },
    )
  }
}
