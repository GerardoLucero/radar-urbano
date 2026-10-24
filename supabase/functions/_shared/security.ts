/** Compara dos cadenas en tiempo constante respecto al contenido (recorre siempre el largo maximo). */
export function timingSafeEqualStrings(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  const len = Math.max(x.length, y.length)
  let diff = x.length ^ y.length
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  }
  return diff === 0
}

/** Verifica el secreto compartido de los webhooks internos. */
export function hasValidWebhookSecret(req: Request, expected: string | undefined): boolean {
  if (!expected) return false
  return timingSafeEqualStrings(req.headers.get('x-webhook-secret'), expected)
}
