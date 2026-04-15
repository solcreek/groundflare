/**
 * ed25519 keypair generation + OpenSSH public key encoding.
 *
 * Why hand-roll instead of using `sshpk` or `ssh2`?
 *   - One npm dep avoided per design principle "minimal native or chunky
 *     surface in the CLI".
 *   - The format is small and stable: SPKI/PKCS#8 from Node's crypto
 *     module, then a 30-line conversion to OpenSSH wire format.
 *
 * The private key is written as PKCS#8 PEM, which OpenSSH 7.8+ accepts
 * directly via `ssh -i <path>` without needing to convert to the newer
 * "OPENSSH PRIVATE KEY" wrapper.
 */

import { createHash, generateKeyPair, type KeyObject } from 'node:crypto'
import { writeFile, mkdir, chmod, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const generateKeyPairAsync = promisify(generateKeyPair)

const FILE_MODE_PRIVATE = 0o600
const FILE_MODE_PUBLIC = 0o644
const DIR_MODE = 0o700

export interface GeneratedKeypair {
  /** Private key in PKCS#8 PEM. */
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
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const publicKeyOpenSsh = encodeOpenSshPublicKey(publicKey, comment)
  const fingerprint = sha256Fingerprint(publicKeyOpenSsh)
  return { privateKeyPem, publicKeyOpenSsh, fingerprint }
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
