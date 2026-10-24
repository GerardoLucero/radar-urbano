import { createClient } from 'npm:@supabase/supabase-js@2'
import { notify } from '../_shared/notify.ts'
import { hasValidWebhookSecret } from '../_shared/security.ts'
import { aggregateYear, chooseYear, mirrorUrl, parseSesnspCsv, validateIngest } from './lib.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
const SERVICE_KEY = SUPABASE_SECRET_KEYS['default'] ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const FUNCTION_SECRET = Deno.env.get('FUNCTION_SECRET')
const TOP_N = 400
const FETCH_TIMEOUT_MS = 30_000

// Espejo comunitario en GitHub de los datos abiertos de SESNSP -- los endpoints
// oficiales (datos.gob.mx, gob.mx/sesnsp) bloquean trafico automatizado (Akamai WAF,
// links de SharePoint fragiles). Ver README para el detalle de esta decision.
// SESNSP_MIRROR_REF fija el commit (SHA) del espejo; sin el se usa 'master' y se avisa.
const MIRROR_REF = Deno.env.get('SESNSP_MIRROR_REF') || 'master'
const REF_PINNED = Boolean(Deno.env.get('SESNSP_MIRROR_REF'))

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY)

/** Registra la corrida si existe la tabla ingest_runs; nunca rompe la ingesta. */
async function logRun(status: 'ok' | 'aborted' | 'error', details: Record<string, unknown>) {
  try {
    const { error } = await supabaseAdmin.from('ingest_runs').insert({
      source: 'sesnsp',
      status,
      details,
    })
    if (error) console.warn('ingest_runs not recorded:', error.message)
  } catch (e) {
    console.warn('ingest_runs not recorded', e instanceof Error ? e.name : 'unknown')
  }
}

async function fail(status: 'aborted' | 'error', httpStatus: number, message: string, details: Record<string, unknown> = {}) {
  console.error(`ingest-sesnsp ${status}: ${message}`)
  await logRun(status, { message, ref: MIRROR_REF, ...details })
  await notify(`ingest-sesnsp ${status}: ${message}`, {
    title: 'Radar Urbano: ingesta SESNSP fallo',
    priority: 'high',
    tags: 'warning',
  })
  return new Response(`${status}: ${message}`, { status: httpStatus })
}

// Este endpoint solo lo llama pg_cron (via pg_net), nunca el navegador.
Deno.serve(async (req) => {
  if (!hasValidWebhookSecret(req, FUNCTION_SECRET)) {
    return new Response('unauthorized', { status: 401 })
  }

  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(MIRROR_REF) || MIRROR_REF.includes('..')) {
    return fail('error', 500, 'SESNSP_MIRROR_REF invalido')
  }

  let csvText: string
  try {
    const csvRes = await fetch(mirrorUrl(MIRROR_REF), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!csvRes.ok) {
      await csvRes.body?.cancel()
      return fail('error', 502, `error fetching source csv: HTTP ${csvRes.status}`)
    }
    csvText = await csvRes.text()
  } catch (e) {
    return fail('error', 502, `error fetching source csv: ${e instanceof Error ? e.name : 'unknown'}`)
  }

  const parsed = parseSesnspCsv(csvText)
  const choice = chooseYear(parsed)
  if (!choice) return fail('aborted', 422, 'el CSV no tiene filas validas')

  const agg = aggregateYear(parsed, choice.year)

  // Solo actualizamos municipios que ya tienen coordenadas sembradas -- FK constraint
  // lo exige, y evita crecer el set de municipios sin supervision cada mes.
  const { data: knownMunis, error: knownError } = await supabaseAdmin
    .from('municipio_coordinates')
    .select('cve_mun')

  if (knownError) {
    return fail('error', 500, `db error: ${knownError.message}`)
  }
  const knownSet = new Set((knownMunis ?? []).map((r: { cve_mun: string }) => r.cve_mun))

  const rows = [...agg.entries()]
    .filter(([cve]) => knownSet.has(cve))
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, TOP_N)
    .map(([cve, v]) => ({
      cve_mun: cve,
      year: choice.year,
      total_delitos: v.total,
      total_robos: v.robos,
      total_violentos: v.violentos,
      updated_at: new Date().toISOString(),
    }))

  // Validacion contra lo existente: ano mas reciente por municipio, mismos municipios.
  let existingTotal: number | null = null
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('sesnsp_municipal_crime')
    .select('cve_mun, year, total_delitos')
    .in('cve_mun', rows.map((r) => r.cve_mun))
  if (existingError) {
    return fail('error', 500, `db error: ${existingError.message}`)
  }
  if (existing && existing.length > 0) {
    const latest = new Map<string, { year: number; total: number }>()
    for (const r of existing as Array<{ cve_mun: string; year: number; total_delitos: number }>) {
      const cur = latest.get(r.cve_mun)
      if (!cur || r.year > cur.year) latest.set(r.cve_mun, { year: r.year, total: r.total_delitos })
    }
    existingTotal = [...latest.values()].reduce((s, v) => s + v.total, 0)
  }
  const newTotal = rows
    .filter((r) => existing?.some((e: { cve_mun: string }) => e.cve_mun === r.cve_mun))
    .reduce((s, r) => s + r.total_delitos, 0)

  const check = validateIngest(newTotal, agg.size, existingTotal)
  if (!check.ok) {
    return fail('aborted', 422, `validacion fallida, nada escrito: ${check.reason}`, {
      year: choice.year,
      municipios: agg.size,
    })
  }

  const { error: upsertError } = await supabaseAdmin
    .from('sesnsp_municipal_crime')
    .upsert(rows, { onConflict: 'cve_mun,year' })

  if (upsertError) {
    return fail('error', 500, `upsert error: ${upsertError.message}`)
  }

  const warnings = [...choice.warnings]
  if (!REF_PINNED) warnings.push("SESNSP_MIRROR_REF no esta configurado; se uso 'master' (sin fijar a un commit).")

  await logRun('ok', {
    ref: MIRROR_REF,
    year: choice.year,
    skipped_partial_year: choice.skippedPartialYear,
    rows: rows.length,
    municipios_en_csv: agg.size,
    warnings,
  })
  await notify(
    `ingest-sesnsp ok: ${rows.length} municipios, ano ${choice.year}, ref ${MIRROR_REF.slice(0, 12)}.${
      warnings.length ? ` Avisos: ${warnings.join(' ')}` : ''
    }`,
    { title: 'Radar Urbano: ingesta SESNSP', priority: warnings.length ? 'default' : 'low', tags: warnings.length ? 'warning' : 'white_check_mark' },
  )

  return new Response(
    `ok: updated ${rows.length} municipios for year ${choice.year}${warnings.length ? ` (avisos: ${warnings.join(' ')})` : ''}`,
    { status: 200 },
  )
})
