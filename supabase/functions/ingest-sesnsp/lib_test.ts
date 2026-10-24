import { assert, assertEquals } from 'jsr:@std/assert@1'
import { aggregateYear, chooseYear, mirrorUrl, parseSesnspCsv, validateIngest } from './lib.ts'

const CSV = [
  'AÑO,CVE_MUN,DELITO,TOTAL',
  '2023,01001,Robo a casa habitación,10',
  '2023,01001,Homicidio doloso,5',
  '2024,01001,"Robo, de vehículo",20',
  '2024,01001,"Lesiones dolosas",4',
  '2024,01002,Fraude,7',
  '',
].join('\n')

Deno.test('parseSesnspCsv: respeta comillas con comas y lee por nombre de columna', () => {
  const rows = parseSesnspCsv(CSV)
  assertEquals(rows.length, 5)
  assertEquals(rows[2], { year: 2024, cve: '01001', delito: 'Robo, de vehículo', total: 20 })
})

Deno.test('parseSesnspCsv: columnas reordenadas se leen por encabezado', () => {
  const rows = parseSesnspCsv('TOTAL,DELITO,CVE_MUN,AÑO\n3,Robo X,02001,2024\n')
  assertEquals(rows, [{ year: 2024, cve: '02001', delito: 'Robo X', total: 3 }])
})

Deno.test('parseSesnspCsv: ignora filas sin ano o sin municipio y vacio da []', () => {
  assertEquals(parseSesnspCsv('AÑO,CVE_MUN,DELITO,TOTAL\n,01001,x,1\n2024,,x,1\n').length, 0)
  assertEquals(parseSesnspCsv('').length, 0)
})

Deno.test('aggregateYear: clasifica robos y violentos (con la coma entre comillas)', () => {
  const agg = aggregateYear(parseSesnspCsv(CSV), 2024)
  assertEquals(agg.get('01001'), { total: 24, robos: 20, violentos: 4 })
  assertEquals(agg.get('01002'), { total: 7, robos: 0, violentos: 0 })
})

Deno.test('chooseYear: usa el ultimo ano si es comparable con el previo', () => {
  const c = chooseYear([
    { year: 2023, cve: 'a', delito: 'x', total: 1000 },
    { year: 2024, cve: 'a', delito: 'x', total: 950 },
  ])
  assertEquals(c?.year, 2024)
  assertEquals(c?.warnings, [])
})

Deno.test('chooseYear: ano mas reciente parcial se descarta y se avisa', () => {
  const c = chooseYear([
    { year: 2024, cve: 'a', delito: 'x', total: 1000 },
    { year: 2025, cve: 'a', delito: 'x', total: 300 },
  ])
  assertEquals(c?.year, 2024)
  assertEquals(c?.skippedPartialYear, 2025)
  assert(c!.warnings[0].includes('2025'))
})

Deno.test('chooseYear: un solo ano o vacio', () => {
  assertEquals(chooseYear([{ year: 2024, cve: 'a', delito: 'x', total: 1 }])?.year, 2024)
  assertEquals(chooseYear([]), null)
})

Deno.test('validateIngest: aborta con menos de 2000 municipios', () => {
  const r = validateIngest(1000, 1999, null)
  assertEquals(r.ok, false)
  assertEquals(validateIngest(1000, 2000, null).ok, true)
})

Deno.test('validateIngest: aborta con variacion total > 50% y acepta <= 50%', () => {
  assertEquals(validateIngest(1600, 2500, 1000).ok, false)
  assertEquals(validateIngest(400, 2500, 1000).ok, false)
  assertEquals(validateIngest(1500, 2500, 1000).ok, true)
  assertEquals(validateIngest(700, 2500, 1000).ok, true)
  assertEquals(validateIngest(700, 2500, 0).ok, true)
})

Deno.test('mirrorUrl: fija el ref en la URL', () => {
  assert(mirrorUrl('abc123').includes('/incidencia-delictiva/abc123/data/timeseries_municipal.csv'))
})
