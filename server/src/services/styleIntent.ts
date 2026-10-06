/**
 * Reading "make it blue" and "smaller font" out of a fix or refine note.
 *
 * A screen cannot change either: every colour in a generated app is mixed from
 * one accent token and every text size is relative to one root size, so the
 * model asked to "make it blue" adds pale classes the kit's own styles
 * override, and the person sees nothing happen. These two are app settings,
 * and a note that asks for them is applied as one — the rest of the note, if
 * there is any, still goes to the model.
 */
import type { TextSize } from '../types.js'

const COLOURS: [RegExp, string, string][] = [
  [/\b(navy|dark blue)\b/i, 'Navy', '#1E3A8A'],
  [/\b(sky|light blue)\b/i, 'Sky', '#0EA5E9'],
  [/\bblue\b/i, 'Blue', '#2563EB'],
  [/\bindigo\b/i, 'Indigo', '#4F46E5'],
  [/\b(purple|violet|lavender)\b/i, 'Purple', '#7C3AED'],
  [/\b(teal|cyan|turquoise)\b/i, 'Teal', '#0D9488'],
  [/\bgreen\b/i, 'Green', '#16A34A'],
  [/\borange\b/i, 'Orange', '#EA580C'],
  [/\b(red|crimson)\b/i, 'Red', '#DC2626'],
  [/\b(pink|rose)\b/i, 'Rose', '#E11D48'],
  [/\b(gr[ae]y|slate)\b/i, 'Slate', '#475569'],
]

// A colour word only counts as a theme request when the note is about colour,
// not when "red" describes an error message the person wants shown.
const ABOUT_COLOUR = /\b(colou?r|theme|palette|accent|make (it|this|the app|everything)|turn)\b/i
const HEX = /#([0-9a-f]{6})\b/i

const ABOUT_TEXT = /\b(font|text|letters?|type(face)?|size)\b/i
const SMALLER = /\b(smaller|small|reduce|decrease|less|shrink|tiny|compact|minimi[sz]e)\b/i
const LARGER = /\b(bigger|big|larger|large|increase|enlarge|more|grow|readable)\b/i
const NORMAL = /\b(normal|default|regular|reset|original)\b/i

/** Words that carry no instruction once the colour and size are taken out. */
const FILLER =
  /\b(the|a|an|and|to|in|on|of|it|this|that|all|app|ui|page|pages|screen|screens|whole|entire|please|pls|plz|make|set|change|use|add|apply|give|want|i|we|me|should|be|with|font|fonts|text|size|sizes|colou?r|colou?rs|theme|palette|accent|little|bit|slightly|much|lot|everything|bro|now|also|turn|into)\b/gi

export interface StyleIntent {
  accent?: { name: string; hex: string }
  textSize?: TextSize
  /** True when nothing but colour and size was asked, so no screen needs the model. */
  styleOnly: boolean
}

export function readStyleIntent(note: string): StyleIntent {
  let rest = note
  const intent: StyleIntent = { styleOnly: false }

  const hex = HEX.exec(note)
  if (hex) {
    intent.accent = { name: `#${hex[1]!.toUpperCase()}`, hex: `#${hex[1]!.toUpperCase()}` }
    rest = rest.replace(HEX, ' ')
  } else if (ABOUT_COLOUR.test(note)) {
    for (const [pattern, name, value] of COLOURS) {
      if (pattern.test(note)) {
        intent.accent = { name, hex: value }
        rest = rest.replace(pattern, ' ')
        break
      }
    }
  }

  if (ABOUT_TEXT.test(note)) {
    const size = NORMAL.test(note) ? 'default' : SMALLER.test(note) ? 'small' : LARGER.test(note) ? 'large' : undefined
    if (size) {
      intent.textSize = size
      rest = rest.replace(NORMAL, ' ').replace(SMALLER, ' ').replace(LARGER, ' ')
    }
  }

  if (intent.accent || intent.textSize) {
    const left = rest.replace(FILLER, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    intent.styleOnly = left.split(/\s+/).filter(Boolean).length <= 1
  }
  return intent
}
