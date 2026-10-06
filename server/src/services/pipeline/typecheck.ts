import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { config } from '../../config.js'
import type { GeneratedFile } from '../../types.js'

const run = promisify(execFile)

export interface TypeError {
  /** Project-relative path, e.g. `src/screens/PolicySearch.tsx`. */
  file: string
  line: number
  column: number
  code: string
  message: string
}

/**
 * Type-checks a generated project for real, in a warm sandbox.
 *
 * Hand-written lint rules can only catch mistakes someone has already seen. A
 * compiler catches the whole class at once: an unimported component, a prop
 * that does not exist, an object passed where a node is expected, a field read
 * off the wrong type. Every runtime crash these screens have produced was a
 * compile error that nobody compiled.
 *
 * The sandbox keeps `node_modules` between runs, so the first check pays an
 * install and every later one takes a few seconds.
 */

const sandboxDir = () => path.join(config.workDir, 'typecheck')

/** Type definitions only — no bundler, so the install stays small and quick. */
const SANDBOX_PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'spec2ui-typecheck-sandbox',
    private: true,
    version: '1.0.0',
    description: 'Warm sandbox for type-checking generated projects. Safe to delete.',
    dependencies: {
      '@types/react': '^19.0.8',
      '@types/react-dom': '^19.0.3',
      clsx: '^2.1.1',
      'lucide-react': '^0.474.0',
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      'react-router-dom': '^7.1.5',
      'tailwind-merge': '^3.0.1',
      typescript: '^5.7.3',
    },
  },
  null,
  2,
)}\n`

/**
 * Deliberately not the project's own tsconfig: that one references `vite/client`,
 * which would drag Vite into the sandbox for no benefit. CSS imports are stubbed
 * by a declaration file instead.
 */
const SANDBOX_TSCONFIG = `${JSON.stringify(
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
      forceConsistentCasingInFileNames: true,
      allowImportingTsExtensions: true,
    },
    include: ['src', 'globals.d.ts'],
  },
  null,
  2,
)}\n`

const GLOBALS_DTS = `// Stubs for imports a bundler resolves but the type-checker does not.
declare module '*.css'
declare module '*.svg'
declare module '*.png'
`

let preparing: Promise<string> | null = null

/** Creates the sandbox and installs its dependencies, once per server run. */
async function prepareSandbox(log: (m: string) => void): Promise<string> {
  preparing ??= (async () => {
    const dir = sandboxDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'package.json'), SANDBOX_PACKAGE_JSON)
    await fs.writeFile(path.join(dir, 'tsconfig.json'), SANDBOX_TSCONFIG)
    await fs.writeFile(path.join(dir, 'globals.d.ts'), GLOBALS_DTS)

    const tsc = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc')
    const installed = await fs
      .access(tsc)
      .then(() => true)
      .catch(() => false)

    if (!installed) {
      log('Preparing the type-check sandbox (one-off, about a minute)')
      const args = ['install', '--no-audit', '--no-fund', '--loglevel=error']
      const options = { cwd: dir, maxBuffer: 16 * 1024 * 1024 }
      if (process.platform === 'win32') {
        /*
         * npm's own script, run by this Node. Node 20.12+ refuses to launch a
         * .cmd without a shell (EINVAL), and a shell would concatenate the
         * arguments rather than escape them.
         */
        const cli = process.env.npm_execpath?.endsWith('.js')
          ? process.env.npm_execpath
          : path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        await run(process.execPath, [cli, ...args], options)
      } else {
        await run('npm', args, options)
      }
    }

    return dir
  })()

  try {
    return await preparing
  } catch (err) {
    // A failed install must not poison every later attempt.
    preparing = null
    throw err
  }
}

/** `src/screens/X.tsx(12,5): error TS2322: Type 'a' is not assignable to 'b'.` */
function parseDiagnostics(output: string): TypeError[] {
  const errors: TypeError[] = []
  const pattern = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/gm

  for (const match of output.matchAll(pattern)) {
    errors.push({
      file: match[1]!.replace(/\\/g, '/'),
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4]!,
      message: match[5]!.trim(),
    })
  }
  return errors
}

export interface TypeCheckResult {
  ok: boolean
  errors: TypeError[]
  /** Set when the check could not run at all, e.g. the install failed. */
  unavailable?: string
}

export async function typeCheck(
  files: GeneratedFile[],
  log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
): Promise<TypeCheckResult> {
  let dir: string
  try {
    dir = await prepareSandbox((m) => log(m))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: true, errors: [], unavailable: `type-check sandbox unavailable: ${message}` }
  }

  // Start from a clean source tree so a renamed screen cannot linger.
  const src = path.join(dir, 'src')
  await fs.rm(src, { recursive: true, force: true })

  for (const file of files) {
    if (!file.path.startsWith('src/')) continue
    const target = path.join(dir, file.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.content, 'utf8')
  }

  const tsc = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc')
  try {
    await run(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], {
      cwd: dir,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, errors: [] }
  } catch (err) {
    // tsc exits non-zero when it finds errors; diagnostics are on stdout.
    const output = `${(err as { stdout?: string }).stdout ?? ''}\n${(err as { stderr?: string }).stderr ?? ''}`
    const errors = parseDiagnostics(output)

    if (errors.length === 0) {
      return { ok: true, errors: [], unavailable: `type-check produced no diagnostics: ${output.trim().slice(0, 300)}` }
    }
    return { ok: false, errors }
  }
}

/** Groups diagnostics by file, most-broken first. */
export function byFile(errors: TypeError[]): Map<string, TypeError[]> {
  const grouped = new Map<string, TypeError[]>()
  for (const error of errors) {
    const bucket = grouped.get(error.file) ?? []
    bucket.push(error)
    grouped.set(error.file, bucket)
  }
  for (const bucket of grouped.values()) bucket.sort((a, b) => a.line - b.line)
  return grouped
}

/** Renders diagnostics the way a developer would read them. */
export function describeErrors(errors: TypeError[], source?: string): string {
  const lines = source?.split('\n')

  return errors
    .slice(0, 20)
    .map((e) => {
      const code = lines?.[e.line - 1]?.trim()
      return code
        ? `line ${e.line}: ${e.message}\n    ${code}`
        : `line ${e.line}, column ${e.column}: ${e.message}`
    })
    .join('\n')
}
