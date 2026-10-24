// Evals de clasificacion, deduplicacion y corroboracion contra el proveedor LLM
// configurado por env (GROQ_API_KEY y/o NVIDIA_NIM_API_KEY). No corre en CI sin llaves.
//
//   deno run --allow-env --allow-net --allow-read supabase/evals/run.ts [--only=adversarial]
//
// Variables: GROQ_API_KEY, NVIDIA_NIM_API_KEY, GROQ_MODEL, NIM_MODEL,
// EVAL_MIN_ACCURACY (por defecto 0.8), EVAL_DELAY_MS (pausa entre casos, por defecto 300).

import { generateJson, hasLlmProvider } from '../functions/_shared/llm.ts'
import {
  buildClassifyUser,
  buildCorroborateUser,
  buildDedupeSchema,
  buildDedupeUser,
  CLASSIFY_SYSTEM,
  ClassificationSchema,
  CORROBORATE_SYSTEM,
  DEDUPE_SYSTEM,
  VerdictSchema,
} from '../functions/corroborate-report/logic.ts'

interface Case {
  id: string
  kind: 'classify' | 'dedupe' | 'corroborate'
  adversarial?: boolean
  text: string
  phone?: boolean
  expected_category_any?: string[]
  forbid_category_regex?: string
  forbid_vehicle_regex?: string
  forbid_reason_regex?: string
  candidates?: Array<{ id: string; text: string }>
  expected_index?: number | null
  prior?: string[]
  expected_verdict?: 'corroborates' | 'contradicts'
}

type Outcome = { pass: boolean; schemaOk: boolean; detail: string }

async function runCase(c: Case): Promise<Outcome> {
  try {
    if (c.kind === 'classify') {
      const { data } = await generateJson(
        { system: CLASSIFY_SYSTEM, user: buildClassifyUser(c.text, Boolean(c.phone)), maxTokens: 400 },
        ClassificationSchema,
      )
      let pass = true
      if (c.expected_category_any) pass = c.expected_category_any.includes(data.category)
      if (c.forbid_category_regex && new RegExp(c.forbid_category_regex, 'i').test(data.category)) pass = false
      if (c.forbid_vehicle_regex && data.vehicle && new RegExp(c.forbid_vehicle_regex, 'i').test(data.vehicle)) pass = false
      return { pass, schemaOk: true, detail: `category=${data.category}` }
    }
    if (c.kind === 'dedupe') {
      const cands = c.candidates ?? []
      const { data } = await generateJson(
        {
          system: DEDUPE_SYSTEM,
          user: buildDedupeUser(cands.map((x) => ({ id: x.id, description: x.text })), c.text),
          maxTokens: 300,
        },
        buildDedupeSchema(cands.map((x) => x.id)),
      )
      const id = data.same_event_id ? String(data.same_event_id).toLowerCase() : null
      const got = id ? cands.findIndex((x) => x.id === id) : null
      return { pass: got === (c.expected_index ?? null), schemaOk: true, detail: `index=${got}` }
    }
    const { data } = await generateJson(
      {
        system: CORROBORATE_SYSTEM,
        user: buildCorroborateUser((c.prior ?? []).map((t, i) => ({ id: String(i), description: t })), c.text),
        maxTokens: 400,
      },
      VerdictSchema,
    )
    let pass = data.verdict === c.expected_verdict
    if (c.forbid_reason_regex && new RegExp(c.forbid_reason_regex, 'i').test(data.reason)) pass = false
    return { pass, schemaOk: true, detail: `verdict=${data.verdict}` }
  } catch (e) {
    // Una salida que no valida cuenta como fallo de esquema; para adversariales
    // es el comportamiento seguro (fail-safe), pero se reporta aparte.
    return { pass: false, schemaOk: false, detail: e instanceof Error ? e.message.slice(0, 120) : 'error' }
  }
}

if (!hasLlmProvider()) {
  console.error('Sin GROQ_API_KEY ni NVIDIA_NIM_API_KEY: evals omitidas.')
  Deno.exit(0)
}

const only = Deno.args.find((a) => a.startsWith('--only='))?.slice(7)
const raw = JSON.parse(await Deno.readTextFile(new URL('./cases.json', import.meta.url)))
let cases: Case[] = raw.cases
if (only === 'adversarial') cases = cases.filter((c) => c.adversarial)
else if (only) cases = cases.filter((c) => c.kind === only && !c.adversarial)

const delay = Number(Deno.env.get('EVAL_DELAY_MS') ?? 300)
const stats = new Map<string, { pass: number; total: number; schemaFail: number }>()
for (const c of cases) {
  const group = c.adversarial ? 'adversarial' : c.kind
  const s = stats.get(group) ?? { pass: 0, total: 0, schemaFail: 0 }
  const o = await runCase(c)
  s.total++
  if (o.pass) s.pass++
  if (!o.schemaOk) s.schemaFail++
  stats.set(group, s)
  console.log(`${o.pass ? 'PASS' : 'FAIL'} ${c.id} ${o.detail}`)
  await new Promise((r) => setTimeout(r, delay))
}

let pass = 0
let total = 0
console.log('\nResumen')
for (const [group, s] of stats) {
  pass += s.pass
  total += s.total
  console.log(`${group.padEnd(12)} ${s.pass}/${s.total} (${Math.round((100 * s.pass) / s.total)}%), fallos de esquema: ${s.schemaFail}`)
}
const accuracy = total ? pass / total : 0
const min = Number(Deno.env.get('EVAL_MIN_ACCURACY') ?? 0.8)
console.log(`Total ${pass}/${total} (${Math.round(accuracy * 100)}%), minimo ${Math.round(min * 100)}%`)
Deno.exit(accuracy >= min ? 0 : 1)
