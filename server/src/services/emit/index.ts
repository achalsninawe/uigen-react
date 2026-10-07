import { emitApiClient, emitConfig, emitHttp, type EmitContext } from './apiClient.js'
import { BFF_PATHS, emitBffFiles } from './bff.js'
import { UNDOCUMENTED_RESPONSE, emitTypes } from './types.js'
import { READ_HELPERS } from './read.js'
import { UI_CN, UI_DATA, UI_FEEDBACK, UI_INDEX, UI_OVERLAY, UI_PRIMITIVES } from './uikit.js'
import {
  emitApp,
  emitIndexCss,
  emitIndexHtml,
  emitLayout,
  emitMain,
  emitPackageJson,
  emitReadme,
  emitTsConfig,
  emitViteConfig,
} from './shell.js'
import { DEMO_NOTICE, emitDemoData } from './demo.js'
import { emitLocalStore, storableEntities } from './localStore.js'
import { emitFlow } from './flow.js'
import type { AppPlan, AppSpec, GeneratedFile } from '../../types.js'

export type { EmitContext } from './apiClient.js'
export { screenComponentName, screenFilePath } from './shell.js'
export { uiKitReference } from './uikit.js'

const file = (path: string, content: string): GeneratedFile => ({ path, content, origin: 'emitted' })

/**
 * Emitted only when some screen has no data source at all. A project whose
 * endpoints are documented never sees these files.
 */
function demoFiles(appSpec: AppSpec, plan: AppPlan): GeneratedFile[] {
  const needing = plan.screens.filter((s) => s.demo)
  if (needing.length === 0) return []

  const { content } = emitDemoData(
    appSpec,
    needing.map((s) => ({
      id: s.id,
      name: s.name,
      spec: appSpec.documentedScreens.find(
        (d) => d.name.toLowerCase().trim() === s.name.toLowerCase().trim(),
      ),
    })),
  )

  return [file('src/lib/demo.ts', content), file('src/components/DemoNotice.tsx', DEMO_NOTICE)]
}

/**
 * Every file in the generated app except the screens themselves.
 *
 * All of it is produced by code. The model writes only `src/screens/*.tsx`,
 * composing from the API client and UI kit emitted here — which is what makes
 * it structurally unable to invent an endpoint.
 */
export function emitFoundation(appSpec: AppSpec, plan: AppPlan, ctx: EmitContext): GeneratedFile[] {
  return [
    // Project scaffolding
    file('package.json', emitPackageJson(appSpec, ctx)),
    file('vite.config.ts', emitViteConfig(ctx)),
    file('tsconfig.json', emitTsConfig()),
    file('index.html', emitIndexHtml(appSpec)),
    file('README.md', emitReadme(appSpec, plan, ctx)),

    // API layer — generated from the extracted endpoints, never by a model
    file('src/lib/config.ts', emitConfig(appSpec, ctx)),
    file('src/lib/http.ts', emitHttp()),
    file('src/lib/api.ts', emitApiClient(appSpec)),
    file('src/lib/types.ts', emitTypes(appSpec, plan)),

    // What the user enters, shared across screens, and the bodies built from it
    ...(plan.flow ? [file('src/lib/flow.ts', emitFlow(appSpec, plan, ctx.projectId))] : []),

    /*
     * The app's own server, for builds that leave the studio. Emitted from the
     * same endpoint list as the client above, so it too cannot reach a URL the
     * documents never stated.
     */
    ...emitBffFiles(appSpec, ctx),

    // Component kit — the closed vocabulary screens are generated against
    file('src/components/ui/cn.ts', UI_CN),
    file('src/components/ui/primitives.tsx', UI_PRIMITIVES),
    file('src/components/ui/feedback.tsx', UI_FEEDBACK),
    file('src/components/ui/data.tsx', UI_DATA),
    file('src/components/ui/overlay.tsx', UI_OVERLAY),
    file('src/components/ui/index.ts', UI_INDEX),

    // Sample data, only for screens nothing else can feed
    ...demoFiles(appSpec, plan),

    // Lookup for responses the documents never described
    ...(plan.screens.some((s) => s.incomingType === UNDOCUMENTED_RESPONSE)
      ? [file('src/lib/read.ts', READ_HELPERS)]
      : []),

    /*
     * A store, when the documents describe data but no API to keep it in.
     * Where endpoints exist they remain the only way data moves, and this file
     * is not emitted at all.
     */
    ...(plan.screens.some((s) => s.local) && storableEntities(appSpec).length > 0
      ? [file('src/lib/store.ts', emitLocalStore(appSpec, ctx.projectId))]
      : []),

    // Shell
    file('src/main.tsx', emitMain(ctx)),
    file('src/index.css', emitIndexCss(plan)),
    file('src/App.tsx', emitApp(plan)),
    file('src/components/Layout.tsx', emitLayout(appSpec, plan)),
  ]
}

/**
 * Re-emits only the files whose content depends on the transport or base path,
 * so switching between preview, export and publish does not regenerate screens.
 *
 * The server in `server/` is added or dropped here too: it belongs to the
 * target, not to the app, and a build that no longer forwards through it must
 * not carry a stale copy.
 */
export function reemitForTarget(
  files: GeneratedFile[],
  appSpec: AppSpec,
  plan: AppPlan,
  ctx: EmitContext,
): GeneratedFile[] {
  const replacements = new Map<string, string>([
    ['package.json', emitPackageJson(appSpec, ctx)],
    ['src/lib/config.ts', emitConfig(appSpec, ctx)],
    /*
     * Re-emitted although its content does not depend on the target: it is the
     * code that implements the transport the config names. A project generated
     * before a transport existed has a client that does not recognise it, and
     * would quietly fall through to calling the documented host directly — the
     * one behaviour the target was chosen to avoid.
     */
    ['src/lib/http.ts', emitHttp()],
    ['vite.config.ts', emitViteConfig(ctx)],
    ['src/main.tsx', emitMain(ctx)],
    ['README.md', emitReadme(appSpec, plan, ctx)],
  ])

  const owned = new Set<string>(BFF_PATHS)

  return [
    ...files
      .filter((f) => !owned.has(f.path))
      .map((f) => {
        const replacement = replacements.get(f.path)
        return replacement ? { ...f, content: replacement } : f
      }),
    ...emitBffFiles(appSpec, ctx),
  ]
}
