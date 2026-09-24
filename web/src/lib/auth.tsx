import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './api'
import type { PublicUser } from './types'

/**
 * Who is signed in, resolved once on load.
 *
 * `user === undefined` means "not known yet" and is deliberately distinct from
 * `null`, which means "nobody". Collapsing the two flashes the sign-in page at
 * someone who is already signed in, on every refresh.
 */
interface AuthState {
  user: PublicUser | null | undefined
  signIn: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, name: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null | undefined>(undefined)

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setUser(await api.login({ email, password }))
  }, [])

  const register = useCallback(async (email: string, password: string, name: string) => {
    setUser(await api.register({ email, password, name }))
  }, [])

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {})
    setUser(null)
  }, [])

  const value = useMemo<AuthState>(() => ({ user, signIn, register, signOut }), [user, signIn, register, signOut])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
