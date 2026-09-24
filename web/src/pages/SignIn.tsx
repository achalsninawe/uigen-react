import { useState } from 'react'
import { motion } from 'framer-motion'
import { Lock, Mail, User as UserIcon } from 'lucide-react'
import { TopBar } from '@/components/TopBar'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/lib/auth'

/**
 * Sign in and register, on one page.
 *
 * Two routes for what is the same three fields and the same outcome adds a
 * navigation step to the most common thing anyone does here. The toggle keeps
 * whatever has already been typed, so choosing the wrong one first costs
 * nothing.
 */
export default function SignIn() {
  const { signIn, register } = useAuth()

  const [mode, setMode] = useState<'signin' | 'register'>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const registering = mode === 'register'

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (registering) await register(email, password, name)
      else await signIn(email, password)
      // No navigation here: the gate re-renders the app once a user exists.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh">
      <TopBar />

      <main className="mx-auto max-w-md px-6 pt-20 pb-24">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="text-[28px] font-bold tracking-tight text-ink">
            {registering ? 'Create an account' : 'Welcome back'}
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-muted">
            {registering
              ? 'Your projects are private to your account.'
              : 'Sign in to reach the projects you have saved.'}
          </p>

          <form onSubmit={submit} className="mt-8 rounded-2xl bg-white p-6 ring-1 ring-line">
            {registering && (
              <label className="mb-4 block">
                <span className="mb-1.5 block text-[12px] font-semibold text-ink">Name</span>
                <span className="relative block">
                  <UserIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    placeholder="Your name"
                    className="h-11 w-full rounded-xl bg-white pr-3.5 pl-9 text-sm text-ink ring-1 ring-line transition-shadow placeholder:text-faint hover:ring-line focus:ring-2 focus:ring-primary focus:outline-none"
                  />
                </span>
              </label>
            )}

            <label className="mb-4 block">
              <span className="mb-1.5 block text-[12px] font-semibold text-ink">Email</span>
              <span className="relative block">
                <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@company.com"
                  className="h-11 w-full rounded-xl bg-white pr-3.5 pl-9 text-sm text-ink ring-1 ring-line transition-shadow placeholder:text-faint focus:ring-2 focus:ring-primary focus:outline-none"
                />
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[12px] font-semibold text-ink">Password</span>
              <span className="relative block">
                <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={registering ? 'new-password' : 'current-password'}
                  placeholder={registering ? 'At least 8 characters' : '••••••••'}
                  className="h-11 w-full rounded-xl bg-white pr-3.5 pl-9 text-sm text-ink ring-1 ring-line transition-shadow placeholder:text-faint focus:ring-2 focus:ring-primary focus:outline-none"
                />
              </span>
            </label>

            {error && (
              <p className="mt-4 rounded-xl bg-rose/10 px-3.5 py-2.5 text-[13px] font-medium text-rose">{error}</p>
            )}

            <Button type="submit" loading={busy} className="mt-6 w-full" size="lg">
              {registering ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-5 text-center text-[13px] text-muted">
            {registering ? 'Already have an account?' : 'No account yet?'}{' '}
            <button
              type="button"
              onClick={() => {
                setMode(registering ? 'signin' : 'register')
                setError(null)
              }}
              className="font-semibold text-primary transition-colors hover:text-ink"
            >
              {registering ? 'Sign in' : 'Create one'}
            </button>
          </p>
        </motion.div>
      </main>
    </div>
  )
}
