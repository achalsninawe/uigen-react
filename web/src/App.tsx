import { Routes, Route, Navigate } from 'react-router-dom'
import Home from '@/pages/Home'
import Project from '@/pages/Project'
import Preview from '@/pages/Preview'
import SignIn from '@/pages/SignIn'
import { AuthProvider, useAuth } from '@/lib/auth'

/**
 * Nothing renders until we know who is signed in.
 *
 * The blank hold is brief and deliberate: rendering the app first and
 * redirecting on the first 401 shows a flash of someone else's empty state, and
 * rendering the sign-in page first shows it to people who are already signed in
 * on every refresh.
 */
function Gate() {
  const { user } = useAuth()

  if (user === undefined) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="size-5 animate-spin rounded-full border-2 border-line border-t-primary" />
      </div>
    )
  }

  if (!user) return <SignIn />

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/p/:id" element={<Project />} />
      {/* The pop-out preview. Inside the gate, so it needs the same sign-in. */}
      <Route path="/preview/:id" element={<Preview />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
