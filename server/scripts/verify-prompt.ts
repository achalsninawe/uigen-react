/**
 * What the codegen prompt actually tells the model to write.
 *
 * The prompt is assembled from the plan, so a route with a parameter used to
 * reach the model as the string it should copy — `navigate('/projects/:projectId/updates')`.
 * React Router matches that pattern, the receiving screen reads ":projectId" as
 * its id, asks the API for it and shows nothing. Nothing downstream could catch
 * it: the file compiles, the validator sees a legal navigate call, and the
 * screen renders an empty state exactly as it was written to.
 */
import { CODEGEN_SYSTEM, codegenUser } from '../src/prompts/codegen.js'
import { coveredSpec } from '../src/services/emit/types.js'
import type { AppPlan, AppSpec, DocumentedScreen, ScreenPlan } from '../src/types.js'

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

const appSpec: AppSpec = {
  appName: 'Project Tracker',
  description: '',
  entities: [
    { name: 'Project', fields: [{ name: 'id', type: 'string', required: true }] },
    { name: 'Update', fields: [{ name: 'note', type: 'string', required: false }] },
  ],
  endpoints: [
    {
      id: 'e1',
      operationId: 'listProjects',
      name: 'List projects',
      method: 'GET',
      path: '/api/projects',
      baseUrl: 'https://api.example.test',
      tags: [],
      auth: { type: 'none' },
      headers: [],
      pathParams: [],
      queryParams: [],
      responses: [{ status: '200', typeName: 'Project[]' }],
    },
  ],
  flows: [],
  gaps: [],
  documentedScreens: [],
  servers: [],
}

const screen = (id: string, name: string, route: string, extra: Partial<ScreenPlan> = {}): ScreenPlan => ({
  id,
  name,
  route,
  type: 'list',
  purpose: `Work with ${name.toLowerCase()}`,
  icon: 'List',
  sections: [],
  endpointIds: [],
  showInNav: true,
  ...extra,
})

const plan: AppPlan = {
  screens: [
    screen('a', 'Projects List', '/', { endpointIds: ['listProjects'] }),
    // The next screen in the journey, and its route needs a record id.
    screen('b', 'Project Updates', '/projects/:projectId/updates', {
      incomingType: 'Update',
      incomingFrom: 'Projects List',
    }),
  ],
  navigation: [],
  theme: { accent: '#6C63FF', mood: 'calm', density: 'comfortable' },
  designNotes: [],
}

const prompt = codegenUser(plan.screens[0]!, appSpec, plan, 'ProjectsList')

// The literal pattern, as an instruction to copy.
const literal = /navigate\('\/projects\/:projectId\/updates'/
if (literal.test(prompt)) {
  bad(
    'a parameterised route is never handed over as a literal',
    prompt.split('\n').find((l) => literal.test(l))?.trim() ?? '',
  )
} else {
  ok('a parameterised route is never handed over as a literal')
}

// ...and is handed over as something to fill instead.
const filled = prompt.includes('navigate(`/projects/${projectId}/updates`')
if (filled) {
  ok(
    'it is handed over as a template literal to fill',
    prompt.split('\n').find((l) => l.includes('/projects/${projectId}/updates'))?.trim() ?? '',
  )
} else {
  bad('it is handed over as a template literal', 'no fillable form of the route appears in the prompt')
}

if (/must be filled from the record you are acting on/.test(prompt)) {
  ok('the prompt says where the parameter value comes from')
} else {
  bad('the prompt says where the value comes from', 'no note accompanies the route')
}

if (/navigates to ":orderId"/.test(CODEGEN_SYSTEM)) {
  ok('the system prompt shows the wrong and right spelling side by side')
} else {
  bad('the system prompt covers it', 'no rule about filling route parameters')
}

// A route with no parameters must still be a plain string, not a template.
const plainPlan: AppPlan = {
  ...plan,
  screens: [plan.screens[0]!, screen('b', 'Settings', '/settings', { incomingType: 'Update', incomingFrom: 'Projects List' })],
}
const plainPrompt = codegenUser(plainPlan.screens[0]!, appSpec, plainPlan, 'ProjectsList')
if (plainPrompt.includes("navigate('/settings'")) {
  ok('a route with no parameters is still a plain string')
} else {
  bad('a route with no parameters stays plain', 'it was turned into a template literal needlessly')
}


/* ------------------------------------------------------------------ */
/* One page answering for several documented screens                   */
/* ------------------------------------------------------------------ */

const documented = (name: string, fields: string[], actions: string[] = []): DocumentedScreen => ({
  id: name.toLowerCase().replace(/W+/g, '-'),
  name,
  purpose: `The ${name}`,
  order: 0,
  fields: fields.map((label) => ({ label })),
  actions: actions.map((label) => ({ label, does: label, endpointIds: [] })),
  validation: [],
})

const merged = coveredSpec(
  { name: 'Project Details', covers: ['Project Details screen', 'Date-wise Updates section'] },
  [
    documented('Project Details screen', ['Project Name', 'Owner'], ['Edit']),
    documented('Date-wise Updates section', ['Update Date', 'Note'], ['+ Add Update']),
    documented('Projects List screen', ['Project Name'], []),
  ],
)

const labels = merged?.fields.map((f) => f.label) ?? []
if (['Project Name', 'Owner', 'Update Date', 'Note'].every((l) => labels.includes(l))) {
  ok('a merged page carries the fields of every document it covers', labels.join(', '))
} else {
  bad('a merged page carries every covered field', labels.join(', ') || '(none)')
}

if (labels.filter((l) => l === 'Project Name').length === 1) {
  ok('a field named in two covered documents is kept once')
} else {
  bad('a duplicated field is kept once', labels.join(', '))
}

const buttons = merged?.actions.map((a) => a.label) ?? []
if (buttons.includes('Edit') && buttons.includes('+ Add Update')) {
  ok('buttons from every covered document survive', buttons.join(', '))
} else {
  bad('buttons from every covered document survive', buttons.join(', ') || '(none)')
}

if (merged?.name === 'Project Details') {
  ok('the merged spec takes the planned name, so other lookups still line up')
} else {
  bad('the merged spec takes the planned name', String(merged?.name))
}

const plain = coveredSpec({ name: 'Projects List screen' }, [documented('Projects List screen', ['Project Name'])])
if (plain?.fields.length === 1) ok('a screen with no covers still resolves by its own name')
else bad('a screen with no covers resolves by name', String(plain?.fields.length))
console.log('')
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
