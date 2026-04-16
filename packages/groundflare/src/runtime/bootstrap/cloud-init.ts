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

  /**
   * Install workerd on first boot by downloading the correct architecture
   * binary from npm. Default true (Mirror track needs it). Set to false
   * for Bun-only VPSes.
   */
  readonly installWorkerd?: boolean

  /**
   * workerd version to install (e.g. "1.20260415.1"). Required when
   * installWorkerd is true (the CLI reads this from its own
   * node_modules/workerd/package.json and passes it through).
   */
  readonly workerdVersion?: string

  /**
   * Install the Bun runtime on first boot. When true:
   *   - adds `unzip` to the apt package list (Bun's install script requires it)
   *   - runs Bun's official install script as root
   *   - symlinks /usr/local/bin/bun to the root-local install so any user
   *     (including the `groundflare` systemd service user) can execute it
   *
   * Use this for VPSes that will run the Bun track
   * (`[groundflare] runtime = "bun"` in wrangler.toml). Default false —
   * Mirror-track VPSes don't need Bun and shouldn't spend boot time on it.
   *
   * See design/tracks.md for track selection semantics.
   */
  readonly installBun?: boolean
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
    // Bun's install script invokes `unzip` to unpack the release tarball;
    // the Ubuntu base image doesn't ship it. We add it only when the
    // Bun runtime is being provisioned to keep Mirror-track VPSes lean.
    ...(opts.installBun === true ? ['unzip'] : []),
  ])

  const lines: string[] = ['#cloud-config']
  lines.push('package_update: true')
  // Skip package_upgrade — it adds 3-8 minutes to first boot downloading
  // hundreds of security patches. unattended-upgrades (installed below)
  // handles this in the background after the VPS is ready.
  lines.push('packages:')
  for (const pkg of packages) {
    lines.push(`  - ${pkg}`)
  }

  lines.push('users:')
  lines.push(`  - name: ${systemUser}`)
  lines.push('    sudo: ALL=(ALL) NOPASSWD:ALL')
  lines.push('    shell: /bin/bash')
  lines.push('    ssh_authorized_keys:')
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

  // Create state directory layout
  lines.push(`  - install -d -m 0755 -o ${systemUser} -g ${systemUser} /var/lib/groundflare`)
  lines.push(`  - install -d -m 0755 -o ${systemUser} -g ${systemUser} /var/lib/groundflare/workers`)
  lines.push(`  - install -d -m 0755 -o ${systemUser} -g ${systemUser} /var/lib/groundflare/do-state`)
  lines.push('  - install -d -m 0755 /etc/groundflare')

  if (opts.installWorkerd !== false) {
    const version = opts.workerdVersion ?? 'latest'
    // Download workerd for the VPS's own architecture from the npm registry.
    // dpkg --print-architecture returns "amd64" or "arm64" on Ubuntu.
    // Cloudflare's npm naming: amd64 → "linux-64", arm64 → "linux-arm64".
    lines.push('  - |')
    lines.push('    ARCH=$(dpkg --print-architecture)')
    lines.push('    case "$ARCH" in')
    lines.push('      amd64) WPKG=workerd-linux-64 ;;')
    lines.push('      arm64) WPKG=workerd-linux-arm64 ;;')
    lines.push('      *)     echo "unsupported arch $ARCH"; exit 1 ;;')
    lines.push('    esac')
    lines.push(`    curl -fsSL "https://registry.npmjs.org/@cloudflare/$WPKG/-/$WPKG-${version}.tgz" \\`)
    lines.push('      -o /tmp/workerd.tgz')
    lines.push('    tar -xzf /tmp/workerd.tgz -C /tmp')
    lines.push('    install -m 0755 /tmp/package/bin/workerd /usr/local/bin/workerd')
    lines.push('    rm -rf /tmp/workerd.tgz /tmp/package')
    lines.push('    /usr/local/bin/workerd --version')
  }

  if (opts.installBun === true) {
    // Install Bun as root (HOME=/root so the installer writes to /root/.bun),
    // then symlink the binary into /usr/local/bin so any user can execute it.
    // Binary permissions default to 0755, so the groundflare systemd user can
    // run it via the symlink without touching root-owned dirs.
    lines.push(
      '  - HOME=/root bash -c "curl -fsSL https://bun.sh/install | bash"',
    )
    lines.push('  - ln -sf /root/.bun/bin/bun /usr/local/bin/bun')
  }

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
