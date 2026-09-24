import { transform } from 'esbuild'

export interface Violation {
  kind: 'syntax' | 'grounding' | 'import' | 'props' | 'scope'
  message: string
  line?: number
}

/**
 * Parses the file. This catches the common failure mode of generated code —
 * a truncated or malformed module — before it ever reaches a preview.
 */
export async function checkSyntax(code: string, path: string): Promise<Violation[]> {
  try {
    await transform(code, { loader: 'tsx', format: 'esm', sourcefile: path })
    return []
  } catch (err) {
    const errors = (err as { errors?: { text: string; location?: { line: number } }[] }).errors
    if (!errors?.length) {
      return [{ kind: 'syntax', message: (err as Error).message }]
    }
    return errors.map((e) => ({
      kind: 'syntax' as const,
      message: e.text,
      ...(e.location?.line ? { line: e.location.line } : {}),
    }))
  }
}

/** Every `import ... from '<source>'` in the file, with its named bindings. */
function parseImports(code: string): { source: string; names: string[] }[] {
  const imports: { source: string; names: string[] }[] = []
  const pattern = /import\s+(?:type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g

  for (const match of code.matchAll(pattern)) {
    const clause = match[1] ?? ''
    const source = match[2]!
    const names: string[] = []

    const braces = clause.match(/\{([^}]*)\}/)
    if (braces?.[1]) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
        if (name) names.push(name)
      }
    }

    const defaultImport = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim()
    if (defaultImport && !defaultImport.startsWith('*')) names.push(defaultImport)

    imports.push({ source, names })
  }
  return imports
}

const lineOf = (code: string, index: number) => code.slice(0, index).split('\n').length

/**
 * Enforces the guarantee the whole product rests on: a generated screen may not
 * reach the network on its own terms. If the model writes a URL, that URL did
 * not come from the specification — so it is rejected here rather than shipped.
 */
export function checkGrounding(code: string, allowedApiFunctions: Set<string>): Violation[] {
  const violations: Violation[] = []

  const banned: { pattern: RegExp; message: string }[] = [
    { pattern: /\bfetch\s*\(/g, message: 'calls fetch() directly — use the generated API client instead' },
    { pattern: /\baxios\b/g, message: 'uses axios — use the generated API client instead' },
    { pattern: /\bXMLHttpRequest\b/g, message: 'uses XMLHttpRequest — use the generated API client instead' },
  ]

  for (const { pattern, message } of banned) {
    for (const match of code.matchAll(pattern)) {
      violations.push({ kind: 'grounding', message, line: lineOf(code, match.index) })
    }
  }

  for (const match of code.matchAll(/['"`]https?:\/\/[^'"`\s]*['"`]/g)) {
    if (isLinkTarget(code, match.index)) continue
    violations.push({
      kind: 'grounding',
      message: 'contains a hard-coded URL — every URL must come from the generated API client',
      line: lineOf(code, match.index),
    })
  }

  for (const imported of parseImports(code)) {
    if (!imported.source.includes('lib/api')) continue
    for (const name of imported.names) {
      // ApiError and RequestOptions are re-exported by the client on purpose.
      if (name === 'ApiError' || name === 'RequestOptions') continue
      if (!allowedApiFunctions.has(name)) {
        violations.push({
          kind: 'grounding',
          message: `imports "${name}" from the API client, which has no such function — it was not in the specification`,
        })
      }
    }
  }

  return violations
}

/**
 * True when a URL literal sits in an attribute that renders a link rather than
 * makes a request.
 *
 * Showing a record's own website as a clickable link — `href={`https://${site}`}`
 * — is good UI and has nothing to do with calling the API, so flagging it would
 * train the model to strip a useful feature to satisfy a rule aimed at
 * something else entirely.
 */
function isLinkTarget(code: string, index: number): boolean {
  // Far enough back to clear `href={` and a little whitespace, no further.
  const preceding = code.slice(Math.max(0, index - 40), index)
  return /\b(href|src|action|formAction|poster|cite|xmlns|srcSet)\s*=\s*\{?\s*$/.test(preceding)
}

/** Rejects imports that will not resolve against the emitted file set. */
export function checkImports(code: string, screenFileNames: Set<string>): Violation[] {
  const allowedBare = new Set(['react', 'react-dom', 'react-router-dom', 'lucide-react', 'clsx', 'tailwind-merge'])
  const allowedRelative = new Set([
    '../lib/api',
    '../lib/types',
    '../lib/http',
    '../lib/config',
    '../components/ui',
    '../components/Layout',
    '../components/DemoNotice',
    '../lib/demo',
    // Emitted only for an app documented without an API; screens read and
    // write it exactly as they would call the client.
    '../lib/store',
    // Emitted when a screen receives a response the documents never described.
    '../lib/read',
  ])

  const violations: Violation[] = []
  for (const { source } of parseImports(code)) {
    if (allowedBare.has(source) || source.startsWith('react/')) continue
    if (allowedRelative.has(source)) continue
    // A screen may import a sibling screen, e.g. for a shared sub-component.
    if (source.startsWith('./') && screenFileNames.has(source.replace(/^\.\//, ''))) continue

    violations.push({
      kind: 'import',
      message: `imports "${source}", which does not exist in the generated project`,
    })
  }
  return violations
}

export function describeViolations(violations: Violation[]): string {
  return violations
    .map((v) => `- ${v.line ? `line ${v.line}: ` : ''}${v.message}`)
    .join('\n')
}

/**
 * Rejects props that a kit component does not declare.
 *
 * This is the class of failure that syntax checking cannot see: `<Button icon=…>`
 * parses perfectly and then fails to compile. Running a real type-check would
 * mean installing React's types and compiling the whole project on every
 * generation; matching JSX attributes against the kit's declared props catches
 * the same mistakes for none of that cost.
 */
export function checkComponentProps(
  code: string,
  componentProps: Record<string, string[]>,
  universalProps: Set<string>,
): Violation[] {
  const violations: Violation[] = []

  // Opening tags for capitalised components, up to the closing bracket. Nested
  // braces in an attribute value are handled by scanning forward rather than
  // trying to express balance in the pattern.
  const tagPattern = /<([A-Z][A-Za-z0-9]*)(\s)/g

  for (const match of code.matchAll(tagPattern)) {
    const name = match[1]!
    const allowed = componentProps[name]
    if (!allowed) continue

    const attrs = readAttributes(code, match.index + match[0].length - 1)
    if (attrs === null) continue

    for (const attr of attrs) {
      if (universalProps.has(attr) || allowed.includes(attr)) continue
      if (attr.startsWith('aria-') || attr.startsWith('data-')) continue
      violations.push({
        kind: 'props',
        message: `<${name}> has no "${attr}" prop — it accepts only: ${allowed.join(', ')}`,
        line: lineOf(code, match.index),
      })
    }
  }

  return violations
}

/**
 * Collects attribute names from one JSX opening tag, tracking brace and quote
 * depth so that an attribute value containing `>` does not end the scan early.
 */
function readAttributes(code: string, start: number): string[] | null {
  const names: string[] = []
  let depth = 0
  let quote: string | null = null
  let i = start
  let pendingName = ''

  while (i < code.length) {
    const ch = code[i]!

    if (quote) {
      if (ch === quote) quote = null
      i++
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      i++
      continue
    }

    if (ch === '{') {
      depth++
      i++
      continue
    }
    if (ch === '}') {
      depth--
      i++
      continue
    }

    if (depth === 0) {
      if (ch === '>') break
      if (ch === '/' && code[i + 1] === '>') break

      // An identifier at depth zero, followed by '=' or whitespace, is a prop.
      if (/[A-Za-z_]/.test(ch)) {
        pendingName = ''
        while (i < code.length && /[A-Za-z0-9_$-]/.test(code[i]!)) {
          pendingName += code[i]!
          i++
        }
        // Skip spread attributes, which we cannot check statically.
        if (pendingName) names.push(pendingName)
        continue
      }
    }

    i++
  }

  return i < code.length ? names : null
}

/** Names declared in the file itself: components, helpers, constants. */
function localDeclarations(code: string): Set<string> {
  const names = new Set<string>()
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\benum\s+([A-Za-z_$][\w$]*)/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) names.add(match[1]!)
  }
  return names
}

/**
 * Catches a component that is used but never brought into scope.
 *
 * `<StatusBadge status="Active" />` with no matching import parses perfectly and
 * then throws "StatusBadge is not defined" the moment the screen renders — a
 * blank page for something the type-checker of a bundled preview never sees.
 */
export function checkUndefinedComponents(code: string): Violation[] {
  const inScope = localDeclarations(code)
  for (const imported of parseImports(code)) {
    for (const name of imported.names) inScope.add(name)
  }

  const violations: Violation[] = []
  const reported = new Set<string>()

  /*
   * The lookbehind is what separates a JSX tag from a type argument.
   *
   * `useRef<HTMLInputElement>(null)` and `ChangeEvent<HTMLInputElement>` are
   * ordinary TypeScript, but they look exactly like `<Card>` to a scan for
   * `<Name>`. Reported as a missing import they send the repair pass looking
   * for `HTMLInputElement` in the component kit, which does not export it and
   * never could — so the screen is rewritten around a problem it never had. A
   * type argument always follows an identifier or a dot; a tag never does.
   */
  for (const match of code.matchAll(
    /(?<![A-Za-z0-9_$.])<([A-Z][A-Za-z0-9_$]*)(?:\.[A-Za-z0-9_$]+)*[\s/>]/g,
  )) {
    const name = match[1]!
    if (inScope.has(name) || reported.has(name)) continue
    // React and Fragment shorthand are always available.
    if (name === 'React' || name === 'Fragment') continue
    reported.add(name)
    violations.push({
      kind: 'scope',
      message: `uses <${name}> but never imports it — add it to the import from '../components/ui'`,
      line: lineOf(code, match.index),
    })
  }

  return violations
}

/**
 * True when `code` contains a call to `name`.
 *
 * Deliberately not built from a regular expression: operation ids come from the
 * documentation, so a name containing regex syntax would either throw or match
 * the wrong thing. Scanning is slightly longer and cannot be broken by input.
 */
function callsFunction(code: string, name: string): boolean {
  const isWordChar = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch)

  let from = 0
  for (;;) {
    const at = code.indexOf(name, from)
    if (at === -1) return false
    from = at + name.length

    // Must be a whole identifier, not a fragment of a longer one.
    if (isWordChar(code[at - 1]) || isWordChar(code[from])) continue

    // ...and must be followed by a call, allowing whitespace between.
    let i = from
    while (i < code.length && /\s/.test(code[i]!)) i++
    if (code[i] === '(') return true
  }
}

/**
 * Rejects a screen that ignores the endpoints it was given.
 *
 * A screen assigned `getPolicy` that renders invented dates and amounts is the
 * worst output this tool can produce: it looks finished and is entirely
 * fictional. If a screen has endpoints, it has to call one.
 */
export function checkUsesApi(code: string, expectedFunctions: string[]): Violation[] {
  if (expectedFunctions.length === 0) return []

  const called = expectedFunctions.filter((fn) => callsFunction(code, fn))
  if (called.length > 0) return []

  return [
    {
      kind: 'grounding',
      message:
        `does not call any of its endpoints (${expectedFunctions.join(', ')}). ` +
        'Load the data from the API instead of writing placeholder values.',
    },
  ]
}

/**
 * Flags values that look invented rather than rendered from data.
 *
 * A screen showing "John Doe" and policy "123456789" looks finished and is
 * fiction — the single most damaging thing this tool can emit, because it is
 * indistinguishable from working software until someone checks a number.
 *
 * `carriesDataFromAnotherScreen` tightens the rules for a screen with no
 * endpoints of its own: it should read what the previous screen fetched out of
 * router state, so any concrete-looking literal in it is almost certainly made
 * up rather than incidental.
 */
export function checkFabricatedData(code: string, carriesDataFromAnotherScreen = false): Violation[] {
  const violations: Violation[] = []

  const suspects: { pattern: RegExp; message: string }[] = [
    {
      pattern: /new Date\(\s*['"]\d{4}-\d{2}-\d{2}/g,
      message: 'builds a Date from a hard-coded date literal — render the value from the data',
    },
    {
      pattern: /['"]\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?['"]/g,
      message: 'contains a hard-coded date — render it from the data',
    },
    {
      pattern: /[>\s]\$\s?[\d,]+\.\d{2}\b/g,
      message: 'contains a hard-coded money amount — render it from the data',
    },
    {
      pattern: /\b(?:const|let)\s+\w*(?:mock|dummy|sample|placeholder|fake|example|stub)\w*\s*=/gi,
      message: 'declares placeholder data — screens must render real values',
    },
    {
      pattern: /\b(?:John|Jane)\s+(?:Doe|Smith)\b|lorem ipsum|\bfoo@|@example\.com/gi,
      message: 'contains a placeholder name or address — render it from the data',
    },
  ]

  for (const { pattern, message } of suspects) {
    for (const match of code.matchAll(pattern)) {
      violations.push({ kind: 'grounding', message, line: lineOf(code, match.index) })
    }
  }

  if (carriesDataFromAnotherScreen) {
    // A long digit run in quotes is an identifier someone invented; nothing
    // legitimate on a display-only screen looks like that.
    for (const match of code.matchAll(/['"]\d{6,}['"]/g)) {
      violations.push({
        kind: 'grounding',
        message:
          'contains a hard-coded identifier — this screen has no endpoint, so read the record ' +
          'from router state via useLocation() instead of inventing one',
        line: lineOf(code, match.index),
      })
    }

    // ...and it must actually read that state, or say it has nothing to show.
    const readsState = /useLocation\s*\(|useParams\s*\(|useSearchParams\s*\(/.test(code)
    const showsEmpty = /<EmptyState\b/.test(code)
    if (!readsState && !showsEmpty) {
      violations.push({
        kind: 'grounding',
        message:
          'has no endpoint and never reads useLocation()/useParams(), so nothing it displays can be real. ' +
          'Read the record the previous screen passed in router state, and render <EmptyState> when it is absent.',
      })
    }
  }

  return violations
}

/**
 * Rejects hooks called after an early return.
 *
 *     if (!data) return <EmptyState />
 *     const onSave = useCallback(...)          // unreachable on one path
 *
 * React requires the same hooks in the same order on every render, so this
 * throws "Rendered more hooks than during the previous render" the moment the
 * guard stops matching. TypeScript has no opinion about it and the code
 * compiles perfectly, which is exactly why it needs checking here.
 *
 * Brace depth is tracked rather than indentation: the guard's `return` sits
 * inside an `if` block, so matching on leading spaces missed it entirely.
 */
export function checkHookOrder(code: string): Violation[] {
  const component = code.search(
    /(?:export\s+default\s+)?function\s+[A-Z]\w*\s*\(|const\s+[A-Z]\w*[^=\n]*=\s*\(/,
  )
  if (component === -1) return []

  const open = code.indexOf('{', component)
  if (open === -1) return []

  const HOOK = /^(useState|useEffect|useCallback|useMemo|useRef|useReducer)\s*[<(]/
  let depth = 0
  let guardLine = -1
  let line = code.slice(0, open).split('\n').length

  for (let i = open; i < code.length; i++) {
    const ch = code[i]!

    if (ch === '\n') {
      line++
      continue
    }
    if (ch === '{') {
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0) break
      continue
    }

    // Only statements in the component body, or one block deep inside a guard,
    // determine whether the hooks that follow are reachable on every render.
    if (depth > 2) continue

    const rest = code.slice(i, i + 24)

    if (guardLine === -1 && /^return[\s(;]/.test(rest)) {
      guardLine = line
      continue
    }

    if (guardLine !== -1 && depth === 1) {
      const hook = rest.match(HOOK)
      if (hook) {
        return [
          {
            kind: 'scope',
            message:
              `calls ${hook[1]}() on line ${line}, after the early return on line ${guardLine}. ` +
              'React runs hooks in the same order every render — declare every hook, including ' +
              'useCallback and useEffect, before any conditional return.',
            line,
          },
        ]
      }
    }
  }

  return []
}

/**
 * Flags an API response that is fetched and then thrown away.
 *
 *     await executeFreeLook(body)      // result discarded
 *     toast.push('Done')               // ...so the screen shows nothing
 *
 * The call succeeds, the code compiles, and the user is left staring at an
 * unchanged screen wondering whether anything happened. A response worth
 * requesting is worth showing, unless the endpoint genuinely returns nothing.
 */
export function checkResponsesRendered(
  code: string,
  functionsWithBodies: { name: string; returnsValue: boolean }[],
): Violation[] {
  const violations: Violation[] = []

  for (const { name, returnsValue } of functionsWithBodies) {
    if (!returnsValue) continue

    let from = 0
    let used = false
    let called = false

    for (;;) {
      const at = code.indexOf(`${name}(`, from)
      if (at === -1) break
      from = at + name.length

      // Skip the import statement and any mention inside a comment.
      const lineStart = code.lastIndexOf('\n', at) + 1
      const line = code.slice(lineStart, code.indexOf('\n', at))
      if (/^\s*(import|\*|\/\/)/.test(line)) continue

      called = true

      const prefix = code.slice(lineStart, at)
      const assigned = /[=:]\s*(await\s+)?$/.test(prefix)
      const returned = /\breturn\s+(await\s+)?$/.test(prefix)
      // `call(x).then(setResult)` uses the value without assigning it.
      const chained = line.includes('.then(')

      if (assigned || returned || chained) used = true
    }

    if (called && !used) {
      violations.push({
        kind: 'grounding',
        message:
          `calls ${name}() and discards the result. Keep it in state and render it — ` +
          'a screen that calls an API and shows nothing back looks broken.',
      })
    }
  }

  return violations
}

/**
 * A screen handed an undocumented response must read it through the emitted
 * lookup. Its own version searched one level deep and rendered a dash for a
 * value that was sitting two levels down.
 */
export function checkUsesReadHelpers(code: string, required: boolean): Violation[] {
  if (!required) return []
  const imports = parseImports(code).some((i) => i.source === '../lib/read')
  if (imports && /\bpick\s*\(/.test(code)) return []
  return [
    {
      kind: 'grounding',
      message:
        "reads an undocumented response without the emitted lookup. Import { pick, fieldsOf } " +
        "from '../lib/read', use pick(incoming, '<label>') for every field, and remove any " +
        'hand-written lookup helper.',
    },
  ]
}
