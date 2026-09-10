import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
const SERVICE_KEY = SUPABASE_SECRET_KEYS['default'] ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const NVIDIA_NIM_API_KEY = Deno.env.get('NVIDIA_NIM_API_KEY')
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const ALERT_EMAIL = Deno.env.get('ALERT_EMAIL')
const FUNCTION_SECRET = Deno.env.get('FUNCTION_SECRET')
const NIM_MODEL = 'deepseek-ai/deepseek-v4-flash-0731'

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY)

async function callNim(prompt: string): Promise<any | null> {
  const doFetch = () =>
    fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NVIDIA_NIM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: NIM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 200,
      }),
    })

  let res = await doFetch()
  // NIM a veces responde 529 "temporarily overloaded" -- transitorio, un reintento
  // corto evita que un reporte se quede sin clasificar por mala suerte de timing.
  if (!res.ok && (res.status === 529 || res.status === 503)) {
    console.warn(`NIM overloaded (${res.status}), retrying once...`)
    await new Promise((r) => setTimeout(r, 1200))
    res = await doFetch()
  }

  if (!res.ok) {
    console.error('NIM error', await res.text())
    return null
  }

  const data = await res.json()
  const raw = data.choices?.[0]?.message?.content ?? ''
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    return JSON.parse(jsonMatch ? jsonMatch[0] : raw)
  } catch {
    console.error('unparseable NIM response', raw)
    return null
  }
}

async function nominatimSearch(query: string): Promise<{ lat: number; lon: number } | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({ q: query, format: 'json', limit: '1', countrycodes: 'mx' })
  const res = await fetch(url, {
    headers: { 'User-Agent': 'radar-urbano/1.0 (contacto: luceroriosg@gmail.com)' },
  })
  if (!res.ok) return null
  const data = await res.json()
  if (!data || data.length === 0) return null
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
}

// "Colonia X" a veces no matchea en Nominatim aunque "X" solo si -- ej "Colonia
// Argentina Antigua" da 0 resultados, pero "Argentina Antigua" encuentra el barrio
// exacto. Reintenta sin el prefijo antes de rendirse.
const NEIGHBORHOOD_PREFIXES = /^(colonia|col\.?|barrio|fraccionamiento|fracc\.?|unidad habitacional)\s+/i

async function geocodeLocationText(locationText: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const first = await nominatimSearch(`${locationText}, Mexico`)
    if (first) return first

    const stripped = locationText.replace(NEIGHBORHOOD_PREFIXES, '').trim()
    if (stripped !== locationText && stripped.length > 0) {
      const second = await nominatimSearch(`${stripped}, Mexico`)
      if (second) return second
    }
    return null
  } catch (e) {
    console.error('geocoding error', e)
    return null
  }
}

// Este endpoint solo lo llama el trigger de Postgres (via pg_net), nunca el navegador.
// Autenticacion propia por header compartido en vez de JWT de usuario -- por eso verify_jwt=false.
Deno.serve(async (req) => {
  if (!FUNCTION_SECRET || req.headers.get('x-webhook-secret') !== FUNCTION_SECRET) {
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

    if (NVIDIA_NIM_API_KEY) {
      const { data: priorPublished } = await supabaseAdmin
        .from('report_subjects')
        .select('report_id, reports!inner(id, description, status)')
        .eq('value_normalized', subject.value_normalized)
        .eq('reports.status', 'published')
        .neq('report_id', newRow.id)

      if (priorPublished && priorPublished.length > 0) {
        corroborationNote = `${priorPublished.length} reporte(s) previo(s) publicado(s) con el mismo nombre -- revisar si describen el mismo patron.`
      }
    }

    if (RESEND_API_KEY && ALERT_EMAIL) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Radar Urbano <onboarding@resend.dev>',
          to: [ALERT_EMAIL],
          subject: `Reporte pendiente de moderacion: ${subject.value}`,
          text: `Nuevo reporte con nombre "${subject.value}" (categoria: ${newRow.category ?? 'sin clasificar'}) esta en status=pending y requiere tu revision manual antes de poder publicarse.\n\n${corroborationNote}\n\nAnuncio referenciado: ${subject.reference_url ?? '(no proporcionado)'}\n\nRevisa en Supabase Studio: tabla reports, id=${newRow.id}. No lo publiques sin antes recortar/redactar la imagen de evidencia (si la hay) y subir solo el derivado al bucket evidence-public.`,
        }),
      })
    }

    // No clasificacion adicional ni fusion de duplicados para reportes con nombre --
    // la categoria ya la fijo submit_named_report() y no tienen lat/lon que fusionar.
    return new Response('ok: named report flagged for manual moderation', { status: 200 })
  }

  // 0. Geocoding: si escribieron una zona/colonia en vez de dar GPS, la convertimos
  // a coordenadas aproximadas para que el reporte SI aparezca en el mapa.
  // El trigger de fuzzing en UPDATE se encarga de difuminarlas al guardarse.
  if (newRow.lat == null && newRow.location_text) {
    const geo = await geocodeLocationText(newRow.location_text)
    if (geo) {
      await supabaseAdmin.from('reports').update({ lat: geo.lat, lon: geo.lon }).eq('id', newRow.id)
      newRow.lat = Math.round(geo.lat * 100) / 100
      newRow.lon = Math.round(geo.lon * 100) / 100
    }
  }

  if (!NVIDIA_NIM_API_KEY) {
    console.error('NVIDIA_NIM_API_KEY not set, skipping classification/corroboration')
    return new Response('ok: geocoded if applicable, rest skipped (no API key)', { status: 200 })
  }

  // 1. Clasificacion + extraccion de entidades: todo reporte se etiqueta y se le
  // sacan datos estructurados del texto libre, sin pedirle mas campos al usuario.
  // Categoria abierta (no un dropdown fijo) -- la IA decide la etiqueta.
  const classifyPrompt = `Eres un clasificador de reportes de un radar urbano comunitario en Mexico. Lee la descripcion y extrae:
1. category: UNA categoria corta en snake_case en espanol (ejemplos: fraude_telefonico, robo_casa_habitacion, robo_auto, asalto_transeunte, extorsion, acoso, otro). Si no encaja en ninguna categoria comun, usa "otro" seguido de una palabra clave, ej "otro_vandalismo".
2. time_of_day: si el texto menciona cuando paso (manana, tarde, noche, madrugada), o null si no lo dice.
3. weapon: si se menciona un arma y cual (ej "arma de fuego", "cuchillo"), o null si no se menciona.
4. vehicle: si se menciona un vehiculo del/los agresores (ej "moto negra", "auto sedan gris"), o null si no se menciona.

Descripcion: ${newRow.description}
${newRow.phone_number ? `(Este reporte tiene numero de telefono asociado: probablemente fraude telefonico salvo que el texto diga otra cosa)` : ''}

Responde UNICAMENTE JSON valido: {"category": "...", "time_of_day": null, "weapon": null, "vehicle": null}`

  const classification = await callNim(classifyPrompt)
  if (classification?.category) {
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
  }

  // 2. Corroboracion: solo aplica a reportes con numero de telefono (es la unica
  // categoria con una identidad natural para comparar -- "mismo numero, mismo patron?").
  if (newRow.phone_number) {
    const { data: existing, error } = await supabaseAdmin
      .from('reports')
      .select('id, description')
      .eq('phone_number', newRow.phone_number)
      .eq('status', 'published')
      .neq('id', newRow.id)

    if (!error && existing && existing.length > 0) {
      const priorDescriptions = existing
        .map((r: { description: string }, i: number) => `Reporte previo ${i + 1}: ${r.description}`)
        .join('\n')

      const corroborationPrompt = `Eres un analista antifraude. Dos o mas personas reportaron el MISMO numero telefonico como fraude en un registro publico mexicano. Decide si las descripciones describen el MISMO patron de estafa (corroboran) o describen situaciones INCOMPATIBLES entre si (contradicen -- senal de posible abuso del sistema para danar a un tercero, no fraude real).

${priorDescriptions}

Reporte nuevo: ${newRow.description}

Responde UNICAMENTE con JSON valido, sin texto adicional: {"verdict": "corroborates" | "contradicts", "reason": "una frase breve"}`

      const verdict = await callNim(corroborationPrompt)
      if (verdict?.verdict === 'contradicts') {
        await supabaseAdmin.from('reports').update({ status: 'pending' }).eq('id', newRow.id)

        if (RESEND_API_KEY && ALERT_EMAIL) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Radar Urbano <onboarding@resend.dev>',
              to: [ALERT_EMAIL],
              subject: `Reportes contradictorios: ${newRow.phone_number}`,
              text: `El numero ${newRow.phone_number} tiene reportes que no coinciden.\n\nMotivo (DeepSeek): ${verdict.reason}\n\nRevisa en el Table Editor de Supabase, tabla "reports", status=pending, id=${newRow.id}.`,
            }),
          })
        }
        return new Response('ok: flagged pending', { status: 200 })
      }
    }
  }

  // 3. Fusion de duplicados: incidentes fisicos muy cercanos en tiempo/lugar pueden
  // ser el MISMO evento visto por varias personas. En vez de mostrar puntos repetidos
  // en el mapa, el reporte nuevo se enlaza al original via duplicate_of.
  if (newRow.lat != null && newRow.lon != null) {
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()
    const { data: nearby } = await supabaseAdmin
      .from('reports')
      .select('id, description')
      .eq('status', 'published')
      .is('duplicate_of', null)
      .eq('lat', newRow.lat)
      .eq('lon', newRow.lon)
      .gte('created_at', seventyTwoHoursAgo)
      .neq('id', newRow.id)
      .limit(5)

    if (nearby && nearby.length > 0) {
      const candidateLines = nearby.map((r: { id: string; description: string }, i: number) => `${i + 1}. [id:${r.id}] ${r.description}`).join('\n')
      const dedupePrompt = `Eres un analista de un radar urbano comunitario. Alguien reporto un incidente muy cerca en tiempo y lugar de otros reportes existentes. Decide si describe el MISMO evento que alguno de ellos (mismo hecho visto o vivido por distintas personas) o si es un evento DIFERENTE que coincide en zona por casualidad.

Reportes existentes cercanos:
${candidateLines}

Reporte nuevo: ${newRow.description}

Si es el MISMO evento que alguno, responde con el id exacto de ESE reporte. Si es distinto a todos, responde "null".
Responde UNICAMENTE JSON valido: {"same_event_id": "uuid-o-null"}`

      const dedupe = await callNim(dedupePrompt)
      const matchId = dedupe?.same_event_id
      if (matchId && matchId !== 'null' && nearby.some((c: { id: string }) => c.id === matchId)) {
        await supabaseAdmin.from('reports').update({ duplicate_of: matchId }).eq('id', newRow.id)
        return new Response('ok: linked as duplicate', { status: 200 })
      }
    }
  }

  return new Response('ok: classified', { status: 200 })
})
