import { z } from 'zod'
import { chatJson } from './azure.js'
import type { AppPlan, BrandTheme } from '../types.js'

/*
 * Reading a brand out of whatever style document someone has.
 *
 * A stylesheet states its colours outright; a brand guide in Markdown or a PDF
 * says "our primary blue is #0B5FFF, headings in Montserrat" in prose. The
 * model reads both. What it returns is then treated as untrusted, because every
 * value is written into CSS: a colour is accepted only if it parses as one, a
 * font name only if it is a font name.
 */

/* ------------------------------------------------------------------ */
/* Sanitising                                                          */
/* ------------------------------------------------------------------ */

const COLOR =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(\s*[-0-9.%,\s/a-z]+\))$/i

export function safeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  return v.length <= 64 && COLOR.test(v) ? v : undefined
}

/** A single family name, without quotes or fallbacks. */
export function safeFontName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const first = value.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '').trim()
  if (!first || first.length > 60 || !/^[a-z0-9][a-z0-9 \-_.]*$/i.test(first)) return undefined
  // Generic keywords are not a brand font; the fallback stack already has them.
  if (/^(sans-serif|serif|monospace|system-ui|ui-sans-serif|inherit|initial)$/i.test(first)) return undefined
  return first
}

function safeFontUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  return /^https:\/\/fonts\.googleapis\.com\/css2?\?[^\s"'()<>;{}\\]+$/.test(v) && v.length < 600 ? v : undefined
}

function safeNumber(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10) / 10 : undefined
}

/** A Google Fonts URL for families the document named but never linked. */
function googleFontsUrl(families: string[]): string | undefined {
  const unique = [...new Set(families)]
  if (unique.length === 0) return undefined
  const params = unique.map((f) => `family=${f.replace(/ /g, '+')}:wght@400;500;600;700`).join('&')
  return `https://fonts.googleapis.com/css2?${params}&display=swap`
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

const loose = z.string().nullish().catch(undefined)

const extractSchema = z.object({
  colors: z
    .object({
      primary: loose,
      background: loose,
      text: loose,
      muted: loose,
      border: loose,
      danger: loose,
      success: loose,
    })
    .default({}),
  font: z
    .object({
      body: loose,
      heading: loose,
      url: loose,
      baseSize: z.union([z.number(), z.string()]).nullish().catch(undefined),
    })
    .default({}),
  radius: z.union([z.number(), z.string()]).nullish().catch(undefined),
  notes: z.array(z.string()).catch([]).default([]),
})

const EXTRACT_SYSTEM = `You read a brand or style document — a CSS/SCSS stylesheet, a design-token
file, a Markdown or text brand guide, an HTML page — and report the visual theme
it defines, so a generated web app can match it exactly.

Return a JSON object:
{
  "colors": {
    "primary":    the main brand / action colour (buttons, links, highlights),
    "background": the page background colour,
    "text":       the main body text colour,
    "muted":      the secondary text colour (captions, labels, hints),
    "border":     the border / divider colour,
    "danger":     the error colour,
    "success":    the success colour
  },
  "font": {
    "body":     the body font family name, e.g. "Inter" — the family only, no fallbacks,
    "heading":  the heading font family, if different from body,
    "url":      a https://fonts.googleapis.com/css2?... stylesheet URL, ONLY if the document contains one,
    "baseSize": the base / body font size in px, as a number (1rem = 16px)
  },
  "radius": the corner radius of a standard button or input, in px, as a number,
  "notes": up to 8 short, concrete style rules the values above cannot express —
           e.g. "Buttons use uppercase labels", "Cards are flat with no shadow",
           "Headings are bold and tight". Only rules the document actually states.
}

Rules:
- Colours as hex (#RRGGBB) where the document gives hex; otherwise rgb()/hsl() as written.
- Resolve CSS variables: if --brand: #123456 and button { background: var(--brand) }, primary is #123456.
- Report only what the document states or clearly implies. Use null for anything it does not define.
  Never invent a brand colour — if nothing reads as a primary colour, pick the most prominent one used.`

/** Hints read directly from CSS, so the model is not relied on to spot them. */
function cssHints(text: string): string {
  const vars = [...text.matchAll(/(--[\w-]+)\s*:\s*([^;}{\n]+)/g)]
    .slice(0, 80)
    .map((m) => `${m[1]}: ${m[2]!.trim()}`)
  const fonts = [...new Set([...text.matchAll(/font-family\s*:\s*([^;}{\n]+)/gi)].map((m) => m[1]!.trim()))].slice(0, 10)
  const imports = [...new Set(text.match(/https:\/\/fonts\.googleapis\.com\/css2?\?[^\s"')]+/g) ?? [])].slice(0, 5)
  const parts = [
    vars.length ? `CSS custom properties:\n${vars.join('\n')}` : '',
    fonts.length ? `font-family declarations:\n${fonts.join('\n')}` : '',
    imports.length ? `Font stylesheet URLs:\n${imports.join('\n')}` : '',
  ].filter(Boolean)
  return parts.join('\n\n')
}

export async function extractBrandTheme(documents: { filename: string; text: string }[]): Promise<BrandTheme> {
  const readable = documents.filter((d) => d.text.trim())
  if (readable.length === 0) throw new Error('None of the theme files contained readable text')

  const share = Math.floor(40_000 / readable.length)
  const body = readable.map((d) => `=== ${d.filename} ===\n${d.text.slice(0, share)}`).join('\n\n')
  const hints = cssHints(readable.map((d) => d.text).join('\n'))

  const raw = await chatJson({
    system: EXTRACT_SYSTEM,
    user: `${hints ? `${hints}\n\n` : ''}DOCUMENTS\n${body}`,
    schema: extractSchema,
    temperature: 0,
    maxTokens: 2000,
  })

  const primary = safeColor(raw.colors.primary)
  if (!primary) throw new Error('Could not find a brand colour in the theme file')

  const colors: BrandTheme['colors'] = { primary }
  for (const key of ['background', 'text', 'muted', 'border', 'danger', 'success'] as const) {
    const value = safeColor(raw.colors[key])
    if (value) colors[key] = value
  }

  const bodyFont = safeFontName(raw.font.body)
  const headingFont = safeFontName(raw.font.heading)
  const families = [bodyFont, headingFont].filter((f): f is string => Boolean(f))
  const font: NonNullable<BrandTheme['font']> = {}
  if (bodyFont) font.body = bodyFont
  if (headingFont && headingFont !== bodyFont) font.heading = headingFont
  const url = safeFontUrl(raw.font.url) ?? googleFontsUrl(families)
  if (url) font.url = url
  const baseSize = safeNumber(raw.font.baseSize, 10, 24)
  if (baseSize) font.baseSize = baseSize

  const radius = safeNumber(raw.radius, 0, 40)

  return {
    sources: readable.map((d) => d.filename),
    extractedAt: new Date().toISOString(),
    colors,
    ...(Object.keys(font).length ? { font } : {}),
    ...(radius !== undefined ? { radius } : {}),
    notes: raw.notes
      .map((n) => n.replace(/\s+/g, ' ').trim())
      .filter((n) => n.length > 0 && n.length <= 200)
      .slice(0, 8),
  }
}

/* ------------------------------------------------------------------ */
/* Applying it                                                         */
/* ------------------------------------------------------------------ */

const BRAND_NOTE = 'Brand style: '

/**
 * Puts the brand on a plan: its colour becomes the accent and its rules become
 * design notes every screen is written against. Idempotent, so a reused plan
 * can be re-branded — or un-branded — without collecting stale notes.
 */
export function applyBrand(plan: AppPlan, brand: BrandTheme | undefined): void {
  plan.designNotes = plan.designNotes.filter((n) => !n.startsWith(BRAND_NOTE))
  if (!brand) {
    delete plan.theme.brand
    return
  }
  plan.theme.brand = brand
  plan.theme.accent = brand.colors.primary
  plan.designNotes.unshift(
    `${BRAND_NOTE}the app follows an uploaded brand theme. Its colours, fonts, sizes and radii are already set in the theme tokens — use the kit and the accent/line/canvas tokens, never hard-coded hex colours, font families or pixel font sizes.`,
    ...brand.notes.map((n) => `${BRAND_NOTE}${n}`),
  )
}

export const DEFAULT_FONT_STACK = `'Plus Jakarta Sans', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`
export const DEFAULT_FONT_URL =
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'

export function fontStack(family: string | undefined): string {
  return family ? `'${family}', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif` : DEFAULT_FONT_STACK
}

/**
 * Tailwind theme tokens the brand overrides.
 *
 * The kit is written in slate, rose, emerald and rounded-* utilities; redefining
 * those tokens re-skins every component without touching a line of it — and
 * without asking the model to remember a second vocabulary.
 */
export function brandTokens(brand: BrandTheme | undefined): string[] {
  if (!brand) return []
  const { colors, font, radius } = brand
  const lines: string[] = []
  if (font?.heading) lines.push(`--font-heading: ${fontStack(font.heading)};`)
  if (font?.baseSize) lines.push(`--brand-root-size: ${font.baseSize}px;`)
  if (colors.background) lines.push(`--color-canvas: ${colors.background};`)
  if (colors.border) lines.push(`--color-line: ${colors.border};`)
  if (colors.text) {
    lines.push(
      `--color-slate-900: ${colors.text};`,
      `--color-slate-800: ${colors.text};`,
      `--color-slate-700: color-mix(in oklab, ${colors.text} 85%, white);`,
    )
  }
  if (colors.muted) {
    lines.push(
      `--color-slate-600: ${colors.muted};`,
      `--color-slate-500: ${colors.muted};`,
      `--color-slate-400: color-mix(in oklab, ${colors.muted} 70%, white);`,
    )
  }
  if (colors.danger) {
    lines.push(
      `--color-rose-700: color-mix(in oklab, ${colors.danger} 80%, black);`,
      `--color-rose-600: ${colors.danger};`,
      `--color-rose-500: ${colors.danger};`,
      `--color-rose-100: color-mix(in oklab, ${colors.danger} 18%, white);`,
      `--color-rose-50: color-mix(in oklab, ${colors.danger} 8%, white);`,
    )
  }
  if (colors.success) {
    lines.push(
      `--color-emerald-700: color-mix(in oklab, ${colors.success} 80%, black);`,
      `--color-emerald-600: ${colors.success};`,
      `--color-emerald-500: ${colors.success};`,
      `--color-emerald-100: color-mix(in oklab, ${colors.success} 18%, white);`,
      `--color-emerald-50: color-mix(in oklab, ${colors.success} 8%, white);`,
    )
  }
  if (radius !== undefined) {
    // Scaled from Tailwind's own ratios, taking rounded-lg (8px) as "a control".
    const f = radius / 8
    const px = (n: number) => `${Math.round(n * f * 10) / 10}px`
    lines.push(
      `--radius-sm: ${px(4)};`,
      `--radius-md: ${px(6)};`,
      `--radius-lg: ${px(8)};`,
      `--radius-xl: ${px(12)};`,
      `--radius-2xl: ${px(16)};`,
      `--radius-3xl: ${px(24)};`,
    )
  }
  return lines
}
