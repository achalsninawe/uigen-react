import { Router, type NextFunction, type Request, type Response } from 'express'
import { asyncRoute, badRequest, HttpError, notFound } from '../http.js'
import { publicUser, store, users } from '../services/store.js'
import {
  SESSION_COOKIE,
  cookieFrom,
  emailProblem,
  hashPassword,
  normaliseEmail,
  passwordProblem,
  readSession,
  signSession,
  verifyPassword,
} from '../services/auth.js'
import type { Project, User } from '../types.js'

export const authRouter = Router()

/** The signed-in account, attached by `requireUser`. */
export interface Authed extends Request {
  user?: User
}

const isSecure = (req: Request) =>
  req.secure || req.headers['x-forwarded-proto'] === 'https'

function setSessionCookie(req: Request, res: Response, userId: string) {
  const { token, expires } = signSession(userId)
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Only over TLS where TLS is in use; a Secure cookie on plain http is
    // silently dropped, which would make local development impossible.
    secure: isSecure(req),
    expires,
    path: '/',
  })
}

/**
 * Rejects anything without a valid session.
 *
 * Applied to the whole project API rather than per route: a new endpoint should
 * be private by default, and forgetting to add a guard is how one ends up
 * public.
 */
export function requireUser(req: Authed, _res: Response, next: NextFunction): void {
  const session = readSession(cookieFrom(req.headers.cookie, SESSION_COOKIE))
  if (!session) {
    next(new HttpError(401, 'Sign in to continue'))
    return
  }

  users
    .byId(session.userId)
    .then((user) => {
      // A session outliving the account it names is not a session.
      if (!user) throw new HttpError(401, 'Sign in to continue')
      req.user = user
      next()
    })
    .catch(next)
}

/** The owner of the current request. Never called outside `requireUser`. */
export function ownerOf(req: Authed): string {
  if (!req.user) throw new HttpError(401, 'Sign in to continue')
  return req.user.id
}

/**
 * Loads a project and proves it belongs to the caller.
 *
 * "Does not exist" and "is not yours" both answer 404. A 403 would confirm the
 * id is real, which is the one thing someone guessing ids wants to learn.
 */
export async function ownedProject(req: Authed, id: string): Promise<Project> {
  const project = await store.get(id)
  if (!project || project.ownerId !== ownerOf(req)) throw notFound('Project not found')
  return project
}

/** As `ownedProject`, without downloading every generated file. */
export async function ownedProjectMeta(req: Authed, id: string): Promise<Project> {
  const project = await store.getMeta(id)
  if (!project || project.ownerId !== ownerOf(req)) throw notFound('Project not found')
  return project
}

authRouter.post(
  '/register',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as { email?: string; password?: string; name?: string }
    const email = normaliseEmail(body.email ?? '')

    const problem = emailProblem(email) ?? passwordProblem(body.password ?? '')
    if (problem) throw badRequest(problem)

    if (await users.byEmail(email)) {
      // Deliberately the same wording a person would see for any other rejected
      // registration, so this page cannot be used to test which emails exist.
      throw badRequest('That email cannot be registered. Try signing in instead.')
    }

    const user = await users.create(email, body.name ?? '', hashPassword(body.password!))
    setSessionCookie(req, res, user.id)
    res.status(201).json({ user: publicUser(user) })
  }),
)

authRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as { email?: string; password?: string }
    const email = normaliseEmail(body.email ?? '')
    const user = email ? await users.byEmail(email) : null

    /*
     * One message for both "no such account" and "wrong password".
     *
     * Distinguishing them turns the form into a way to enumerate who has an
     * account here. The work is still done when the user is missing, so the two
     * cases take comparable time.
     */
    const ok = user
      ? verifyPassword(body.password ?? '', user.passwordHash)
      : verifyPassword(body.password ?? '', hashPassword('placeholder-for-timing'))

    if (!user || !ok) throw new HttpError(401, 'Email or password is incorrect')

    setSessionCookie(req, res, user.id)
    res.json({ user: publicUser(user) })
  }),
)

authRouter.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: isSecure(req) })
  res.status(204).end()
})

/** Who am I — used on load to decide between the app and the sign-in page. */
authRouter.get(
  '/me',
  asyncRoute(async (req, res) => {
    const session = readSession(cookieFrom(req.headers.cookie, SESSION_COOKIE))
    const user = session ? await users.byId(session.userId) : null
    res.json({ user: user ? publicUser(user) : null })
  }),
)
