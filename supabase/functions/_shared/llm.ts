// Cliente LLM compartido: cascada Groq -> NVIDIA NIM con presupuesto de tiempo,
// reintentos con backoff, modo JSON, parseo robusto y validacion con zod.
// Adaptado de cv-stress-test/src/sdk/model-provider.ts.

import { z } from 'npm:zod@3.25.76'

export type ProviderName = 'groq' | 'nim'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmDeps {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
  getEnv?: (key: string) => string | undefined
}

export interface GenerateOptions {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
  /** Presupuesto total (todos los proveedores y reintentos). Por defecto 25 s. */
  budgetMs?: number
  /** Tope por llamada individual. Por defecto 10 s. */
  callTimeoutMs?: number
  /** Reintentos por proveedor ante errores transitorios. Por defecto 2 intentos. */
  attemptsPerProvider?: number
}

export interface GenerateResult<T> {
  data: T
  provider: ProviderName
  model: string
}

export type LlmErrorKind = 'no_provider' | 'provider_failure' | 'invalid_output'

/** Error final de generateJson. `summary` no contiene texto de reportes ni cuerpos de respuesta. */
export class LlmError extends Error {
  constructor(public kind: LlmErrorKind, public summary: string) {
    super(`${kind}: ${summary}`)
    this.name = 'LlmError'
  }
}

class HttpError extends Error {
  constructor(public status: number, provider: ProviderName) {
    super(`${provider} HTTP ${status}`)
  }
}

class TransientError extends Error {}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b'
const DEFAULT_NIM_MODEL = 'openai/gpt-oss-20b'
const DEFAULT_BUDGET_MS = 25_000
const DEFAULT_CALL_TIMEOUT_MS = 10_000
const MIN_CALL_MS = 1_500
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529])

function envReader(deps: LlmDeps) {
  return deps.getEnv ?? ((k: string) => Deno.env.get(k))
}

interface ProviderConfig {
  name: ProviderName
  url: string
  key: string
  model: string
}

/** Proveedores con llave configurada, en orden de preferencia. Los que no tienen llave se omiten. */
export function configuredProviders(deps: LlmDeps = {}): ProviderConfig[] {
  const env = envReader(deps)
  const out: ProviderConfig[] = []
  const groqKey = env('GROQ_API_KEY')
  if (groqKey) out.push({ name: 'groq', url: GROQ_URL, key: groqKey, model: env('GROQ_MODEL') || DEFAULT_GROQ_MODEL })
  const nimKey = env('NVIDIA_NIM_API_KEY')
  if (nimKey) out.push({ name: 'nim', url: NIM_URL, key: nimKey, model: env('NIM_MODEL') || DEFAULT_NIM_MODEL })
  return out
}

export function hasLlmProvider(deps: LlmDeps = {}): boolean {
  return configuredProviders(deps).length > 0
}

/**
 * Extrae el primer objeto JSON de una respuesta: quita fences de codigo y recorre
 * llaves balanceadas respetando cadenas (sin regex voraz).
 */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/```[a-zA-Z0-9]*/g, '').trim()
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findObjectEnd(text, start)
    if (end === -1) continue
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      // Llaves balanceadas pero no JSON (prosa con {}): probar el siguiente '{'.
    }
  }
  throw new Error('no JSON object found')
}

function findObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

async function callOnce(
  p: ProviderConfig,
  messages: ChatMessage[],
  opts: GenerateOptions,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: p.model,
    messages,
    temperature: opts.temperature ?? 0.1,
    // gpt-oss gasta parte del limite en razonamiento antes del JSON.
    max_tokens: opts.maxTokens ?? 1500,
    response_format: { type: 'json_object' },
  }
  if (p.name === 'groq') body.reasoning_effort = 'low'

  let res: Response
  try {
    res = await fetchImpl(p.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    // Timeout, conexion caida o DNS: transitorio.
    throw new TransientError(`${p.name} ${e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network'}`)
  }
  if (!res.ok) {
    await res.body?.cancel()
    throw new HttpError(res.status, p.name)
  }
  let json: any
  try {
    json = await res.json()
  } catch {
    throw new TransientError(`${p.name} bad response body`)
  }
  const text = json?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new TransientError(`${p.name} empty reply`)
  return text
}

async function callWithRetry(
  p: ProviderConfig,
  messages: ChatMessage[],
  opts: GenerateOptions,
  deadline: number,
  deps: Required<Pick<LlmDeps, 'fetchImpl' | 'sleep' | 'now' | 'random'>>,
): Promise<string> {
  const attempts = opts.attemptsPerProvider ?? 2
  const callCap = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  let last: unknown = new Error(`${p.name} not attempted`)
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = deadline - deps.now()
    if (remaining < MIN_CALL_MS) throw new TransientError(`${p.name} time budget exhausted`)
    try {
      return await callOnce(p, messages, opts, Math.min(callCap, remaining), deps.fetchImpl)
    } catch (e) {
      last = e
      const retryable = e instanceof TransientError || (e instanceof HttpError && RETRYABLE_STATUS.has(e.status))
      if (!retryable || attempt === attempts - 1) break
      // Backoff exponencial con jitter, sin gastar mas de un cuarto del tiempo restante.
      const base = 500 * 2 ** attempt
      const delay = Math.min(base + deps.random() * base, Math.max(0, (deadline - deps.now()) / 4))
      await deps.sleep(delay)
    }
  }
  throw last
}

function describe(e: unknown): string {
  if (e instanceof z.ZodError) return 'schema mismatch'
  if (e instanceof HttpError || e instanceof TransientError) return e.message
  if (e instanceof SyntaxError || (e instanceof Error && e.message === 'no JSON object found')) return 'invalid JSON'
  return 'error'
}

/**
 * Pide una respuesta JSON al modelo y la valida con `schema`. Cascada Groq -> NIM;
 * si todos fallan (o devuelven algo invalido) reintenta una vez en orden inverso.
 * El texto del usuario debe ir ya sanitizado y dentro de etiquetas en `opts.user`.
 */
export async function generateJson<S extends z.ZodTypeAny>(
  opts: GenerateOptions,
  schema: S,
  deps: LlmDeps = {},
): Promise<GenerateResult<z.infer<S>>> {
  const providers = configuredProviders(deps)
  if (providers.length === 0) throw new LlmError('no_provider', 'no LLM API key configured')

  const d = {
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
    random: deps.random ?? Math.random,
  }
  const deadline = d.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS)
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `${opts.system}\n\nResponde UNICAMENTE con un objeto JSON valido, sin markdown ni explicaciones.`,
    },
    { role: 'user', content: opts.user },
  ]

  const failures: string[] = []
  let sawInvalid = false
  for (let round = 0; round < 2; round++) {
    const order = round === 0 ? providers : [...providers].reverse()
    // En el segundo intento la salida debe ser lo mas determinista posible.
    const roundOpts = round === 0 ? opts : { ...opts, temperature: 0 }
    for (const p of order) {
      if (deadline - d.now() < MIN_CALL_MS) {
        failures.push(`${p.name}:budget`)
        continue
      }
      let text: string
      try {
        text = await callWithRetry(p, messages, roundOpts, deadline, d)
      } catch (e) {
        failures.push(`${p.name}:${describe(e)}`)
        continue
      }
      try {
        const data = schema.parse(extractJson(text))
        return { data, provider: p.name, model: p.model }
      } catch (e) {
        sawInvalid = true
        failures.push(`${p.name}:${describe(e)}`)
      }
    }
    if (deadline - d.now() < MIN_CALL_MS) break
  }
  throw new LlmError(sawInvalid ? 'invalid_output' : 'provider_failure', failures.join('; ').slice(0, 300))
}
