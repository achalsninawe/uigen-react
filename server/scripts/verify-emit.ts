/**
 * Emits a full project for a stored AppSpec and type-checks it for real.
 *
 * Screen generation needs a live model, but everything else is deterministic —
 * this proves the emitted API client, types, UI kit and shell actually compile
 * together, which is the half of the pipeline that must never be wrong.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../src/config.js'
import { store } from '../src/services/store.js'
import { emitFoundation, screenComponentName, type EmitContext } from '../src/services/emit/index.js'
import type { AppPlan, ScreenPlan } from '../src/types.js'

const id = process.argv[2]
if (!id) throw new Error('usage: npm run verify:emit -w server -- <projectId>')

const project = await store.get(id)
if (!project?.appSpec) throw new Error('project has no appSpec — run analyze first')
const appSpec = project.appSpec

/** A stand-in plan, so the shell has screens to route to. */
const screens: ScreenPlan[] = [
  {
    id: 'home',
    name: 'Overview',
    route: '/',
    type: 'list',
    purpose: 'Everything at a glance',
    icon: 'LayoutDashboard',
    sections: [],
    endpointIds: appSpec.endpoints.slice(0, 2).map((e) => e.operationId),
    showInNav: true,
  },
  {
    id: 'detail',
    name: 'Record Detail',
    route: '/records/:recordId',
    type: 'detail',
    purpose: 'One record in full',
    icon: 'FileText',
    sections: [],
    endpointIds: [],
    showInNav: false,
  },
]

const plan: AppPlan = {
  screens,
  navigation: screens.filter((s) => s.showInNav).map((s) => ({ screenId: s.id, label: s.name, icon: s.icon })),
  theme: { accent: '#6C63FF', mood: 'calm', density: 'comfortable' },
  designNotes: [],
}

const ctx: EmitContext = { projectId: id, transport: 'proxy', serverOrigin: 'http://localhost:5177' }
const files = emitFoundation(appSpec, plan, ctx)

/**
 * Stub screens that exercise the kit the way generated screens will: every
 * exported component is referenced, so a broken export fails the type-check.
 */
const stub = (name: string) => `import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import {
  Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, DataTable, DetailList, Dialog,
  EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Spinner, Stat,
  StatusBadge, TableSkeleton, Textarea, Value, cn, useToast, type Column,
} from '../components/ui'

export default function ${name}() {
  const navigate = useNavigate()
  const params = useParams<{ recordId: string }>()
  const toast = useToast()
  const [rows, setRows] = useState<{ id: string; label: string }[]>()
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(undefined)
    Promise.resolve([{ id: '1', label: 'demo' }])
      .then(setRows)
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const columns: Column<{ id: string; label: string }>[] = [
    { header: 'Id', cell: (row) => row.id },
    { header: 'Label', cell: (row) => <Value value={row.label} />, className: 'text-right tabular-nums' },
  ]

  return (
    <div className={cn('space-y-6')}>
      <PageHeader
        title="${name}"
        description={params.recordId ?? 'Stub screen used to type-check the component kit'}
        actions={<Button onClick={() => { setOpen(true); toast.push('opened', 'info') }}><Search className="size-4" />Open</Button>}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total" value={rows?.length ?? 0} hint="records" />
        <Card><CardHeader title="Panel" subtitle="sub" action={<Badge tone="accent">new</Badge>} /><CardBody><Skeleton className="h-4 w-24" /></CardBody></Card>
        <Card><CardBody><StatusBadge status="pending" /><Spinner /></CardBody></Card>
      </div>
      <Card>
        <CardHeader title="Records" />
        <DataTable rows={rows} columns={columns} loading={loading} error={error} onRetry={load}
          onRowClick={() => navigate('/')} getRowKey={(row) => row.id}
          empty={{ title: 'Nothing yet', description: 'No records found', action: <Button size="sm">Add</Button> }} />
      </Card>
      <Card><DetailList items={[{ label: 'Field', value: <Value value={{ nested: true }} /> }]} /></Card>
      <TableSkeleton rows={2} columns={2} />
      <EmptyState title="Empty" description="nothing here" />
      {error ? <ErrorState error={error} onRetry={load} /> : null}
      <Dialog open={open} onClose={() => setOpen(false)} title="Edit" description="desc"
        footer={<Button onClick={() => setOpen(false)}>Done</Button>}>
        <div className="space-y-3">
          <Field label="Name" required hint="hint"><Input placeholder="name" /></Field>
          <Field label="Notes" error="bad"><Textarea /></Field>
          <Field label="Kind"><Select><option value="a">A</option></Select></Field>
        </div>
      </Dialog>
      <ConfirmDialog open={false} onClose={() => {}} onConfirm={() => {}} title="Delete?" confirmLabel="Delete" />
    </div>
  )
}
`

for (const screen of screens) {
  files.push({
    path: `src/screens/${screenComponentName(screen)}.tsx`,
    content: stub(screenComponentName(screen)),
    origin: 'model',
    screenId: screen.id,
  })
}

const outDir = path.join(config.workDir, 'verify', id)
await fs.rm(outDir, { recursive: true, force: true })
for (const f of files) {
  const target = path.join(outDir, f.path)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, f.content, 'utf8')
}

console.log(`wrote ${files.length} files to ${outDir}`)
for (const f of files) console.log(`  ${f.origin === 'emitted' ? '·' : '+'} ${f.path}`)
