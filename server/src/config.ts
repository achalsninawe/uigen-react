import { config as loadEnv } from 'dotenv'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// src/ -> server/ -> repo root. The .env lives at the root so both workspaces share it.
const repoRoot = path.resolve(here, '..', '..')

for (const candidate of [path.join(repoRoot, '.env'), path.join(repoRoot, 'server', '.env')]) {
  if (fs.existsSync(candidate)) loadEnv({ path: candidate })
}

function str(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim()
}

function int(name: string, fallback: number): number {
  const parsed = Number.parseInt(str(name), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(name: string, fallback: boolean): boolean {
  const value = str(name).toLowerCase()
  if (!value) return fallback
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

const storageConnectionString = str('AZURE_STORAGE_CONNECTION_STRING')

/**
 * Which of the two configured deployments to talk to.
 *
 * Both stay in `.env` — `AZURE_OPENAI_*` and `AZURE_V2_*` — and `AZURE_MODEL`
 * picks between them. A newer model is not reliably a better one for this work:
 * it may plan the same document differently, extract a different number of
 * screens, or cost more time per screen, and the only way to know is to run the
 * same document through both. That comparison has to be a one-line change, not
 * a credential edit that loses the deployment you were using.
 *
 * Unset, the newer deployment wins when it is configured, which is what this
 * did before the switch existed.
 */
const v2Key = str('AZURE_V2_API_KEY')
const v2Available = v2Key.length > 0 && v2Key !== 'dummy' && str('AZURE_V2_ENDPOINT').length > 0

const chosen = str('AZURE_MODEL').toLowerCase()
// Accept the deployment's own name too, so `AZURE_MODEL=gpt-4o` does what it
// plainly says rather than being ignored for not being the word "v1".
const namesV1 = chosen.length > 0 && chosen === str('AZURE_OPENAI_DEPLOYMENT', 'gpt-4o').toLowerCase()
const namesV2 = chosen.length > 0 && chosen === str('AZURE_V2_DEPLOYMENT', 'gpt-5.5').toLowerCase()

const wantsV1 = chosen === 'v1' || chosen === '1' || namesV1
const wantsV2 = chosen === 'v2' || chosen === '2' || namesV2

const useV2 = wantsV1 ? false : wantsV2 ? v2Available : v2Available

if (wantsV2 && !v2Available) {
  console.warn(
    '[spec2ui] AZURE_MODEL asks for the second deployment, but AZURE_V2_API_KEY ' +
      'and AZURE_V2_ENDPOINT are not both set. Falling back to AZURE_OPENAI_*.',
  )
}
if (chosen.length > 0 && !wantsV1 && !wantsV2) {
  console.warn(
    `[spec2ui] AZURE_MODEL="${str('AZURE_MODEL')}" is not one of v1, v2, or either ` +
      'deployment name. Ignoring it.',
  )
}

const openaiKey = useV2 ? v2Key : str('AZURE_OPENAI_API_KEY')
const openaiEndpoint = useV2 ? str('AZURE_V2_ENDPOINT') : str('AZURE_OPENAI_ENDPOINT')
const openaiDeployment = useV2
  ? str('AZURE_V2_DEPLOYMENT', 'gpt-5.5')
  : str('AZURE_OPENAI_DEPLOYMENT', 'gpt-4o')
const openaiApiVersion = useV2
  ? str('AZURE_V2_API_VERSION', '2024-12-01-preview')
  : str('AZURE_OPENAI_API_VERSION', '2024-12-01-preview')

export const config = {
  repoRoot,
  port: int('PORT', 5177),
  workDir: path.resolve(repoRoot, str('WORK_DIR', './.work')),

  azureOpenAI: {
    apiKey: openaiKey,
    endpoint: openaiEndpoint,
    deployment: openaiDeployment,
    apiVersion: openaiApiVersion,
    /** True when the deployment came from `AZURE_V2_*` rather than the original vars. */
    usingV2: useV2,
    /**
     * `dummy` is the placeholder shipped in .env. Until a real key lands we run
     * the whole pipeline against canned data instead of failing at the first call.
     */
    get isConfigured() {
      return Boolean(openaiKey) && openaiKey !== 'dummy' && Boolean(openaiEndpoint)
    },
  },

  session: {
    /**
     * Signs session cookies. Unset is fine for a single local instance — a key
     * is generated and kept in the work directory — but every deployment, and
     * anything running more than one instance, must set it.
     */
    secret: str('SESSION_SECRET'),
  },

  storage: {
    connectionString: storageConnectionString,
    prefix: str('AZURE_STORAGE_PREFIX', 'spec2ui'),
    webEndpoint: str('AZURE_STORAGE_WEB_ENDPOINT'),
    get isConfigured() {
      return storageConnectionString.length > 0
    },
  },

  runner: {
    portStart: int('RUNNER_PORT_START', 5310),
    portEnd: int('RUNNER_PORT_END', 5360),
  },

  analysis: {
    /**
     * The second pass that re-reads a document for screens the first one
     * dropped.
     *
     * Off by default. It is an extra model call on every analysis where the
     * heading counter disagrees with the extraction, and the first pass is
     * usually right — the disagreement is more often a heading that announces a
     * section than a screen genuinely missed. Turning it off costs only the
     * recovery: the mismatch is still logged and still recorded as a gap, so a
     * dropped screen never becomes silent.
     */
    recoverMissingScreens: bool('RECOVER_MISSING_SCREENS', false),

    /**
     * Call each safely reachable GET once before planning, and use the shape
     * that comes back instead of the one guessed from the prose.
     *
     * On by default. Documents name fields the way people say them and APIs
     * name them the way they were typed, so types derived from prose describe a
     * payload that never arrives — a table with the right number of rows and a
     * dash in every cell. The information was never missing; it was simply
     * never asked for.
     *
     * Only GET is ever called. Set PROBE_ENDPOINTS=0 to turn it off entirely.
     */
    probeEndpoints: bool('PROBE_ENDPOINTS', true),
  },
} as const

export type Config = typeof config
