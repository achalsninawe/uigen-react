import { BFF_PORT, wantsBff } from './bff.js'
import { str, toPascalCase } from './lang.js'
import type { EmitContext } from './apiClient.js'
import { DEFAULT_FONT_URL, brandTokens, fontStack } from '../brand.js'
import { ROOT_SIZE, type AppPlan, type AppSpec, type ScreenPlan } from '../../types.js'

/** Component/file name for a screen, e.g. `OrderDetail`. */
export function screenComponentName(screen: ScreenPlan): string {
  return toPascalCase(screen.name, 'Screen')
}

export function screenFilePath(screen: ScreenPlan): string {
  return `src/screens/${screenComponentName(screen)}.tsx`
}

/* ------------------------------------------------------------------ */
/* Project scaffolding                                                 */
/* ------------------------------------------------------------------ */

export function emitPackageJson(appSpec: AppSpec, ctx: EmitContext): string {
  const name =
    appSpec.appName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'generated-app'

  // A BFF build ships its own server, so it needs a way to run it and the one
  // dependency that serves it.
  const bff = wantsBff(appSpec, ctx)

  return `${JSON.stringify(
    {
      name,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'tsc -b && vite build',
        preview: 'vite preview',
        ...(bff
          ? {
              /** Serves the built UI and the API on one origin. */
              start: 'node server/index.js',
              /** The two processes a BFF build needs while developing. */
              'dev:server': 'node --watch server/index.js',
            }
          : {}),
      },
      // The emitted server reads .env through Node's own loader.
      ...(bff ? { engines: { node: '>=20.12' } } : {}),
      dependencies: {
        clsx: '^2.1.1',
        ...(bff ? { express: '^5.1.0' } : {}),
        'lucide-react': '^0.474.0',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
        'react-router-dom': '^7.1.5',
        'tailwind-merge': '^3.0.1',
      },
      devDependencies: {
        '@tailwindcss/vite': '^4.0.6',
        '@types/react': '^19.0.8',
        '@types/react-dom': '^19.0.3',
        '@vitejs/plugin-react': '^4.3.4',
        tailwindcss: '^4.0.6',
        typescript: '^5.7.3',
        vite: '^6.1.0',
      },
    },
    null,
    2,
  )}\n`
}

export function emitViteConfig(ctx: EmitContext): string {
  const base = ctx.basePath ? `\n  base: ${str(`${ctx.basePath}/`)},` : ''

  /*
   * `npm run dev` serves the page from Vite, but the BFF answers on its own
   * port. Without this, a same-origin call to /api/call/… would hit Vite and
   * come back as the app's own HTML.
   */
  const proxy =
    ctx.transport === 'bff'
      ? `
  server: {
    proxy: {
      '${ctx.basePath ?? ''}/api': {
        target: 'http://localhost:${BFF_PORT}',
        changeOrigin: true,
      },
    },
  },`
      : ''

  return `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],${base}${proxy}
})
`
}

export function emitTsConfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        isolatedModules: true,
        resolveJsonModule: true,
        allowImportingTsExtensions: true,
        forceConsistentCasingInFileNames: true,
        types: ['vite/client'],
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`
}

export function emitIndexHtml(appSpec: AppSpec, plan?: AppPlan): string {
  const fontUrl = plan?.theme.brand?.font?.url ?? DEFAULT_FONT_URL
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(appSpec.appName)}</title>
    ${appSpec.description ? `<meta name="description" content="${escapeHtml(appSpec.description.slice(0, 160))}" />` : ''}
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="${escapeHtml(fontUrl)}"
      rel="stylesheet"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

export function emitIndexCss(plan: AppPlan): string {
  const brand = plan.theme.brand
  /*
   * An uploaded brand overrides tokens rather than adding classes: the kit's
   * slate text, hairlines and radii are redefined here, so every component
   * picks the brand up without the screens knowing it exists.
   */
  const brandBlock = brand
    ? `

  /* Brand theme, read from ${brand.sources.join(', ').replace(/\*\//g, '')} */
  ${brandTokens(brand).join('\n  ')}`
    : ''

  return `@import 'tailwindcss';

/*
 * Declared static so every token below is emitted whether or not a utility class
 * references it by name. Several are used only from inside arbitrary values —
 * the hero's gradient is one — and those do not register as usage, so without
 * this the variable would be tree-shaken and the gradient would resolve to
 * nothing.
 */
@theme static {
  --font-sans: ${fontStack(brand?.font?.body)};

  /*
   * One colour decides the palette.
   *
   * Everything else is mixed from it, so changing --color-accent moves the
   * canvas, the hairlines, the washes behind table headers and the dark summary
   * panel together. That is what keeps a generated app looking designed instead
   * of assembled out of defaults — and it means a screen never has to name a
   * second colour to stay consistent with the first.
   */
  --color-accent: ${plan.theme.accent};
  --color-accent-soft: color-mix(in oklab, var(--color-accent) 16%, white);
  --color-accent-tint: color-mix(in oklab, var(--color-accent) 6%, white);
  --color-accent-deep: color-mix(in oklab, var(--color-accent) 58%, #12101f);
  --color-canvas: color-mix(in oklab, var(--color-accent) 4%, white);
  --color-line: color-mix(in oklab, var(--color-accent) 14%, white);${brandBlock}${
    // After the brand's, so the person's choice wins over the brand guide's.
    plan.theme.rootSize ? `

  /* Text size chosen in the studio */
  --brand-root-size: ${plan.theme.rootSize}px;` : ''
  }
}

@layer base {
  html {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    font-size: var(--brand-root-size, 16px);
  }

  body {
    @apply bg-canvas font-sans text-slate-900 antialiased;
  }

  h1, h2, h3, h4 {
    font-family: var(--font-heading, var(--font-sans));
  }

  :focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: 6px;
  }
}
`
}

/**
 * A plain-CSS stand-in used by the in-browser preview, which has no build step
 * and therefore cannot run Tailwind's PostCSS pipeline. Tailwind itself is
 * loaded from a CDN there; this only carries the theme tokens.
 */
export function emitPreviewCss(plan: AppPlan): string {
  return `:root {
  --color-accent: ${plan.theme.accent};
  --color-accent-soft: color-mix(in oklab, var(--color-accent) 16%, white);
  --color-accent-tint: color-mix(in oklab, var(--color-accent) 6%, white);
  --color-accent-deep: color-mix(in oklab, var(--color-accent) 58%, #12101f);
  --color-canvas: color-mix(in oklab, var(--color-accent) 4%, white);
  --color-line: color-mix(in oklab, var(--color-accent) 14%, white);
}

html {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  margin: 0;
  background: var(--color-canvas);
  color: #0f172a;
  font-family: 'Plus Jakarta Sans', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
}
`
}

/* ------------------------------------------------------------------ */
/* Entry, router and layout                                            */
/* ------------------------------------------------------------------ */

export function emitMain(ctx: EmitContext): string {
  const basename = ctx.basePath ? `basename={${str(ctx.basePath)}} ` : ''
  return `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ToastProvider } from './components/ui'
import App from './App'
import './index.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter ${basename}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
)
`
}

/** Icon names the layout may reference, kept to ones lucide-react really has. */
const SAFE_ICONS = new Set([
  'LayoutDashboard', 'List', 'Table', 'FileText', 'Users', 'User', 'Settings', 'Search',
  'ShoppingCart', 'Package', 'CreditCard', 'BarChart3', 'Bell', 'Calendar', 'Mail', 'Home',
  'Folder', 'Database', 'Boxes', 'Receipt', 'Truck', 'Tag', 'Shield', 'Key', 'Activity',
  'PlusCircle', 'Star', 'Heart', 'Clock', 'Map', 'Globe', 'Building2', 'Briefcase', 'Square',
])

const safeIcon = (icon: string) => (SAFE_ICONS.has(icon) ? icon : 'Square')

/**
 * A screen's own look, as an inline style on the element around it.
 *
 * The palette tokens are mixed from the accent where they are declared, so a
 * new accent has to bring its derived tokens with it or the washes and lines
 * would keep the app's colour. Text sizes are rem, relative to the app's root,
 * so a screen's own size is a zoom by the ratio of the two.
 */
function lookStyle(screen: ScreenPlan, plan: AppPlan): string | undefined {
  const look = screen.look
  if (!look) return undefined
  const entries: string[] = []
  if (look.accent) {
    const a = look.accent
    entries.push(
      `'--color-accent': ${str(a)}`,
      `'--color-accent-soft': ${str(`color-mix(in oklab, ${a} 16%, white)`)}`,
      `'--color-accent-tint': ${str(`color-mix(in oklab, ${a} 6%, white)`)}`,
      `'--color-accent-deep': ${str(`color-mix(in oklab, ${a} 58%, #12101f)`)}`,
      `'--color-canvas': ${str(`color-mix(in oklab, ${a} 4%, white)`)}`,
      `'--color-line': ${str(`color-mix(in oklab, ${a} 14%, white)`)}`,
    )
  }
  if (look.textSize) {
    const zoom = ROOT_SIZE[look.textSize] / (plan.theme.rootSize ?? ROOT_SIZE.default)
    if (Math.abs(zoom - 1) > 0.001) entries.push(`zoom: ${+zoom.toFixed(4)}`)
  }
  return entries.length > 0 ? `{ ${entries.join(', ')} }` : undefined
}

export function emitApp(plan: AppPlan): string {
  const screens = plan.screens
  const imports = screens
    .map((s) => `import ${screenComponentName(s)} from './screens/${screenComponentName(s)}'`)
    .join('\n')

  const routes = screens
    .map((s) => {
      const element = `<${screenComponentName(s)} />`
      const style = lookStyle(s, plan)
      const wrapped = style ? `<div style={${style} as CSSProperties}>${element}</div>` : element
      return `        <Route path=${str(s.route)} element={${wrapped}} />`
    })
    .join('\n')
  const styled = screens.some((s) => lookStyle(s, plan))

  // Send unknown paths to the first navigable screen rather than a blank page.
  const home = screens.find((s) => s.route === '/') ?? screens.find((s) => s.showInNav) ?? screens[0]

  return `${styled ? "import type { CSSProperties } from 'react'\n" : ''}import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
${imports}

export default function App() {
  return (
    <Layout>
      <Routes>
${routes}
        <Route path="*" element={<Navigate to=${str(home?.route ?? '/')} replace />} />
      </Routes>
    </Layout>
  )
}
`
}

/**
 * A journey reads as a numbered rail; a set of destinations reads as a nav.
 *
 * Both were a sidebar of equal links before, which flattened an application
 * whose documents plainly described a sequence — apply, review, pay, confirm —
 * into five interchangeable pages. Where the plan numbered its screens, the
 * shell says which one you are on and how many are left.
 */
export function emitLayout(appSpec: AppSpec, plan: AppPlan): string {
  const journey = plan.screens.filter((s) => s.step).sort((a, b) => a.step!.index - b.step!.index)
  return journey.length >= 3 ? emitJourneyLayout(appSpec, journey) : emitNavLayout(appSpec, plan)
}

/** One line of context under a step's name, kept short enough not to wrap. */
function caption(text: string): string {
  const clean = (text ?? '').trim().replace(/\s+/g, ' ')
  return clean.length <= 34 ? clean : `${clean.slice(0, 33).trimEnd()}…`
}

/** Route matching that tolerates path parameters. Shared by both layouts. */
const ROUTE_MATCH = `/** "/orders/:orderId" still matches "/orders/7". */
function matches(pattern: string, pathname: string) {
  const expected = pattern.split('/').filter(Boolean)
  const actual = pathname.split('/').filter(Boolean)
  if (expected.length !== actual.length) return false
  return expected.every((segment, i) => segment.startsWith(':') || segment === actual[i])
}`

function emitJourneyLayout(appSpec: AppSpec, journey: ScreenPlan[]): string {
  /*
   * A step whose route takes a parameter is shown but not linked.
   *
   * The rail's job is to say where you are in the sequence, and a step that
   * needs a record id is still part of the sequence. What it is not is
   * something you can click from here: there is no id to put in the link, and
   * linking to the literal ":projectId" sends the screen a route parameter of
   * ":projectId", which it then calls the API with.
   */
  const items = journey
    .map(
      (s) =>
        `  { to: ${str(s.route)}, label: ${str(s.name)}, caption: ${str(caption(s.purpose))},` +
        ` linkable: ${!/[:{]/.test(s.route)} },`,
    )
    .join('\n')

  /*
   * The card under the rail, only when the documents gave us something true to
   * put in it. Nothing on this shell is written for the app — an invented line
   * of reassurance is still invented.
   */
  const blurb = appSpec.description?.trim()
    ? `
        <div className="mx-5 mb-6 rounded-2xl bg-accent-tint p-4 ring-1 ring-line">
          <p className="text-[0.7813rem] leading-relaxed text-slate-600">
            ${escapeJsxText(appSpec.description.trim())}
          </p>
        </div>
`
    : ''

  return `import type { ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { cn } from './ui'

const steps = [
${items}
]

${ROUTE_MATCH}

/**
 * One step in the rail.
 *
 * A step you cannot click is still a step: it shows where it sits in the
 * sequence and whether you have passed it. It is reached from the screen that
 * holds its record id, not from here.
 */
function Step({
  step,
  index,
  active,
  done,
}: {
  step: (typeof steps)[number]
  index: number
  active: boolean
  done: boolean
}) {
  const body = (
    <>
      <span
        className={cn(
          'z-10 grid size-[1.625rem] shrink-0 place-items-center rounded-full text-[0.7188rem] font-bold ring-1',
          active
            ? 'bg-accent text-white ring-accent'
            : done
              ? 'bg-accent-soft text-accent ring-transparent'
              : 'bg-white text-slate-400 ring-line',
        )}
      >
        {done ? (
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          index + 1
        )}
      </span>
      <span className="min-w-0 pt-0.5">
        <span
          className={cn(
            'block truncate text-[0.8438rem] font-semibold',
            active ? 'text-slate-900' : 'text-slate-600',
          )}
        >
          {step.label}
        </span>
        <span className="mt-0.5 hidden truncate text-[0.7188rem] text-slate-400 lg:block">
          {step.caption}
        </span>
      </span>
    </>
  )

  const shape = cn(
    'relative flex items-start gap-3 rounded-xl px-2 py-2 transition-colors',
    active ? 'bg-accent-tint' : step.linkable ? 'hover:bg-accent-tint' : '',
  )

  if (!step.linkable) {
    return (
      <div className={shape} title="Open this from the record it belongs to">
        {body}
      </div>
    )
  }

  return (
    <NavLink to={step.to} end={step.to === '/'} className={shape}>
      {body}
    </NavLink>
  )
}

/**
 * App frame for a sequence: a numbered rail on wide screens, a scrolling strip
 * of the same steps on narrow ones. Screens render into the main column and
 * should not repeat the app title.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const found = steps.findIndex((step) => matches(step.to, pathname))
  const current = found === -1 ? 0 : found

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="shrink-0 border-b border-line bg-white/70 lg:h-dvh lg:w-72 lg:border-r lg:border-b-0">
        <div className="px-6 pt-7 pb-5">
          <p className="text-[0.6563rem] font-semibold tracking-[0.16em] text-accent uppercase">
            Your progress
          </p>
          <h1 className="mt-2 text-[1.375rem] leading-tight font-bold tracking-tight text-slate-900">
            ${escapeJsxText(appSpec.appName)}
          </h1>
        </div>

        <ol className="flex gap-1 overflow-x-auto px-5 pb-5 lg:block lg:space-y-1 lg:overflow-visible">
          {steps.map((step, i) => {
            const done = i < current
            const active = i === current
            return (
              <li key={step.to} className="relative shrink-0 lg:shrink">
                {i < steps.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute top-[2.25rem] bottom-0 left-[1.3125rem] hidden w-px bg-line lg:block"
                  />
                )}
                <Step step={step} index={i} active={active} done={done} />
              </li>
            )
          })}
        </ol>
${blurb}      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-5 py-8 lg:px-10">
          <p className="mb-7 flex items-center gap-2 text-[0.75rem] text-slate-400">
            <span>${escapeJsxText(appSpec.appName)}</span>
            <span aria-hidden>/</span>
            <span className="font-medium text-slate-600">{steps[current]?.label}</span>
          </p>
          {children}
        </div>
      </main>
    </div>
  )
}
`
}

function emitNavLayout(appSpec: AppSpec, plan: AppPlan): string {
  const initial = appSpec.appName.trim().charAt(0).toUpperCase() || 'A'
  /*
   * A parameterised route is never a navigation item: the link would have to
   * carry a record id, and the navigation has none. Such a screen is reached
   * from whatever lists those records.
   */
  const navScreens = plan.screens.filter((s) => s.showInNav && !/[:{]/.test(s.route))
  const nav = navScreens.length > 0 ? navScreens : plan.screens.slice(0, 1)

  const icons = [...new Set(nav.map((s) => safeIcon(s.icon)))]
  const iconImport = icons.length > 0 ? `import { ${icons.join(', ')} } from 'lucide-react'\n` : ''

  const items = nav
    .map((s) => `  { to: ${str(s.route)}, label: ${str(s.name)}, Icon: ${safeIcon(s.icon)} },`)
    .join('\n')

  return `import type { ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
${iconImport}import { cn } from './ui'

const navItems = [
${items}
]

${ROUTE_MATCH}

/**
 * App frame: a fixed sidebar on wide screens, a horizontal bar on narrow ones.
 * Screens render into the main column and should not repeat the app title.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const current = navItems.find((item) => matches(item.to, pathname))

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="border-b border-line bg-white/70 lg:h-dvh lg:w-64 lg:shrink-0 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="grid size-9 place-items-center rounded-xl bg-accent text-sm font-bold text-white shadow-sm">
            ${escapeJsxText(initial)}
          </span>
          <span className="truncate text-[0.9375rem] font-bold tracking-tight text-slate-900">
            ${escapeJsxText(appSpec.appName)}
          </span>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible">
          {navItems.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2 text-[0.8438rem] font-medium transition-colors',
                  isActive
                    ? 'bg-accent-soft text-accent'
                    : 'text-slate-600 hover:bg-accent-tint hover:text-slate-900',
                )
              }
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-5 py-8 lg:px-10">
          <p className="mb-7 flex items-center gap-2 text-[0.75rem] text-slate-400">
            <span>${escapeJsxText(appSpec.appName)}</span>
            <span aria-hidden>/</span>
            <span className="font-medium text-slate-600">{current?.label ?? ''}</span>
          </p>
          {children}
        </div>
      </main>
    </div>
  )
}
`
}

function escapeJsxText(value: string): string {
  return value.replace(/[{}<>]/g, (c) => `{'${c}'}`)
}

/* ------------------------------------------------------------------ */
/* README                                                              */
/* ------------------------------------------------------------------ */

export function emitReadme(appSpec: AppSpec, plan: AppPlan, ctx: EmitContext): string {
  const endpointRows = appSpec.endpoints
    .map((e) => `| \`${e.method}\` | \`${e.path}\` | \`${e.operationId}()\` |`)
    .join('\n')

  const screenRows = plan.screens.map((s) => `| ${s.name} | \`${s.route}\` | ${s.purpose} |`).join('\n')

  const gaps = appSpec.gaps.length
    ? appSpec.gaps.map((g) => `- **${g.topic}** — ${g.detail}${g.suggestion ? ` _${g.suggestion}_` : ''}`).join('\n')
    : '_None recorded._'

  const bff = wantsBff(appSpec, ctx)

  const running = bff
    ? `\`\`\`bash
npm install
cp .env.example .env     # then put your API credential in it
npm run build
npm start                # http://localhost:${BFF_PORT}
\`\`\`

While developing, run the two processes side by side — Vite serves the page and
forwards \`/api\` to the server:

\`\`\`bash
npm run dev:server       # in one terminal
npm run dev              # in another
\`\`\``
    : `\`\`\`bash
npm install
npm run dev
\`\`\``

  const transportNote = bff
    ? `, so calls go to this app's own server in \`server/\` and it forwards them
to the documented host.

That server is why the app works anywhere you host it. The page and the API
share one origin, so there is no CORS for the API to allow, and the credential
lives in the server's environment instead of being bundled into JavaScript that
anyone can read.

It is generated the same way \`src/lib/api.ts\` is — \`server/endpoints.json\` is
the closed list of calls it will make, emitted from your specification. There is
no route that accepts a URL, so it can only reach hosts your documents named.

| File | What it is |
| --- | --- |
| \`server/index.js\` | Serves \`dist/\` and answers \`POST /api/call/:operationId\` |
| \`server/upstream.js\` | Rebuilds the documented request and applies the credential |
| \`server/endpoints.json\` | The ${appSpec.endpoints.length} operations it will forward |
| \`.env.example\` | The configuration it reads |

Configure it with environment variables, not \`src/lib/config.ts\`:

\`\`\`bash
API_AUTH_VALUE=your-token
API_BASE_URL=https://staging.example.com     # optional override
API_EXTRA_HEADERS={"X-Tenant":"acme"}        # optional
PORT=${BFF_PORT}
\`\`\`

Deploy it as one unit — \`npm ci && npm run build && npm start\` — on anything
that runs Node: a container, Azure App Service, Container Apps, Fly, Render. A
static-only host cannot serve this build, because there would be nothing to run
the server.`
    : ctx.transport === 'direct'
      ? `, so the browser calls the documented host directly. The API must send CORS headers that allow this origin.

Set credentials and override the base URL in \`src/lib/config.ts\`:

\`\`\`ts
runtimeConfig.authValue = 'your-token'
runtimeConfig.baseUrlOverride = 'https://staging.example.com'
\`\`\``
      : `, so calls are forwarded by the Spec2UI server.

Set credentials and override the base URL in \`src/lib/config.ts\`:

\`\`\`ts
runtimeConfig.authValue = 'your-token'
runtimeConfig.baseUrlOverride = 'https://staging.example.com'
\`\`\``

  return `# ${appSpec.appName}

${appSpec.description || 'Generated by Spec2UI from your specification.'}

## Running it

${running}

## How API calls work

\`src/lib/api.ts\` has one function per endpoint found in your specification. It
was written directly from the extracted endpoint list — every URL, method,
parameter and header is a literal copy of what your documents state.

This build uses the **${ctx.transport}** transport${transportNote}

## Endpoints

| Method | Path | Function |
| --- | --- | --- |
${endpointRows || '| — | — | _none found_ |'}

## Screens

| Screen | Route | Purpose |
| --- | --- | --- |
${screenRows}

## What the specification left open

${gaps}

---

Generated by Spec2UI. Re-generate rather than hand-editing \`src/lib/api.ts\`,
\`src/lib/types.ts\`${bff ? ', `server/`' : ''} or \`src/components/ui/\`.
`
}
