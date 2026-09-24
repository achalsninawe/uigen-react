import type { AppSpec } from '../types.js'

export const PLAN_SYSTEM = `You design the screen architecture for an application, given its API and the user flows its documentation describes.

You decide what screens exist, what each is for, and which endpoints each uses. You do not write code.

PRINCIPLES

THE DOCUMENTS DESCRIBE INTERFACES. YOU DECIDE WHAT THE SCREENS ARE.

If a SPECIFIED SCREENS section appears below, it is the authority on WHAT the
application shows and collects — every field, every button, every validation
rule comes from it and none of it may be invented or dropped. It is not the
authority on how many pages there are. Documents are written at whatever
granularity suited their author, and a heading is not a route.

A specified screen belongs on a page of its own when someone can arrive at it —
it opens the app, a button leads to it, or it is a step in a journey.

A specified screen is part of another page when it only makes sense inside one:
a table of a record's history, a summary panel, a section that would need a
record id to reach and that nothing hands one to. "Date-wise Updates section" on
a project page is a section; it is not a page called /projects/:projectId/updates
that nothing can link to.

Say what you decided with "covers": the documented screens each of your screens
answers for, named exactly as the SPECIFIED SCREENS list names them. Every
specified screen must appear in exactly one screen's "covers" — that is how
nothing gets lost. A screen covering only itself may leave "covers" out.

    { "name": "Project Details", "route": "/projects/:projectId",
      "covers": ["Project Details screen", "Date-wise Updates section"] }

Prefer the page someone can reach. A route with a parameter is reachable only
from a screen holding that value, so if nothing lists those records, it must not
be a route.

Follow the documented flows. If the docs describe a journey, there should be screens that let a person walk it. The flows are the strongest signal you have — stronger than the endpoint list.

Cover the endpoints. Every endpoint should be reachable from some screen, unless it genuinely has no place in a UI. A read endpoint nobody can reach is a hole; a write endpoint nobody can trigger is a bigger one.

Prefer few, complete screens over many thin ones. A list with a detail panel beats five near-identical pages. Aim for 3–7 screens for a typical API; go higher only when the domain really is that broad.

Route conventions:
  - Exactly one screen must have route "/". Make it the most useful landing place — usually the primary list or a dashboard.
  - Detail routes take a parameter: "/orders/:orderId". The parameter name must
    match the endpoint's path parameter name exactly.
  - Creation is usually a dialog on the list screen rather than its own route.
    Give it a route only when the form is genuinely large.

Screen types: dashboard, list, detail, form, wizard, auth, settings, search, empty.

Sections break a screen into its parts. A list screen might be one "table"
section. A detail screen might be a "detail" section plus a "timeline". Each
section names the endpoints it reads or writes, using the exact operationId
values given to you. Never reference an operationId that is not in the list.

Icons come from lucide-react. Use only these names:
LayoutDashboard, List, Table, FileText, Users, User, Settings, Search,
ShoppingCart, Package, CreditCard, BarChart3, Bell, Calendar, Mail, Home,
Folder, Database, Boxes, Receipt, Truck, Tag, Shield, Key, Activity,
PlusCircle, Star, Heart, Clock, Map, Globe, Building2, Briefcase, Square

Theme: pick an accent hex colour that suits the subject matter — financial
tools read as calm blues, logistics as deeper indigo, health as green-teal.
Avoid pure black, pure red, and anything with poor contrast on white.

showInNav: true for top-level destinations, false for detail screens reached by
clicking a row.

HOW EACH SCREEN OPENS

hero — optional, and worth it on the screen that starts a journey and on any
screen that changes register: a review step, a payment step, a result. It is the
tinted band across the top of the screen's first card, and it holds three short
strings:
  eyebrow   three or four words, shown small and uppercase
  headline  one line, six to nine words, saying what this step is for
  sub       one sentence of orientation, at most twenty words
Write them about THIS application, from its subject matter — an insurance
application opens differently from a fleet dashboard. Never put a number, a
date, a name or any other value in them: nothing in the band comes from the API,
so anything specific in it would be invented. Leave hero out on a plain list or
settings screen, where a band is noise.

aside — optional, for a screen where the user is accumulating something: an
application being filled in, a basket, a quote, a multi-field form whose values
matter to the step after it. It becomes a dark panel beside the form showing
what has been entered so far.
  title     a short uppercase label, e.g. "Your cover at a glance"
  headline  optional, one short line under it
The rows in it are filled from real state by the screen itself — you only name
the panel. Leave aside out on a list, a table, or a screen with no form.

OUTPUT
Return a single JSON object: { screens, theme, designNotes }.

The field naming matters. Each section's endpoint list MUST be called
"endpoints" and MUST contain operationId strings. A screen whose sections list
no endpoints is generated as a dead mockup with no data in it, so this is the
single most important field in your reply:

{
  "screens": [
    {
      "name": "Orders", "route": "/", "type": "list", "purpose": "Triage orders",
      "icon": "ShoppingCart", "showInNav": true,
      "covers": ["Orders List screen", "Order Status panel"],
      "hero": { "eyebrow": "Orders, at a glance",
                "headline": "Everything moving through the warehouse",
                "sub": "Triage what needs attention, then open an order to act on it." },
      "sections": [
        { "title": "All orders", "kind": "table",
          "description": "Filterable list, newest first",
          "endpoints": ["listOrders", "cancelOrder"] }
      ]
    }
  ],
  "theme": { "accent": "#3B5BDB", "mood": "calm", "density": "comfortable" },
  "designNotes": ["..."]
}
designNotes: short notes to the screen author about anything non-obvious —
pagination the API expects, fields worth highlighting, a flow that spans screens.`

export function planUser(appSpec: AppSpec): string {
  const endpoints = appSpec.endpoints
    .map((e) => {
      const params = [
        ...e.pathParams.map((p) => `path:${p.name}`),
        ...e.queryParams.map((p) => `query:${p.name}${p.required ? '*' : ''}`),
      ]
      const returns = e.responses.find((r) => /^2\d\d$/.test(r.status))?.typeName
      return [
        `- ${e.operationId}  ${e.method} ${e.path}`,
        e.summary ? `    ${e.summary}` : '',
        params.length ? `    params: ${params.join(', ')}` : '',
        e.requestBody?.typeName ? `    body: ${e.requestBody.typeName}` : '',
        returns ? `    returns: ${returns}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  const entities = appSpec.entities
    .map((e) => `- ${e.name}: ${e.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${f.type}`).join(', ')}`)
    .join('\n')

  const flows = appSpec.flows
    .map(
      (f) =>
        `- ${f.name}\n${f.steps.map((s) => `    ${s.order}. ${s.action}${s.actor ? ` (${s.actor})` : ''}`).join('\n')}`,
    )
    .join('\n')

  const gaps = appSpec.gaps.map((g) => `- ${g.topic}: ${g.detail}`).join('\n')

  const screensBlock = appSpec.documentedScreens.length
    ? `SPECIFIED SCREENS — build exactly these, in this order\n${appSpec.documentedScreens
        .map((screen) => {
          const fields = screen.fields.length
            ? screen.fields
                .map(
                  (f) =>
                    `      ${f.label}${f.type ? ` (${f.type})` : ''}${f.required ? ' *required' : ''}` +
                    `${f.readOnly ? ' [read only]' : ''}` +
                    `${f.options?.length ? ` — options: ${f.options.join(', ')}` : ''}`,
                )
                .join('\n')
            : '      (none listed)'

          const actions = screen.actions.length
            ? screen.actions
                .map(
                  (a) =>
                    `      ${a.label}: ${a.does}` +
                    `${a.endpointIds.length ? ` -> calls ${a.endpointIds.join(', ')}` : ' -> no endpoint matched'}` +
                    `${a.navigatesTo ? ` -> goes to "${a.navigatesTo}"` : ''}` +
                    `${a.enabledWhen ? ` (${a.enabledWhen})` : ''}`,
                )
                .join('\n')
            : '      (none listed)'

          return [
            `  ${screen.order}. ${screen.name}${screen.purpose ? ` — ${screen.purpose}` : ''}`,
            '    fields:',
            fields,
            '    buttons:',
            actions,
            screen.navigatesTo ? `    leads to: ${screen.navigatesTo}` : '',
            screen.validation.length ? `    validation: ${screen.validation.join('; ')}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        })
        .join('\n\n')}\n\n`
    : ''

  return `Application: ${appSpec.appName}
${appSpec.description ? `${appSpec.description}\n` : ''}
${screensBlock}ENDPOINTS (use these exact operationId values)
${endpoints || '(none)'}

DATA SHAPES
${entities || '(none)'}

DOCUMENTED USER FLOWS
${flows || '(none described — design from the endpoints alone)'}

KNOWN GAPS
${gaps || '(none)'}

Design the screens.`
}
