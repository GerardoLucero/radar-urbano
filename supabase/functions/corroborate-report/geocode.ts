// Geocodificacion con Nominatim: presupuesto global, timeout por llamada y cache en memoria.

export interface GeoPoint {
  lat: number
  lon: number
}

const GEOCODE_BUDGET_MS = 8000
const CALL_TIMEOUT_MS = 4000
const CACHE_TTL_HIT_MS = 6 * 60 * 60 * 1000
const CACHE_TTL_MISS_MS = 10 * 60 * 1000
const CACHE_MAX = 500

const cache = new Map<string, { value: GeoPoint | null; expires: number }>()

function cacheKey(q: string): string {
  return q.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function cacheGet(key: string): { value: GeoPoint | null } | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (hit.expires < Date.now()) {
    cache.delete(key)
    return undefined
  }
  return { value: hit.value }
}

function cacheSet(key: string, value: GeoPoint | null): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { value, expires: Date.now() + (value ? CACHE_TTL_HIT_MS : CACHE_TTL_MISS_MS) })
}

function userAgent(): string {
  const email = Deno.env.get('NOMINATIM_EMAIL')
  return email ? `radar-urbano/1.0 (contacto: ${email})` : 'radar-urbano/1.0'
}

async function nominatimSearch(query: string, timeoutMs: number): Promise<GeoPoint | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({ q: query, format: 'json', limit: '1', countrycodes: 'mx' })
  const res = await fetch(url, {
    headers: { 'User-Agent': userAgent() },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    await res.body?.cancel()
    return null
  }
  const data = await res.json()
  if (!Array.isArray(data) || data.length === 0) return null
  const lat = parseFloat(data[0].lat)
  const lon = parseFloat(data[0].lon)
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
}

// "Colonia X" a veces no matchea en Nominatim aunque "X" solo si -- ej "Colonia
// Argentina Antigua" da 0 resultados, pero "Argentina Antigua" encuentra el barrio
// exacto. Reintenta sin el prefijo antes de rendirse.
const NEIGHBORHOOD_PREFIXES = /^(colonia|col\.?|barrio|fraccionamiento|fracc\.?|unidad habitacional)\s+/i

export async function geocodeLocationText(locationText: string): Promise<GeoPoint | null> {
  const key = cacheKey(locationText)
  const cached = cacheGet(key)
  if (cached) return cached.value

  const deadline = Date.now() + GEOCODE_BUDGET_MS
  const budgeted = () => Math.min(CALL_TIMEOUT_MS, deadline - Date.now())

  try {
    let found = await nominatimSearch(`${locationText}, Mexico`, budgeted())
    if (!found) {
      const stripped = locationText.replace(NEIGHBORHOOD_PREFIXES, '').trim()
      if (stripped !== locationText && stripped.length > 0 && budgeted() > 500) {
        found = await nominatimSearch(`${stripped}, Mexico`, budgeted())
      }
    }
    cacheSet(key, found)
    return found
  } catch (e) {
    // Timeout o red: no se cachea para poder reintentar en la siguiente peticion.
    console.error('geocoding error', e instanceof Error ? e.name : 'unknown')
    return null
  }
}
