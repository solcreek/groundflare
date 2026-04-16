import { describe, it, expect } from 'vitest'
import { generateCloudInit } from '../../../../src/runtime/bootstrap/index.js'

const SAMPLE_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABCDEFGHIJK1234567890abcdefghij user@laptop'

describe('generateCloudInit — header and basic shape', () => {
  it('starts with the #cloud-config header', () => {
    const out = generateCloudInit({ sshAuthorizedKeys: [SAMPLE_KEY] })
    expect(out.split('\n')[0]).toBe('#cloud-config')
  })

  it('enables package_update but skips package_upgrade (handled by unattended-upgrades)', () => {
    const out = generateCloudInit({ sshAuthorizedKeys: [SAMPLE_KEY] })
    expect(out).toContain('package_update: true')
    expect(out).not.toContain('package_upgrade')
  })

  it('always ends with a newline', () => {
    const out = generateCloudInit({ sshAuthorizedKeys: [SAMPLE_KEY] })
    expect(out.endsWith('\n')).toBe(true)
  })
})

describe('generateCloudInit — packages', () => {
  it('includes the groundflare base set', () => {
    const out = generateCloudInit({ sshAuthorizedKeys: [SAMPLE_KEY] })
    for (const pkg of ['caddy', 'ufw', 'fail2ban', 'unattended-upgrades', 'restic']) {
      expect(out).toContain(`  - ${pkg}`)
    }
  })

  it('appends extraPackages after the base set', () => {
    const out = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      extraPackages: ['tmux', 'vim'],
    })
    expect(out).toContain('  - tmux')
    expect(out).toContain('  - vim')
  })

  it('dedupes duplicate packages while preserving order', () => {
    const out = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      extraPackages: ['caddy', 'tmux', 'caddy'],
    })
    const caddyMatches = out.match(/^\s*- caddy$/gm) ?? []
    expect(caddyMatches).toHaveLength(1)
    const tmuxMatches = out.match(/^\s*- tmux$/gm) ?? []
    expect(tmuxMatches).toHaveLength(1)
  })

  it('accepts a fully custom basePackages list', () => {
    const out = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      basePackages: ['minimal'],
    })
    expect(out).toContain('  - minimal')
    expect(out).not.toContain('  - caddy')
  })
})

describe('generateCloudInit — user and SSH', () => {
  it('creates the default groundflare user', () => {
    const out = generateCloudInit({ sshAuthorizedKeys: [SAMPLE_KEY] })
    expect(out).toContain('- name: groundflare')
    expect(out).toContain('sudo: ALL=(ALL) NOPASSWD:ALL')
    expect(out).toContain('shell: /bin/bash')
  })

  it('honours a custom systemUser', () => {
    const out = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      systemUser: 'workerd',
    })
    expect(out).toContain('- name: workerd')
  })

  it('embeds each SSH key under the user block', () => {
    const secondKey =
      'ssh-rsa AAAAB3NzaC1yc2EAAAA_second_key_material second@laptop'
    const out = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY, secondKey],
    })
    expect(out).toContain(`      - ${SAMPLE_KEY}`)
    expect(out).toContain(`      - ${secondKey}`)
  })
})

describe('generateCloudInit — runcmd hardening', () => {
  const out = generateCloudInit({ sshAuthorizedKeys: [SAMPLE_KEY] })

  it('enables fail2ban', () => {
    expect(out).toContain('systemctl enable --now fail2ban')
  })

  it('enables the firewall with only SSH + 80 + 443 open', () => {
    expect(out).toContain('ufw --force enable')
    expect(out).toContain('ufw allow OpenSSH')
    expect(out).toContain('ufw allow 80/tcp')
    expect(out).toContain('ufw allow 443/tcp')
  })

  it('disables root login + password auth in sshd_config', () => {
    expect(out).toContain('PermitRootLogin no')
    expect(out).toContain('PasswordAuthentication no')
    expect(out).toContain('systemctl restart ssh')
  })
})

describe('generateCloudInit — unattended-upgrades', () => {
  it('writes /etc/apt/apt.conf.d/50unattended-upgrades', () => {
    const out = generateCloudInit({ sshAuthorizedKeys: [SAMPLE_KEY] })
    expect(out).toContain('- path: /etc/apt/apt.conf.d/50unattended-upgrades')
  })

  it('includes Automatic-Reboot at 03:00 by default', () => {
    const out = generateCloudInit({ sshAuthorizedKeys: [SAMPLE_KEY] })
    expect(out).toContain('Unattended-Upgrade::Automatic-Reboot "true"')
    expect(out).toContain('Unattended-Upgrade::Automatic-Reboot-Time "03:00"')
  })

  it('disables auto-reboot when opted out', () => {
    const out = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      autoReboot: false,
    })
    expect(out).toContain('Unattended-Upgrade::Automatic-Reboot "false"')
    expect(out).not.toContain('Automatic-Reboot-Time')
  })

  it('adds notification email when provided', () => {
    const out = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      notifyEmail: 'ops@example.com',
    })
    expect(out).toContain('Unattended-Upgrade::Mail "ops@example.com"')
    expect(out).toContain('Unattended-Upgrade::MailReport "on-change"')
  })

  it('omits notification email when not provided', () => {
    const out = generateCloudInit({ sshAuthorizedKeys: [SAMPLE_KEY] })
    expect(out).not.toContain('Unattended-Upgrade::Mail')
  })
})

describe('generateCloudInit — validation', () => {
  it('rejects empty SSH key list', () => {
    expect(() => generateCloudInit({ sshAuthorizedKeys: [] })).toThrow(
      /at least one public key/,
    )
  })

  it('rejects keys containing newlines (would break YAML layout)', () => {
    expect(() =>
      generateCloudInit({ sshAuthorizedKeys: ['ssh-ed25519 ABC\nssh-ed25519 DEF'] }),
    ).toThrow(/newlines/)
  })

  it('rejects keys that do not start with a known key type', () => {
    expect(() =>
      generateCloudInit({ sshAuthorizedKeys: ['not-a-key AAAA user@host'] }),
    ).toThrow(/key type/)
  })

  it('accepts every common OpenSSH key type', () => {
    const types = [
      'ssh-ed25519',
      'ssh-rsa',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'sk-ssh-ed25519@openssh.com',
    ]
    for (const t of types) {
      expect(() =>
        generateCloudInit({ sshAuthorizedKeys: [`${t} AAAA user@host`] }),
      ).not.toThrow()
    }
  })

  it('rejects invalid system user names', () => {
    expect(() =>
      generateCloudInit({
        sshAuthorizedKeys: [SAMPLE_KEY],
        systemUser: '1root', // must start with letter/underscore
      }),
    ).toThrow(/system user name/)
    expect(() =>
      generateCloudInit({
        sshAuthorizedKeys: [SAMPLE_KEY],
        systemUser: 'has space',
      }),
    ).toThrow(/system user name/)
  })
})

describe('generateCloudInit — installBun', () => {
  it('does not install Bun by default (Mirror-track VPSes stay lean)', () => {
    const y = generateCloudInit({ sshAuthorizedKeys: [SAMPLE_KEY] })
    expect(y).not.toContain('unzip')
    expect(y).not.toContain('bun.sh/install')
    expect(y).not.toContain('/root/.bun/bin/bun')
  })

  it('adds unzip to packages when installBun is true', () => {
    const y = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      installBun: true,
    })
    expect(y).toMatch(/^ {2}- unzip$/m)
  })

  it('appends the bun install runcmd + symlink when installBun is true', () => {
    const y = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      installBun: true,
    })
    expect(y).toContain(
      '  - HOME=/root bash -c "curl -fsSL https://bun.sh/install | bash"',
    )
    expect(y).toContain('  - ln -sf /root/.bun/bin/bun /usr/local/bin/bun')
  })

  it('emits the bun steps after SSH hardening, before write_files', () => {
    const y = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      installBun: true,
    })
    const sshIdx = y.indexOf('systemctl restart ssh')
    const bunIdx = y.indexOf('bun.sh/install')
    const writeFilesIdx = y.indexOf('write_files:')
    expect(sshIdx).toBeGreaterThan(0)
    expect(bunIdx).toBeGreaterThan(sshIdx)
    expect(writeFilesIdx).toBeGreaterThan(bunIdx)
  })

  it('de-dupes unzip when it is also in extraPackages', () => {
    const y = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      installBun: true,
      extraPackages: ['unzip', 'vim'],
    })
    const matches = y.match(/^ {2}- unzip$/gm) ?? []
    expect(matches.length).toBe(1)
  })

  it('does not add the symlink when installBun is false explicitly', () => {
    const y = generateCloudInit({
      sshAuthorizedKeys: [SAMPLE_KEY],
      installBun: false,
    })
    expect(y).not.toContain('/usr/local/bin/bun')
  })
})
