// Lista de modelos por proveedor, editable sin redesplegar las funciones.
// Fuente: models.json de la rama main en GitHub (cache de 5 min); si no responde o no es
// valido, la lista por defecto del codigo. Cada proveedor lleva una lista ordenada: si un
// modelo falla (404/410 al retirarlo) se prueba el siguiente. GROQ_MODEL / NIM_MODEL se
// anteponen como anulacion de emergencia.

import { z } from 'npm:zod@3.25.76'

export interface ModelConfig {
  groq: string[]
  nim: string[]
}

export interface ModelConfigDeps {
  fetchImpl?: typeof fetch
  now?: () => number
  getEnv?: (key: string) => string | undefined
}

const configSchema = z.object({
  groq: z.array(z.string().min(1).max(120)).min(1).max(5),
  nim: z.array(z.string().min(1).max(120)).min(1).max(5),
})

export const DEFAULT_MODELS: ModelConfig = {
  groq: ['openai/gpt-oss-120b'],
  nim: ['openai/gpt-oss-20b'],
}

const DEFAULT_URL = 'https://raw.githubusercontent.com/GerardoLucero/radar-urbano/main/models.json'
const TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 2000

let cache: { at: number; value: ModelConfig } | null = null

export function resetModelConfigCache(): void {
  cache = null
}

function withOverrides(base: ModelConfig, env: (k: string) => string | undefined): ModelConfig {
  const groq = env('GROQ_MODEL')
  const nim = env('NIM_MODEL')
  return {
    groq: groq ? [groq, ...base.groq.filter((m) => m !== groq)] : base.groq,
    nim: nim ? [nim, ...base.nim.filter((m) => m !== nim)] : base.nim,
  }
}

export async function getModelConfig(deps: ModelConfigDeps = {}): Promise<ModelConfig> {
  const env = deps.getEnv ?? ((k: string) => Deno.env.get(k))
  const now = deps.now ?? Date.now
  if (cache && now() - cache.at < TTL_MS) return withOverrides(cache.value, env)

  const url = env('MODEL_CONFIG_URL') || DEFAULT_URL
  if (url === 'off') return withOverrides(DEFAULT_MODELS, env)

  try {
    const res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const value = configSchema.parse(await res.json())
    cache = { at: now(), value }
  } catch {
    // Se guarda el valor por defecto un rato para no reintentar el fetch en cada request.
    cache = { at: now(), value: DEFAULT_MODELS }
  }
  return withOverrides(cache.value, env)
}
