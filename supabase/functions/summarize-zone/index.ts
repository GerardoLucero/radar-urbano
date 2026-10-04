import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
const SERVICE_KEY = SUPABASE_SECRET_KEYS['default'] ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const NVIDIA_NIM_API_KEY = Deno.env.get('NVIDIA_NIM_API_KEY')
const NIM_MODEL = 'deepseek-ai/deepseek-v4.1-flash'
const MAX_REPORTS = 15
const BOX = 0.15 // ~15km, "esta zona" -- mismo rango que usaba el cliente antes

const ALLOWED_ORIGINS = new Set(['https://radarurbano.org', 'https://www.radarurbano.org'])

function corsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://radarurbano.org'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

function sesnspLine(sesnsp: any): string {
  if (!sesnsp) return ''
  return `Contexto oficial (SESNSP, ${sesnsp.municipio}, ${sesnsp.estado}, ultimo ano disponible): ${sesnsp.total_delitos} delitos totales, ${sesnsp.total_robos} robos, ${sesnsp.total_violentos} delitos violentos. Esto es un promedio historico del municipio, no reportes en vivo de esta app.`
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY)

// Llamada directa desde el navegador (boton "que tan segura es esta zona").
// El cliente solo manda lat/lng -- la consulta a "reports" (que incluye texto
// libre de descripcion) se hace aqui con service key, nunca en el navegador.
// Antes el cliente traia hasta 15 descripciones completas via anon key y las
// reenviaba; cualquiera podia leer ese trafico o pedirle lo mismo a PostgREST
// directo. Ahora el texto crudo nunca sale del servidor -- solo el resumen.
Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  const headers = corsHeaders(origin)

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'bad payload' }), {
      status: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
    })
  }

  const lat = Number(body.lat)
  const lng = Number(body.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return new Response(JSON.stringify({ error: 'lat/lng requeridos' }), {
      status: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
    })
  }

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
    return new Response(JSON.stringify({ error: 'db error' }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
    })
  }

  const reports = nearby ?? []

  // Contexto SESNSP de la zona -- especialmente util cuando no hay reportes en vivo:
  // en vez de "no sabemos nada", el resumen puede decir "sin reportes en vivo, pero
  // el historico oficial de esta zona muestra X delitos/ano".
  let sesnsp: any = null
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
    }
  }

  const count = reports.length
  let tone: string
  let title: string
  if (count > 0) {
    tone = 'tone-alert'
    title = `${count} reporte${count === 1 ? '' : 's'} cerca`
  } else if (sesnsp && sesnsp.total_delitos > 1500) {
    tone = 'tone-warn'
    title = 'Sin reportes en vivo — histórico alto'
  } else {
    tone = 'tone-clear'
    title = 'Sin reportes cerca'
  }

  if (reports.length === 0 && !sesnsp) {
    return new Response(
      JSON.stringify({
        title,
        tone,
        summary:
          'No hay reportes recientes en esta zona ni datos históricos disponibles todavía. Eso no significa que sea segura, solo que no tenemos información de esta zona.',
      }),
      { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } }
    )
  }

  if (!NVIDIA_NIM_API_KEY) {
    return new Response(JSON.stringify({ title, tone, summary: 'Resumen no disponible por ahora.' }), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
    })
  }

  const reportLines = reports.length > 0
    ? reports
        .map((r: any, i: number) => `${i + 1}. [${r.category || 'sin clasificar'}] ${r.description} (${r.created_at ? new Date(r.created_at).toLocaleDateString('es-MX') : 'fecha desconocida'})`)
        .join('\n')
    : 'Ninguno.'

  const prompt = `Eres el asistente de un radar urbano comunitario en Mexico. Un usuario quiere saber que tan segura es una zona ahora mismo. Tienes dos fuentes, no las confundas:

Reportes en vivo cercanos (de la app, recientes):
${reportLines}

${sesnspLine(sesnsp) || 'Sin contexto oficial SESNSP disponible para esta zona.'}

Escribe 2-3 frases cortas en espanol neutro de Mexico. El tono correcto es el de alguien que conoce la zona y te da un aviso rapido y directo -- ni el reporte de una dependencia de gobierno, ni un chat entre cuates con groserias o jerga de calle ("un chingo", "no manches", "aguas"). Nada de frases como "actividad delictiva considerable en terminos generales" o "te sugiero mantener precauciones habituales" -- pero tampoco caigas en slang. Punto medio: claro, humano, sin adornos. Ve al grano: que paso (o no paso), que tan grave es, y una recomendacion breve si aplica. No alarmista, pero tampoco le restes importancia. Deja claro que son reportes de usuarios sin verificar, no hechos confirmados. Si no hay reportes en vivo pero SI hay contexto SESNSP, dilo directo ("nadie ha reportado nada aqui todavia, pero esta zona historicamente tiene..."). Si hay reportes en vivo, esos van primero. No inventes datos que no esten arriba.`

  // NIM a veces responde 529 "temporarily overloaded" -- transitorio, un reintento
  // corto lo resuelve la mayoria de las veces en vez de mostrarle el error al usuario.
  // Tambien a veces no responde nada (cuelga la conexion) -- esta es una llamada
  // directa del navegador, asi que sin timeout propio el usuario se queda esperando
  // hasta que la plataforma mata la funcion con un error crudo en vez del fallback.
  const NIM_TIMEOUT_MS = 12000
  async function callNimOnce() {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), NIM_TIMEOUT_MS)
    try {
      return await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${NVIDIA_NIM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: NIM_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 200,
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  const fallbackResponse = () =>
    new Response(JSON.stringify({ title, tone, summary: 'No se pudo generar el resumen. Intenta de nuevo.' }), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
    })

  let nimRes: Response
  try {
    nimRes = await callNimOnce()
  } catch (e) {
    console.error('NIM fetch failed or timed out', e)
    return fallbackResponse()
  }

  if (!nimRes.ok && (nimRes.status === 529 || nimRes.status === 503)) {
    console.warn(`NIM overloaded (${nimRes.status}), retrying once...`)
    await new Promise((r) => setTimeout(r, 1200))
    try {
      nimRes = await callNimOnce()
    } catch (e) {
      console.error('NIM retry fetch failed or timed out', e)
      return fallbackResponse()
    }
  }

  if (!nimRes.ok) {
    console.error('NIM error', await nimRes.text())
    return fallbackResponse()
  }

  const nimData = await nimRes.json()
  const summary = nimData.choices?.[0]?.message?.content?.trim() || 'No se pudo generar el resumen.'

  return new Response(JSON.stringify({ title, tone, summary }), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
})
