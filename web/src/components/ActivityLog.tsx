import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Info, XCircle } from 'lucide-react'
import { Dots } from '@/components/ui/Spinner'
import { cn } from '@/lib/cn'

export interface LogLine {
  id: number
  level: 'info' | 'warn' | 'error'
  message: string
}

const icons = {
  info: Info,
  warn: AlertTriangle,
  error: XCircle,
}

export function ActivityLog({ lines, running }: { lines: LogLine[]; running: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [lines.length])

  if (lines.length === 0 && !running) return null

  return (
    <div className="max-h-56 overflow-y-auto px-5 py-4">
      <ul className="space-y-1.5">
        <AnimatePresence initial={false}>
          {lines.map((line) => {
            const Icon = icons[line.level]
            return (
              <motion.li
                key={line.id}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2 }}
                className="flex items-start gap-2.5 text-[13px] leading-relaxed"
              >
                <Icon
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    line.level === 'info' && 'text-faint',
                    line.level === 'warn' && 'text-amber',
                    line.level === 'error' && 'text-rose',
                  )}
                />
                <span className={cn(line.level === 'info' ? 'text-ink-soft' : 'text-ink')}>{line.message}</span>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>

      {running && (
        <div className="mt-2 flex items-center gap-2.5 pl-6 text-primary">
          <Dots />
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}
