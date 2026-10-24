import { assertEquals, assertRejects, assert } from 'jsr:@std/assert@1'
import { z } from 'npm:zod@3.25.76'
import { configuredProviders, extractJson, generateJson, LlmError } from './llm.ts'

const Schema = z.object({ ok: z.boolean() })
const env = (vars: Record<string, string>) => (k: string) => vars[k]
const BOTH = env({ GROQ_API_KEY: 'g', NVIDIA_NIM_API_KEY: 'n' })

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

interface Call {
  url: string
  body: any
}

function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: JSON.parse(String(init?.body ?? '{}')) }
    calls.push(call)
    return Promise.resolve(handler(call, calls.length))
  }) as typeof fetch
  return { impl, calls }
}

const instant = { sleep: () => Promise.resolve(), random: () => 0 }
const opts = { system: 's', user: 'u' }

Deno.test('extractJson: quita fences y texto alrededor', () => {
  assertEquals(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assertEquals(extractJson('Claro, aqui esta: {"a":{"b":[1,2]}} espero que sirva'), { a: { b: [1, 2] } })
})

Deno.test('extractJson: llaves dentro de cadenas no rompen el balance', () => {
  assertEquals(extractJson('{"a":"}{ \\" }","b":2}'), { a: '}{ " }', b: 2 })
})

Deno.test('extractJson: prosa con llaves antes del objeto real (sin regex voraz)', () => {
  assertEquals(extractJson('usa {llaves} asi. Resultado: {"ok":true} fin {otra}'), { ok: true })
})

Deno.test('extractJson: sin objeto o truncado lanza', () => {
  for (const bad of ['', 'no json', '{"a":', '[1,2]']) {
    let threw = false
    try {
      extractJson(bad)
    } catch {
      threw = true
    }
    assert(threw, bad)
  }
})

Deno.test('configuredProviders: omite proveedores sin llave y respeta modelos de env', () => {
  assertEquals(configuredProviders({ getEnv: env({}) }), [])
  const only = configuredProviders({ getEnv: env({ NVIDIA_NIM_API_KEY: 'n', NIM_MODEL: 'x/y' }) })
  assertEquals(only.map((p) => [p.name, p.model]), [['nim', 'x/y']])
  const both = configuredProviders({ getEnv: BOTH })
  assertEquals(both.map((p) => [p.name, p.model]), [['groq', 'openai/gpt-oss-120b'], ['nim', 'openai/gpt-oss-20b']])
})

Deno.test('generateJson: sin llaves lanza no_provider', async () => {
  const err = await assertRejects(() => generateJson(opts, Schema, { getEnv: env({}) }), LlmError)
  assertEquals((err as LlmError).kind, 'no_provider')
})

Deno.test('generateJson: primario falla -> respaldo responde', async () => {
  const f = fakeFetch((call) =>
    call.url.includes('groq') ? new Response('boom', { status: 401 }) : completion('{"ok":true}')
  )
  const out = await generateJson(opts, Schema, { fetchImpl: f.impl, getEnv: BOTH, ...instant })
  assertEquals(out.provider, 'nim')
  assertEquals(out.data, { ok: true })
  assertEquals(f.calls.length, 2)
  assertEquals(f.calls[0].body.reasoning_effort, 'low')
  assertEquals(f.calls[0].body.response_format, { type: 'json_object' })
  assertEquals(f.calls[1].body.reasoning_effort, undefined)
})

Deno.test('generateJson: 429 se reintenta con el mismo proveedor', async () => {
  const f = fakeFetch((_c, n) => (n === 1 ? new Response('', { status: 429 }) : completion('{"ok":true}')))
  const out = await generateJson(opts, Schema, { fetchImpl: f.impl, getEnv: BOTH, ...instant })
  assertEquals(out.provider, 'groq')
  assertEquals(f.calls.length, 2)
})

Deno.test('generateJson: 401 no se reintenta en el mismo proveedor', async () => {
  const f = fakeFetch((call) =>
    call.url.includes('groq') ? new Response('', { status: 401 }) : completion('{"ok":true}')
  )
  await generateJson(opts, Schema, { fetchImpl: f.impl, getEnv: BOTH, ...instant })
  assertEquals(f.calls.filter((c) => c.url.includes('groq')).length, 1)
})

Deno.test('generateJson: salida invalida del primario -> prueba el respaldo', async () => {
  const f = fakeFetch((call) =>
    call.url.includes('groq') ? completion('{"ok":"si"}') : completion('{"ok":false}')
  )
  const out = await generateJson(opts, Schema, { fetchImpl: f.impl, getEnv: BOTH, ...instant })
  assertEquals(out.provider, 'nim')
})

Deno.test('generateJson: todo falla -> segunda ronda en orden inverso y luego error', async () => {
  const order: string[] = []
  const f = fakeFetch((call) => {
    order.push(call.url.includes('groq') ? 'groq' : 'nim')
    return new Response('', { status: 503 })
  })
  const err = await assertRejects(
    () => generateJson(opts, Schema, { fetchImpl: f.impl, getEnv: BOTH, ...instant }),
    LlmError,
  )
  assertEquals((err as LlmError).kind, 'provider_failure')
  // Ronda 1: groq x2, nim x2. Ronda 2 (inversa): nim x2, groq x2.
  assertEquals(order, ['groq', 'groq', 'nim', 'nim', 'nim', 'nim', 'groq', 'groq'])
})

Deno.test('generateJson: la segunda ronda recupera y usa temperature 0', async () => {
  const f = fakeFetch((_c, n) => (n <= 4 ? new Response('', { status: 529 }) : completion('{"ok":true}')))
  const out = await generateJson({ ...opts, temperature: 0.5 }, Schema, { fetchImpl: f.impl, getEnv: BOTH, ...instant })
  assertEquals(out.provider, 'nim')
  assertEquals(f.calls[0].body.temperature, 0.5)
  assertEquals(f.calls[4].body.temperature, 0)
})

Deno.test('generateJson: respuesta basura de ambos -> invalid_output', async () => {
  const f = fakeFetch(() => completion('no soy json'))
  const err = await assertRejects(
    () => generateJson(opts, Schema, { fetchImpl: f.impl, getEnv: BOTH, ...instant }),
    LlmError,
  )
  assertEquals((err as LlmError).kind, 'invalid_output')
})

Deno.test('generateJson: respeta el presupuesto de tiempo total', async () => {
  let t = 0
  const f = fakeFetch(() => {
    t += 20_000 // cada llamada "consume" 20 s
    return new Response('', { status: 503 })
  })
  await assertRejects(
    () =>
      generateJson({ ...opts, budgetMs: 25_000 }, Schema, {
        fetchImpl: f.impl,
        getEnv: BOTH,
        now: () => t,
        sleep: () => Promise.resolve(),
        random: () => 0,
      }),
    LlmError,
  )
  assert(f.calls.length <= 2, `demasiadas llamadas: ${f.calls.length}`)
})

Deno.test('generateJson: el mensaje de error no filtra el cuerpo de la respuesta', async () => {
  const f = fakeFetch(() => new Response('texto sensible del reporte', { status: 500 }))
  const err = await assertRejects(
    () => generateJson(opts, Schema, { fetchImpl: f.impl, getEnv: BOTH, ...instant }),
    LlmError,
  )
  assert(!(err as LlmError).message.includes('sensible'))
})

Deno.test('generateJson: las instrucciones van en system y el dato en user', async () => {
  const f = fakeFetch(() => completion('{"ok":true}'))
  await generateJson({ system: 'REGLAS', user: '<reporte>x</reporte>' }, Schema, {
    fetchImpl: f.impl,
    getEnv: BOTH,
    ...instant,
  })
  const [sys, usr] = f.calls[0].body.messages
  assertEquals(sys.role, 'system')
  assert(sys.content.startsWith('REGLAS'))
  assertEquals(usr, { role: 'user', content: '<reporte>x</reporte>' })
})
