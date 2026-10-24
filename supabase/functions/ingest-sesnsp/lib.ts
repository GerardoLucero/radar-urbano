// Logica pura de ingest-sesnsp: parseo del CSV, eleccion de ano y validaciones.

import { parseCsv } from '../_shared/csv.ts'

export const MIN_MUNICIPIOS = 2000
export const MAX_TOTAL_VARIATION = 0.5
/** Si el total del ano mas reciente es menor a esta fraccion del anterior, se considera parcial. */
export const PARTIAL_YEAR_RATIO = 0.75

export const VIOLENT = new Set([
  'Homicidio doloso',
  'Secuestro',
  'Violación simple',
  'Violación equiparada',
  'Lesiones dolosas',
  'Extorsión',
  'Trata de personas',
])

export interface SesnspRow {
  year: number
  cve: string
  delito: string
  total: number
}

export interface Agg {
  total: number
  robos: number
  violentos: number
}

/** Parsea el CSV (AÑO,CVE_MUN,DELITO,TOTAL) usando los nombres de columna del encabezado. */
export function parseSesnspCsv(text: string): SesnspRow[] {
  const table = parseCsv(text)
  if (table.length < 2) return []
  const header = table[0].map((h) => h.trim().toUpperCase())
  const idx = (names: string[], fallback: number) => {
    const i = header.findIndex((h) => names.includes(h))
    return i === -1 ? fallback : i
  }
  const iYear = idx(['AÑO', 'ANO', 'AÑ O', 'YEAR'], 0)
  const iCve = idx(['CVE_MUN', 'CVE_MUNICIPIO'], 1)
  const iDelito = idx(['DELITO'], 2)
  const iTotal = idx(['TOTAL'], 3)

  const out: SesnspRow[] = []
  for (let r = 1; r < table.length; r++) {
    const row = table[r]
    const year = parseInt(row[iYear] ?? '', 10)
    const cve = (row[iCve] ?? '').trim()
    if (!year || !cve) continue
    out.push({
      year,
      cve,
      delito: (row[iDelito] ?? '').trim(),
      total: Math.round(Number(row[iTotal])) || 0,
    })
  }
  return out
}

export interface YearChoice {
  year: number
  /** Ano mas reciente descartado por parecer parcial, si lo hubo. */
  skippedPartialYear: number | null
  warnings: string[]
}

/**
 * Elige el ano a cargar. El ano mas reciente se descarta si su total es muy inferior
 * al del ano previo (dato parcial) y se avisa en lugar de usarlo en silencio.
 */
export function chooseYear(rows: SesnspRow[]): YearChoice | null {
  const totals = new Map<number, number>()
  for (const r of rows) totals.set(r.year, (totals.get(r.year) ?? 0) + r.total)
  const years = [...totals.keys()].sort((a, b) => b - a)
  if (years.length === 0) return null

  const latest = years[0]
  const prev = years[1]
  if (prev !== undefined) {
    const ratio = (totals.get(latest) ?? 0) / Math.max(1, totals.get(prev) ?? 0)
    if (ratio < PARTIAL_YEAR_RATIO) {
      return {
        year: prev,
        skippedPartialYear: latest,
        warnings: [
          `El ano ${latest} parece parcial (${Math.round(ratio * 100)}% del total de ${prev}); se carga ${prev}.`,
        ],
      }
    }
  }
  return { year: latest, skippedPartialYear: null, warnings: [] }
}

export function aggregateYear(rows: SesnspRow[], year: number): Map<string, Agg> {
  const agg = new Map<string, Agg>()
  for (const r of rows) {
    if (r.year !== year) continue
    const e = agg.get(r.cve) ?? { total: 0, robos: 0, violentos: 0 }
    e.total += r.total
    if (r.delito.startsWith('Robo')) e.robos += r.total
    if (VIOLENT.has(r.delito)) e.violentos += r.total
    agg.set(r.cve, e)
  }
  return agg
}

export type Validation = { ok: true } | { ok: false; reason: string }

/** Aborta (sin escribir) si el conjunto nuevo es sospechosamente pequeno o difiere mucho del existente. */
export function validateIngest(
  newTotal: number,
  municipiosCount: number,
  existingTotal: number | null,
): Validation {
  if (municipiosCount < MIN_MUNICIPIOS) {
    return { ok: false, reason: `solo ${municipiosCount} municipios en el CSV (minimo ${MIN_MUNICIPIOS})` }
  }
  if (existingTotal && existingTotal > 0) {
    const variation = Math.abs(newTotal - existingTotal) / existingTotal
    if (variation > MAX_TOTAL_VARIATION) {
      return {
        ok: false,
        reason: `variacion total de ${Math.round(variation * 100)}% frente a lo existente (maximo ${MAX_TOTAL_VARIATION * 100}%)`,
      }
    }
  }
  return { ok: true }
}

export function mirrorUrl(ref: string): string {
  return `https://raw.githubusercontent.com/lapanquecita/incidencia-delictiva/${ref}/data/timeseries_municipal.csv`
}
