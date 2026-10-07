import { uiKitReference } from '../services/emit/uikit.js'
import { demoFieldKey } from '../services/emit/demo.js'
import { UNDOCUMENTED_RESPONSE, capturedFields, coveredSpec, fieldWidths, formTypeName } from '../services/emit/types.js'
import { collectionName, storableEntities } from '../services/emit/localStore.js'
import { builderName, senderName } from '../services/emit/flow.js'
import type { AppPlan, AppSpec, DocumentedField, Endpoint, FlowSpec, ScreenPlan } from '../types.js'

export const CODEGEN_SYSTEM = `You write one React screen component in TypeScript. You are given a generated API client and a fixed component kit, and you compose from them.

THE HARD RULES

1. Never write a URL. Never call fetch, axios, or XMLHttpRequest. The only way to
   reach the API is the functions imported from '../lib/api'. Those functions
   already contain the documented URLs, methods and headers.

2. Only call API functions listed in the AVAILABLE API section. Only use their
   exact signatures. Do not add, rename or reorder arguments.

3. Only use components listed in the COMPONENT KIT section, plus plain HTML
   elements, plus icons from 'lucide-react'.

4. Only read fields that the given types declare. If you want a field the type
   does not have, you may not have it — render what exists instead.

5. Output one file: a complete .tsx module with a default-exported component.
   No markdown fences, no commentary before or after the code.

6. Never invent data. Every date, amount, name, status and identifier on screen
   must come from an API response, from the local store, or from something the
   user typed. Writing a
   literal date such as new Date('2023-01-01'), or a hard-coded amount, to make
   a screen look finished is the worst thing you can do here — it produces a
   convincing screen that is entirely fictional. If you have no data for a
   region, render an empty state saying what is missing.

7. Import every component you use. A component referenced without an import
   throws at runtime and shows a blank page.

HOW TO WRITE IT

Data loading — use this shape, it handles the states the kit expects:

    const [data, setData] = useState<Order[]>()
    const [error, setError] = useState<unknown>()
    const [loading, setLoading] = useState(true)

    const load = useCallback(() => {
      setLoading(true)
      setError(undefined)
      listOrders()
        .then(setData)
        .catch(setError)
        .finally(() => setLoading(false))
    }, [])

    useEffect(() => { load() }, [load])

Pass loading / error / onRetry straight to <DataTable>. It renders the loading,
error and empty states itself — never write your own skeleton or error block
around it.

CARRYING DATA BETWEEN SCREENS

A screen with no endpoints of its own is displaying something the previous
screen fetched. Pass it through the router, never re-invent it.

When the screen's brief has a FLOW section, what the user typed is NOT in
router state at all: every screen shares one draft from '../lib/flow', and
router state carries only the API result, as { data }. Follow the FLOW section
and ignore everything below about "form".

Otherwise router state carries two things, and the keys are always "data" and "form":

    { data: <what the API returned>, form: <what the user typed> }

Both sides must agree or the receiver sees nothing. Name the variable you read
"data" into something else — "incoming" — because plenty of APIs wrap their
payload in a field that is ALSO called "data", and \`data.data.record\`
is a line nobody writes correctly by accident.

"form" exists because a form usually sends more than the API gives back. A
registration screen collects thirteen values and the response returns four; the
other nine are in no payload anywhere, and the next screen is still specified to
display them. Forward them or that screen cannot be built.

Sending screen, after its call succeeds:
    const result = await searchRecords(reference)
    navigate('/results', { state: { data: result, form: values } })

Receiving screen:
    const location = useLocation()
    const state = location.state as { data?: SearchRecordsResponse; form?: SearchForm } | null
    const incoming = state?.data
    const carried = state?.form

    if (!incoming) {
      return (
        <EmptyState
          title="Nothing selected"
          description="Search for a record first."
          action={{ label: 'Back to search', onClick: () => navigate('/') }}
        />
      )
    }

Landing on that screen directly, with nothing in state, is normal — a refresh
does it. Render the empty state. Do NOT substitute example values to fill the
layout: a screen showing "John Doe" and "123456789" looks finished and is a lie.

Route parameters come from useParams, and the name must match the route:
    const { orderId } = useParams<{ orderId: string }>()
Guard against it being undefined before calling an API function with it.

Navigating TO a route that has a parameter means filling it in. Writing the
parameter name into the URL sends the next screen the literal string ":orderId",
which it then asks the API for — the screen compiles, the navigation appears to
work, and the page is empty.

    navigate('/orders/:orderId')            // wrong: navigates to ":orderId"
    navigate(\`/orders/\${order.id}\`)         // right

The value comes from the record you are acting on: the row that was clicked, or
what this screen loaded. If you have no value for it, do not navigate there.

Navigation uses useNavigate() from 'react-router-dom'.

Mutations: disable the button while in flight, show a toast on success and on
failure, then re-load the affected data. Destructive actions go behind
<ConfirmDialog>.

SHOW WHAT CAME BACK

Never discard a response. A button that calls an API and renders nothing leaves
the user unable to tell what happened — the single most common way a generated
screen feels broken while working perfectly.

    const [quotation, setQuotation] = useState<QuotationResponse>()

    const onQuote = useCallback(async () => {
      setBusy(true)
      try {
        const result = await getQuotation(body)
        setQuotation(result)                       // keep it
        toast.push('Quotation ready', 'success')
      } catch (err) {
        toast.push('Quotation failed', 'error')
      } finally {
        setBusy(false)
      }
    }, [body, toast])

Then render it, below the form, using the fields the type declares:

    {quotation && (
      <Card>
        <CardHeader title="Refund summary" />
        <DetailList items={[
          { label: 'Total refund', value: quotation.totalRefundAmount },
          { label: 'GST', value: quotation.totalGstAmount },
        ]} />
      </Card>
    )}

If the response contains a list, render it with <DataTable>. If the screen
definition names a results area — "Refund Summary", "Transaction Result" — build
that area and fill it from the matching response.

The only responses you may ignore are those typed void.

HOW A SCREEN IS PUT TOGETHER

Every screen is a <PageHeader> and then one or more <Card>s on a tinted canvas.
Use the palette tokens — accent, accent-soft, accent-tint, accent-deep, line —
rather than slate-* for anything coloured, so the app reads as one design and not
as a grey admin panel with a single blue button.

    <div>
      <PageHeader eyebrow="Step 02 / 05" title="…" description="…" />
      <Card>
        <Hero eyebrow="…" headline="…" sub="…" />
        <CardBody>
          …
        </CardBody>
      </Card>
    </div>

<Hero> goes inside the card, as its first child, and only on a screen the HERO
section gives words for. It is decoration: never put a value in it.

When a SUMMARY PANEL section appears, wrap the screen in <SplitPage> and pass the
panel as its aside. Its rows come from real state and may be empty — an empty row
renders a dash, which is the whole point of it:

    <SplitPage
      aside={
        <SummaryPanel
          title="Your cover at a glance"
          items={[
            { label: 'Sum assured', value: values.sumAssured },
            { label: 'Currency', value: values.currency },
          ]}
        />
      }
    >
      … the cards …
    </SplitPage>

FORMS

Controlled inputs — in the shared draft when the brief has a FLOW section,
otherwise in useState — each wrapped in <Field>, and every group of <Field>s
inside a <FormGrid>. Mark required fields required. Only include fields the
specification lists — or, where it lists none, those the request body type
declares.

    <FormGrid>
      <Field label="Coverage type" span="half" required>…</Field>
      <Field label="Sum assured" span="third">…</Field>
    </FormGrid>

The grid is six columns wide, so a row holds two halves, three thirds, or a mix
of spans. Give each field the span the FIELDS list gives it — that was worked out
from the field's own type and label, and one field per row on a laptop is the
difference between a form that looks designed and one that looks generated.
<FormGrid> owns the spacing, so do not add gap-* or space-y-* inside it.

Put the buttons that close a form or a card in <Actions>, which provides the
separation above them; a <Button> emitted straight after the last input sits hard
against it and reads as part of it.

Use <Note> for a caveat, a reassurance, or a line about what happens next — never
a plain grey div.

    <Actions>
      <Button onClick={onSearch} loading={busy}>Search</Button>
      <Button variant="outline" onClick={onNext}>Next</Button>
    </Actions>

QUALITY

Every screen opens with <PageHeader>. Give it a title, a one-line description
saying what the screen is for, and the eyebrow the SCREEN block supplies.

Read nested data down to its leaves. The TYPES section gives you the whole tree,
so when a response is Result { policy: Policy } and Policy { info: Info } and
Info { number: string }, render result.policy.info.number — not the object. Use
<Value> only for a field genuinely typed unknown; passing it a whole object
produces a JSON dump where labelled fields were asked for.

When the screen definition lists fields by label, find each one in the type tree
and render it under that label, in that order.

Carry the optional chain the whole way down. \`a?.b.c\` only guards \`a\`: the
moment the server omits \`b\` it throws at runtime, which is how a screen that
compiles still shows a red box. Write \`a?.b?.c\`.

A value that may be missing cannot be formatted directly — \`amount.toLocaleString()\`
throws on undefined. Guard first, and show a dash rather than a zero, because a
missing amount and an amount of nought are not the same fact:

    { label: 'Total refund', value: r?.result?.total?.toLocaleString() ?? '—' }

Render dates as \`new Date(value).toLocaleString()\`, guarded for undefined.
Render money and counts with tabular-nums. Use <StatusBadge> for status fields.
Use <Value> for anything whose type is unknown.

Make it look considered: sensible column widths, right-aligned numbers, truncation
on long text, a real empty state with a next action where one exists.

Do not add comments explaining what a line does. Add a comment only where the
reason for something is not obvious from reading it.`

/**
 * A route written the way the model must actually call it.
 *
 * Handing over `/projects/:projectId/updates` verbatim is an instruction to
 * navigate to a literal ":projectId" — React Router matches the pattern, the
 * receiving screen reads ":projectId" as its route parameter, asks the API for
 * a record by that name and shows nothing. The screen compiles, the navigation
 * "works", and the page is empty, which is the hardest kind of wrong to find.
 *
 * So a parameterised route is handed over as a template literal with the
 * parameter left as an expression to fill, rather than as a string to copy.
 */
function navTarget(route: string): string {
  const filled = route.replace(/[:{]([A-Za-z0-9_]+)\}?/g, (_match, name: string) => '${' + name + '}')
  return filled === route ? "'" + route + "'" : '`' + filled + '`'
}

/** The parameters a route needs a value for, in order. */
function routeParams(route: string): string[] {
  return [...route.matchAll(/[:{]([A-Za-z0-9_]+)\}?/g)].map((m) => m[1]!)
}

/** A reminder of where a route parameter's value has to come from. */
function fillNote(route: string): string {
  const names = routeParams(route)
  if (names.length === 0) return ''
  return (
    `\n      ${names.join(' and ')} must be filled from the record you are acting on — ` +
    'the row that was clicked, or what this screen loaded. Never put the parameter ' +
    'name in the URL.'
  )
}

/** Endpoint signature exactly as emitted, so the model cannot drift from it. */
function signatureFor(endpoint: Endpoint): string {
  const args: string[] = []

  const names = [...endpoint.path.matchAll(/\{([^}]+)\}|:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? m[2]!)
  for (const name of names) {
    const param = endpoint.pathParams.find((p) => p.name === name)
    args.push(`${name}: ${param?.enum?.length ? param.enum.map((v) => `'${v}'`).join(' | ') : (param?.type ?? 'string')}`)
  }
  if (endpoint.requestBody) args.push(`body: ${endpoint.requestBody.typeName ?? 'unknown'}`)
  if (endpoint.queryParams.length > 0) {
    const required = endpoint.queryParams.some((p) => p.required)
    const fields = endpoint.queryParams
      .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.enum?.length ? p.enum.map((v) => `'${v}'`).join(' | ') : p.type}`)
      .join('; ')
    args.push(`query${required ? '' : '?'}: { ${fields} }`)
  }
  args.push('options?: RequestOptions')

  const success = endpoint.responses.find((r) => /^2\d\d$/.test(r.status))
  const returns = success?.status === '204' ? 'void' : (success?.typeName ?? 'unknown')

  const doc = endpoint.summary ? `  // ${endpoint.summary}\n` : ''
  return `${doc}  ${endpoint.operationId}(${args.join(', ')}): Promise<${returns}>`
}

/** A sender as the flow module emits it: the client function minus its body. */
function senderSignatureFor(endpoint: Endpoint): string {
  const args: string[] = []
  const names = [...endpoint.path.matchAll(/\{([^}]+)\}|:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? m[2]!)
  for (const name of names) args.push(`${name}: ${endpoint.pathParams.find((p) => p.name === name)?.type ?? 'string'}`)
  if (endpoint.queryParams.length > 0) {
    const required = endpoint.queryParams.some((p) => p.required)
    args.push(`query${required ? '' : '?'}: { ${endpoint.queryParams.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join('; ')} }`)
  }
  args.push('options?: RequestOptions')

  const success = endpoint.responses.find((r) => /^2\d\d$/.test(r.status))
  const returns = success?.status === '204' ? 'void' : (success?.typeName ?? 'unknown')
  const doc = endpoint.summary ? `  // ${endpoint.summary}\n` : ''
  return `${doc}  ${senderName(endpoint.operationId)}(${args.join(', ')}): Promise<${returns}>\n  ${builderName(endpoint.operationId)}(): the body it will send — for a screen that shows it before sending`
}

/**
 * What a screen is told about the flow's shared draft.
 *
 * Exact keys, which of them have real codes, and — on the screen that sends —
 * every value the request needs from every step, so it can say which step to
 * go back to instead of sending a half-empty body.
 */
function flowSection(
  flow: FlowSpec,
  ownFields: DocumentedField[],
  bound: Endpoint[],
  appSpec: AppSpec,
  plan: AppPlan,
  screen: ScreenPlan,
): string {
  const labelOf = new Map(flow.fields.map((f) => [f.key, f.label]))
  const describe = (fieldKey: string) => {
    const options = flow.options[fieldKey]
    if (options?.length) return `dropdown — fieldOptions.${fieldKey} (${options.length} code${options.length === 1 ? '' : 's'})`
    const hint = flow.hints[fieldKey]
    return hint !== undefined ? `input — placeholder={fieldHints.${fieldKey}}` : 'input'
  }

  const own = ownFields
    .map((f) => {
      const fieldKey = demoFieldKey(f.label)
      return `      ${fieldKey}   // ${f.label}${f.required ? ', required' : ''} — ${describe(fieldKey)}`
    })
    .join('\n')

  const all = flow.fields.map((f) => `      form.${f.key}   // ${f.label}`).join('\n')

  // Which screen collects each required value, for the sender's own check.
  const requiredBy: { key: string; label: string; screen: string; route: string }[] = []
  for (const screen of plan.screens) {
    const spec = coveredSpec(screen, appSpec.documentedScreens)
    for (const field of spec ? capturedFields(spec) : []) {
      const fieldKey = demoFieldKey(field.label)
      if (field.required && !requiredBy.some((r) => r.key === fieldKey)) {
        requiredBy.push({ key: fieldKey, label: field.label, screen: screen.name, route: screen.route })
      }
    }
  }

  /*
   * Where a successful send goes, decided here rather than left as "<next
   * route>": told nothing, a last step sent the user back to step three.
   */
  const receiver = plan.screens.find((s) => s.incomingFrom === screen.name && s.incomingType)
  const index = plan.screens.findIndex((s) => s.id === screen.id)
  const later = plan.screens.slice(index + 1).find((s) => s.endpointIds.length === 0 || s.incomingType)
  const afterSend = receiver
    ? `navigate(${navTarget(receiver.route)}, { state: { data: result } })`
    : later
      ? `navigate(${navTarget(later.route)}, { state: { data: result } })`
      : null

  const sending = bound.length
    ? `
  SENDING. Call the sender — it builds the whole body from the draft:

      const [error, setError] = useState<unknown>()
      const [busy, setBusy] = useState(false)
      ...
      setBusy(true)
      setError(undefined)
      try {
        const result = await ${senderName(bound[0]!.operationId)}()
        ${afterSend ?? 'setResult(result)'}
      } catch (err) {
        setError(err)
        toast.push(err instanceof Error ? err.message : 'The request failed', 'error')
      } finally {
        setBusy(false)
      }

${
  afterSend
    ? ''
    : `  No screen follows this one, so the result is shown HERE: keep it in state
  (const [result, setResult] = useState<...>()), and once it is set, replace the
  form with a confirmation card that renders the response's key fields — a
  policy or reference number first. Never navigate back to an earlier step.

`
}  Render <FormError error={error} /> directly under the <Actions> holding the
  button. It shows the API's own reason for refusing — never replace it with a
  sentence of your own like "Please check your details".
${
  requiredBy.length
    ? `
  Before sending, check every value the flow requires, from EVERY step — not only
  this screen's. If any are empty, do not send: set an error naming them and the
  step they are on, so the user knows where to go back to:

${requiredBy.map((r) => `      form.${r.key}   // ${r.label} — on ${r.screen} (${r.route})`).join('\n')}
`
    : ''
}`
    : ''

  return `
FLOW — import { useDraft, fieldOptions, fieldHints${bound.length ? ', ...' : ''} } from '../lib/flow'

  Every screen shares ONE draft of what the user has entered. A value typed on
  an earlier step is already in it; nothing is passed through router state.

      const { form, setField } = useDraft()
${
  own
    ? `
  This screen collects these keys, exactly:
${own}

  Inputs write straight to the draft:

      <Input value={form.firstName ?? ''} onChange={(e) => setField('firstName', e.target.value)} />

  A dropdown renders the codes the API accepts — they come only from the
  documents, so never write an option list of your own:

      <Select value={form.gender ?? ''} onChange={(e) => setField('gender', e.target.value)}>
        <option value="">Select…</option>
        {fieldOptions.gender?.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </Select>

  A field marked "input" has no documented codes: an <Input>, never a <Select>.
  Dates are <Input type="date" />; amounts and counts <Input inputMode="decimal" />.
  Formats the API wants are applied when the request is built — keep what the
  user typed as they typed it.
`
    : ''
}
  Everything the flow holds — read any of it on any screen, e.g. a review step
  or a summary panel. For a dropdown value show its label, not its code:
  fieldOptions.gender?.find((o) => o.value === form.gender)?.label ?? form.gender

${all}

  Moving on: navigate('<route>'), or navigate('<route>', { state: { data: result } })
  when a later screen reads what a call returned. Never put form values in state.
${sending}`
}

export function codegenUser(
  screen: ScreenPlan,
  appSpec: AppSpec,
  plan: AppPlan,
  componentName: string,
): string {
  const byId = new Map(appSpec.endpoints.map((e) => [e.operationId, e]))
  const used = [...new Set([...screen.endpointIds, ...screen.sections.flatMap((s) => s.endpointIds)])]
    .map((id) => byId.get(id))
    .filter((e): e is Endpoint => Boolean(e))

  const isBound = (endpoint: Endpoint) =>
    Boolean(plan.flow?.requests.some((r) => r.operationId === endpoint.operationId))
  const signatures = used.filter((e) => !isBound(e)).map(signatureFor).join('\n')
  const senderSignatures = used.filter(isBound).map(senderSignatureFor).join('\n')

  // Only the types this screen can actually touch, so the prompt stays small.
  const relevantTypeNames = new Set<string>()
  for (const endpoint of used) {
    for (const name of [endpoint.requestBody?.typeName, ...endpoint.responses.map((r) => r.typeName)]) {
      const base = (name ?? '').replace(/\[\]$/, '').trim()
      if (base) relevantTypeNames.add(base)
    }
  }
  /*
   * Follow references all the way down, not one level.
   *
   * With only the top level, a screen given `Policy { policyInfo: PolicyInfo }`
   * has no idea what PolicyInfo contains, so it renders the whole object as a
   * JSON blob instead of the labelled fields the design asked for. Real payloads
   * nest four or five deep.
   */
  // A display-only screen must know the exact type it is handed.
  if (screen.incomingType) {
    const base = screen.incomingType.replace(/\[\]$/, '').trim()
    if (base) relevantTypeNames.add(base)
  }

  const byName = new Map(appSpec.entities.map((e) => [e.name, e]))
  const queue = [...relevantTypeNames]
  while (queue.length > 0) {
    const entity = byName.get(queue.pop()!)
    if (!entity) continue
    for (const field of entity.fields) {
      // A field type may be `Thing`, `Thing[]`, or a union of either.
      for (const part of field.type.split(/[|&]/)) {
        const base = part.replace(/\[\]/g, '').trim()
        if (base && byName.has(base) && !relevantTypeNames.has(base)) {
          relevantTypeNames.add(base)
          queue.push(base)
        }
      }
    }
  }

  const types = appSpec.entities
    .filter((e) => relevantTypeNames.has(e.name))
    .map(
      (e) =>
        `interface ${e.name} {\n${e.fields
          .map((f) => `  ${f.name}${f.required ? '' : '?'}: ${f.type}`)
          .join('\n')}\n}`,
    )
    .join('\n\n')

  /*
   * The form interfaces this screen touches.
   *
   * They are emitted next to the entities but derived from the documented
   * screens rather than from any API, so they are assembled here the same way —
   * the model has to see the exact keys or it invents camel-cased guesses that
   * do not compile.
   */
  const formInterface = (typeName: string | undefined): string => {
    if (!typeName) return ''
    // Resolved through the PLAN: a form type is named after the planned screen
    // that captures it, which may cover several documented ones.
    const ownerScreen = plan.screens.find((s) => formTypeName(s.name) === typeName)
    const owner = ownerScreen ? coveredSpec(ownerScreen, appSpec.documentedScreens) : undefined
    if (!owner) return ''
    const members = capturedFields(owner)
      .map((f) => `  ${demoFieldKey(f.label)}?: string   // ${f.label}`)
      .join('\n')
    return `interface ${typeName} {\n${members}\n}`
  }

  const formTypes = [formInterface(screen.formType), formInterface(screen.incomingFormType)]
    .filter((block, index, all) => block && all.indexOf(block) === index)
    .join('\n\n')

  /*
   * Which of this screen's documented fields the API can actually supply, and
   * which only the user's own earlier typing can.
   *
   * Told nothing, the model assumes the response holds every field the
   * specification lists and writes `incoming.notificationChannel` against a
   * response declaring only a case number — eleven compile errors from one
   * wrong assumption.
   */
  /*
   * Every readable path on the incoming payload, spelled out.
   *
   * The TYPES section gives the model a tree and leaves it to navigate — and it
   * navigates wrong in a specific, repeating way: `incoming.claimCaseBasic` when
   * the response is `{ result, data: { claimCaseBasic } }`, `incoming.caseId`
   * when caseId lives two levels down. Every one of those is a compile error
   * that survives both repair rounds. Handing over the finished paths turns
   * navigation into copying, which it does not get wrong.
   */
  function accessPaths(rootType: string, rootVar: string): string[] {
    const out: string[] = []

    const walk = (typeName: string, prefix: string, depth: number, seen: Set<string>) => {
      if (depth > 4 || out.length >= 70) return
      const entity = byName.get(typeName)
      if (!entity || seen.has(typeName)) return
      const nextSeen = new Set(seen).add(typeName)

      for (const field of entity.fields) {
        if (out.length >= 70) return
        const isArray = /\[\]$/.test(field.type)
        const base = field.type.replace(/\[\]$/, '').trim()
        const access = `${prefix}?.${field.name}`

        if (byName.has(base)) {
          if (isArray) {
            out.push(`${access}   // ${base}[] — a list, map over it`)
            walk(base, `${access}?.[0]`, depth + 1, nextSeen)
          } else {
            walk(base, access, depth + 1, nextSeen)
          }
        } else {
          out.push(`${access}   // ${field.type}`)
        }
      }
    }

    walk(rootType.replace(/\[\]$/, '').trim(), rootVar, 0, new Set())
    return out
  }

  const incomingPaths = screen.incomingType ? accessPaths(screen.incomingType, 'incoming') : []

  const spec = coveredSpec(screen, appSpec.documentedScreens)

  const entityFieldNames = new Set<string>()
  for (const name of relevantTypeNames) {
    for (const field of byName.get(name)?.fields ?? []) entityFieldNames.add(field.name.toLowerCase())
  }

  const carriedOwnerScreen = plan.screens.find((s) => formTypeName(s.name) === screen.incomingFormType)
  const carriedOwner = carriedOwnerScreen
    ? coveredSpec(carriedOwnerScreen, appSpec.documentedScreens)
    : undefined
  const carriedKeys = new Set(
    carriedOwner ? capturedFields(carriedOwner).map((f) => demoFieldKey(f.label)) : [],
  )

  // Documented on this screen, absent from every response type it can see, and
  // captured earlier — those are exactly the ones that must come from `form`.
  const fromForm = (spec?.fields ?? []).filter((field) => {
    const fieldKey = demoFieldKey(field.label)
    return !entityFieldNames.has(fieldKey.toLowerCase()) && carriedKeys.has(fieldKey)
  })

  const ownKeys = spec ? capturedFields(spec) : []

  const flow = plan.flow
  const boundHere = flow
    ? used.filter((e) => flow.requests.some((r) => r.operationId === e.operationId))
    : []

  /*
   * The shared draft and the senders, when the app has a flow module.
   *
   * Replaces the router-state "form" hand-off entirely: that passed each
   * screen's own values one step on, so a five-step flow arrived at Submit
   * with one step's data, and the body was then written by hand around it.
   */
  const flowBlock = flow ? flowSection(flow, ownKeys, boundHere, appSpec, plan, screen) : ''

  const formBlock = flow
    ? flowBlock
    : screen.incomingFormType || screen.formType
      ? `
FORM VALUES

${
  screen.incomingFormType
    ? `  Values the user entered earlier in this flow arrive beside the response.
  They are in NO API response — this is the only place they exist:

      const state = location.state as { data?: ${screen.incomingType ?? 'unknown'}; form?: ${screen.incomingFormType} } | null
      const incoming = state?.data
      const carried = state?.form
${
  fromForm.length
    ? `
  These documented fields come from \`carried\`, not from the response:
${fromForm.map((f) => `      carried?.${demoFieldKey(f.label)}   // ${f.label}`).join('\n')}
`
    : ''
}
  Every member is an optional string. Show a dash when one is absent; do not
  substitute a plausible value.
`
    : ''
}${
  screen.formType
    ? `  This screen captures its own values. Hold them in one state object typed
  ${screen.formType} rather than a variable per input:

      const [values, setValues] = useState<${screen.formType}>({})

  Keys, exactly these:
${ownKeys.map((f) => `      ${demoFieldKey(f.label)}   // ${f.label}`).join('\n')}
`
    : ''
}
  Pass them on with EVERY navigation out of this screen, or the next screen
  loses them and cannot show what it is specified to show:

      navigate('<route>', { state: { data: result, form: ${
        screen.incomingFormType ? 'carried' : 'values'
      } } })
`
      : ''

  const sections = screen.sections
    .map(
      (s) =>
        `- ${s.title} (${s.kind})${s.description ? `: ${s.description}` : ''}${
          s.endpointIds.length ? `\n    uses: ${s.endpointIds.join(', ')}` : ''
        }`,
    )
    .join('\n')

  const otherRoutes = plan.screens
    .filter((s) => s.id !== screen.id)
    .map((s) => `  ${s.route}  — ${s.name}`)
    .join('\n')

  const notes = plan.designNotes.length ? plan.designNotes.map((n) => `- ${n}`).join('\n') : ''

  // The exact keys the emitted sample record carries. Without these the model
  // guesses a name like `policyNumber` where the emitter wrote `policyNo`.
  const demoKeys = (spec?.fields ?? [])
      .map((f) => `      ${demoFieldKey(f.label)}    // ${f.label}`)
      .join('\n') || '      note'

  /*
   * The store, for an application documented without an API.
   *
   * Given sample data these screens compile and do nothing — a form that saves
   * nowhere, a list that never changes. The store makes the same screens real,
   * so it is described here in the same detail the API gets: exact hook names,
   * exact fields, and the one rule that keeps it honest.
   */
  const storeBlock = screen.local
    ? `
LOCAL DATA — import { ... } from '../lib/store'

  Your documents describe this application's data but no API, so records live in
  the browser. This is real storage: what a screen creates, other screens see,
  and a refresh keeps.

${storableEntities(appSpec)
  .map((entity) => {
    const name = collectionName(entity.name)
    const hook = `use${name[0]!.toUpperCase()}${name.slice(1)}`
    const fields = entity.fields.map((f) => `        ${f.name}: ${f.type}`).join('\n')
    return `  ${hook}()  ->  { items, create, update, remove, byId }\n      items: ${entity.name}[]\n${fields}`
  })
  .join('\n\n')}

  Use it like any hook, at the top of the component:

      const projects = useProjects()
      projects.items                          // every record
      projects.create({ name, owner })        // returns the new record, with its id
      projects.update(id, { status })
      projects.remove(id)
      projects.byId(routeParamId)

  \`create\` assigns the id — never invent one, and never pass it in.

  Records related to another hold its id as a plain field, so a child list is
  filtered, not nested: \`updates.items.filter((u) => u.projectId === project.id)\`.

  Rule 6 still stands. Render what the store holds and nothing else — an empty
  store means an empty state inviting the first record, never a screen filled
  with plausible examples. A brand new install shows nothing, and that is right.

  \`persistence\` says whether records will outlive a refresh. Some contexts —
  a sandboxed preview, a private window, blocked site data — allow no storage,
  and there the application still works but only for the session. On the
  landing screen, and nowhere else, say so when it does not:

      import { persistence, useProjects } from '../lib/store'
      ...
      {!persistence.available && (
        <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-[13px] text-amber-800 ring-1 ring-amber-200">
          This browser is not allowing local storage, so anything you add here
          lasts until you reload.
        </div>
      )}
`
    : ''

  // Sample data, used only when nothing real can feed this screen.
  const demoBlock = screen.demo
    ? `
SAMPLE DATA — no endpoint is documented for this screen

  Nothing feeds this screen, so render the sample record and say so plainly:

      import { ${screen.demo.constName} } from '../lib/demo'
      import { DemoNotice } from '../components/DemoNotice'

      export default function ${componentName}() {
        return (
          <div>
            <PageHeader title="..." description="..." />
            <DemoNotice />
            ... render the fields of ${screen.demo.constName} ...
          </div>
        )
      }

  <DemoNotice /> is required and must sit above the data. A screen showing
  invented values without saying so is indistinguishable from working software,
  which is the one outcome worth avoiding entirely.

  ${screen.demo.constName} has exactly these keys — there are no others:
${demoKeys}

  Reading any other key will not compile. Do not add records, do not call any
  API, and do not read router state.

  Buttons the specification says call an API must still work, using the sample
  record in place of a response: on click, set it into state and reveal the
  result area, or navigate onward carrying it as { state: { data: record } }. A dead
  button is a worse demonstration than a sample one.

  A demo action ALWAYS succeeds. There is nothing real to look anything up in,
  so never compare what the user typed against the sample values and never
  report "not found" — a search that rejects every input is not a demonstration
  of anything. Accept whatever is entered, copy it into the matching field of
  the sample record, and continue:

      const onSearch = () => {
        const record = { ...${screen.demo.constName}, policyNo: policyNumber }
        navigate('/next-screen', { state: { data: record } })
      }

  Only validate that required fields are non-empty. That is the one failure a
  demo may legitimately show.
`
    : ''

  // API-only project, and nothing can feed this screen.
  const unsourcedBlock = screen.unsourced
    ? `
NO API — this project is API-only and nothing supplies this screen

  Build the layout the specification describes — headings, sections, labels,
  form fields and buttons — but never show a value. Where data would appear,
  render an <EmptyState> titled "No API connected" whose description says the
  documents give no API for this screen. Do not invent records, do not import
  from '../lib/demo', do not render <DemoNotice />, and do not call any API.
  Inputs may still be typed into, and navigation buttons still navigate; a
  button meant to call an API is shown disabled with a short note saying why.
`
    : ''

  /*
   * The screen as the documentation specified it.
   *
   * Sections are derived from buttons that call an API, so a navigation-only
   * button — "NEXT: go to the Free Look Entry screen" — reached nothing and was
   * simply missing from the built screen. The specification is the brief, so it
   * is passed through whole: every field, every button, endpoint or not.
   */
  const routeOf = (screenName?: string) =>
    plan.screens.find((s) => s.name.toLowerCase().trim() === screenName?.toLowerCase().trim())?.route

  const specification = spec
    ? `
AS SPECIFIED IN THE DOCUMENTATION — build exactly this
${
  spec.fields.length
    ? `  Fields, in this order:\n${spec.fields
        .map(
          (f) =>
            `    ${f.label}${f.type ? ` — ${f.type}` : ''}${f.required ? ' (mandatory)' : ''}` +
            `${f.readOnly ? ' (read only)' : ''}` +
            `${f.options?.length ? `\n        options: ${f.options.join(', ')}` : ''}` +
            `${f.notes ? `\n        ${f.notes}` : ''}`,
        )
        .join('\n')}`
    : '  Fields: none listed'
}
${
  spec.actions.length
    ? `  Buttons, all of which must be present:\n${spec.actions
        .map((a) => {
          /*
           * The button's own destination first.
           *
           * A screen offering Save / Next / Exit has one screen-level
           * `navigatesTo` between the three, so only one of them could ever be
           * wired and the others generated as dead controls — the "Missing NEXT
           * button" complaint. The screen-level value still applies, but only to
           * a button that calls nothing and states no destination of its own,
           * which is what an onward button looks like when the document was
           * terse.
           */
          const named = a.navigatesTo ?? (a.endpointIds.length === 0 ? spec.navigatesTo : undefined)
          const target = plan.screens.find(
            (s) => s.name.toLowerCase().trim() === named?.toLowerCase().trim(),
          )
          // Forward what this screen received, or the next one starts empty and
          // can never recover — it has no way to fetch the record itself.
          // The key stays "data"; the variable holding it is "incoming", so the
          // shorthand `{ data }` would forward nothing.
          const carry = target?.incomingType ? ', { state: { data: incoming } }' : ''
          const onward = target
            ? ` — navigates onward: navigate(${navTarget(target.route)}${carry})${fillNote(target.route)}`
            : ''
          const nav = a.endpointIds.length
            ? ` — calls ${a.endpointIds.join(', ')}${onward}`
            : onward || ' — navigation or local behaviour only, no API call'
          return `    ${a.label}: ${a.does}${nav}${a.enabledWhen ? `\n        enabled when: ${a.enabledWhen}` : ''}`
        })
        .join('\n')}`
    : '  Buttons: none listed'
}
${spec.validation.length ? `  Validation:\n${spec.validation.map((v) => `    ${v}`).join('\n')}` : ''}
${spec.navigatesTo && routeOf(spec.navigatesTo) ? `  Leads to: ${routeOf(spec.navigatesTo)} (${spec.navigatesTo})` : ''}
`
    : ''

  /*
   * A way forward, when the documentation drew one but never named a button.
   *
   * Buttons are only built when a document lists them, which is right for
   * anything that calls an API — inventing a call is dangerous. Navigation is
   * not that. A specification that draws "Search -> Details -> Confirm" has
   * stated the sequence; leaving the middle screen with nothing to press does
   * not protect anyone from an invention, it just produces a flow nobody can
   * walk. So when the plan puts a screen after this one and no documented
   * button goes there, the screen gets a plain onward control.
   */
  const index = plan.screens.findIndex((s) => s.id === screen.id)
  const next = index >= 0 ? plan.screens[index + 1] : undefined
  const alreadyLeads =
    Boolean(spec?.navigatesTo) || Boolean(spec?.actions.some((a) => a.navigatesTo))

  const onward =
    next && !alreadyLeads && !screen.demo
      ? `
A WAY FORWARD
  Nothing in the documentation names a button that leaves this screen, but
  ${next.name} comes after it. Add one primary control — label it "Next" unless
  the screen's own wording suggests better — that navigates there:

      navigate(${navTarget(next.route)}${
        plan.flow
          ? next.incomingType
            ? `, { state: { data: ${screen.endpointIds.length ? 'result' : 'incoming'} } }`
            : ''
          : next.incomingType || next.incomingFormType
            ? `, { state: { data: ${screen.endpointIds.length ? 'result' : 'incoming'}, form: ${
                screen.formType ? 'values' : 'carried'
              } } }`
            : ''
      })${fillNote(next.route)}

  Put it in <Actions> with the screen's other buttons. If this screen loads or
  submits something first, enable it only once that has succeeded — a control
  that moves on before there is anything to carry forward is worse than none.
`
      : ''

  // Screens waiting on this one to hand them their data. Both sides are told
  // the same key and the same type, so the handoff cannot be mismatched.
  const receivers = plan.screens.filter((s) => s.incomingFrom === screen.name && s.incomingType)
  const handOff = receivers.length
    ? `\nHANDS OFF TO\n${receivers
        .map(
          (r) =>
            `  Once your call succeeds, navigate to ${r.route} (${r.name}) carrying the result:\n` +
            `      navigate(${navTarget(r.route)}, { state: { data: result } })${fillNote(r.route)}\n` +
            `  It reads that as ${r.incomingType}, so pass the response through unchanged.`,
        )
        .join('\n')}\n`
    : ''

  /*
   * The band that opens the screen, and the running summary beside it.
   *
   * Both are handed over as exact strings rather than described, for the same
   * reason the access paths are: asked to write its own heading the model
   * reaches for the data to make it specific, and a headline naming a policy
   * number is invented content in the one region of a screen that nothing
   * validates.
   */
  const quoted = (value: string) => value.replace(/"/g, '&quot;')

  const heroBlock = screen.hero
    ? `
HERO — the tinted band that opens this screen

  Put it inside the screen's first <Card>, as the first child, before
  <CardBody>. Use these words exactly. Do not embellish them, and do not add a
  value, name, date or number to any of them:

      <Hero
${screen.hero.eyebrow ? `        eyebrow="${quoted(screen.hero.eyebrow)}"\n` : ''}        headline="${quoted(screen.hero.headline)}"
${screen.hero.sub ? `        sub="${quoted(screen.hero.sub)}"\n` : ''}      />
`
    : ''

  const summaryRows = ownKeys
    .slice(0, 8)
    .map((f) => `      { label: '${f.label.replace(/'/g, "\\'")}', value: ${plan.flow ? 'form' : 'values'}.${demoFieldKey(f.label)} },`)
    .join('\n')

  const asideBlock = screen.aside
    ? `
SUMMARY PANEL — this screen carries one

  Wrap the whole screen in <SplitPage> and pass a <SummaryPanel> as its aside,
  titled "${screen.aside.title}"${screen.aside.headline ? `, with the headline "${screen.aside.headline}"` : ''}.

  One row per value worth tracking${
    summaryRows ? `, taken from this screen's own state:\n${summaryRows}` : ' that this screen holds.'
  }

  Leave a row's value undefined while there is nothing yet — the panel renders a
  dash by itself, and that dash is what tells someone the step is unfinished.
  Never substitute a plausible value to fill a row.
`
    : ''

  return `Write the screen component "${componentName}" for the app "${appSpec.appName}".

SCREEN
  name:    ${screen.name}
  route:   ${screen.route}
  type:    ${screen.type}
  purpose: ${screen.purpose}
${screen.step ? `  eyebrow: give <PageHeader> eyebrow="Step ${String(screen.step.index).padStart(2, '0')} / ${String(screen.step.total).padStart(2, '0')}"\n` : ''}${screen.notes ? `  notes:   ${screen.notes}\n` : ''}${heroBlock}${asideBlock}
${storeBlock}${demoBlock}${unsourcedBlock}${specification}SECTIONS
${sections || '(none specified — design a sensible single section)'}
${
  screen.incomingType
    ? `
INCOMING DATA
  ${screen.incomingFrom} navigates here carrying its result in router state.
  ${
    screen.endpointIds.length > 0
      ? 'Use it to populate the fields the specification marks as carried over, and as input to the calls this screen makes.'
      : 'This screen makes no call of its own, so everything it shows comes from here.'
  }
${
  screen.incomingType === UNDOCUMENTED_RESPONSE
    ? `  The documents never show what that API returns, so there is no type for it.
  It is real data, not sample data — never render <DemoNotice /> for it and
  never invent values. Read it as:

      const location = useLocation()
      const incoming = (location.state as { data?: ${UNDOCUMENTED_RESPONSE} } | null)?.data

  The lookup is already written — import it, do NOT write your own:

      import { pick, fieldsOf } from '../lib/read'

  pick(incoming, 'Policy Number') finds the value at ANY depth (the real
  payload nests it, e.g. policyInfo.policyBasicInfo.policyNumber), ignores
  case, spaces and "_", treats "No"/"Number" as equal, and returns text ready
  to render ('—' when absent). Pass the specification's label for each field;
  add alternatives when a label is vague: pick(incoming, 'Currency', 'currencyCode').
  Values from the same lookup feed any summary panel too.

  Below the named fields, render the rest of the response ONCE, collapsed by
  default (a <details> element), from fieldsOf(incoming), which expands nested
  objects into rows { label, value }. Never String() an object and never walk
  the response yourself.
`
    : `  Read it as exactly this type — these are the only fields that exist:

      const location = useLocation()
      const incoming = (location.state as { data?: ${screen.incomingType} } | null)?.data

  The router's key is "data" and so is the variable it used to be read into,
  which is why a response that itself has a "data" field came out one level too
  shallow: \`incoming.record\` compiles against nothing, where the real
  path is \`incoming.data.record\`. Read the TYPES section and follow it
  field by field; if ${screen.incomingType} declares "data", you go through it.
`
}
  Declare EVERY hook before that guard. React runs hooks in the same order on
  every render, so a useState below an early return crashes with "Rendered more
  hooks than during the previous render":

      const location = useLocation()
      const navigate = useNavigate()
      const [value, setValue] = useState('')        // all hooks first
      const incoming = (location.state as { data?: T } | null)?.data

      if (!incoming) {                               // guard last
        return (
          <EmptyState
            title="Nothing to show yet"
            description="Start from the beginning of the flow."
            action={{ label: 'Go back', onClick: () => navigate(-1) }}
          />
        )
      }

  Use optional chaining for every nested step, because a real payload may omit
  an intermediate object: data.record?.owner?.address?.city
${
  incomingPaths.length
    ? `
  THESE ARE THE ONLY READABLE PATHS ON \`incoming\`. Copy them character for
  character. A field you remember from the documentation but cannot find in this
  list is not on this payload — render what is here, or leave that row out:

${incomingPaths.map((p) => `      ${p}`).join('\n')}
`
    : ''
}`
    : ''
}${formBlock}
AVAILABLE API — import { ... } from '../lib/api'
${signatures || (senderSignatures ? '(none directly — see below)' : '(this screen makes no API calls)')}
${
  senderSignatures
    ? `
REQUESTS BUILT FOR YOU — import { ... } from '../lib/flow'
${senderSignatures}

  Each one sends the documented request example with what the user entered in
  the draft laid over it, in the formats the API expects. Call it with no body.
  Never import the underlying function from '../lib/api', and never assemble a
  request object yourself — not even partly, not even "just the dates".
`
    : ''
}
TYPES — import type { ... } from '../lib/types'
${[types, formTypes].filter(Boolean).join('\n\n') || '(none)'}

COMPONENT KIT
${uiKitReference()}

OTHER ROUTES you may navigate to
${otherRoutes || '  (none)'}
${handOff}${onward}
${notes ? `\nDESIGN NOTES\n${notes}` : ''}

Return the complete contents of src/screens/${componentName}.tsx.`
}

/**
 * Refinement, as distinct from repair.
 *
 * Repair is told to change as little as possible, which is right when the
 * compiler has rejected something and wrong when someone asks for a wider table
 * or the amounts grouped together — under those instructions the model declines
 * to move anything and nothing happens. This one may restructure, under exactly
 * the same rules about where data comes from.
 */
export const REFINE_SYSTEM = `You revise one React screen to a person's instruction.

Return the complete revised file. No markdown fences, no explanation.

You may restructure freely — reorder fields, regroup them into cards or columns,
change a list into a table, adjust widths, spacing, emphasis and wording. That is
what you are here for.

What you may NOT change, whatever the instruction says:

1. No URLs. No fetch, axios or XMLHttpRequest. The only way to the API is the
   functions already imported from '../lib/api'.
2. Only the API functions this file already imports, with their exact
   signatures. Asked for data no endpoint provides, say so by leaving that area
   out — do not reach for a call that is not there.
3. Only components from the kit listed below, plus plain HTML and lucide-react
   icons. Import every one you use.
4. Only fields the given types declare. A field the type does not have is a
   field you do not have.
5. No invented data. Every value on screen comes from a response or from
   something the user typed. Filling a prettier layout with a plausible amount
   or date is the one outcome worth avoiding entirely — render an empty state
   instead.

If the instruction cannot be followed within those rules, do as much of it as
can be done and leave the rest alone. Returning the file unchanged is the right
answer when the instruction is about some other screen.`

export const REPAIR_SYSTEM = `You fix a TypeScript React file that failed to compile.

Return the complete corrected file. No markdown fences, no explanation.

Change as little as possible. Do not restructure working code, and do not
silence an error by deleting the feature that caused it. If an import does not
exist, replace it with something from the component kit that does. If a field is
missing from a type, render a field that exists instead.

The hard rules still apply: no URLs, no fetch, only the listed API functions and
components.`
