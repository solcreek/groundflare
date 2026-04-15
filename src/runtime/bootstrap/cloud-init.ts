/**
 * cloud-init user-data generator.
 *
 * Runs once on first VPS boot, idempotently. Installs the packages our
 * bootstrap needs (Caddy, ufw, fail2ban, restic), sets up the
 * `groundflare` system user with the provided SSH public key, enables the
 * firewall, and writes unattended-upgrades config for automatic security
 * patches. Matches Stage 3 of design/bootstrap.md.
 *
 * Output is YAML. We hand-format it rather than pulling in a YAML lib
 * because:
 *   - the schema is small and stable
 *   - values are almost always simple ASCII (email, pubkey, package names)
 *   - strict quoting gives us deterministic output (important for diffs)
 */

export interface CloudInitOptions {
  /**
   * SSH public keys authorized for the `groundflare` user. Pubkeys only;
   * one entry per line. At least one required — cloud-init without an
   * authorized key produces an unreachable VPS.
   */
  readonly sshAuthorizedKeys: readonly string[]

  /**
   * Unix user created on the VPS. Default `groundflare`. All systemd units
   * run as this user.
   */
  readonly systemUser?: string

  /**
   * Contact email used in the unattended-upgrades reports. If omitted,
   * the `Unattended-Upgrade::Mail` line is skipped.
   */
  readonly notifyEmail?: string

  /**
   * Additional apt packages to install on first boot. Merged with the
   * groundflare base set; duplicates de-duped.
   */
  readonly extraPackages?: readonly string[]

  /**
   * Base packages. Override to pin or prune (not recommended for v0.1).
   */
  readonly basePackages?: readonly string[]

  /**
   * Enable automatic reboot after upgrades. Default true. Reboot time is
   * 03:00 VPS-local, matching the schedule in design/bootstrap.md §8.
   */
  readonly autoReboot?: boolean
}

const DEFAULT_SYSTEM_USER = 'groundflare'

const DEFAULT_BASE_PACKAGES: readonly string[] = Object.freeze([
  'caddy',
  'ufw',
  'fail2ban',
  'unattended-upgrades',
  'restic',
  'jq',
  'curl',
  'htop',
])

const DEFAULT_AUTO_REBOOT_TIME = '03:00'

export function generateCloudInit(opts: CloudInitOptions): string {
  if (opts.sshAuthorizedKeys.length === 0) {
    throw new TypeError(
      'cloud-init: sshAuthorizedKeys must contain at least one public key — ' +
        'otherwise the VPS will not be reachable after boot.',
    )
  }

  for (const key of opts.sshAuthorizedKeys) {
    validatePublicKey(key)
  }

  const systemUser = opts.systemUser ?? DEFAULT_SYSTEM_USER
  validateUsername(systemUser)

  const packages = dedupePreserveOrder([
    ...(opts.basePackages ?? DEFAULT_BASE_PACKAGES),
    ...(opts.extraPackages ?? []),
  ])

  const lines: string[] = ['#cloud-config']
  lines.push('package_update: true')
  lines.push('package_upgrade: true')
  lines.push('packages:')
  for (const pkg of packages) {
    lines.push(`  - ${pkg}`)
  }

  lines.push('users:')
  lines.push(`  - name: ${systemUser}`)
  lines.push('    sudo: ALL=(ALL) NOPASSWD:ALL')
  lines.push('    shell: /bin/bash')
  lines.push('    ssh-authorized-keys:')
  for (const key of opts.sshAuthorizedKeys) {
    lines.push(`      - ${yamlScalar(key)}`)
  }

  lines.push('runcmd:')
  lines.push('  - systemctl enable --now fail2ban')
  lines.push('  - ufw --force enable')
  lines.push('  - ufw allow OpenSSH')
  lines.push('  - ufw allow 80/tcp')
  lines.push('  - ufw allow 443/tcp')
  lines.push(
    '  - sed -i "s/^#*PermitRootLogin.*/PermitRootLogin no/" /etc/ssh/sshd_config',
  )
  lines.push(
    '  - sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config',
  )
  lines.push('  - systemctl restart ssh')

  lines.push('write_files:')
  lines.push('  - path: /etc/apt/apt.conf.d/50unattended-upgrades')
  lines.push('    permissions: "0644"')
  lines.push('    content: |')
  const unattended = buildUnattendedUpgradesConfig(opts)
  for (const l of unattended.split('\n')) {
    lines.push(`      ${l}`)
  }

  // Always terminate with a newline.
  return lines.join('\n') + '\n'
}

// ─── Helpers ───────────────────────────────────────────────────────

function buildUnattendedUpgradesConfig(opts: CloudInitOptions): string {
  const body: string[] = []
  body.push('Unattended-Upgrade::Allowed-Origins {')
  body.push('  "${distro_id}:${distro_codename}-security";')
  body.push('};')
  if (opts.autoReboot !== false) {
    body.push('Unattended-Upgrade::Automatic-Reboot "true";')
    body.push(`Unattended-Upgrade::Automatic-Reboot-Time "${DEFAULT_AUTO_REBOOT_TIME}";`)
  } else {
    body.push('Unattended-Upgrade::Automatic-Reboot "false";')
  }
  if (opts.notifyEmail) {
    body.push(`Unattended-Upgrade::Mail "${opts.notifyEmail}";`)
    body.push('Unattended-Upgrade::MailReport "on-change";')
  }
  return body.join('\n')
}

function yamlScalar(value: string): string {
  // cloud-init YAML subset. Plain scalar is fine for anything composed of
  // SSH-key / email / package-name characters. Spaces are allowed because
  // SSH public keys are three whitespace-separated tokens. We quote on
  // anything that could confuse a YAML parser (colons, hashes, brackets,
  // leading punctuation, etc.) so the output diffs cleanly.
  if (/^[A-Za-z0-9][A-Za-z0-9._@/+= -]*$/.test(value)) return value
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

function dedupePreserveOrder<T>(items: readonly T[]): T[] {
  const seen = new Set<T>()
  const out: T[] = []
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/

function validateUsername(name: string): void {
  if (!USERNAME_RE.test(name)) {
    throw new TypeError(`cloud-init: invalid system user name: ${name}`)
  }
}

function validatePublicKey(key: string): void {
  // Looser validation than a full parser — we only reject values that
  // clearly won't be accepted by sshd or OpenSSH:
  //   - must start with a known key-type prefix
  //   - must not contain newline (one key per entry)
  if (key.includes('\n') || key.includes('\r')) {
    throw new TypeError('cloud-init: SSH key entry must not contain newlines')
  }
  const KNOWN_TYPES = [
    'ssh-ed25519',
    'ssh-rsa',
    'ssh-dss',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'sk-ssh-ed25519@openssh.com',
    'sk-ecdsa-sha2-nistp256@openssh.com',
  ]
  const type = key.split(/\s+/)[0] ?? ''
  if (!KNOWN_TYPES.includes(type)) {
    throw new TypeError(
      `cloud-init: SSH key type ${JSON.stringify(type)} is not recognised — ` +
        `expected one of ${KNOWN_TYPES.slice(0, 3).join(', ')}, ...`,
    )
  }
}
