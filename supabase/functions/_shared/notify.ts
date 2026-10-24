// Alertas operativas por ntfy. Nunca lanza, nunca bloquea mas de 3 s y no debe
// recibir datos personales ni texto de reportes: solo estados y conteos.

const NOTIFY_TIMEOUT_MS = 3000
const lastSent = new Map<string, number>()

export interface NotifyOptions {
  title?: string
  priority?: 'min' | 'low' | 'default' | 'high' | 'urgent'
  tags?: string
  /** Si se da, no se vuelve a enviar la misma clave antes de `throttleMs` (por instancia). */
  throttleKey?: string
  throttleMs?: number
  fetchImpl?: typeof fetch
  topic?: string
}

/** Deja un valor apto para cabecera HTTP: ASCII imprimible, una linea. */
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]+/g, ' ').slice(0, 120)
}

export async function notify(message: string, opts: NotifyOptions = {}): Promise<boolean> {
  try {
    const topic = opts.topic ?? Deno.env.get('NTFY_TOPIC')
    if (!topic || !/^[A-Za-z0-9_-]{1,100}$/.test(topic)) return false

    if (opts.throttleKey) {
      const now = Date.now()
      const prev = lastSent.get(opts.throttleKey)
      if (prev !== undefined && now - prev < (opts.throttleMs ?? 10 * 60 * 1000)) return false
      lastSent.set(opts.throttleKey, now)
    }

    const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' }
    if (opts.title) headers['Title'] = headerSafe(opts.title)
    if (opts.priority) headers['Priority'] = opts.priority
    if (opts.tags) headers['Tags'] = headerSafe(opts.tags)

    const res = await (opts.fetchImpl ?? fetch)(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers,
      body: message.slice(0, 1000),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    })
    // Consumir el cuerpo para liberar la conexion.
    await res.body?.cancel()
    return res.ok
  } catch {
    return false
  }
}

/** Solo para pruebas. */
export function _resetNotifyThrottle(): void {
  lastSent.clear()
}
