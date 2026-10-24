import { createClient } from 'npm:@supabase/supabase-js@2'
import { generateJson, hasLlmProvider, LlmError } from '../_shared/llm.ts'
import { notify } from '../_shared/notify.ts'
import { sanitizeModelText } from '../_shared/sanitize.ts'
import { hasValidWebhookSecret } from '../_shared/security.ts'
import { geocodeLocationText } from './geocode.ts'
import {
  buildClassifyUser,
  buildCorroborateUser,
  buildDedupeSchema,
  buildDedupeUser,
  CLASSIFY_SYSTEM,
  ClassificationSchema,
  CORROBORATE_SYSTEM,
  CORROBORATION_WINDOW_MS,
  DEDUPE_SYSTEM,
  DEDUPE_WINDOW_MS,
  geoBox,
  MAX_CANDIDATES,
  selectCandidates,
  VerdictSchema,
} from './logic.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
const SERVICE_KEY = SUPABASE_SECRET_KEYS['default'] ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const ALERT_EMAIL = Deno.env.get('ALERT_EMAIL')
const FUNCTION_SECRET = Deno.env.get('FUNCTION_SECRET')

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY)

/**
 * Politica de falla segura: si la IA falla no se publica ni se enlaza nada. Los
 * reportes con telefono quedan en 'pending' para revision manual; el resto se
 * queda sin categoria. Se registra ai_status='failed' si la columna existe.
 */
async function handleAiFailure(reportId: string, stage: string, err: unknown, holdAsPending: boolean) {
  const summary = err instanceof LlmError ? `${err.kind} (${err.summary})` : 'unexpected error'
  console.error(`AI ${stage} failed for report ${reportId}: ${summary}`)

  if (holdAsPending) {
    const { error } = await supabaseAdmin.from('reports').update({ status: 'pending' }).eq('id', reportId)
    if (error) console.error('could not set pending', error.message)
  }
  try {
    const { error } = await supabaseAdmin.from('reports').update({ ai_status: 'failed' }).eq('id', reportId)
    // Si la columna aun no existe el error es esperado; no rompe el flujo.
    if (error) console.warn('ai_status not recorded:', error.message)
  } catch (e) {
    console.warn('ai_status not recorded', e instanceof Error ? e.name : 'unknown')
  }
  await notify(`Fallo de IA en corroborate-report (${stage}): ${summary}. Reporte ${reportId}${holdAsPending ? ' dejado en pending' : ' sin clasificar'}.`, {
    title: 'Radar Urbano: fallo del modelo',
    priority: 'high',
    tags: 'warning',
    throttleKey: `corroborate-ai-${stage}`,
    throttleMs: 60_000,
  })
}

async function sendEmail(subject: string, text: string) {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Radar Urbano <onboarding@resend.dev>',
        to: [ALERT_EMAIL],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    console.error('email failed', e instanceof Error ? e.name : 'unknown')
  }
}

// Este endpoint solo lo llama el trigger de Postgres (via pg_net), nunca el navegador.
// Autenticacion propia por header compartido en vez de JWT de usuario -- por eso verify_jwt=false.
Deno.serve(async (req) => {
  if (!hasValidWebhookSecret(req, FUNCTION_SECRET)) {
    return new Response('unauthorized', { status: 401 })
  }

  let payload: any
  try {
    payload = await req.json()
  } catch {
    return new Response('bad payload', { status: 400 })
  }

  const newRow = payload.record
  if (!newRow?.id || !newRow?.description) {
    return new Response('bad payload', { status: 400 })
  }

  // 0.5 Reportes con nombre (hospedaje y futuras categorias que identifiquen a una
  // persona): NUNCA se auto-publican -- eso ya lo garantiza submit_named_report() al
  // insertar con status='pending' a nivel de base de datos, este endpoint no lo toca.
  // Aqui solo avisamos por correo (no hay panel de moderacion dedicado en v1) y
  // señalamos si ya existe corroboracion, para que la revision manual sea mas rapida.
  const { data: subjects } = await supabaseAdmin
    .from('report_subjects')
    .select('value, value_normalized, reference_url')
    .eq('report_id', newRow.id)

  if (subjects && subjects.length > 0) {
    const subject = subjects[0]
    let corroborationNote = 'Sin otros reportes previos con este nombre.'

    const { data: priorPublished } = await supabaseAdmin
      .from('report_subjects')
      .select('report_id, reports!inner(id, description, status)')
      .eq('value_normalized', subject.value_normalized)
      .eq('reports.status', 'published')
      .neq('report_id', newRow.id)

    if (priorPublished && priorPublished.length > 0) {
      corroborationNote = `${priorPublished.length} reporte(s) previo(s) publicado(s) con el mismo nombre -- revisar si describen el mismo patron.`
    }

    await sendEmail(
      `Reporte pendiente de moderacion: ${subject.value}`,
      `Nuevo reporte con nombre "${subject.value}" (categoria: ${newRow.category ?? 'sin clasificar'}) esta en status=pending y requiere tu revision manual antes de poder publicarse.\n\n${corroborationNote}\n\nAnuncio referenciado: ${subject.reference_url ?? '(no proporcionado)'}\n\nRevisa en Supabase Studio: tabla reports, id=${newRow.id}. No lo publiques sin antes recortar/redactar la imagen de evidencia (si la hay) y subir solo el derivado al bucket evidence-public.`,
    )

    // No clasificacion adicional ni fusion de duplicados para reportes con nombre --
    // la categoria ya la fijo submit_named_report() y no tienen lat/lon que fusionar.
    return new Response('ok: named report flagged for manual moderation', { status: 200 })
  }

  // 0. Geocoding: si escribieron una zona/colonia en vez de dar GPS, la convertimos
  // a coordenadas aproximadas para que el reporte SI aparezca en el mapa.
  // El trigger de fuzzing en UPDATE se encarga de difuminarlas al guardarse.
  if (newRow.lat == null && newRow.location_text) {
    const geo = await geocodeLocationText(String(newRow.location_text).slice(0, 200))
    if (geo) {
      await supabaseAdmin.from('reports').update({ lat: geo.lat, lon: geo.lon }).eq('id', newRow.id)
      newRow.lat = Math.round(geo.lat * 100) / 100
      newRow.lon = Math.round(geo.lon * 100) / 100
    }
  }

  const hasPhone = Boolean(newRow.phone_number)

  if (!hasLlmProvider()) {
    await handleAiFailure(newRow.id, 'config', new LlmError('no_provider', 'no LLM API key configured'), hasPhone)
    return new Response('ok: geocoded if applicable, AI skipped (no API key)', { status: 200 })
  }

  // 1. Clasificacion + extraccion de entidades. Categoria abierta (la IA decide la
  // etiqueta) pero validada: solo [a-z_]{2,40}. Las instrucciones van en el mensaje
  // system; el texto del usuario viaja como dato dentro de <reporte>.
  let classification
  try {
    const out = await generateJson(
      { system: CLASSIFY_SYSTEM, user: buildClassifyUser(newRow.description, hasPhone), maxTokens: 400 },
      ClassificationSchema,
    )
    classification = out.data
  } catch (e) {
    // Sin categoria no hay comparacion segura: no se enlaza nada.
    await handleAiFailure(newRow.id, 'classify', e, hasPhone)
    return new Response('ok: AI failed, report left unclassified', { status: 200 })
  }

  const entities: Record<string, string> = {}
  if (classification.time_of_day) entities.time_of_day = classification.time_of_day
  if (classification.weapon) entities.weapon = classification.weapon
  if (classification.vehicle) entities.vehicle = classification.vehicle

  await supabaseAdmin
    .from('reports')
    .update({
      category: classification.category,
      entities: Object.keys(entities).length > 0 ? entities : null,
    })
    .eq('id', newRow.id)

  // 2. Corroboracion: solo aplica a reportes con numero de telefono (es la unica
  // categoria con una identidad natural para comparar -- "mismo numero, mismo patron?").
  // La identidad es el numero, asi que aqui no se filtra por categoria (un reporte
  // contradictorio podria clasificarse distinto); si se limita a ventana y a 10 recientes.
  if (hasPhone) {
    const since = new Date(Date.now() - CORROBORATION_WINDOW_MS).toISOString()
    const { data: existing, error } = await supabaseAdmin
      .from('reports')
      .select('id, description, created_at')
      .eq('phone_number', newRow.phone_number)
      .eq('status', 'published')
      .neq('id', newRow.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(MAX_CANDIDATES)

    const prior = error ? [] : selectCandidates(existing ?? [], newRow.id, CORROBORATION_WINDOW_MS)

    if (prior.length > 0) {
      let verdict
      try {
        const out = await generateJson(
          { system: CORROBORATE_SYSTEM, user: buildCorroborateUser(prior, newRow.description), maxTokens: 400 },
          VerdictSchema,
        )
        verdict = out.data
      } catch (e) {
        await handleAiFailure(newRow.id, 'corroborate', e, true)
        return new Response('ok: AI failed, held as pending', { status: 200 })
      }

      if (verdict.verdict === 'contradicts') {
        await supabaseAdmin.from('reports').update({ status: 'pending' }).eq('id', newRow.id)
        await sendEmail(
          `Reportes contradictorios: ${newRow.phone_number}`,
          `El numero ${newRow.phone_number} tiene reportes que no coinciden.\n\nMotivo (modelo): ${sanitizeModelText(verdict.reason, 200)}\n\nRevisa en el Table Editor de Supabase, tabla "reports", status=pending, id=${newRow.id}.`,
        )
        return new Response('ok: flagged pending', { status: 200 })
      }
    }
  }

  // 3. Fusion de duplicados: incidentes fisicos muy cercanos en tiempo/lugar pueden
  // ser el MISMO evento visto por varias personas. En vez de mostrar puntos repetidos
  // en el mapa, el reporte nuevo se enlaza al original via duplicate_of.
  // Solo candidatos de la MISMA categoria, en una caja de +-0.01 grados y dentro de
  // 72 h, los 10 mas recientes.
  if (newRow.lat != null && newRow.lon != null) {
    const box = geoBox(Number(newRow.lat), Number(newRow.lon))
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()
    const { data: nearbyRaw } = await supabaseAdmin
      .from('reports')
      .select('id, description, created_at')
      .eq('status', 'published')
      .eq('category', classification.category)
      .is('duplicate_of', null)
      .gte('lat', box.latMin)
      .lte('lat', box.latMax)
      .gte('lon', box.lonMin)
      .lte('lon', box.lonMax)
      .gte('created_at', since)
      .neq('id', newRow.id)
      .order('created_at', { ascending: false })
      .limit(MAX_CANDIDATES)

    const nearby = selectCandidates(nearbyRaw ?? [], newRow.id, DEDUPE_WINDOW_MS)

    if (nearby.length > 0) {
      try {
        const out = await generateJson(
          {
            system: DEDUPE_SYSTEM,
            user: buildDedupeUser(nearby, newRow.description),
            maxTokens: 300,
          },
          buildDedupeSchema(nearby.map((c) => c.id)),
        )
        const matchId = out.data.same_event_id
        if (matchId) {
          await supabaseAdmin.from('reports').update({ duplicate_of: matchId }).eq('id', newRow.id)
          return new Response('ok: linked as duplicate', { status: 200 })
        }
      } catch (e) {
        // Falla segura: sin enlace. El reporte ya esta clasificado y sigue su curso normal.
        await handleAiFailure(newRow.id, 'dedupe', e, false)
        return new Response('ok: classified, dedupe skipped (AI failed)', { status: 200 })
      }
    }
  }

  return new Response('ok: classified', { status: 200 })
})
