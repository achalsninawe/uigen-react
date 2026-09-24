import path from 'node:path'
import yaml from 'js-yaml'
import SwaggerParser from '@apidevtools/swagger-parser'
import { looksLikePostman } from './postman.js'
import type { SourceKind } from '../../types.js'

export interface ParsedFile {
  kind: SourceKind
  /** Plain text handed to the model. */
  text: string
  /** Present only for OpenAPI documents: the fully dereferenced spec. */
  openapi?: unknown
  /** Present only for Postman collections: the parsed collection. */
  postman?: unknown
  error?: string
}

const EXT_KIND: Record<string, SourceKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.json': 'json',
  '.yaml': 'json',
  '.yml': 'json',
  '.pdf': 'pdf',
  '.docx': 'docx',
}

function looksLikeOpenAPI(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false
  const d = doc as Record<string, unknown>
  return (typeof d.openapi === 'string' || typeof d.swagger === 'string') && typeof d.paths === 'object'
}

async function parseStructured(raw: string): Promise<ParsedFile> {
  let doc: unknown
  try {
    // js-yaml reads JSON too, so one path covers both .json and .yaml.
    doc = yaml.load(raw)
  } catch (err) {
    return { kind: 'json', text: raw, error: `Could not parse as JSON/YAML: ${(err as Error).message}` }
  }

  // A collection is machine-readable too, and reading it as prose mangles the
  // split-up URLs it stores.
  if (looksLikePostman(doc)) return { kind: 'postman', text: raw, postman: doc }

  if (!looksLikeOpenAPI(doc)) {
    // Structured but not OpenAPI — still useful context, pass the text through.
    return { kind: 'json', text: raw }
  }

  try {
    // dereference() resolves $ref so downstream code sees complete schemas.
    // The doc is cloned first because the parser mutates what it's given.
    const api = await SwaggerParser.dereference(JSON.parse(JSON.stringify(doc)) as never)
    return { kind: 'openapi', text: raw, openapi: api }
  } catch (err) {
    // A spec that fails strict validation is still worth reading — fall back to
    // the raw document and let the model work from it.
    return {
      kind: 'openapi',
      text: raw,
      openapi: doc,
      error: `OpenAPI did not fully validate, using it as-is: ${(err as Error).message}`,
    }
  }
}

async function parsePdf(buffer: Buffer): Promise<ParsedFile> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const { text } = await extractText(pdf, { mergePages: true })
    const merged = Array.isArray(text) ? text.join('\n\n') : text
    if (!merged.trim()) {
      return { kind: 'pdf', text: '', error: 'No selectable text found — the PDF may be scanned images.' }
    }
    return { kind: 'pdf', text: merged }
  } catch (err) {
    return { kind: 'pdf', text: '', error: `Could not read PDF: ${(err as Error).message}` }
  }
}

async function parseDocx(buffer: Buffer): Promise<ParsedFile> {
  try {
    const mammoth = await import('mammoth')
    const { value } = await mammoth.extractRawText({ buffer })
    return { kind: 'docx', text: value }
  } catch (err) {
    return { kind: 'docx', text: '', error: `Could not read DOCX: ${(err as Error).message}` }
  }
}

export async function parseFile(filename: string, buffer: Buffer): Promise<ParsedFile> {
  const ext = path.extname(filename).toLowerCase()
  const kind = EXT_KIND[ext] ?? 'unknown'

  switch (kind) {
    case 'pdf':
      return parsePdf(buffer)
    case 'docx':
      return parseDocx(buffer)
    case 'json':
      return parseStructured(buffer.toString('utf8'))
    case 'markdown':
    case 'text':
      return { kind, text: buffer.toString('utf8') }
    default: {
      // Unknown extension: if it reads as text, keep it; otherwise reject.
      const text = buffer.toString('utf8')
      const printable = text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '').length / Math.max(text.length, 1)
      if (printable < 0.85) {
        return { kind: 'unknown', text: '', error: `Unsupported file type ${ext || '(none)'}` }
      }
      return looksLikeOpenAPIText(text) ? parseStructured(text) : { kind: 'text', text }
    }
  }
}

function looksLikeOpenAPIText(text: string) {
  return /^\s*[{-]|^\s*(openapi|swagger)\s*:/m.test(text)
}
