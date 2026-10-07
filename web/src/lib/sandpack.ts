import type { GeneratedFile } from './types'
import DEMO_PLAYER from './demo-player.js?raw'

/**
 * Translates the stored Vite project into a file set Sandpack can run.
 *
 * Sandpack bundles in the browser with no build step, so two things from the
 * real project cannot come along: Tailwind's PostCSS pipeline, and Vite's
 * index.html entry convention. Tailwind is swapped for its browser build from a
 * CDN, and the HTML shell is replaced. Everything else — the API client, the
 * component kit, every screen — is byte-for-byte what gets exported.
 */

/** Files that only make sense to a real build, and confuse the in-browser one. */
const SKIP = new Set([
  'vite.config.ts',
  'tsconfig.json',
  'index.html',
  'README.md',
  'package.json',
  // The preview has its own entry and mounts the app itself; shipping the app's
  // Vite entry as well gives the bundler two entry points to choose between.
  'src/main.tsx',
])

const DEFAULT_FONT_URL =
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'

const FALLBACK_THEME = `--font-sans: 'Plus Jakarta Sans', 'Inter', ui-sans-serif, system-ui, sans-serif;
    --color-accent: #6C63FF;
    --color-accent-soft: color-mix(in oklab, var(--color-accent) 16%, white);
    --color-accent-tint: color-mix(in oklab, var(--color-accent) 6%, white);
    --color-accent-deep: color-mix(in oklab, var(--color-accent) 58%, #12101f);
    --color-canvas: color-mix(in oklab, var(--color-accent) 4%, white);
    --color-line: color-mix(in oklab, var(--color-accent) 14%, white);`

/**
 * The emitted stylesheet's whole @theme block, not just its accent.
 *
 * The palette is a set of tokens mixed from one colour — the canvas, the
 * hairlines, the washes, the dark summary panel — and copying only the accent
 * left the preview rendering every one of those as nothing, so the app it
 * showed was not the app that would be exported. Taking the block verbatim is
 * also what stops the two definitions drifting: there is only one.
 */
function themeFrom(files: GeneratedFile[]): string {
  const css = files.find((f) => f.path === 'src/index.css')?.content ?? ''
  const block = css.match(/@theme[^{]*\{([\s\S]*?)\n\}/)?.[1]
  if (!block) return FALLBACK_THEME
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('--'))
    .join('\n    ')
}

/**
 * Base styles only.
 *
 * Sandpack injects this as a plain `<style>` tag, which Tailwind's browser build
 * does not read — so the `@theme` block lives in the entry shim instead, inside
 * a `<style type="text/tailwindcss">` element where it is actually honoured.
 */
function previewCss(): string {
  return `html {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

html {
  font-size: var(--brand-root-size, 16px);
}

body {
  margin: 0;
  background: var(--color-canvas, #f8fafc);
  color: var(--color-slate-900, #0f172a);
  font-family: var(--font-sans, 'Plus Jakarta Sans', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif);
}

h1, h2, h3, h4 {
  font-family: var(--font-heading, var(--font-sans, inherit));
}

:focus-visible {
  outline: 2px solid var(--color-accent, #6C63FF);
  outline-offset: 2px;
  border-radius: 6px;
}
`
}

/**
 * Preview-only entry point.
 *
 * Sandpack ignores a custom `index.html`, so the Tailwind browser build cannot
 * be added with a script tag — it has to be injected at runtime, before the app
 * mounts, along with the `@theme` block that defines the accent colour.
 */
function previewEntry(theme: string, fontUrl: string): string {
  /*
   * Mounts the app itself rather than importing the generated `main`.
   *
   * It used to defer with `import('./main')`, and a dynamic import is not in the
   * bundler's static graph — so against a cold bundler the module was requested
   * before it had been compiled and the preview died with "/src/main.tsx hasn't
   * been transpiled yet". It survived in the studio only because an earlier run
   * had already warmed the cache; a fresh window failed every time.
   *
   * Every import here is static, so everything is compiled before anything runs,
   * and the mount still waits for Tailwind so the first paint is styled.
   */
  return `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ToastProvider } from './components/ui'
import App from './App'
import './index.css'
import './demo-player.js'

const theme = document.createElement('style')
theme.type = 'text/tailwindcss'
theme.textContent = \`
  @theme static {
    ${theme}
  }
\`
document.head.appendChild(theme)

const font = document.createElement('link')
font.rel = 'stylesheet'
font.href = ${JSON.stringify(fontUrl)}
document.head.appendChild(font)

function mount() {
  const rootEl = document.getElementById('root')
  if (!rootEl) return
  createRoot(rootEl).render(
    <StrictMode>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </StrictMode>,
  )
}

let mounted = false
const once = () => {
  if (mounted) return
  mounted = true
  mount()
}

const tailwind = document.createElement('script')
tailwind.src = 'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4'
// Styled on first paint when the CDN answers; mounted anyway when it does not.
tailwind.onload = once
tailwind.onerror = once
document.head.appendChild(tailwind)
setTimeout(once, 2500)
`
}

export interface SandpackBundle {
  files: Record<string, { code: string; hidden?: boolean; active?: boolean }>
  dependencies: Record<string, string>
  entry: string
  activeFile: string
}

export function toSandpackBundle(generated: GeneratedFile[]): SandpackBundle {
  const files: SandpackBundle['files'] = {}

  for (const file of generated) {
    if (SKIP.has(file.path)) continue
    if (file.path === 'src/index.css') continue
    // Sandpack paths are absolute from the project root.
    files[`/${file.path}`] = { code: file.content }
  }

  const theme = themeFrom(generated)
  // index.html is not shipped to the preview, but it names the font the brand uses.
  const fontUrl =
    generated
      .find((f) => f.path === 'index.html')
      ?.content.match(/href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"/)?.[1]
      ?.replace(/&amp;/g, '&') ?? DEFAULT_FONT_URL
  files['/src/index.css'] = { code: previewCss(), hidden: true }
  files['/src/preview-entry.tsx'] = { code: previewEntry(theme, fontUrl), hidden: true }
  // Drives the app on its own when the studio asks for a demo run; idle otherwise.
  files['/src/demo-player.js'] = { code: DEMO_PLAYER, hidden: true }

  // Open the first screen by default — it is what someone wants to look at.
  const firstScreen = generated.find((f) => f.origin === 'model' && f.path.startsWith('src/screens/'))
  const activeFile = firstScreen ? `/${firstScreen.path}` : '/src/App.tsx'
  const active = files[activeFile]
  if (active) active.active = true

  return {
    files,
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      'react-router-dom': '^7.1.5',
      'lucide-react': '^0.474.0',
      clsx: '^2.1.1',
      'tailwind-merge': '^3.0.1',
    },
    entry: '/src/preview-entry.tsx',
    activeFile,
  }
}

/** Groups file paths into a tree for the file list. */
export function groupFiles(files: GeneratedFile[]): { dir: string; files: GeneratedFile[] }[] {
  const byDir = new Map<string, GeneratedFile[]>()
  for (const file of files) {
    const slash = file.path.lastIndexOf('/')
    const dir = slash === -1 ? '.' : file.path.slice(0, slash)
    const bucket = byDir.get(dir) ?? []
    bucket.push(file)
    byDir.set(dir, bucket)
  }
  return [...byDir.entries()]
    .map(([dir, entries]) => ({ dir, files: entries.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
}
