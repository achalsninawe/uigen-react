import { AzureOpenAI } from 'openai'
import type { ZodType, ZodTypeDef } from 'zod'
import { config } from '../config.js'

let client: AzureOpenAI | null = null

function getClient(): AzureOpenAI {
  if (!config.azureOpenAI.isConfigured) {
    throw new Error('Azure OpenAI is not configured — set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT')
  }
  client ??= new AzureOpenAI({
    apiKey: config.azureOpenAI.apiKey,
    endpoint: config.azureOpenAI.endpoint,
    apiVersion: config.azureOpenAI.apiVersion,
    deployment: config.azureOpenAI.deployment,
  })
  return client
}

export const aiAvailable = () => config.azureOpenAI.isConfigured

export interface ChatOptions {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  return status === 429 || (typeof status === 'number' && status >= 500)
}

/* ------------------------------------------------------------------ *
 * Talking to whichever model the deployment points at
 * ------------------------------------------------------------------ */

type Params = Record<string, unknown>

/**
 * Families that take `max_completion_tokens` and fix their own temperature.
 *
 * A first guess only. A deployment name is chosen by whoever created it —
 * `gpt-5.5` is a label, not a version — so this cannot be relied on, and the
 * real correction happens below when the service says what it will not accept.
 */
const REASONING = /(^|[-_/.])(gpt-5|gpt-6|o1|o3|o4)/i

function initialParams(deployment: string, maxTokens: number, temperature: number): Params {
  if (REASONING.test(deployment)) {
    // Newer models budget reasoning tokens out of the same allowance, so the
    // ceiling has to be higher than the visible answer needs.
    return { model: deployment, max_completion_tokens: Math.max(maxTokens, 16384) }
  }
  return { model: deployment, max_tokens: maxTokens, temperature }
}

/**
 * The parameter a 400 is complaining about, and what to do with it.
 *
 * Azure names it in the message — "Unsupported parameter: 'max_tokens' is not
 * supported with this model", "Unsupported value: 'temperature' does not
 * support 0.2". Taking it at its word costs one request; the alternative is
 * a run that dies at the first call after someone changes a deployment, which
 * reads as the tool being broken rather than a setting being wrong.
 */
function adapt(err: unknown, params: Params): Params | null {
  const status = (err as { status?: number })?.status
  if (status !== 400) return null

  const message = String((err as { message?: string })?.message ?? '')
  if (!/unsupported|not supported|unrecognized/i.test(message)) return null

  const named = /'([a-z_]+)'/i.exec(message)?.[1]
  if (!named || !(named in params)) return null

  const next = { ...params }
  delete next[named]

  // A token ceiling is not optional — it is the same request under the name
  // this model expects.
  if (named === 'max_tokens' && !('max_completion_tokens' in next)) {
    next.max_completion_tokens = Math.max(Number(params.max_tokens) || 0, 16384)
  }
  if (named === 'max_completion_tokens' && !('max_tokens' in next)) {
    next.max_tokens = Number(params.max_completion_tokens) || 4096
  }

  console.warn(`[spec2ui] ${config.azureOpenAI.deployment} rejected '${named}' — retrying without it`)
  return next
}

/** One completion, retried against whatever the deployment turns out to accept. */
async function complete(params: Params, signal?: AbortSignal) {
  let current = params
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await withRetry(() =>
        getClient().chat.completions.create(current as never, { signal }),
      )
    } catch (err) {
      const corrected = adapt(err, current)
      if (!corrected) throw err
      current = corrected
    }
  }
  throw new Error(`${config.azureOpenAI.deployment} rejected every parameter combination tried`)
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!isRetryable(err) || attempt === attempts - 1) break
      // Honour Retry-After when the service sends one, else exponential backoff.
      const retryAfter = Number((err as { headers?: Record<string, string> })?.headers?.['retry-after'])
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 800 * 2 ** attempt
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
  throw lastError
}

/** Plain completion — used for code generation, where the output is a file. */
export async function chat(options: ChatOptions): Promise<string> {
  const response = await complete(
    {
      ...initialParams(
        config.azureOpenAI.deployment,
        options.maxTokens ?? 4096,
        options.temperature ?? 0.3,
      ),
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.user },
      ],
    },
    options.signal,
  )
  return response.choices[0]?.message?.content ?? ''
}

/**
 * Strips markdown fences and leading prose so a stray ```json wrapper does not
 * cost a whole repair round-trip.
 */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced?.[1] ?? raw).trim()

  const firstBrace = body.search(/[[{]/)
  if (firstBrace === -1) return body
  const opening = body[firstBrace]
  const closing = opening === '{' ? '}' : ']'
  const lastBrace = body.lastIndexOf(closing)
  return lastBrace > firstBrace ? body.slice(firstBrace, lastBrace + 1) : body.slice(firstBrace)
}

export interface JsonChatOptions<T> extends ChatOptions {
  /** Input is `unknown` so zod defaults stay out of the inferred result type. */
  schema: ZodType<T, ZodTypeDef, unknown>
  /** How many times to hand validation errors back to the model. Default 2. */
  repairAttempts?: number
}

/**
 * Asks for JSON and validates it against a zod schema. On failure the errors are
 * fed back so the model can repair its own output — which is markedly more
 * reliable than one-shot prompting, and keeps every downstream stage able to
 * assume well-formed input.
 */
export async function chatJson<T>(options: JsonChatOptions<T>): Promise<T> {
  const { schema, repairAttempts = 2, ...rest } = options

  /*
   * Azure rejects response_format "json_object" unless the word "json" appears
   * somewhere in the messages:
   *   400 'messages' must contain the word 'json' in some form
   * A prompt can easily describe its output shape without ever naming the
   * format, so the requirement is satisfied here rather than relied upon in
   * every prompt.
   */
  const mentionsJson = /json/i.test(rest.system) || /json/i.test(rest.user)
  const system = mentionsJson ? rest.system : `${rest.system}\n\nRespond with a single JSON object.`

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: system },
    { role: 'user', content: rest.user },
  ]

  let lastError = ''
  for (let attempt = 0; attempt <= repairAttempts; attempt++) {
    const response = await complete(
      {
        ...initialParams(
          config.azureOpenAI.deployment,
          rest.maxTokens ?? 8192,
          rest.temperature ?? 0.2,
        ),
        response_format: { type: 'json_object' },
        messages,
      },
      rest.signal,
    )

    const raw = response.choices[0]?.message?.content ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(extractJson(raw))
    } catch (err) {
      lastError = `Response was not valid JSON: ${(err as Error).message}`
      messages.push({ role: 'assistant', content: raw.slice(0, 4000) })
      messages.push({ role: 'user', content: `${lastError}\nReturn only a single valid JSON object.` })
      continue
    }

    const result = schema.safeParse(parsed)
    if (result.success) return result.data

    lastError = result.error.errors
      .slice(0, 12)
      .map((e) => `- ${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('\n')
    messages.push({ role: 'assistant', content: raw.slice(0, 8000) })
    messages.push({
      role: 'user',
      content: `That JSON did not match the required shape:\n${lastError}\n\nReturn the corrected JSON object only.`,
    })
  }

  throw new Error(`Model output failed validation after ${repairAttempts + 1} attempts:\n${lastError}`)
}
