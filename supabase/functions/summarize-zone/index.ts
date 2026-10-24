import { createClient } from 'npm:@supabase/supabase-js@2'
import { generateJson, hasLlmProvider, LlmError } from '../_shared/llm.ts'
import { notify } from '../_shared/notify.ts'
import { sanitizeModelText } from '../_shared/sanitize.ts'
import {
  buildSummaryUser,
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  cellKey,
  clientIp,
  DailyBudget,
  deterministicSummary,
  isHighHistorical,
  RateLimiter,
  SUMMARY_SYSTEM,
  SummarySchema,
  TtlCache,
  type SesnspZone,
  type SummaryResponse,
} from './lib.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
const SERVICE_KEY = SUPABASE_SECRET_KEYS['default'] ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MAX_REPORTS = 15
const BOX = 0.15 // ~15km, "esta zona" -- mismo rango que usaba el cliente antes
const DAILY_LLM_CAP = Number(Deno.env.get('SUMMARIZE_DAILY_LLM_CAP')) || 500
const HIGH_RATE_PER_100K = Number(Deno.env.get('SESNSP_HIGH_RATE_PER_100K')) || undefined

const ALLOWED_ORIGINS = new Set(['https://radarurbano.org', 'https://www.radarurbano.org'])

function corsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://radarurbano.org'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY)

// Estado en memoria de la instancia (mejor esfuerzo: cada instancia tiene el suyo).
const cache = new TtlCache<SummaryResponse>(CACHE_TTL_MS, CACHE_MAX_ENTRIES)
const rateLimiter = new RateLimiter()
const dailyBudget = new DailyBudget(DAILY_LLM_CAP)

// Llamada directa desde el navegador (boton "que tan segura es esta zona").
// El cliente solo manda lat/lng -- la consulta a "reports" (que incluye texto
// libre de descripcion) se hace aqui con service key, nunca en el navegador.
// Antes el cliente traia hasta 15 descripciones completas via anon key y las
// reenviaba; cualquiera podia leer ese trafico o pedirle lo mismo a PostgREST
// directo. Ahora el texto crudo nunca sale del servidor -- solo el resumen.
Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  const headers = corsHeaders(origin)
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, 'Content-Type': 'application/json', ...extra },
    })

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers })
  }

  const ip = clientIp(req)
  if (!rateLimiter.allow(ip)) {
    return json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': String(rateLimiter.retryAfterSeconds(ip)) })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad payload' }, 400)
  }

  const lat = Number(body?.lat)
  const lng = Number(body?.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return json({ error: 'lat/lng requeridos' }, 400)
  }

  // Cache por celda de 0.05 grados (~5 km), 20 min: evita pagar el LLM y la base
  // de nuevo para la misma zona.
  const key = cellKey(lat, lng)
  const cached = cache.get(key)
  if (cached) return json(cached)

  const { data: nearby, error: nearbyError } = await supabaseAdmin
    .from('reports')
    .select('category, description, created_at')
    .eq('status', 'published')
    .not('lat', 'is', null)
    .gte('lat', lat - BOX)
    .lte('lat', lat + BOX)
    .gte('lon', lng - BOX)
    .lte('lon', lng + BOX)
    .order('created_at', { ascending: false })
    .limit(MAX_REPORTS)

  if (nearbyError) {
    return json({ error: 'db error' }, 500)
  }

  const reports = nearby ?? []

  // Contexto SESNSP de la zona -- especialmente util cuando no hay reportes en vivo:
  // en vez de "no sabemos nada", el resumen puede decir "sin reportes en vivo, pero
  // el historico oficial de esta zona muestra X delitos/ano".
  let sesnsp: SesnspZone | null = null
  const { data: nearbyMunis } = await supabaseAdmin
    .from('municipio_coordinates')
    .select('cve_mun, municipio, estado, lat, lon')
    .gte('lat', lat - BOX)
    .lte('lat', lat + BOX)
    .gte('lon', lng - BOX)
    .lte('lon', lng + BOX)

  if (nearbyMunis && nearbyMunis.length > 0) {
    // El municipio de la ZONA es el mas cercano al centro, no el de mas delitos
    // en el rango -- evita reportar el municipio "peor" cercano en vez de donde estas.
    const withDist = nearbyMunis.map((m: any) => ({
      ...m,
      dist: Math.hypot(m.lat - lat, m.lon - lng),
    }))
    withDist.sort((a: any, b: any) => a.dist - b.dist)
    const closest = withDist[0]

    const { data: crimeRow } = await supabaseAdmin
      .from('sesnsp_municipal_crime')
      .select('total_delitos, total_robos, total_violentos')
      .eq('cve_mun', closest.cve_mun)
      .maybeSingle()

    if (crimeRow) {
      sesnsp = { municipio: closest.municipio, estado: closest.estado, ...crimeRow }

      // Poblacion opcional (para la tasa por 100k). Si la columna no existe en
      // municipio_coordinates el error se ignora y se usa el umbral absoluto.
      try {
        const { data: popRow, error: popError } = await supabaseAdmin
          .from('municipio_coordinates')
          .select('poblacion')
          .eq('cve_mun', closest.cve_mun)
          .maybeSingle()
        if (!popError && popRow && (popRow as any).poblacion != null) {
          sesnsp.poblacion = Number((popRow as any).poblacion)
        }
      } catch {
        // sin poblacion
      }
    }
  }

  const count = reports.length
  const high = isHighHistorical(sesnsp, HIGH_RATE_PER_100K)
  let tone: string
  let title: string
  if (count > 0) {
    tone = 'tone-alert'
    title = `${count} reporte${count === 1 ? '' : 's'} cerca`
  } else if (sesnsp && high) {
    tone = 'tone-warn'
    title = 'Sin reportes en vivo — histórico alto'
  } else {
    tone = 'tone-clear'
    title = 'Sin reportes cerca'
  }

  if (reports.length === 0 && !sesnsp) {
    return json({
      title,
      tone,
      summary:
        'No hay reportes recientes en esta zona ni datos históricos disponibles todavía. Eso no significa que sea segura, solo que no tenemos información de esta zona.',
    })
  }

  // Degradacion: sin llave, sin presupuesto diario o con fallo del modelo se usa
  // el resumen determinista (no se cachea, para reintentar el LLM mas tarde).
  const degraded = () => json({ title, tone, summary: deterministicSummary(count, sesnsp, high) })

  if (!hasLlmProvider()) {
    await notify('summarize-zone: ningun proveedor LLM configurado, sirviendo resumen determinista.', {
      title: 'Radar Urbano: sin proveedor LLM',
      priority: 'high',
      throttleKey: 'summarize-no-provider',
    })
    return degraded()
  }

  if (!dailyBudget.tryConsume()) {
    await notify(`summarize-zone: tope diario de LLM (${DAILY_LLM_CAP}) agotado en esta instancia.`, {
      title: 'Radar Urbano: tope diario LLM',
      throttleKey: 'summarize-daily-cap',
      throttleMs: 6 * 60 * 60 * 1000,
    })
    return degraded()
  }

  try {
    const out = await generateJson(
      { system: SUMMARY_SYSTEM, user: buildSummaryUser(reports, sesnsp), temperature: 0.3, maxTokens: 800 },
      SummarySchema,
    )
    const summary = sanitizeModelText(out.data.summary, 700)
    if (summary.length < 10) throw new LlmError('invalid_output', 'summary empty after sanitizing')
    const result: SummaryResponse = { title, tone, summary }
    cache.set(key, result)
    return json(result)
  } catch (e) {
    const detail = e instanceof LlmError ? `${e.kind} (${e.summary})` : 'unexpected error'
    console.error('summarize-zone LLM failed:', detail)
    await notify(`summarize-zone: fallo del modelo, resumen determinista. ${detail}`, {
      title: 'Radar Urbano: fallo del modelo',
      priority: 'high',
      tags: 'warning',
      throttleKey: 'summarize-llm-failure',
    })
    return degraded()
  }
})
