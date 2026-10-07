import { CODEGEN_SYSTEM, signatureFor } from './codegen.js'
import { uiKitReference } from '../services/emit/uikit.js'
import type { AppSpec, Endpoint, ScreenPlan, SpecDocument } from '../types.js'

/*
 * Prompts for the AI builder.
 *
 * The classic pipeline hands each stage a summary of the one before, so the
 * model writing a screen never saw the documents or a real response, and every
 * guess made upstream arrived downstream as a fact. Here every call gets the
 * whole picture — the documents, the real API functions and types, and real
 * responses — and the decisions about flow and data are the model's.
 */

/* ------------------------------------------------------------------ */
/* Shared context blocks                                               */
/* ------------------------------------------------------------------ */

/** Enough for several long specifications, well inside any current context window. */
const DOCS_BUDGET = 150_000
const EXAMPLE_BUDGET = 6_000

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters not shown)`
}

function json(value: unknown, max = EXAMPLE_BUDGET): string {
  try {
    return clip(JSON.stringify(value, null, 2), max)
  } catch {
    return '(not serialisable)'
  }
}

/** Every document, in full where it fits, each given a fair share of the budget. */
export function documentsBlock(documents: SpecDocument[]): string {
  const readable = documents.filter((d) => d.text.trim())
  if (readable.length === 0) return '(no document text)'
  const share = Math.floor(DOCS_BUDGET / readable.length)
  return readable.map((d) => `=== ${d.filename} ===\n${clip(d.text.trim(), share)}`).join('\n\n')
}

/** Each endpoint as the emitted client exposes it, with what the docs and real calls say. */
export function endpointsBlock(endpoints: Endpoint[]): string {
  if (endpoints.length === 0) return '(no API is documented)'
  return endpoints
    .map((e) => {
      const lines = [`${e.method} ${e.path}${e.summary ? ` — ${e.summary}` : ''}`, signatureFor(e).trim()]
      if (e.requestBody?.example !== undefined) lines.push(`request example:\n${json(e.requestBody.example)}`)
      const success = e.responses.find((r) => /^2\d\d$/.test(r.status))
      if (success?.example !== undefined) {
        const observed = success.description === 'Observed in a live call' ? ' (REAL, from a live call)' : ''
        lines.push(`response example${observed}:\n${json(success.example)}`)
      } else if (!success?.typeName) {
        lines.push('response: not documented and not yet observed')
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

function dataRule(sampleData: boolean): string {
  return sampleData
    ? `SAMPLE DATA IS ALLOWED. A screen no API can feed may show sample values, but
only beneath <DemoNotice /> imported from '../components/DemoNotice', so nobody
mistakes them for real ones. Real API data always wins where it exists.`
    : `API ONLY. Every value on screen comes from an API response, from router state
passed by an earlier screen, or from what the user typed. Never invent a value,
never hard-code a record. A screen or region no API can feed renders an
<EmptyState> saying no API supplies it.`
}

/* ------------------------------------------------------------------ */
/* 1. Samples                                                          */
/* ------------------------------------------------------------------ */

export const SAMPLES_SYSTEM = `You decide which API endpoints may be called ONCE, for real, so the app can be
built against real responses instead of guesses.

For each endpoint you are given, return:
  operationId  exactly as given
  readOnly     true ONLY if calling it cannot change anything: a read, get, search,
               query, lookup, list, quotation, calculation or trial that the
               documents say does not store, execute, submit or issue anything.
               Anything that creates, updates, deletes, executes, submits, issues,
               cancels, pays, registers or sends is false. When unsure, false.
  why          one short reason
  pathParams, query, body
               the inputs for that one call, taken from example values that appear
               in the documents (request examples, sample policy numbers, sample
               payloads). NEVER invent identifiers. If a required input has no
               example value anywhere in the documents, omit body/params entirely.

Return JSON: { "endpoints": [ ... ] }`

export function samplesUser(documents: SpecDocument[], endpoints: Endpoint[]): string {
  return `ENDPOINTS
${endpointsBlock(endpoints)}

DOCUMENTS
${documentsBlock(documents)}`
}

/* ------------------------------------------------------------------ */
/* 2. Design                                                           */
/* ------------------------------------------------------------------ */

export const DESIGN_SYSTEM = `You are designing a complete React web app from its documentation. Read all of
it — the documents, the API, the types and the real responses — and decide the
screens, the flow between them, and exactly what each one does. A separate step
writes each screen from your design, so your design must be complete and exact.

Return JSON:
{
  "journey": boolean,      // true when the screens are one sequence walked in order
  "screens": [
    {
      "name":        "Policy Search Result",
      "route":       "/policy-result",          // the first screen is "/"
      "type":        "form" | "detail" | "list" | "dashboard" | "search" | "wizard" | "settings" | "auth" | "empty",
      "purpose":     one line, shown under the title,
      "icon":        a lucide-react icon name, e.g. "Search",
      "showInNav":   boolean,
      "hero":        { "eyebrow"?, "headline", "sub"? } or null — orientation copy only, never data,
      "aside":       { "title", "headline"? } or null — a running summary panel beside the screen,
      "calls":       [operationIds this screen calls itself],
      "receives":    TypeScript type of what arrives in router state, or "" for nothing,
      "navigatesTo": [names of screens it moves to],
      "brief":       the build instructions for this screen (see below)
    }
  ],
  "theme": { "accent": "#hex", "mood": "calm" | "vivid" | "corporate" | "playful", "density": "comfortable" | "compact" },
  "designNotes": [short notes that apply to every screen]
}

RULES

1. When the documents specify screens ("UI 1 - …", field tables, button lists),
   reproduce them: the same screens, names, fields, labels, buttons and order.
   Otherwise design the screens the flows and API need — no more.

2. "calls" may contain only operationIds from the API section.

3. "receives" is a TypeScript type over the emitted types, written as T.TypeName
   (only names that exist in TYPES), e.g.
     { policy: T.PostGryQueryPolicyByNumberResponse; policyNo: string }
   Pass the whole API response rather than picking fields out of it, plus
   anything the user typed that a later screen shows. Every screen that
   navigates here must be able to build exactly this value. Keep it on one line.

4. Base every data path on the REAL response examples where they exist — they
   are the truth; the prose may be wrong. Write the exact path in the brief,
   e.g. "Policy Number = state.policy.policyInfo.policyBasicInfo.policyNumber".

5. The brief is what the screen writer gets, so leave nothing to guess:
   - every field shown: its label and its exact data path
   - every input: label, type, required, validation, which request field it fills
   - every button: which API it calls and with what body (built from what),
     what happens on success and on failure, where it navigates and what it passes
   - loading, empty and error states worth mentioning
   - when a button is enabled or disabled

6. Routes are unique and the first screen is "/". Use a route parameter only when
   the value is available to every screen that navigates there.

7. Theme: soft and light — a blue or violet accent suits most apps.`

export function designUser(
  appSpec: AppSpec,
  documents: SpecDocument[],
  typesSource: string,
  sampleData: boolean,
): string {
  return `APP
${appSpec.appName}${appSpec.description ? ` — ${appSpec.description}` : ''}

${dataRule(sampleData)}

API — the only functions the app can call
${endpointsBlock(appSpec.endpoints)}

TYPES — src/lib/types.ts, referenced in "receives" as T.Name
${clip(typesSource, 40_000)}

DOCUMENTS
${documentsBlock(documents)}`
}

/* ------------------------------------------------------------------ */
/* 3. Build                                                            */
/* ------------------------------------------------------------------ */

const CARRY_START = 'CARRYING DATA BETWEEN SCREENS'
const CARRY_END = 'SHOW WHAT CAME BACK'

/*
 * The classic system prompt's styling and quality guidance, kept word for word
 * so screens look exactly as they do today, with its section on passing data
 * replaced: here that is done through typed helpers the design defined.
 */
const FLOW_SECTION = `MOVING BETWEEN SCREENS

This app's navigation is generated in '../lib/flow', typed from the design:

    import { useGoToPolicySearchResult, useLandingState } from '../lib/flow'

    const goToResult = useGoToPolicySearchResult()   // a hook: call it at the top
    goToResult({ policy: result, policyNo })          // exactly the declared state type

    const state = useLandingState()                   // what this screen receives
    if (!state) return <EmptyState … />               // opened directly, e.g. a refresh

Always navigate with the go-to helpers and read incoming state with this
screen's state hook. Never call navigate() with state yourself, never cast
location.state. The compiler checks both ends against the same type.

Route parameters come from useParams, and the name must match the route.

Mutations: disable the button while in flight, show a toast on success and on
failure. Destructive actions go behind <ConfirmDialog>.

`

function buildSystem(): string {
  const start = CODEGEN_SYSTEM.indexOf(CARRY_START)
  const end = CODEGEN_SYSTEM.indexOf(CARRY_END)
  if (start < 0 || end < start) {
    throw new Error('CODEGEN_SYSTEM no longer has the sections the AI builder replaces')
  }
  return CODEGEN_SYSTEM.slice(0, start) + FLOW_SECTION + CODEGEN_SYSTEM.slice(end)
}

export const BUILD_SYSTEM = buildSystem()

export interface BuildContext {
  appSpec: AppSpec
  documents: SpecDocument[]
  screens: ScreenPlan[]
  designNotes: string[]
  typesSource: string
  flowSource: string
  sampleData: boolean
}

export function buildUser(screen: ScreenPlan, ctx: BuildContext, componentName: string): string {
  const app = ctx.screens
    .map((s) => `  ${s.name}  ${s.route}  — ${s.purpose}${s === screen ? '   ← THIS SCREEN' : ''}`)
    .join('\n')

  const calls = screen.endpointIds.length > 0 ? screen.endpointIds.join(', ') : '(none of its own)'

  return `Write src/screens/${componentName}.tsx, default-exporting ${componentName}.

THE APP
${app}
${ctx.designNotes.length ? `\nDesign notes:\n${ctx.designNotes.map((n) => `  - ${n}`).join('\n')}\n` : ''}
THIS SCREEN
  name:    ${screen.name}
  route:   ${screen.route}
  type:    ${screen.type}
  purpose: ${screen.purpose}
${screen.step ? `  eyebrow: give <PageHeader> eyebrow="Step ${String(screen.step.index).padStart(2, '0')} / ${String(screen.step.total).padStart(2, '0')}"\n` : ''}${screen.hero ? `  hero:    <Hero> as the first child of the first card — ${JSON.stringify(screen.hero)}\n` : ''}${screen.aside ? `  aside:   wrap in <SplitPage> with a <SummaryPanel> — ${JSON.stringify(screen.aside)}\n` : ''}  calls:   ${calls}
  receives: ${screen.receives || '(nothing)'}
  goes to: ${screen.navigatesTo?.length ? screen.navigatesTo.join(', ') : '(nowhere)'}

BRIEF — build exactly this
${screen.brief || screen.purpose}

${dataRule(ctx.sampleData)}

FLOW HELPERS — src/lib/flow.ts
${ctx.flowSource}

AVAILABLE API — import from '../lib/api'
${endpointsBlock(ctx.appSpec.endpoints.filter((e) => screen.endpointIds.includes(e.operationId)))}

TYPES — src/lib/types.ts, import what you use from '../lib/types'
${clip(ctx.typesSource, 40_000)}

COMPONENT KIT
${uiKitReference()}

DOCUMENTS — the source of truth for labels, wording and rules
${documentsBlock(ctx.documents)}`
}
