import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

/**
 * Passwords and sessions, on Node's own crypto.
 *
 * scrypt for hashing and an HMAC-signed cookie for sessions need no
 * dependencies, and both are the boring, correct choice: scrypt is deliberately
 * slow so a leaked table is expensive to attack, and a signed cookie carries no
 * secret of its own, so a stolen one expires on its own schedule.
 */

const SCRYPT_KEYLEN = 64
/** Node's default cost. Raising it later is safe: the cost is stored per hash. */
const SCRYPT_COST = 16384
const SESSION_DAYS = 30

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, { N: SCRYPT_COST })
  return `scrypt$${SCRYPT_COST}$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

/**
 * Constant-time comparison, so a wrong password cannot be narrowed down by
 * timing how long the rejection took.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, costText, saltText, hashText] = stored.split('$')
  if (scheme !== 'scrypt' || !costText || !saltText || !hashText) return false

  const cost = Number.parseInt(costText, 10)
  if (!Number.isFinite(cost)) return false

  const expected = Buffer.from(hashText, 'base64url')
  let derived: Buffer
  try {
    derived = crypto.scryptSync(password.normalize('NFKC'), Buffer.from(saltText, 'base64url'), expected.length, {
      N: cost,
    })
  } catch {
    return false
  }

  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived)
}

/**
 * The key that signs sessions.
 *
 * Set SESSION_SECRET and every instance agrees. Without one, a random key is
 * generated and kept in the work directory rather than in memory — otherwise
 * `--watch` restarting on every file save would sign everyone out mid-task.
 */
function sessionSecret(): Buffer {
  const configured = config.session.secret
  if (configured) return Buffer.from(configured, 'utf8')

  const file = path.join(config.workDir, 'session.key')
  try {
    if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url')
  } catch {
    /* fall through and mint a new one */
  }

  const generated = crypto.randomBytes(32)
  try {
    fs.mkdirSync(config.workDir, { recursive: true })
    fs.writeFileSync(file, generated.toString('base64url'), { mode: 0o600 })
  } catch {
    /* in-memory only; sessions will not survive a restart */
  }
  return generated
}

let cachedSecret: Buffer | undefined
const secret = () => (cachedSecret ??= sessionSecret())

export const SESSION_COOKIE = 'spec2ui_session'

interface SessionPayload {
  userId: string
  /** Expiry, seconds since the epoch. */
  exp: number
}

export function signSession(userId: string): { token: string; expires: Date } {
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  const payload: SessionPayload = { userId, exp: Math.floor(expires.getTime() / 1000) }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = crypto.createHmac('sha256', secret()).update(body).digest('base64url')
  return { token: `${body}.${signature}`, expires }
}

export function readSession(token: string | undefined): { userId: string } | null {
  if (!token) return null
  const [body, signature] = token.split('.')
  if (!body || !signature) return null

  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url')
  const given = Buffer.from(signature, 'base64url')
  const want = Buffer.from(expected, 'base64url')
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
    if (!payload.userId || typeof payload.exp !== 'number') return null
    if (payload.exp * 1000 < Date.now()) return null
    return { userId: payload.userId }
  } catch {
    return null
  }
}

/** Reads one cookie without pulling in a parser. */
export function cookieFrom(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}

/** Emails identify accounts, so they are compared in one canonical form. */
export const normaliseEmail = (email: string) => email.trim().toLowerCase()

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters'
  if (password.length > 200) return 'Password must be shorter than 200 characters'
  return null
}

export function emailProblem(email: string): string | null {
  const value = normaliseEmail(email)
  if (!value) return 'Email is required'
  // Deliberately permissive: the point is to catch a typo, not to police
  // which addresses are legitimate.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'That does not look like an email address'
  if (value.length > 254) return 'Email is too long'
  return null
}
