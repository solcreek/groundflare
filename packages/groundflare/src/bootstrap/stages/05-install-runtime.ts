/**
 * Stage 5 — Verify the workerd binary + state layout on the VPS.
 *
 * Since v0.3 the workerd binary is downloaded directly on the VPS by
 * cloud-init (no cross-platform SCP from the operator's machine).
 * This stage:
 *
 *   1. Confirm /usr/local/bin/workerd exists and runs (cloud-init
 *      should have installed it). If missing, download it now via
 *      curl as a recovery path.
 *   2. Verify Caddy is installed (also cloud-init's job).
 *   3. Verify the state directory layout exists (cloud-init creates it).
 *
 * The stage is idempotent — running it twice is a no-op.
 */

import { createRequire } from 'node:module'

import { BootstrapError, type Stage } from '../types.js'

const STAGE_ID = 'system.install-runtime'
const REMOTE_WORKERD = '/usr/local/bin/workerd'
const STATE_BASE = '/var/lib/groundflare'

export interface InstallRuntimeStageOptions {
  /**
   * @deprecated No longer used — workerd is downloaded on the VPS by
   * cloud-init. Kept for API compat (value is ignored).
   */
  readonly workerdBinaryPath?: string
}

export function installRuntimeStage(_opts: InstallRuntimeStageOptions = {}): Stage {
  return {
    id: STAGE_ID,
    description: 'Verify workerd binary and state directory layout',

    async isComplete(ctx) {
      if (!ctx.ssh) return false
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

      // 1. Verify workerd — cloud-init should have downloaded it.
      //    If not present (cloud-init runcmd failed?), attempt recovery
      //    via curl on the VPS itself.
      const check = await ctx.ssh.run(`test -x ${REMOTE_WORKERD}`, { timeoutMs: 5_000 })
      if (check.exitCode !== 0) {
        ctx.log('warn', 'workerd not found — cloud-init may have failed; attempting recovery download')
        const version = resolveLocalWorkerdVersion()
        const downloadScript = [
          'ARCH=$(dpkg --print-architecture)',
          'case "$ARCH" in amd64) WPKG=workerd-linux-64 ;; arm64) WPKG=workerd-linux-arm64 ;; *) echo "unsupported arch $ARCH" && exit 1 ;; esac',
          `curl -fsSL "https://registry.npmjs.org/@cloudflare/$WPKG/-/$WPKG-${version}.tgz" -o /tmp/workerd.tgz`,
          'tar -xzf /tmp/workerd.tgz -C /tmp',
          `sudo install -m 0755 /tmp/package/bin/workerd ${REMOTE_WORKERD}`,
          'rm -rf /tmp/workerd.tgz /tmp/package',
        ].join(' && ')
        const dl = await ctx.ssh.run(downloadScript, { timeoutMs: 120_000 })
        if (dl.exitCode !== 0) {
          throw new BootstrapError(
            `recovery workerd download failed: ${dl.stderr || dl.stdout}`,
            'stage_failed',
            STAGE_ID,
          )
        }
      }

      const version = await ctx.ssh.run(`${REMOTE_WORKERD} --version`, { timeoutMs: 10_000 })
      if (version.exitCode !== 0) {
        throw new BootstrapError(
          `workerd binary failed to run: ${version.stderr}`,
          'stage_failed',
          STAGE_ID,
        )
      }
      ctx.log('info', `workerd ready: ${version.stdout.trim()}`)

      // 2. Verify state layout (created by cloud-init runcmd).
      //    Re-create if missing for robustness.
      const layoutCmd = [
        `sudo mkdir -p ${STATE_BASE}/workers`,
        `sudo mkdir -p ${STATE_BASE}/do-state`,
        `sudo mkdir -p /etc/groundflare`,
        `sudo chown -R groundflare:groundflare ${STATE_BASE}`,
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

      // 3. Verify Caddy
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
 * Read the workerd version from node_modules/workerd/package.json.
 * Used for the recovery download path + cloud-init version pinning.
 */
export function resolveLocalWorkerdVersion(): string {
  const require = createRequire(import.meta.url)
  try {
    const pkgPath = require.resolve('workerd/package.json')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(pkgPath) as { version: string }
    return pkg.version
  } catch {
    return 'latest'
  }
}

/** @deprecated Use resolveLocalWorkerdVersion instead. */
export function resolveLocalWorkerdBinary(): string {
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve('workerd/package.json')
  return pkgPath.replace(/\/package\.json$/, '') + '/bin/workerd'
}
