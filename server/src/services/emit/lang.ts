/** Small helpers shared by the code emitters. */

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'async',
  'implements', 'interface', 'package', 'private', 'protected', 'public', 'abstract', 'declare',
  'type', 'namespace', 'module', 'any', 'unknown', 'never', 'object', 'string', 'number', 'boolean',
])

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export const isIdentifier = (name: string) => IDENTIFIER.test(name)

/** `user-id` -> `userId`, `2fa` -> `_2fa`, `class` -> `class_`. */
export function toIdentifier(raw: string, fallback = 'value'): string {
  const camel = raw
    .replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^[0-9]/, (d) => `_${d}`)
  const name = camel || fallback
  return RESERVED.has(name) ? `${name}_` : name
}

/**
 * `order item` -> `OrderItem`. Used for type and component names.
 *
 * The trailing underscore `toIdentifier` adds to a reserved word is dropped
 * first: a type name marks the clash with a `Model` suffix instead, and
 * carrying both meant `interface` became `Interface_` once and `InterfaceModel`
 * the next time the same spec was normalised. A name that changes when it is
 * re-derived is a name that stops matching the screens written against it.
 */
export function toPascalCase(raw: string, fallback = 'Item'): string {
  const identifier = toIdentifier(raw, fallback).replace(/_+$/, '') || fallback
  const pascal = identifier[0] ? identifier[0]!.toUpperCase() + identifier.slice(1) : fallback
  return RESERVED.has(pascal.toLowerCase()) ? `${pascal}Model` : pascal
}

/** Quotes an object key only when it is not a bare identifier. */
export const key = (name: string) => (isIdentifier(name) ? name : JSON.stringify(name))

/** A safe TypeScript string literal. */
export const str = (value: string) => JSON.stringify(value)

/** Escapes text for a JSX text node or JS template literal. */
export const jsText = (value: string) => value.replace(/[\\`$]/g, '\\$&')

/** Wraps prose as a JSDoc block at the given indent, or returns '' when empty. */
export function docComment(lines: (string | undefined)[], indent = ''): string {
  const content = lines.filter((l): l is string => Boolean(l && l.trim()))
  if (content.length === 0) return ''
  if (content.length === 1 && content[0]!.length < 80) return `${indent}/** ${content[0]} */\n`
  const body = content.flatMap((l) => l.split('\n')).map((l) => `${indent} * ${l}`)
  return `${indent}/**\n${body.join('\n')}\n${indent} */\n`
}

/**
 * Two names with nothing between them, e.g. `Project List Response`.
 *
 * `A | B`, `Foo[]` and `Record<string, unknown>` all have punctuation between
 * their names and so do not match.
 */
const UNSPACED = /[A-Za-z_$][\w$]*\s+[A-Za-z_$]/

/**
 * Whether a string can stand where TypeScript expects a type.
 *
 * Documents describe types the way people talk — `UUID/String`, `Project List
 * Response`, `array of Task` — and every one of those emits a file that does
 * not parse, which takes the rest of the file with it. The rule is therefore
 * permissive about shape and strict about characters: anything a type
 * expression cannot contain means this is prose, not a type.
 */
function isTypeExpression(type: string): boolean {
  // String-literal members are legitimate; take them out before judging.
  const skeleton = type.replace(/'[^']*'|"[^"]*"/g, 'S')
  if (!/^[A-Za-z0-9_$ .,|&<>[\]]+$/.test(skeleton)) return false
  if (UNSPACED.test(skeleton)) return false

  let angle = 0
  let square = 0
  for (const char of skeleton) {
    if (char === '<') angle++
    else if (char === '>') angle--
    else if (char === '[') square++
    else if (char === ']') square--
    if (angle < 0 || square < 0) return false
  }
  return angle === 0 && square === 0
}

/**
 * The primitive a prose type names, when it names one.
 *
 * `UUID/String` is a statement that the value is a string, and reading it as
 * one is copying what the document says rather than guessing. Only reached for
 * a type that could not be used as written, so nothing valid is reinterpreted.
 */
export function primitiveFrom(raw: string): string | undefined {
  const text = raw.toLowerCase()
  if (/\b(bool|boolean)\b/.test(text)) return 'boolean'
  if (/\b(number|integer|int|float|double|decimal|long|money|amount)\b/.test(text)) return 'number'
  if (/\b(string|uuid|guid|text|char|date|datetime|timestamp|iso|email|url)\b/.test(text)) return 'string'
  return undefined
}

/**
 * Normalises a type string produced during extraction into valid TypeScript.
 *
 * Unknown or empty types become `unknown` rather than `any`, so the generated
 * screens are forced to narrow before use — except where the caller knows
 * better: a path or query parameter is spelled into a URL, so `string` is both
 * true and usable where `unknown` would only move the error.
 *
 * `withSafeTypeNames` resolves names against the declared entities before any
 * of this. What follows is the last gate rather than the first: emitted
 * infrastructure that does not parse is the one failure the design is supposed
 * to make impossible, so it is worth refusing twice.
 */
/**
 * How documentation spells a primitive, and what it means in TypeScript.
 *
 * Matched without regard to case, because `String` is what a field table
 * usually says and it is not a harmless variant: `String` is a real
 * TypeScript type — the boxed wrapper — so it compiles as a parameter and then
 * fails where the value is used, "Type 'String' is not assignable to type
 * 'string'". A type that is right in the signature and wrong at the call site
 * is worse than one that is obviously wrong.
 *
 * Dates map to `string` because JSON has no date: the documented examples send
 * `"2026-10-01"`, and that is what the client must hold.
 */
const PRIMITIVES: Record<string, string> = {
  string: 'string',
  str: 'string',
  text: 'string',
  char: 'string',
  uuid: 'string',
  guid: 'string',
  date: 'string',
  datetime: 'string',
  timestamp: 'string',
  time: 'string',
  email: 'string',
  url: 'string',
  uri: 'string',
  number: 'number',
  int: 'number',
  integer: 'number',
  float: 'number',
  double: 'number',
  long: 'number',
  short: 'number',
  decimal: 'number',
  bool: 'boolean',
  boolean: 'boolean',
  object: 'Record<string, unknown>',
  json: 'Record<string, unknown>',
  array: 'unknown[]',
  file: 'Blob',
  binary: 'Blob',
  null: 'null',
  unknown: 'unknown',
  any: 'unknown',
  void: 'void',
}

export function toTsType(raw: string | undefined, fallback = 'unknown'): string {
  const type = (raw ?? '').trim()
  if (!type) return fallback

  const primitive = PRIMITIVES[type.toLowerCase()]
  if (primitive) return primitive

  if (isTypeExpression(type)) return type

  // Not usable as written. Read the primitive the words name, or give the
  // caller's fallback — never the prose itself.
  return primitiveFrom(type) ?? fallback
}
