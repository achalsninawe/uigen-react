import { useEffect, useState } from 'react'
import { Cloud, HardDrive, LogOut, Sparkles, TriangleAlert } from 'lucide-react'
import { Wordmark } from '@/components/Logo'
import { api, type HealthInfo } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/cn'

function Pill({
  icon,
  label,
  tone = 'neutral',
}: {
  icon: React.ReactNode
  label: string
  tone?: 'neutral' | 'mint' | 'amber'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold',
        tone === 'mint' && 'bg-mint-soft text-mint',
        tone === 'amber' && 'bg-amber-soft text-amber',
        tone === 'neutral' && 'bg-canvas-deep text-muted',
      )}
    >
      {icon}
      {label}
    </span>
  )
}

export function TopBar() {
  const [health, setHealth] = useState<HealthInfo | null>(null)

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-canvas/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Wordmark />
        <div className="flex items-center gap-2">
          {health && (
            <>
              <Pill
                icon={health.ai === 'ready' ? <Sparkles className="size-3.5" /> : <TriangleAlert className="size-3.5" />}
                label={health.ai === 'ready' ? health.deployment : 'mock mode'}
                tone={health.ai === 'ready' ? 'mint' : 'amber'}
              />
              <Pill
                icon={health.storage === 'azure' ? <Cloud className="size-3.5" /> : <HardDrive className="size-3.5" />}
                label={health.storage === 'azure' ? 'azure' : 'local'}
              />
            </>
          )}
          <AccountMenu />
        </div>
      </div>
    </header>
  )
}

/**
 * Who is signed in, and the way out.
 *
 * Rendered from the auth context rather than taking props, so the sign-in page
 * — which has no account yet — can use the same top bar without special-casing.
 */
function AccountMenu() {
  const { user, signOut } = useAuth()
  if (!user) return null

  return (
    <div className="ml-1 flex items-center gap-2 border-l border-line/70 pl-3">
      <span className="hidden text-[12px] font-semibold text-muted sm:inline" title={user.email}>
        {user.name}
      </span>
      <button
        type="button"
        onClick={() => void signOut()}
        aria-label="Sign out"
        className="rounded-lg p-1.5 text-faint transition-colors hover:bg-canvas-deep hover:text-ink"
      >
        <LogOut className="size-4" />
      </button>
    </div>
  )
}
