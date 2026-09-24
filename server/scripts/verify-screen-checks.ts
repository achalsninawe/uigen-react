/**
 * Guards the checks that judge a generated screen.
 *
 * These decide whether a screen is rewritten, so a false positive is expensive
 * twice over: a repair round is spent, and the model is told to fix something
 * that was never wrong — which it can only do by changing code that worked.
 * `useRef<HTMLInputElement>(null)` was being reported as a missing component
 * import, and the advice was to import it from the component kit, which does
 * not export it and never could.
 *
 *   npm run verify:screen-checks -w server
 */
import { checkUndefinedComponents } from '../src/services/pipeline/validate.js'

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

const header = `import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, Field, Input } from '../components/ui'
`

/** Nothing here is a missing import. */
const clean = `${header}
export default function EditProject() {
  const nameRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<Project>()
  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => setRows(undefined)
  const onSelect = (event: React.ChangeEvent<HTMLSelectElement>) => undefined

  return (
    <Card>
      <Field label="Name">
        <Input ref={nameRef} onChange={onChange} />
      </Field>
      <Button onClick={() => onSelect}>Save</Button>
    </Card>
  )
}
`

const onClean = checkUndefinedComponents(clean)
record(
  'type arguments are not mistaken for components',
  onClean.length === 0,
  onClean.length ? onClean.map((v) => v.message).join(' · ') : 'no violations',
)

/** A genuinely missing component must still be caught. */
const missing = `${header}
export default function Projects() {
  return (
    <Card>
      <StatusBadge status="Active" />
      <DataTable rows={[]} />
    </Card>
  )
}
`

const onMissing = checkUndefinedComponents(missing)
record(
  'a component that is used but never imported is still caught',
  onMissing.length === 2 &&
    onMissing.every((v) => /StatusBadge|DataTable/.test(v.message)),
  onMissing.map((v) => v.message.split(' —')[0]).join(' · ') || 'nothing reported',
)

/** A generic on its own line, and a tag right after a brace. */
const mixed = `${header}
type Column<T> = { header: string; cell: (row: T) => unknown }

export default function Projects() {
  const columns: Column<Project>[] = []
  const el = document.querySelector<HTMLDivElement>('#root')
  return <div>{columns.length ? <Card /> : null}</div>
}
`

const onMixed = checkUndefinedComponents(mixed)
record(
  'generics in declarations and calls stay quiet',
  onMixed.length === 0,
  onMixed.length ? onMixed.map((v) => v.message).join(' · ') : 'no violations',
)

console.log()
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}\n          ${c.detail}`)

const failed = checks.filter((c) => !c.ok)
console.log()
if (failed.length > 0) {
  console.error(`${failed.length} of ${checks.length} checks failed`)
  process.exit(1)
}
console.log(`all ${checks.length} checks passed`)
