import { useCallback, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileText, UploadCloud, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SampleDataToggle } from '@/components/SampleDataToggle'
import { cn } from '@/lib/cn'

const ACCEPT = '.md,.markdown,.txt,.json,.yaml,.yml,.pdf,.docx'

const FORMATS = [
  { label: 'user flows', ext: 'md' },
  { label: 'openapi', ext: 'yaml · json' },
  { label: 'api docs', ext: 'pdf · docx · txt' },
]

function prettyBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function Dropzone({
  onSubmit,
  busy,
}: {
  onSubmit: (files: File[], name: string, sampleData: boolean) => void
  busy?: boolean
}) {
  const [files, setFiles] = useState<File[]>([])
  const [name, setName] = useState('')
  const [sampleData, setSampleData] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // dragenter/dragleave fire for every child element, so count depth instead.
  const dragDepth = useRef(0)

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming?.length) return
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`))
      const next = [...prev]
      for (const f of Array.from(incoming)) {
        if (!seen.has(`${f.name}:${f.size}`)) next.push(f)
      }
      return next
    })
  }, [])

  return (
    <div className="w-full">
      <motion.div
        layout
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          dragDepth.current -= 1
          if (dragDepth.current <= 0) setDragging(false)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          addFiles(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'group relative cursor-pointer overflow-hidden rounded-[28px] px-8 py-14',
          'bg-surface/70 backdrop-blur-sm transition-all duration-300 ease-[var(--ease-out-soft)]',
          'shadow-[var(--shadow-soft)]',
          dragging
            ? 'ring-2 ring-primary shadow-[var(--shadow-lift)] scale-[1.01]'
            : 'ring-1 ring-line hover:ring-primary-ring hover:shadow-[var(--shadow-lift)]',
        )}
      >
        {/* dashed inner guide, softened so it never feels like a form field */}
        <div
          className={cn(
            'pointer-events-none absolute inset-3 rounded-[20px] border-2 border-dashed transition-colors duration-300',
            dragging ? 'border-primary/50' : 'border-line group-hover:border-primary-ring',
          )}
        />

        <div className="relative flex flex-col items-center text-center">
          <motion.div
            animate={dragging ? { y: -4, scale: 1.06 } : { y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 320, damping: 20 }}
            className="grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-primary-soft to-sky-soft text-primary"
            style={{ animation: dragging ? undefined : 's2u-float 4s ease-in-out infinite' }}
          >
            <UploadCloud className="size-7" strokeWidth={1.8} />
          </motion.div>

          <p className="mt-5 text-[17px] font-semibold text-ink">
            {dragging ? 'Drop them right here' : 'Drop your specs'}
          </p>
          <p className="mt-1.5 text-sm text-muted">
            or <span className="font-semibold text-primary">browse files</span> — add as many as you like
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {FORMATS.map((f) => (
              <span
                key={f.label}
                className="rounded-full bg-canvas-deep px-3 py-1 text-[11.5px] font-medium text-muted"
              >
                {f.label} <span className="text-faint">· {f.ext}</span>
              </span>
            ))}
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </motion.div>

      <AnimatePresence initial={false}>
        {files.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <ul className="mt-4 space-y-2">
              <AnimatePresence initial={false}>
                {files.map((f) => (
                  <motion.li
                    key={`${f.name}:${f.size}`}
                    layout
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3 ring-1 ring-line"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-lilac-soft text-lilac">
                      <FileText className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{f.name}</span>
                    <span className="shrink-0 text-[11.5px] font-medium text-faint">{prettyBytes(f.size)}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-rose-soft hover:text-rose"
                    >
                      <X className="size-3.5" />
                    </button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>

            {/*
              Named here rather than afterwards: this is the label you will scan
              for in a list of twenty, and "QueryPolicy API 2" is not it.
            */}
            <label className="mt-5 block">
              <span className="mb-1.5 block text-[12px] font-semibold text-ink">Project name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                maxLength={120}
                placeholder="Freelook — named after your files if you leave this blank"
                className="h-11 w-full rounded-xl bg-white px-3.5 text-sm text-ink ring-1 ring-line transition-shadow placeholder:text-faint focus:ring-2 focus:ring-primary focus:outline-none disabled:bg-surface"
              />
            </label>

            <SampleDataToggle
              className="mt-4"
              checked={sampleData}
              onChange={setSampleData}
              disabled={busy}
            />

            <div className="mt-5 flex items-center justify-center gap-3">
              <Button size="lg" loading={busy} onClick={() => onSubmit(files, name.trim(), sampleData)}>
                Analyze {files.length} {files.length === 1 ? 'file' : 'files'}
              </Button>
              <Button size="lg" variant="ghost" onClick={() => setFiles([])} disabled={busy}>
                Clear
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
