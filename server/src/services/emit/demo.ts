import { key, str, toIdentifier } from './lang.js'
import type { AppSpec, DocumentedField, DocumentedScreen } from '../../types.js'

/**
 * Sample data for screens no API feeds.
 *
 * When documentation describes an interface but never an endpoint, the choice
 * is between an empty shell and something you can click through. Sample data
 * makes the second possible — but only because it is labelled everywhere it
 * appears. Unlabelled invented data is the failure this whole pipeline exists
 * to prevent; the difference is entirely in whether the screen admits it.
 */

/** Plausible-looking values by field name, so a demo reads sensibly. */
function sampleFor(field: DocumentedField, index: number): string {
  const label = field.label.toLowerCase()
  const type = (field.type ?? '').toLowerCase()

  if (field.options?.length) return str(field.options[index % field.options.length]!)

  if (/date|expiry|inception|issue|birth|effective/.test(label) || type.includes('date')) {
    const day = String(((index * 7) % 28) + 1).padStart(2, '0')
    return str(`2026-0${(index % 9) + 1}-${day}T00:00:00`)
  }
  if (/amount|premium|refund|fee|total|duty|sum|price|balance/.test(label)) {
    return String(1000 + index * 250)
  }
  if (/number|no\.$|^no|id$|code|reference|proposal/.test(label)) {
    return str(`SAMPLE-${1000 + index}`)
  }
  if (/email/.test(label)) return str(`person${index + 1}@example.test`)
  if (/phone|mobile|tel/.test(label)) return str(`+10000000${index}`)
  if (/status/.test(label)) return str(['Active', 'Pending', 'Closed'][index % 3]!)
  if (/count|quantity|age|year/.test(label)) return String(index + 1)
  if (/currency/.test(label)) return str('USD')
  if (/name/.test(label)) return str(`Sample ${index + 1}`)

  return str(`Sample ${field.label} ${index + 1}`)
}

/** `Policy No.` -> `policyNo`, so screens read fields by a real identifier. */
export const demoFieldKey = (label: string) => lowerFirst(toIdentifier(label, 'field'))

const lowerFirst = (value: string) => (value ? value[0]!.toLowerCase() + value.slice(1) : value)

/**
 * The names a demo screen's data is exported under.
 *
 * Shared with the planner so the constant a screen imports is always the one
 * that was emitted — computing it twice is how those drift apart.
 */
export function demoNames(screenName: string): { constName: string; typeName: string } {
  const base = toIdentifier(screenName, 'screen')
  const pascal = base[0] ? base[0]!.toUpperCase() + base.slice(1) : 'Screen'
  return { constName: `${lowerFirst(pascal)}Demo`, typeName: `${pascal}Demo` }
}

export interface DemoScreenData {
  screenId: string
  /** Exported constant name, e.g. `policySearchResultDemo`. */
  constName: string
  /** Type the constant is declared with. */
  typeName: string
}

/**
 * Emits `src/lib/demo.ts`: one record per screen, keyed by its documented
 * fields. Nothing here is guessed about your API — it is built from the field
 * labels the documentation itself lists.
 */
export function emitDemoData(
  appSpec: AppSpec,
  screensNeedingDemo: { id: string; name: string; spec?: DocumentedScreen }[],
): { content: string; data: DemoScreenData[] } {
  const data: DemoScreenData[] = []
  const blocks: string[] = []

  for (const screen of screensNeedingDemo) {
    const fields = screen.spec?.fields ?? []
    const { constName, typeName } = demoNames(screen.name)

    const members = fields.length
      ? fields
          .map((f, i) => `  ${key(demoFieldKey(f.label))}: ${sampleFor(f, i)},`)
          .join('\n')
      : '  note: "This screen has no documented fields.",'

    const typeMembers = fields.length
      ? fields
          .map((f) => `  ${key(demoFieldKey(f.label))}: ${f.options?.length || !/amount|premium|refund|fee|total|count|quantity|age|year/.test(f.label.toLowerCase()) ? 'string' : 'number'}`)
          .join('\n')
      : '  note: string'

    blocks.push(`export interface ${typeName} {
${typeMembers}
}

/** Sample only — ${screen.name} has no documented endpoint. */
export const ${constName}: ${typeName} = {
${members}
}`)

    data.push({ screenId: screen.id, constName, typeName })
  }

  const header = `/**
 * Sample data, shown because no endpoint is documented for these screens.
 *
 * Every value here is invented. The field NAMES come from the documentation;
 * the values do not, and must never be mistaken for real records. Screens using
 * this file render a visible notice saying so.
 *
 * Document the endpoints for ${appSpec.appName} and regenerate to replace it.
 */
`

  return {
    content: blocks.length > 0 ? `${header}\n${blocks.join('\n\n')}\n` : `${header}\nexport {}\n`,
    data,
  }
}

/** The banner every demo screen renders, so the state is never ambiguous. */
export const DEMO_NOTICE = `import type { ReactNode } from 'react'

/**
 * Shown on any screen backed by sample data.
 *
 * Deliberately hard to miss: a screen that looks finished and contains invented
 * records is worse than one that is obviously unfinished.
 */
export function DemoNotice({ children }: { children?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start gap-3 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
      <svg viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0 text-amber-600" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>
      <div className="min-w-0 text-[13px] leading-relaxed text-amber-900">
        <span className="font-semibold">Sample data.</span>{' '}
        {children ?? 'No API is documented for this screen, so the values below are invented.'}
      </div>
    </div>
  )
}
`
