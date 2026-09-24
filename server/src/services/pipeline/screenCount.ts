/**
 * Counts screen headings in a document, independently of the model.
 *
 * Asked to extract screens, a model can quietly return the first one and stop.
 * Nothing downstream can tell — a plan with one screen looks exactly like a
 * document that described one screen. Counting the headings directly turns a
 * silent omission into a reported one.
 *
 * Deliberately conservative: it only counts headings that clearly announce a
 * screen, so a miscount reads as "we found fewer than expected", never as a
 * demand to invent screens that are not there.
 */

/** `### Screen 2.1 - Basic Case Info`, `# UI 2 – Policy Result`, `## Page 3: X` */
const SCREEN_HEADING =
  /^#{1,6}\s*(?:screen|ui|page|scr)\b[\s.:#-]*[\d.]*\s*[-–—:]?\s*(.+?)\s*$/gim

export interface ScreenHeading {
  title: string
  raw: string
}

export function findScreenHeadings(text: string): ScreenHeading[] {
  const found: ScreenHeading[] = []
  const seen = new Set<string>()

  for (const match of text.matchAll(SCREEN_HEADING)) {
    const title = (match[1] ?? '').trim()
    // A heading that is only a number, a bullet, or absurdly long is not a
    // screen name — those come from list items caught by a loose match.
    if (!title || title.length > 90) continue
    if (/^[\d.\s-]+$/.test(title)) continue
    if (/^[*+•\-]/.test(title)) continue
    // "#### UI Merge Logic (`saveCaseInfo()` in index.html)" opens with "UI" and
    // is prose about code, not a screen. Backticks and call syntax give it away.
    if (/[`(]/.test(title)) continue

    const normalised = title.toLowerCase().replace(/\s+/g, ' ')
    if (seen.has(normalised)) continue
    seen.add(normalised)

    found.push({ title, raw: match[0].trim() })
  }

  return found
}

/** How the extracted screens compare with the headings actually present. */
export function compareScreenCounts(
  documentText: string,
  extractedNames: string[],
): { expected: ScreenHeading[]; missing: ScreenHeading[] } {
  const expected = findScreenHeadings(documentText)
  const extracted = extractedNames.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())

  const missing = expected.filter((heading) => {
    const title = heading.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    // Either direction counts as a match: models drop or add qualifiers.
    return !extracted.some((name) => name.includes(title) || title.includes(name))
  })

  return { expected, missing }
}
