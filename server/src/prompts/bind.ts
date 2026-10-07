/**
 * The binding pass: which value in a request body each form field fills.
 *
 * This is the one judgement in building a request that needs reading — that
 * "Smoking Status: No" is `person.smoking: "N"`, that the doc wants fullName
 * made from the three name parts. Everything mechanical around it (copying the
 * example, formats, types, checking each answer exists) is done by code, so
 * the model is asked for a mapping and nothing else.
 */
export const BIND_SYSTEM = `You connect the fields a user fills in to the request body an API expects.

You are given:
- FORM FIELDS: every value the user enters, by key and label.
- REQUESTS: each API call's documented example body, flattened to "path = value".
- EARLIER RESPONSES: values earlier calls in the flow return, by path.
- DOCUMENTS: the documentation, for what fields mean and which codes exist.

The application sends each documented example EXACTLY as written, except at
the paths you bind. So bind only what the user supplies; every technical, fixed,
relationship, status and ID value stays as documented by being left alone.

BINDINGS — one entry per value the user supplies, across all requests
- { "operationId": "...", "path": "<example path>", "field": "<form key>" } where the
  user's value goes. One field may fill several paths (an email in the person
  and in the contact) — give one entry for each — but only paths that hold
  the SAME kind of value in the example. "Coverage / Term: 10 Years" fills
  coverageYear = "15" and chargeYear = 15; it does not fill coveragePeriod =
  "2", which is a code for the unit, not a number of years.
- { "operationId": "...", "path": "...", "template": "{firstName} {middleName} {lastName}" }
  for a value the documents say is derived from form fields. Only keys from FORM FIELDS.
- { "operationId": "...", "path": "...", "responseOperationId": "...", "responsePath": "..." }
  for a value an earlier call returned (a policy number found by a search, a
  quoted premium). Only paths listed under EARLIER RESPONSES.
- Copy paths character for character from the lists. Array items are addressed
  by index: policy.coverages.0.productCode.
- Every form field that has a home in a request gets an entry. A typical
  customer form fills names, gender, birth date, ID, contact, address lines,
  product, dates, amounts — expect dozens of entries, not a handful.
- Do not bind a field to a path that means something else. A "Collection Date"
  is not the policy's application date. If nothing fits, leave it out.
- Do not bind formats: the application writes each value in the format of the
  example's own value (dates, numbers, booleans). Just say where it goes.

Example — FORM FIELDS has firstName, smokingStatus; the example has
person.firstName = "AB598214", person.fullName = "AB598214 M la598214", person.smoking = "N":
  "bindings": [
    { "operationId": "createPolicy", "path": "policy.person.firstName", "field": "firstName" },
    { "operationId": "createPolicy", "path": "policy.person.fullName", "template": "{firstName} {middleName} {lastName}" },
    { "operationId": "createPolicy", "path": "policy.person.smoking", "field": "smokingStatus" }
  ],
  "options": [ { "field": "smokingStatus", "options": [ { "value": "Y", "label": "Yes" }, { "value": "N", "label": "No" } ] } ]

OPTIONS — for every field the user picks from a list (dropdown, yes/no, radio)
- { "field": "<form key>", "options": [ { "value": "<code the API expects>", "label": "<what the user reads>" } ] }
- A value MUST be a code the documents or the example actually contain. The
  example says "smoking": "N", so No = "N" and Yes = "Y". The example says
  "productCode": "GEMEND001", so that is a product the API knows.
- NEVER invent codes. If the documents do not say which codes a field takes
  (e.g. nationality "156" appears but no list of countries), give only the
  codes you can ground — one is fine — or none, and report the field in "unclear".
- A label is the documents' wording for that code when they give one;
  otherwise the plainest description the documents support, or the code itself.

UNCLEAR
- { "field": "<form key>", "reason": "..." } for anything you could not ground:
  no code list, no matching path, an ambiguous meaning. This is shown to the
  person so they can add it to the documents — it is a useful answer, not a failure.

Return one JSON object: { "bindings": [...], "options": [...], "unclear": [...] }`

export interface BindPromptInput {
  fields: { key: string; label: string; type?: string; options?: string[]; notes?: string; screen: string }[]
  requests: { operationId: string; summary: string; screens: string[]; leaves: string[] }[]
  responses: { operationId: string; leaves: string[] }[]
  documents: string
}

export function bindUser(input: BindPromptInput): string {
  const fields = input.fields
    .map(
      (f) =>
        `  ${f.key}  — "${f.label}"${f.type ? ` (${f.type})` : ''} on ${f.screen}` +
        `${f.options?.length ? `\n      documented options: ${f.options.join(', ')}` : ''}` +
        `${f.notes ? `\n      ${f.notes}` : ''}`,
    )
    .join('\n')

  const requests = input.requests
    .map(
      (r) =>
        `${r.operationId} — ${r.summary} (called from ${r.screens.join(', ')})\n${r.leaves
          .map((l) => `    ${l}`)
          .join('\n')}`,
    )
    .join('\n\n')

  const responses = input.responses.length
    ? input.responses
        .map((r) => `${r.operationId}\n${r.leaves.map((l) => `    ${l}`).join('\n')}`)
        .join('\n\n')
    : '  (none)'

  return `FORM FIELDS
${fields || '  (none)'}

REQUESTS
${requests || '  (none)'}

EARLIER RESPONSES
${responses}

DOCUMENTS
${input.documents}`
}

/**
 * The second, narrower question: of the example values nobody fills in, which
 * belonged only to the example's one test record?
 *
 * Asked inside the binding pass it was ignored — the model was busy mapping
 * thirty fields — and the app went on sending the example's policy number and
 * its test customer's third address line with every new policy.
 */
export const RESET_SYSTEM = `You review an API request example before an application reuses it for every request it sends.

Each listed value will be sent unchanged, every time, unless you say otherwise. Most of them are configuration and must stay: agent codes, currency, payment method, product parameters, relationship codes, status codes, IDs that link parts of the same request together (partyId 1 used in several places).

Pick out only the values that belonged to the example's one test case and would be wrong or harmful to resend:
- a policy, proposal, application, transaction or reference number ("now" is never right for these — use "empty")
- a timestamp of when the example was submitted or created ("now")
- personal test data — a name, address line, phone, email, ID number — that the form does not ask for ("empty")

Return one JSON object:
{ "reset": [ { "path": "<path exactly as listed>", "as": "empty" | "now", "why": "<a few words>" } ] }

When in doubt, leave it out: an unnecessary reset can break a request that worked.`

export function resetUser(operationId: string, leaves: string[], formLabels: string[], documents: string): string {
  return `REQUEST ${operationId}

VALUES SENT UNCHANGED
${leaves.map((l) => `  ${l}`).join('\n')}

THE FORM ASKS THE USER FOR
${formLabels.map((l) => `  ${l}`).join('\n')}

DOCUMENTS
${documents}`
}
