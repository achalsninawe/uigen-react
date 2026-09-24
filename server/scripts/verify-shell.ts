/**
 * Compiles the emitted shell and component kit, in both layouts.
 *
 * Everything under `src/components/ui/` and `src/components/Layout.tsx` is
 * written by code, so a mistake in it is our bug and it lands in every screen of
 * every generated app at once. `verify:emit-parses` covers the API layer and the
 * screen checks cover model output; between them sat the kit, which nothing
 * compiled until a real generation run did — by which point the run had already
 * spent its tokens.
 *
 * Two plans are checked, because the shell branches on them: a numbered journey
 * and a plain set of destinations.
 */
import { emitConfig } from '../src/services/emit/apiClient.js'
import { emitFoundation, screenComponentName, screenFilePath } from '../src/services/emit/index.js'
import { fieldWidths } from '../src/services/emit/types.js'
import { callableEndpoints } from '../src/services/pipeline/generate.js'
import { typeCheck } from '../src/services/pipeline/typecheck.js'
import type { AppPlan, AppSpec, DocumentedField, ScreenPlan } from '../src/types.js'

let failures = 0

function ok(label: string, detail?: string) {
  console.log(`  ok    ${label}`)
  if (detail) console.log(`          ${detail}`)
}

function bad(label: string, detail: string) {
  failures++
  console.log(`  FAIL  ${label}`)
  console.log(`          ${detail}`)
}

const appSpec: AppSpec = {
  appName: 'Protection Portal',
  description: 'Apply for cover, review the quotation, and pay the first premium.',
  entities: [
    {
      name: 'Quotation',
      fields: [
        { name: 'quotationNo', type: 'string', required: true },
        { name: 'premium', type: 'number', required: false },
      ],
    },
  ],
  endpoints: [
    {
      id: 'e1',
      operationId: 'createQuotation',
      name: 'Create quotation',
      method: 'POST',
      path: '/quotations',
      baseUrl: 'https://api.example.test',
      tags: [],
      auth: { type: 'none' },
      headers: [],
      pathParams: [],
      queryParams: [],
      responses: [{ status: '200', typeName: 'Quotation' }],
    },
  ],
  flows: [],
  gaps: [],
  documentedScreens: [],
  servers: ['https://api.example.test'],
}

const screen = (
  id: string,
  name: string,
  route: string,
  extra: Partial<ScreenPlan> = {},
): ScreenPlan => ({
  id,
  name,
  route,
  type: 'form',
  purpose: `Everything needed for ${name.toLowerCase()}`,
  icon: 'FileText',
  sections: [],
  endpointIds: [],
  showInNav: true,
  ...extra,
})

const theme = { accent: '#6C63FF', mood: 'calm', density: 'comfortable' } as AppPlan['theme']

const journey: AppPlan = {
  screens: [
    screen('a', 'Choose coverage', '/', {
      step: { index: 1, total: 4 },
      hero: {
        eyebrow: 'Life, with confidence',
        headline: 'Protection for the moments that matter',
        sub: 'Choose your cover, then complete your application step by step.',
      },
      aside: { title: 'Your cover at a glance', headline: 'Protection for your future' },
    }),
    screen('b', 'Personal details', '/details', { step: { index: 2, total: 4 } }),
    screen('c', 'Review', '/review/:quotationId', { step: { index: 3, total: 4 } }),
    screen('d', 'Result', '/result', { step: { index: 4, total: 4 } }),
  ],
  navigation: [],
  theme,
  designNotes: [],
}

const destinations: AppPlan = {
  screens: [
    screen('a', 'Quotations', '/'),
    screen('b', 'Settings', '/settings'),
    // Forced into the nav by repairPlan in the real pipeline; the shell must
    // still refuse to link it, because the link has no id to carry.
    screen('c', 'Quotation detail', '/quotations/:quotationId', { showInNav: true }),
  ],
  navigation: [],
  theme,
  designNotes: [],
}

/**
 * A screen exercising every kit component, standing in for model output.
 *
 * Written here rather than generated: the point is to prove the kit's own props
 * line up, and a model-written screen would confound a kit bug with a prompt bug.
 */
const EXERCISE = `import { useState } from 'react'
import {
  Actions,
  Button,
  Card,
  CardBody,
  CardHeader,
  DetailList,
  Field,
  FormGrid,
  Hero,
  Input,
  Note,
  PageHeader,
  Select,
  SplitPage,
  StatusBadge,
  SummaryPanel,
  Textarea,
} from '../components/ui'

export default function Exercise() {
  const [values, setValues] = useState<{ sumAssured?: string; currency?: string }>({})

  return (
    <SplitPage
      aside={
        <SummaryPanel
          title="Your cover at a glance"
          headline="Protection for your future"
          items={[
            { label: 'Sum assured', value: values.sumAssured },
            { label: 'Currency', value: values.currency },
            { label: 'Status', value: <StatusBadge status="Pending" /> },
          ]}
          footer="Coverage is subject to the issued policy terms."
        />
      }
    >
      <PageHeader eyebrow="Step 01 / 04" title="Start your application" description="Choose your coverage." />
      <Card>
        <Hero
          eyebrow="Life, with confidence"
          headline="Protection for the moments that matter"
          sub="Choose your cover, then complete your application step by step."
        />
        <CardHeader title="Build your coverage" subtitle="Enter the details below." />
        <CardBody>
          <FormGrid>
            <Field label="Coverage type" span="half" required>
              <Select value="" onChange={() => {}}>
                <option value="">Select</option>
              </Select>
            </Field>
            <Field label="Product name" span="full" hint="Chosen for you">
              <Input value="" readOnly />
            </Field>
            <Field label="Sum assured" span="third">
              <Input
                value={values.sumAssured ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, sumAssured: e.target.value }))}
              />
            </Field>
            <Field label="Currency" span="third" error="Required">
              <Input
                value={values.currency ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, currency: e.target.value }))}
              />
            </Field>
            <Field label="Term" span="third">
              <Input value="" onChange={() => {}} />
            </Field>
            <Field label="Notes" span="twoThirds">
              <Textarea value="" onChange={() => {}} />
            </Field>
          </FormGrid>

          <Note tone="accent">Entering an amount does not charge your account.</Note>

          <DetailList items={[{ label: 'Reference', value: '—' }]} />

          <Actions>
            <Button>Continue</Button>
          </Actions>
        </CardBody>
      </Card>
    </SplitPage>
  )
}
`

async function check(label: string, plan: AppPlan) {
  const files = emitFoundation(appSpec, plan, { projectId: 'verify-shell', transport: 'bridge' })

  // App.tsx routes to one file per planned screen. The first gets the screen
  // that exercises the kit; the rest are stubs, so a missing module cannot be
  // mistaken for a fault in what is being checked.
  plan.screens.forEach((s, i) => {
    const name = screenComponentName(s)
    files.push({
      path: screenFilePath(s),
      content:
        i === 0
          ? EXERCISE.replace('export default function Exercise()', `export default function ${name}()`)
          : `export default function ${name}() {\n  return null\n}\n`,
      origin: 'model',
    })
  })

  const layout = files.find((f) => f.path === 'src/components/Layout.tsx')?.content ?? ''
  const isJourney = layout.includes('Your progress')
  const wanted = plan.screens.some((s) => s.step)
  if (isJourney === wanted) {
    ok(`${label}: emits the ${wanted ? 'step rail' : 'destination nav'}`)
  } else {
    bad(`${label}: wrong layout`, `journey rail present=${isJourney}, expected=${wanted}`)
  }

  /*
   * A link to a route with a parameter would have to carry a record id, and
   * neither the rail nor the nav has one — it used to emit the literal
   * ":projectId", which React Router matches and hands to the screen as its id.
   */
  const parameterised = plan.screens.filter((s) => /[:{]/.test(s.route))
  if (parameterised.length > 0) {
    const linked = parameterised.filter((s) => layout.includes(`to: "${s.route}"`) && !layout.includes('linkable: false'))
    const navItem = parameterised.filter((s) => new RegExp(`\{ to: "${s.route.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}", label:[^}]*Icon:`).test(layout))
    if (linked.length === 0 && navItem.length === 0) {
      ok(`${label}: a parameterised route is never linked from the shell`, parameterised.map((s) => s.route).join(' · '))
    } else {
      bad(
        `${label}: a parameterised route is linked`,
        `${[...linked, ...navItem].map((s) => s.route).join(' · ')} — the link would carry a literal ":param"`,
      )
    }
  }

  const css = files.find((f) => f.path === 'src/index.css')?.content ?? ''
  const tokens = ['--color-accent-soft', '--color-accent-tint', '--color-accent-deep', '--color-canvas', '--color-line']
  const missing = tokens.filter((t) => !css.includes(t))
  if (missing.length === 0) ok(`${label}: every palette token is emitted`, tokens.join(' · '))
  else bad(`${label}: palette incomplete`, `missing ${missing.join(', ')}`)

  const result = await typeCheck(files, () => {})
  if (result.unavailable) {
    bad(`${label}: compiles`, `could not run the compiler — ${result.unavailable}`)
    return
  }
  if (result.ok) ok(`${label}: the emitted kit, shell and a screen using all of it compile`)
  else {
    bad(
      `${label}: compile errors`,
      result.errors.map((e) => `${e.file}:${e.line} ${e.code} ${e.message}`).join('\n          '),
    )
  }
}

function checkWidths() {
  const field = (label: string, type?: string, options?: string[]): DocumentedField => ({
    label,
    ...(type ? { type } : {}),
    ...(options ? { options } : {}),
  })

  const cases: { name: string; fields: DocumentedField[]; expect: string[] }[] = [
    {
      name: 'three short fields in a row become a three-up row',
      fields: [field('Coverage term (years)'), field('Premium payment term (years)'), field('Payment frequency', 'number')],
      expect: ['third', 'third', 'third'],
    },
    {
      name: 'a lone short field stays a half rather than leaving a gap',
      fields: [field('Coverage type'), field('Sum assured'), field('Select product')],
      expect: ['half', 'half', 'half'],
    },
    {
      name: 'long text takes the whole row',
      fields: [field('Correspondence address'), field('Remarks', 'textarea')],
      expect: ['full', 'full'],
    },
    {
      name: 'a dropdown of sentences takes the whole row',
      fields: [field('Reason', 'select', ['The policy was mis-sold at the point of purchase'])],
      expect: ['full'],
    },
  ]

  for (const c of cases) {
    const got = fieldWidths(c.fields)
    if (got.join(',') === c.expect.join(',')) ok(c.name, got.join(' · '))
    else bad(c.name, `got ${got.join(' · ')}, wanted ${c.expect.join(' · ')}`)
  }
}

/**
 * A document that describes operations and names no server.
 *
 * The host arrives later, from Connection settings, and until it was consulted
 * here every screen in such a project was generated with sample data — and
 * setting the host afterwards changed nothing, because the decision had already
 * been taken.
 */
function checkHostFromConnection() {
  const hostless: AppSpec = {
    ...appSpec,
    endpoints: appSpec.endpoints.map((e) => ({ ...e, baseUrl: '' })),
  }

  const withoutHost = callableEndpoints(hostless)
  if (withoutHost.size === 0) ok('no host anywhere: nothing is callable, so screens fall back to samples')
  else bad('no host anywhere', `expected nothing callable, got ${[...withoutHost].join(', ')}`)

  const withHost = callableEndpoints(hostless, 'https://api.example.test')
  if (withHost.size === hostless.endpoints.length) {
    ok('a host in Connection makes documented endpoints callable', [...withHost].join(', '))
  } else {
    bad(
      'a host in Connection makes documented endpoints callable',
      `expected ${hostless.endpoints.length}, got ${withHost.size} — screens would be generated as samples`,
    )
  }

  if (callableEndpoints(hostless, '   ').size === 0) ok('whitespace is not a host')
  else bad('whitespace is not a host', 'a blank override was treated as a real one')

  const config = emitConfig(hostless, {
    projectId: 'verify-shell',
    transport: 'direct',
    serverOrigin: 'http://localhost:5177',
    baseUrlOverride: 'https://api.example.test',
  })
  if (config.includes('baseUrlOverride: "https://api.example.test"')) {
    ok('the host reaches the emitted config, so an exported build can reach it too')
  } else {
    bad(
      'the host reaches the emitted config',
      config.split('\n').find((l) => l.includes('baseUrlOverride'))?.trim() ?? '(not found)',
    )
  }
}

async function main() {
  console.log('')
  checkWidths()
  checkHostFromConnection()
  await check('journey', journey)
  await check('destinations', destinations)

  console.log('')
  console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
