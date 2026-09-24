import { Check } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/cn'

export type StepKey = 'upload' | 'analyze' | 'generate' | 'preview'

const STEPS: { key: StepKey; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'analyze', label: 'Analyze' },
  { key: 'generate', label: 'Generate' },
  { key: 'preview', label: 'Preview' },
]

export function StepRail({ current, done }: { current: StepKey; done: StepKey[] }) {
  const currentIndex = STEPS.findIndex((s) => s.key === current)

  return (
    <div className="flex items-center gap-2">
      {STEPS.map((step, i) => {
        const isDone = done.includes(step.key)
        const isCurrent = step.key === current
        const isFuture = i > currentIndex && !isDone

        return (
          <div key={step.key} className="flex items-center gap-2">
            <div
              className={cn(
                'flex items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors duration-300',
                isDone && 'bg-mint-soft text-mint',
                isCurrent && !isDone && 'bg-primary-soft text-primary',
                isFuture && 'text-faint',
              )}
            >
              <span
                className={cn(
                  'grid size-4 place-items-center rounded-full text-[10px] font-bold',
                  isDone && 'bg-mint text-white',
                  isCurrent && !isDone && 'bg-primary text-white',
                  isFuture && 'bg-line text-muted',
                )}
              >
                {isDone ? <Check className="size-2.5" strokeWidth={3.5} /> : i + 1}
              </span>
              {step.label}
            </div>

            {i < STEPS.length - 1 && (
              <span className="relative h-px w-6 overflow-hidden rounded-full bg-line">
                <motion.span
                  className="absolute inset-0 bg-mint"
                  initial={false}
                  animate={{ scaleX: isDone ? 1 : 0 }}
                  style={{ originX: 0 }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
