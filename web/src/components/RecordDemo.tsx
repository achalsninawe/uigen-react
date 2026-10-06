import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Circle, MousePointerClick, Sparkles } from 'lucide-react'

/**
 * The two ways to record, behind one button. Both open a window in this
 * browser and record it through the browser's own tab sharing: one plays the
 * demo by itself, the other leaves the app for the person to drive.
 */
export function RecordMenu({ onDemo, onSelf }: { onDemo: () => void; onSelf: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const item =
    'flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-canvas-deep'
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-rose-soft px-2.5 py-1.5 text-[12px] font-semibold text-rose transition-colors hover:opacity-80"
      >
        <Circle className="size-3 fill-current" />
        Record
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1.5 w-72 rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-line">
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false)
              onDemo()
            }}
          >
            <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              <span className="block text-[13px] font-semibold text-ink">Record demo</span>
              <span className="block text-[12px] leading-snug text-muted">
                Opens like Run demo and records it. Share the tab once, then it plays by itself with sample data.
              </span>
            </span>
          </button>
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false)
              onSelf()
            }}
          >
            <MousePointerClick className="mt-0.5 size-4 shrink-0 text-rose" />
            <span>
              <span className="block text-[13px] font-semibold text-ink">Record myself</span>
              <span className="block text-[12px] leading-snug text-muted">
                You use the app, with its real APIs, while your browser records the tab.
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

