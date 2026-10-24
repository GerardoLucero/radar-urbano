import { hasLlmProvider } from '../_shared/llm.ts'

// Endpoint de salud para monitoreo externo. No llama al LLM ni expone secretos:
// solo reporta si la base responde y si hay al menos un proveedor con llave.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')

async function checkDatabase(): Promise<boolean> {
  if (!SUPABASE_URL || !ANON_KEY) return false
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/sesnsp_municipal_crime?select=cve_mun&limit=1`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      signal: AbortSignal.timeout(4000),
    })
    await res.body?.cancel()
    return res.ok
  } catch {
    return false
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 })
  }
  const checks = {
    database: await checkDatabase(),
    llm_provider_configured: hasLlmProvider(),
  }
  const ok = checks.database && checks.llm_provider_configured
  return new Response(JSON.stringify({ ok, checks }), {
    status: ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
})
