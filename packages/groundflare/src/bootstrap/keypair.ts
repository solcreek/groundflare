/**
 * ed25519 keypair generation + OpenSSH public/private encoding.
 *
 * Why hand-roll instead of using `sshpk` or `ssh2`?
 *   - One npm dep avoided per design principle "minimal native or chunky
 *     surface in the CLI".
 *   - The format is small and stable.
 *
 * OpenSSH (10.x at least) does NOT accept PKCS#8 PEM keys for ed25519.
 * We emit the key in OpenSSH's own "OPENSSH PRIVATE KEY" format instead.
 */

import { createHash, generateKeyPair, randomBytes, type KeyObject } from 'node:crypto'
import { writeFile, mkdir, chmod, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const generateKeyPairAsync = promisify(generateKeyPair)

const FILE_MODE_PRIVATE = 0o600
const FILE_MODE_PUBLIC = 0o644
const DIR_MODE = 0o700

export interface GeneratedKeypair {
  /**
   * Private key in the OpenSSH "OPENSSH PRIVATE KEY" format, unencrypted.
   * This is what `ssh -i <path>` expects — PKCS#8 PEM does NOT work for
   * ed25519 with modern OpenSSH.
   */
  readonly privateKeyPem: string
  /** Public key in OpenSSH single-line format ("ssh-ed25519 AAAA... <comment>"). */
  readonly publicKeyOpenSsh: string
  /** SHA-256 fingerprint of the public key, formatted "SHA256:<base64>". */
  readonly fingerprint: string
}

/**
 * Generate a new ed25519 keypair entirely in-process. No spawning of
 * ssh-keygen — keeps the dep surface to "Node + nothing".
 */
export async function generateEd25519Keypair(comment: string): Promise<GeneratedKeypair> {
  const { publicKey, privateKey } = await generateKeyPairAsync('ed25519')
  const rawPriv = extractRawEd25519PrivateKey(privateKey)
  const rawPub = extractRawEd25519PublicKey(publicKey)
  const privateKeyPem = encodeOpenSshPrivateKey(rawPriv, rawPub, comment)
  const publicKeyOpenSsh = encodeOpenSshPublicKey(publicKey, comment)
  const fingerprint = sha256Fingerprint(publicKeyOpenSsh)
  return { privateKeyPem, publicKeyOpenSsh, fingerprint }
}

/**
 * Extract the 32-byte raw seed from Node's PKCS#8 DER export.
 * PKCS#8 for ed25519 is 48 bytes: 16 bytes of ASN.1 wrapping + 32 bytes key.
 */
function extractRawEd25519PrivateKey(privateKey: KeyObject): Buffer {
  const der = privateKey.export({ type: 'pkcs8', format: 'der' })
  if (!Buffer.isBuffer(der) || der.length !== 48) {
    throw new TypeError(`expected 48-byte ed25519 PKCS#8 DER, got ${der.length} bytes`)
  }
  return Buffer.from(der.subarray(16))
}

function extractRawEd25519PublicKey(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  if (!Buffer.isBuffer(der) || der.length !== 44) {
    throw new TypeError(`expected 44-byte ed25519 SPKI DER, got ${der.length} bytes`)
  }
  return Buffer.from(der.subarray(12))
}

/**
 * Serialize an unencrypted ed25519 key in OpenSSH's native format.
 *
 * Wire layout (all length-prefixed strings use uint32 BE lengths):
 *   "openssh-key-v1\0"
 *   string "none"                     (cipher)
 *   string "none"                     (kdf)
 *   string ""                         (kdf options, empty)
 *   uint32 1                          (number of keys)
 *   string <pubkey block>             (ssh-ed25519 wire format)
 *   string <private section>:
 *      uint32 checkint | uint32 checkint  (same random value, twice)
 *      string "ssh-ed25519"
 *      string <32-byte pub>
 *      string <64-byte priv||pub>
 *      string <comment>
 *      padding 1,2,3...N to cipher blocksize (8 for "none")
 */
function encodeOpenSshPrivateKey(
  rawPriv: Buffer,
  rawPub: Buffer,
  comment: string,
): string {
  const sanitizedComment = comment.replace(/[\r\n]+/g, ' ').trim()
  const algo = Buffer.from('ssh-ed25519', 'ascii')

  const pubBlock = Buffer.concat([lengthPrefix(algo), lengthPrefix(rawPub)])
  const privPayload = Buffer.concat([lengthPrefix(rawPriv), lengthPrefix(rawPub)])

  const checkint = randomBytes(4)
  const privSection = Buffer.concat([
    checkint,
    checkint,
    lengthPrefix(algo),
    lengthPrefix(rawPub),
    // OpenSSH stores the 64-byte "expanded" ed25519 secret (seed || pub).
    lengthPrefix(Buffer.concat([rawPriv, rawPub])),
    lengthPrefix(Buffer.from(sanitizedComment, 'utf-8')),
  ])
  void privPayload
  const padded = padToBlocksize(privSection, 8)

  const magic = Buffer.from('openssh-key-v1\0', 'binary')
  const body = Buffer.concat([
    magic,
    lengthPrefix(Buffer.from('none', 'ascii')),
    lengthPrefix(Buffer.from('none', 'ascii')),
    lengthPrefix(Buffer.alloc(0)),
    uint32BE(1),
    lengthPrefix(pubBlock),
    lengthPrefix(padded),
  ])

  return toPem(body, 'OPENSSH PRIVATE KEY')
}

function padToBlocksize(buf: Buffer, blocksize: number): Buffer {
  const rem = buf.length % blocksize
  if (rem === 0) return buf
  const padLen = blocksize - rem
  const padding = Buffer.alloc(padLen)
  for (let i = 0; i < padLen; i++) padding[i] = i + 1
  return Buffer.concat([buf, padding])
}

function uint32BE(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function toPem(body: Buffer, label: string): string {
  const b64 = body.toString('base64')
  // Wrap at 70 columns — ssh-keygen itself uses 70.
  const wrapped = b64.match(/.{1,70}/g) ?? [b64]
  return `-----BEGIN ${label}-----\n${wrapped.join('\n')}\n-----END ${label}-----\n`
}

/**
 * Convert an ed25519 KeyObject (Node) into OpenSSH single-line public key
 * format: "ssh-ed25519 <base64-wire-format> <comment>".
 *
 * Wire format:
 *   uint32 BE length-prefix | "ssh-ed25519" | uint32 BE length-prefix | <32-byte raw key>
 */
export function encodeOpenSshPublicKey(publicKey: KeyObject, comment: string): string {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  // SPKI for ed25519 is exactly 44 bytes: 12-byte ASN.1 prefix + 32-byte key.
  if (!Buffer.isBuffer(der) || der.length !== 44) {
    throw new TypeError(
      `expected 44-byte ed25519 SPKI export, got ${der.length} bytes`,
    )
  }
  const rawKey = der.subarray(12)
  const algorithmName = Buffer.from('ssh-ed25519', 'ascii')
  const wire = Buffer.concat([
    lengthPrefix(algorithmName),
    lengthPrefix(rawKey),
  ])
  const sanitizedComment = comment.replace(/[\r\n]+/g, ' ').trim()
  return `ssh-ed25519 ${wire.toString('base64')} ${sanitizedComment}`.trimEnd()
}

function lengthPrefix(buf: Buffer): Buffer {
  const lengthBytes = Buffer.alloc(4)
  lengthBytes.writeUInt32BE(buf.length)
  return Buffer.concat([lengthBytes, buf])
}

/**
 * SHA-256 fingerprint of an OpenSSH public key, matching `ssh-keygen -lf`'s
 * default output: SHA256:<base64>.
 */
export function sha256Fingerprint(opensshLine: string): string {
  // Pull the base64-encoded wire key out of the line.
  const parts = opensshLine.split(/\s+/)
  if (parts.length < 2 || parts[0] !== 'ssh-ed25519') {
    throw new TypeError('not an OpenSSH ed25519 public key line')
  }
  const wire = Buffer.from(parts[1]!, 'base64')
  const digest = createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

// ─── Persistence ──────────────────────────────────────────────────

export interface SaveKeypairOptions {
  readonly directory: string
  readonly basename: string
}

export interface SavedKeypairPaths {
  readonly privateKeyPath: string
  readonly publicKeyPath: string
}

/**
 * Write the keypair to disk in OpenSSH conventions:
 *   <directory>/<basename>          (PKCS#8 PEM private key, mode 0600)
 *   <directory>/<basename>.pub      (OpenSSH single-line public key, mode 0644)
 */
export async function saveKeypair(
  keypair: GeneratedKeypair,
  opts: SaveKeypairOptions,
): Promise<SavedKeypairPaths> {
  await mkdir(opts.directory, { recursive: true, mode: DIR_MODE })
  // Tighten in case the directory pre-existed.
  try {
    await chmod(opts.directory, DIR_MODE)
  } catch {
    // best-effort on Windows
  }

  const privateKeyPath = join(opts.directory, opts.basename)
  const publicKeyPath = join(opts.directory, `${opts.basename}.pub`)

  await writeFile(privateKeyPath, keypair.privateKeyPem, {
    mode: FILE_MODE_PRIVATE,
    encoding: 'utf-8',
  })
  await writeFile(publicKeyPath, keypair.publicKeyOpenSsh + '\n', {
    mode: FILE_MODE_PUBLIC,
    encoding: 'utf-8',
  })

  // Force tighten perms — the umask might have widened the file as written.
  try {
    await chmod(privateKeyPath, FILE_MODE_PRIVATE)
    await chmod(publicKeyPath, FILE_MODE_PUBLIC)
  } catch {
    // best-effort
  }

  return { privateKeyPath, publicKeyPath }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Default location for groundflare-managed SSH keys, per workspace. */
export function defaultKeypairDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return join(xdg, 'groundflare', 'keys')
  return join(homedir(), '.config', 'groundflare', 'keys')
}
