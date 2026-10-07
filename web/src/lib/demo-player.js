/*
 * The demo player, loaded into the preview as-is.
 *
 * It drives the generated app the way a person would: a visible cursor moves to
 * each empty field and types into it, then clicks the button that moves the
 * journey on, screen after screen, until nothing new is left to press. While it
 * runs, the studio answers every API call with sample data, so nothing real is
 * called and nothing can fail or change.
 *
 * Plain JavaScript on purpose: it is shipped into someone else's bundle and
 * must not depend on anything that bundle may or may not have.
 */

const MSG = '__spec2ui'
let running = false
let stopped = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const post = (type, extra = {}) => window.parent?.postMessage({ [MSG]: type, ...extra }, '*')

/* ------------------------------ overlay -------------------------------- */

let cursor, caption
function overlay() {
  if (cursor) return
  cursor = document.createElement('div')
  cursor.setAttribute('aria-hidden', 'true')
  Object.assign(cursor.style, {
    position: 'fixed', left: '50%', top: '40%', width: '22px', height: '22px', zIndex: 2147483647,
    pointerEvents: 'none', transition: 'left .6s cubic-bezier(.22,1,.36,1), top .6s cubic-bezier(.22,1,.36,1), transform .15s',
    background: 'radial-gradient(circle at 35% 35%, #fff 0 18%, var(--color-accent, #6C63FF) 22% 100%)',
    borderRadius: '50%', boxShadow: '0 4px 14px rgb(0 0 0 / .25)', transform: 'translate(-50%,-50%)',
  })
  caption = document.createElement('div')
  Object.assign(caption.style, {
    position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)', zIndex: 2147483647,
    pointerEvents: 'none', maxWidth: '86%', padding: '9px 16px', borderRadius: '999px',
    background: 'rgb(17 17 34 / .86)', color: '#fff', font: '600 13px/1.35 system-ui, sans-serif',
    boxShadow: '0 8px 24px rgb(0 0 0 / .2)', textAlign: 'center',
  })
  document.body.append(cursor, caption)
}

function say(text) {
  overlay()
  caption.textContent = `▶ Demo · ${text}`
  post('demo-progress', { text })
}

function clear() {
  cursor?.remove()
  caption?.remove()
  cursor = caption = undefined
}

async function pointAt(el) {
  overlay()
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await sleep(350)
  const r = el.getBoundingClientRect()
  cursor.style.left = `${r.left + Math.min(r.width / 2, 60)}px`
  cursor.style.top = `${r.top + r.height / 2}px`
  await sleep(650)
}

function flash(el) {
  const before = el.style.outline
  el.style.outline = '3px solid var(--color-accent, #6C63FF)'
  el.style.outlineOffset = '2px'
  setTimeout(() => (el.style.outline = before), 700)
}

/* ------------------------------- fields -------------------------------- */

const visible = (el) => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
}

function labelOf(el) {
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
    if (label) return label.textContent
  }
  const wrapping = el.closest('label')
  if (wrapping) return wrapping.textContent
  // The kit's Field puts the label just before the control, in the same wrapper.
  let node = el
  for (let i = 0; i < 3 && node; i++) {
    node = node.parentElement
    const label = node?.querySelector('label, [data-label]')
    if (label && !label.contains(el)) return label.textContent
  }
  return el.getAttribute('aria-label') || el.placeholder || ''
}

function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return d.toISOString().slice(0, 10)
}

/** A value for one field: what the studio knows first, then something plausible for its kind. */
function valueFor(el, values) {
  const label = labelOf(el)
  const keys = [el.name, el.id, label, el.placeholder].map(norm).filter(Boolean)
  for (const key of keys) if (values[key] !== undefined) return values[key]
  for (const key of keys) {
    const hit = Object.keys(values).find((k) => k.length > 3 && (key.includes(k) || k.includes(key)))
    if (hit) return values[hit]
  }

  const type = (el.type || '').toLowerCase()
  const words = norm(label)
  if (type === 'date') return today()
  if (type === 'datetime-local') return `${today()}T09:00`
  if (type === 'time') return '09:00'
  if (type === 'email' || /email/.test(words)) return 'demo@example.com'
  if (type === 'tel' || /phone|mobile/.test(words)) return '9876543210'
  if (type === 'number' || /amount|premium|sum|age|qty|quantity|count/.test(words)) return '1000'
  if (/date/.test(words)) return today()
  if (/policy|proposal|number|no$|id$|code/.test(words)) return '1055864001'
  if (/name/.test(words)) return 'Alex Demo'
  if (el.tagName === 'TEXTAREA') return 'Sample text for the demo'
  return 'Sample'
}

/** Sets a React-controlled value so React sees it as typed. */
function setValue(el, value) {
  const proto =
    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

async function fill(el, values) {
  if (el.tagName === 'SELECT') {
    const options = [...el.options].filter((o) => o.value && !o.disabled)
    if (options.length === 0) return
    await pointAt(el)
    const wanted = valueFor(el, values)
    const pick = options.find((o) => norm(o.value) === norm(wanted) || norm(o.text) === norm(wanted)) ?? options[0]
    say(`Choosing “${pick.text.trim()}”`)
    setValue(el, pick.value)
    return
  }
  if (el.type === 'checkbox' || el.type === 'radio') {
    if (!el.required || el.checked) return
    await pointAt(el)
    el.click()
    return
  }

  const value = String(valueFor(el, values))
  await pointAt(el)
  const name = labelOf(el).trim().replace(/\s*\*$/, '') || 'a field'
  say(`Filling ${name}`)
  el.focus()
  if (['date', 'datetime-local', 'time', 'month', 'week', 'color', 'range'].includes(el.type)) {
    setValue(el, value)
  } else {
    let typed = ''
    for (const ch of value.slice(0, 40)) {
      typed += ch
      setValue(el, typed)
      await sleep(35)
    }
  }
  el.blur()
}

function emptyFields(root) {
  return [...root.querySelectorAll('input, select, textarea')].filter((el) => {
    if (el.disabled || el.readOnly || !visible(el)) return false
    const type = (el.type || '').toLowerCase()
    if (['hidden', 'submit', 'button', 'file', 'search'].includes(type) && !el.required) return false
    if (type === 'checkbox' || type === 'radio') return el.required && !el.checked
    if (el.tagName === 'SELECT') return !el.value
    return !el.value
  })
}

/* ------------------------------- actions ------------------------------- */

const AVOID = /\b(back|cancel|reset|clear|close|delete|remove|log ?out|sign ?out|previous|prev|start over|new search|edit|retry|dismiss|discard)\b/i
const FORWARD = /\b(next|continue|proceed|search|find|submit|calculat|quot|get|confirm|execut|finish|save|apply|view|open|go|run|check|review|done|create|add|register|issue|pay|send|load)/i

function nextAction(root, pressed) {
  const page = location.pathname
  const candidates = [...root.querySelectorAll('button, a[href], [role="button"]')].filter((el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !visible(el)) return false
    const text = (el.textContent || el.getAttribute('aria-label') || '').trim()
    if (!text || AVOID.test(text)) return false
    return !pressed.has(`${page}::${text}`)
  })

  const score = (el) => {
    const text = el.textContent.trim()
    let s = 0
    if (FORWARD.test(text)) s += 3
    if (/bg-accent|bg-primary/.test(el.className)) s += 2
    if (el.type === 'submit') s += 2
    if (el.tagName === 'A') s -= 1
    return s
  }
  const best = candidates.sort((a, b) => score(b) - score(a))[0]
  if (best && score(best) > 0) return best

  // A list whose rows open a detail screen.
  const row = root.querySelector('tr.cursor-pointer, [class*="cursor-pointer"] tr, tbody tr[class*="cursor-pointer"]')
  if (row && !pressed.has(`${page}::row`)) return row
  return best
}

/** Waits for loading to finish and the page to stop changing. */
async function settle(maxMs = 7000) {
  const started = Date.now()
  let last = Date.now()
  const observer = new MutationObserver(() => (last = Date.now()))
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  try {
    while (Date.now() - started < maxMs) {
      const busy = document.querySelector('.animate-spin, [aria-busy="true"]')
      if (!busy && Date.now() - last > 500) return
      await sleep(120)
    }
  } finally {
    observer.disconnect()
  }
}

/* ------------------------------ showing -------------------------------- */

const shown = new WeakSet()

/** The element that scrolls the page: the document, or a scrolling panel around main. */
function scroller() {
  const doc = document.scrollingElement || document.documentElement
  if (doc.scrollHeight > window.innerHeight + 4) return doc
  let el = document.querySelector('main')
  while (el && el !== document.body) {
    const style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4) return el
    el = el.parentElement
  }
  return doc
}

/**
 * Lets the viewer see what a step brought back: each new table, detail list
 * or summary is brought into view and outlined, then the page is scrolled
 * slowly to the bottom so nothing below the fold goes unseen.
 */
async function showData(root) {
  const fresh = [...root.querySelectorAll('table, dl, [role="table"]')].filter((el) => visible(el) && !shown.has(el))
  for (const el of fresh.slice(0, 4)) {
    if (stopped) return
    shown.add(el)
    const rows = el.querySelectorAll('tbody tr').length
    say(rows > 0 ? `Showing ${rows} row${rows === 1 ? '' : 's'} of data` : 'Showing the details')
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    await sleep(500)
    flash(el)
    await sleep(1600)
  }

  const box = scroller()
  const viewport = box === (document.scrollingElement || document.documentElement) ? window.innerHeight : box.clientHeight
  if (box.scrollHeight - box.scrollTop - viewport > 40) {
    say('Scrolling through the page')
    for (let i = 0; i < 30 && !stopped && box.scrollTop + viewport < box.scrollHeight - 4; i++) {
      box.scrollBy({ top: Math.max(160, viewport * 0.45), behavior: 'smooth' })
      await sleep(550)
    }
    await sleep(700)
  }
}

async function run(values) {
  running = true
  stopped = false
  const pressed = new Set()
  say('Starting the journey with sample data')
  // The app mounts once Tailwind loads, which can be a moment after this file.
  for (let i = 0; i < 60 && !document.querySelector('main'); i++) await sleep(150)
  await sleep(900)

  try {
    for (let step = 0; step < 40 && !stopped; step++) {
      await settle()
      const root = document.querySelector('main') || document.body
      // What the last click brought back is worth a look before moving on.
      if (step > 0) await showData(root)
      if (stopped) break

      for (const el of emptyFields(root)) {
        if (stopped) break
        await fill(el, values)
        await sleep(150)
      }
      if (stopped) break

      const action = nextAction(root, pressed)
      if (!action) {
        // The last screen's data, before saying the journey is over.
        await showData(root)
        break
      }
      const text = action.tagName === 'TR' ? 'row' : action.textContent.trim().slice(0, 40)
      pressed.add(`${location.pathname}::${text}`)
      await pointAt(action)
      say(action.tagName === 'TR' ? 'Opening the first row' : `Clicking “${text}”`)
      cursor.style.transform = 'translate(-50%,-50%) scale(.8)'
      flash(action)
      await sleep(180)
      cursor.style.transform = 'translate(-50%,-50%)'
      action.click()
      await sleep(900)
    }
    say(stopped ? 'Stopped' : 'Journey complete')
    post('demo-done', { stopped })
    await sleep(2200)
  } catch (err) {
    post('demo-done', { error: String(err?.message ?? err) })
  } finally {
    running = false
    clear()
  }
}

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data[MSG] === 'demo-start' && !running) void run(data.values ?? {})
  if (data[MSG] === 'demo-stop') stopped = true
})

// Keys typed inside the app never reach the window around it, so Esc — stop
// recording, stop the demo — is passed up from here.
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Escape') post('demo-escape')
  },
  true,
)

// Tells the studio the player is listening, once the app has actually mounted —
// not while the preview is still showing its loading screen.
const announce = () => (document.querySelector('main') ? post('demo-ready') : setTimeout(announce, 150))
announce()
