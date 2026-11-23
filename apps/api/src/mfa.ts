import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { config } from './config'
import type { Store, UserRow } from './store'

/**
 * Two-step sign-in with a time-based one-time code (RFC 6238, HMAC-SHA1, six digits, thirty seconds): the settings every
 * authenticator app understands, Google Authenticator included (it ignores any other). Nothing here talks to a third
 * party, so it works on a server with no internet.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error('not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new shared secret: 160 bits, as base32 (what an authenticator app is given). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', key).update(message).digest()
  const offset = mac[mac.length - 1]! & 15
  const binary =
    ((mac[offset]! & 127) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** The code for one thirty-second step. */
export function totpCode(secret: string, step: number): string {
  return hotp(base32Decode(secret), step)
}

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / TOTP_STEP_SECONDS)

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The step a code belongs to, or null. A code from the step before or after the current one is accepted (a phone clock
 * is rarely exact), but never one at or before `lastStep`: a code works once, so a sighted or intercepted code is
 * useless the moment it has been used.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now = Date.now(),
  lastStep = 0,
  window = 1,
): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const key = base32Decode(secret)
  const current = stepAt(now)
  let match: number | null = null
  // Every step is compared, whatever matches, so the time taken says nothing about which one did.
  for (let step = current - window; step <= current + window; step += 1) {
    if (sameText(hotp(key, step), code) && step > lastStep) match = match === null ? step : match
  }
  return match
}

/** The address an authenticator app reads from the QR code. */
export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  return (
    `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`
  )
}

// --- the secret at rest -------------------------------------------------------------------------------------------

const sealingKey = (): Buffer =>
  createHash('sha256')
    .update(`two-step-secret:${config.mfa.encryptionKey || config.jwtSecret}`)
    .digest()

/** AES-256-GCM: what is stored is unreadable without the server's key, and cannot be altered unnoticed. */
export function sealSecret(secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sealingKey(), iv)
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`
}

/** The secret, or null when it was not sealed with this server's key (or was changed). */
export function openSecret(sealed: string | null): string | null {
  if (!sealed) return null
  const [version, iv, tag, body] = sealed.split(':')
  if (version !== 'v1' || !iv || !tag || !body) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString(
      'utf8',
    )
  } catch {
    return null
  }
}

// --- recovery codes -----------------------------------------------------------------------------------------------

// No 0, O, 1, I or L: a code read off a printed page is not mistaken.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const RECOVERY_CODE_COUNT = 10

/** `ABCDE-FGHJK`: ten letters and digits (about 49 bits), each usable once, for a lost phone. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10)
    const chars = Array.from(bytes, (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]!)
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`
  })
}

/** What someone typed, as a recovery code ready to hash, or null when it cannot be one. */
export function normalizeRecoveryCode(text: string): string | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, '')
  return /^[A-Z2-9]{10}$/.test(clean) ? clean : null
}

/** Stored as a hash: codes are long and random, so a plain digest is enough, and a copy of the table yields none. */
export const hashRecoveryCode = (clean: string): string =>
  createHash('sha256').update(`recovery:${clean}`).digest('hex')

// --- policy and the second step -----------------------------------------------------------------------------------

/** Whether this role must have two-step sign-in on. */
export function mfaRequiredFor(role: string): boolean {
  return role !== 'pilot' && config.mfa.requiredRoles.includes(role)
}

export type SecondFactor = { ok: true; method: 'totp' | 'recovery' } | { ok: false }

/**
 * Checks what someone typed as the second step: a six-digit code, or a recovery code. A code is spent in one atomic
 * statement, so two requests with the same code cannot both pass. A wrong one counts against the account (see
 * `store.recordTotpFailure`); the caller turns that into a lock.
 */
export async function checkSecondFactor(
  store: Store,
  user: UserRow,
  typed: string,
): Promise<SecondFactor> {
  const digits = typed.replace(/\s/g, '')
  if (/^\d{6}$/.test(digits)) {
    const secret = openSecret(user.totp_secret)
    const step = secret ? verifyTotp(secret, digits, Date.now(), Number(user.totp_last_step)) : null
    if (step !== null && (await store.spendTotpStep(user.id, step)))
      return { ok: true, method: 'totp' }
    return { ok: false }
  }
  const recovery = normalizeRecoveryCode(typed)
  if (recovery && (await store.spendRecoveryCode(user.id, hashRecoveryCode(recovery))))
    return { ok: true, method: 'recovery' }
  return { ok: false }
}
