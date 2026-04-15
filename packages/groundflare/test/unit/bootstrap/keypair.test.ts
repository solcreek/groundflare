import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'

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
  it('produces an OpenSSH-format private key (not PKCS#8)', async () => {
    const kp = await generateEd25519Keypair('test')
    // OpenSSH 10+ rejects PKCS#8 ed25519; we must emit the native wrapper.
    expect(kp.privateKeyPem).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/)
    expect(kp.privateKeyPem).toMatch(/-----END OPENSSH PRIVATE KEY-----[\r\n]*$/)
    // Body should start with the "openssh-key-v1\0" magic after base64 decode.
    const body = kp.privateKeyPem
      .replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '')
      .replace(/\s+/g, '')
    const decoded = Buffer.from(body, 'base64')
    expect(decoded.subarray(0, 15).toString('binary')).toBe('openssh-key-v1\0')
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
  it('is deterministic for the same KeyObject + comment', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const a = encodeOpenSshPublicKey(publicKey, 'comment')
    const b = encodeOpenSshPublicKey(publicKey, 'comment')
    expect(a).toBe(b)
    expect(a).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* comment$/)
  })

  it('changes only the trailing comment when given different labels', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const a = encodeOpenSshPublicKey(publicKey, 'one')
    const b = encodeOpenSshPublicKey(publicKey, 'two')
    expect(a.split(/\s+/).slice(0, 2)).toEqual(b.split(/\s+/).slice(0, 2))
    expect(a.endsWith(' one')).toBe(true)
    expect(b.endsWith(' two')).toBe(true)
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
