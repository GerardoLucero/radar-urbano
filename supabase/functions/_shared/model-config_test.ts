import { assertEquals } from 'jsr:@std/assert@1'
import { DEFAULT_MODELS, getModelConfig, resetModelConfigCache } from './model-config.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const noEnv = () => undefined

Deno.test('model-config: usa la lista remota valida y la cachea', async () => {
  resetModelConfigCache()
  let n = 0
  const fetchImpl = (() => (n++, Promise.resolve(json({ groq: ['a/b'], nim: ['c/d', 'e/f'] })))) as typeof fetch
  assertEquals(await getModelConfig({ fetchImpl, getEnv: noEnv }), { groq: ['a/b'], nim: ['c/d', 'e/f'] })
  await getModelConfig({ fetchImpl, getEnv: noEnv })
  assertEquals(n, 1)
})

Deno.test('model-config: remoto caido o invalido -> lista por defecto', async () => {
  for (const res of [json({}, 500), json({ groq: [], nim: [] })]) {
    resetModelConfigCache()
    const fetchImpl = (() => Promise.resolve(res.clone())) as typeof fetch
    assertEquals(await getModelConfig({ fetchImpl, getEnv: noEnv }), DEFAULT_MODELS)
  }
})

Deno.test('model-config: GROQ_MODEL se antepone', async () => {
  resetModelConfigCache()
  const fetchImpl = (() => Promise.resolve(json({ groq: ['a/b'], nim: ['c/d'] }))) as typeof fetch
  const cfg = await getModelConfig({ fetchImpl, getEnv: (k) => (k === 'GROQ_MODEL' ? 'x/y' : undefined) })
  assertEquals(cfg.groq, ['x/y', 'a/b'])
})
