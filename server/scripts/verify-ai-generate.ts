/**
 * The AI builder, end to end.
 *
 * Offline checks always run: the typed flow helpers, the plan mapping and the
 * build prompt. With --live, the whole generator runs against Azure OpenAI on a
 * Freelook-shaped fixture whose QueryPolicy response is the real payload — the
 * one whose policyNumber sits two levels down and that the classic pipeline
 * rendered as dashes — and the app must compile and read those real paths.
 *
 *   npm run verify:ai-generate            offline only
 *   npm run verify:ai-generate -- --live  plus a real generation (costs tokens)
 */
import './local-env.js'
import { BUILD_SYSTEM } from '../src/prompts/aiBuild.js'
import { aiGenerate, checkUsesFlow, emitFlow, toPlan } from '../src/services/pipeline/aiGenerate.js'
import { applyObservedShape } from '../src/services/pipeline/probe.js'
import { aiAvailable } from '../src/services/azure.js'
import { designSchema } from '../src/schemas.js'
import type { AppSpec, Endpoint, SpecDocument } from '../src/types.js'

let failures = 0
const ok = (label: string, detail?: string) => {
  console.log(`  ok    ${label}`)
  if (detail) console.log(`          ${detail}`)
}
const bad = (label: string, detail: string) => {
  failures++
  console.log(`  FAIL  ${label}`)
  console.log(`          ${detail}`)
}
const check = (condition: boolean, label: string, detail = '') => (condition ? ok(label) : bad(label, detail))

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const BASE = 'https://portal.insuremo.com/api/platform/1.0/v1/flow'

function endpoint(operationId: string, path: string, requestType: string, summary: string): Endpoint {
  return {
    id: operationId,
    operationId,
    name: summary,
    method: 'POST',
    path,
    baseUrl: BASE,
    summary,
    tags: [],
    auth: { type: 'bearer' },
    headers: [],
    pathParams: [],
    queryParams: [],
    requestBody: { contentType: 'application/json', typeName: requestType },
    responses: [{ status: '200', contentType: 'application/json' }],
  }
}

/** The response the real API returned for policy 1057884147. */
const REAL_POLICY = {
  result: 1,
  policyInfo: {
    policyBasicInfo: {
      policyNumber: '1057884147',
      policyId: 1057884148,
      productCode: 'MRKT_TL_WAIVER',
      productVersion: '1.0',
      proposalNumber: '1057884147',
      inceptionDate: '2026-09-24T00:00:00',
      expiryDate: '2031-09-23T00:00:00',
      issueDate: '2026-09-24T14:44:30',
      premiumCurrencyCode: 21,
      riskStatus: 1,
    },
    coverages: [{ coverageCode: 'TL_BASE', sumAssured: 100000 }],
  },
}

function fixture(): { appSpec: AppSpec; documents: SpecDocument[] } {
  const appSpec: AppSpec = {
    appName: 'Freelook Refund',
    description: 'Refund trial and execution during the free look period.',
    entities: [
      { name: 'QueryPolicyRequest', fields: [{ name: 'policyNo', type: 'string', required: true }] },
      {
        name: 'QuotationRequest',
        fields: [
          { name: 'policyNo', type: 'string', required: true },
          { name: 'freelookDate', type: 'string', required: true },
        ],
      },
      {
        name: 'FreeLookTradRequest',
        fields: [
          { name: 'policyNo', type: 'string', required: true },
          { name: 'freelookDate', type: 'string', required: true },
          { name: 'reason', type: 'string', required: false },
        ],
      },
    ],
    endpoints: [
      endpoint('postGryQueryPolicyByNumber', '/Gry_QueryPolicyByNumber', 'QueryPolicyRequest', 'Query a policy by its number'),
      endpoint('postFreelookRefundQuotation', '/FreelookRefundQuotation', 'QuotationRequest', 'Refund trial for the free look period'),
      endpoint('postFreeLookTrad', '/FreeLookTrad', 'FreeLookTradRequest', 'Execute the free look'),
    ],
    flows: [],
    gaps: [],
    documentedScreens: [],
    servers: [BASE],
  }
  applyObservedShape(appSpec, 'postGryQueryPolicyByNumber', REAL_POLICY, 200)

  const text = `# Policy FreeLook Management

## UI 1 - CS Registration
Field: Policy No. (required). Button SEARCH calls Gry_QueryPolicyByNumber with { policyNo }.
On success show "Policy found" and enable NEXT, which opens the Policy Search Result screen.

## UI 2 - Policy Search Result
Shows: Policy Number, Policy ID, Product Code, Inception Date, Expiry Date, Issue Date, Currency.
Button NEXT opens Free Look Entry.

## UI 3 - Free Look Entry
Fields: Free Look Date (required), Reason. Shows the policy number.
Button CALCULATE calls FreelookRefundQuotation with { policyNo, freelookDate } and shows the refund.
Button SUBMIT calls FreeLookTrad to execute the free look, enabled only after a successful calculation.
`
  const documents: SpecDocument[] = [
    { id: 'd1', filename: 'Policy FreeLook Management.md', kind: 'markdown', bytes: text.length, blobPath: '', text, uploadedAt: '' },
  ]
  return { appSpec, documents }
}

/* ------------------------------------------------------------------ */
/* Offline                                                             */
/* ------------------------------------------------------------------ */

console.log('\nOffline')

check(!BUILD_SYSTEM.includes('CARRYING DATA BETWEEN SCREENS'), 'build prompt drops the classic data-passing rules')
check(BUILD_SYSTEM.includes('MOVING BETWEEN SCREENS'), 'build prompt teaches the flow helpers')
check(BUILD_SYSTEM.includes('HOW A SCREEN IS PUT TOGETHER'), 'build prompt keeps the classic styling guidance')

{
  const { appSpec } = fixture()
  const design = designSchema.parse({
    journey: true,
    screens: [
      { name: 'CS Registration', route: 'registration', calls: ['postGryQueryPolicyByNumber', 'inventedCall'] },
      { name: 'Policy Search Result', route: '/policy-result', receives: '{ policy: T.X;\n policyNo: string }' },
      { name: 'Policy Detail', route: '/policy/:policyId' },
    ],
  })
  const plan = toPlan(design, appSpec, false)
  check(plan.screens[0]!.route === '/', 'first screen is moved to "/" when none is')
  check(
    plan.screens[0]!.endpointIds.join() === 'postGryQueryPolicyByNumber',
    'invented operationIds are dropped',
    plan.screens[0]!.endpointIds.join(),
  )
  check(plan.screens[1]!.receives === '{ policy: T.X; policyNo: string }', 'state type collapsed to one line')
  check(plan.screens.every((s) => s.step?.total === 3), 'a journey numbers its steps')
  check(plan.builder === 'ai', 'plan is marked as AI-built')

  const flow = emitFlow(plan)
  check(flow.includes('export type PolicySearchResultState = { policy: T.X; policyNo: string }'), 'flow declares the state type')
  check(flow.includes('export function usePolicySearchResultState()'), 'flow has a state hook for a receiving screen')
  check(!flow.includes('useCSRegistrationState'), 'no state hook for a screen that receives nothing')
  check(
    flow.includes('navigate(`/policy/${encodeURIComponent(String(params.policyId))}`)'),
    'route parameters are filled, never left as ":policyId"',
  )
}

check(checkUsesFlow(`navigate('/x', { state: { a: 1 } })`).length === 1, 'hand-passed router state is rejected')
check(checkUsesFlow(`const s = location.state as Foo`).length === 1, 'reading location.state is rejected')
check(checkUsesFlow(`const go = useGoToX(); go({ a: 1 })`).length === 0, 'flow helpers pass')

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

if (process.argv.includes('--live')) {
  console.log('\nLive (Azure OpenAI)')
  if (!aiAvailable()) {
    bad('live run', 'Azure OpenAI is not configured')
  } else {
    const { appSpec, documents } = fixture()
    const started = Date.now()
    const result = await aiGenerate(
      appSpec,
      documents,
      { projectId: 'verify-ai', transport: 'bridge', serverOrigin: 'http://localhost:5177' },
      { log: (m, level = 'info') => console.log(`          [${level}] ${m}`) },
      undefined,
      false,
    )
    const seconds = ((Date.now() - started) / 1000).toFixed(0)
    const screens = result.files.filter((f) => f.path.startsWith('src/screens/'))
    const all = screens.map((f) => f.content).join('\n')

    ok(`generated ${result.plan.screens.length} screen(s) in ${seconds}s`, result.plan.screens.map((s) => s.name).join(', '))
    check(result.compiles, 'the project compiles', result.typeErrors.slice(0, 5).map((e) => `${e.file}:${e.line} ${e.message}`).join(' | '))
    check(result.files.some((f) => f.path === 'src/lib/flow.ts'), 'flow.ts is emitted')
    check(/policyBasicInfo/.test(all) && /policyNumber/.test(all), 'a screen reads the real nested path policyInfo.policyBasicInfo.policyNumber')
    check(!/DemoNotice|SAMPLE-/.test(all), 'no sample data in an API-only app')
    check(screens.every((f) => checkUsesFlow(f.content).length === 0), 'every screen navigates through the flow helpers')
    check(/postFreelookRefundQuotation/.test(all) && /postFreeLookTrad/.test(all), 'quotation and execution are both wired to buttons')
    check(result.violations.length === 0, 'no rule violations remain', JSON.stringify(result.violations).slice(0, 400))
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
