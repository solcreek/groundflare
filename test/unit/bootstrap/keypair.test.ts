import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { createPublicKey } from 'node:crypto'

import {
  generateEd25519Keypair,
  encodeOpenSshPublicKey,
  saveKeypair,
  sha256Fingerprint,
} from '../../../src/bootstrap/index.js'

const isPosix = platform() !== 'win32'
let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gf-keypair-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('generateEd25519Keypair', () => {
  it('produces a PKCS#8 PEM private key', async () => {
    const kp = await generateEd25519Keypair('test')
    expect(kp.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/)
    expect(kp.privateKeyPem).toMatch(/-----END PRIVATE KEY-----[\r\n]*$/)
  })

  it('produces a single-line OpenSSH public key starting with ssh-ed25519', async () => {
    const kp = await generateEd25519Keypair('alice@laptop')
    expect(kp.publicKeyOpenSsh).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* alice@laptop$/)
    expect(kp.publicKeyOpenSsh).not.toContain('\n')
  })

  it('public key wire format decodes to the expected algorithm + 32 bytes', async () => {
    const kp = await generateEd25519Keypair('test')
    const wireB64 = kp.publicKeyOpenSsh.split(/\s+/)[1]!
    const wire = Buffer.from(wireB64, 'base64')
    // 4 bytes length + "ssh-ed25519" (11 bytes) + 4 bytes length + 32 bytes key = 51 bytes total
    expect(wire.length).toBe(51)
    const algoLen = wire.readUInt32BE(0)
    expect(algoLen).toBe(11)
    expect(wire.subarray(4, 4 + 11).toString('ascii')).toBe('ssh-ed25519')
    const keyLen = wire.readUInt32BE(4 + 11)
    expect(keyLen).toBe(32)
  })

  it('fingerprint is SHA256:<base64-without-padding>', async () => {
    const kp = await generateEd25519Keypair('test')
    expect(kp.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(kp.fingerprint).not.toContain('=')
  })

  it('two generations produce different keys', async () => {
    const a = await generateEd25519Keypair('a')
    const b = await generateEd25519Keypair('b')
    expect(a.publicKeyOpenSsh).not.toBe(b.publicKeyOpenSsh)
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('comment normalisation strips embedded newlines', async () => {
    const kp = await generateEd25519Keypair('multi\nline\rcomment')
    expect(kp.publicKeyOpenSsh).not.toContain('\n')
    expect(kp.publicKeyOpenSsh).not.toContain('\r')
  })
})

describe('encodeOpenSshPublicKey', () => {
  it('round-trips a Node KeyObject', async () => {
    const kp = await generateEd25519Keypair('comment')
    // Re-encode the public key directly from a KeyObject and confirm match.
    // Reconstruct PublicKey from the PKCS#8 private's exported public part.
    const fromPem = createPublicKey(kp.privateKeyPem)
    const reEncoded = encodeOpenSshPublicKey(fromPem, 'comment')
    expect(reEncoded).toBe(kp.publicKeyOpenSsh)
  })
})

describe('sha256Fingerprint', () => {
  it('rejects non-ed25519 lines', () => {
    expect(() => sha256Fingerprint('ssh-rsa AAAAB3 user@host')).toThrow(
      /not an OpenSSH ed25519/,
    )
  })

  it('produces the same fingerprint as the keypair generator', async () => {
    const kp = await generateEd25519Keypair('check')
    expect(sha256Fingerprint(kp.publicKeyOpenSsh)).toBe(kp.fingerprint)
  })
})

describe('saveKeypair', () => {
  it('writes private + public files with the right modes', async () => {
    const kp = await generateEd25519Keypair('test')
    const result = await saveKeypair(kp, {
      directory: tmp,
      basename: 'workspace_ed25519',
    })
    expect(result.privateKeyPath).toBe(join(tmp, 'workspace_ed25519'))
    expect(result.publicKeyPath).toBe(join(tmp, 'workspace_ed25519.pub'))

    const priv = await readFile(result.privateKeyPath, 'utf-8')
    expect(priv).toBe(kp.privateKeyPem)

    const pub = await readFile(result.publicKeyPath, 'utf-8')
    expect(pub.trimEnd()).toBe(kp.publicKeyOpenSsh)

    if (isPosix) {
      const privStat = await stat(result.privateKeyPath)
      expect(privStat.mode & 0o777).toBe(0o600)
      const pubStat = await stat(result.publicKeyPath)
      expect(pubStat.mode & 0o777).toBe(0o644)
      const dirStat = await stat(tmp)
      expect(dirStat.mode & 0o777).toBe(0o700)
    }
  })

  it('overwrites previous files (idempotent re-save)', async () => {
    const kp1 = await generateEd25519Keypair('first')
    await saveKeypair(kp1, { directory: tmp, basename: 'k' })
    const kp2 = await generateEd25519Keypair('second')
    await saveKeypair(kp2, { directory: tmp, basename: 'k' })
    const pub = await readFile(join(tmp, 'k.pub'), 'utf-8')
    expect(pub.trimEnd()).toBe(kp2.publicKeyOpenSsh)
  })
})
