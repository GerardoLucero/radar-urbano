# Acceso para asistentes de IA

Decisiones de diseño de cómo los asistentes de IA usan Radar Urbano.

## Qué está implementado

1. **Descubrimiento**: `llms.txt`, `openapi.json` y la página `agentes.html`, publicados en la raíz del sitio.
2. **Consulta**: lectura de `phone_confidence` con la llave publicable (descrita en `openapi.json`).
3. **Reporte con confirmación humana**: enlaces `/?buscar=<telefono>` y `/?reportar=1&telefono=&descripcion=&zona=`. Solo prellenan el formulario; el envío sigue pasando por la persona y por las defensas existentes.
4. **Servidor MCP** (`mcp/`): `consultar_numero` y `preparar_reporte`.

## Qué NO se permite a propósito

- Reportes de personas por nombre (vertical de hospedaje): riesgo de difamación masiva y falta de revisión legal.
- Envío automático o en lote: un reporte debe venir de alguien que vivió o presenció el hecho.

## Fase 3 (no implementada): escritura directa por agentes

Si algún día se abre, requiere como mínimo:

- Función `submit-report` en Supabase con llave por agente o por usuario, cuota diaria y registro de quién envió qué.
- Todo reporte de agente entra como `pending` y no cuenta para la confianza hasta que lo corrobore otra fuente independiente.
- Solo fraude por teléfono e incidentes por zona; nunca nombres.
- Turnstile no aplica a agentes; la identidad la da la llave.

## Cloudflare

El sitio está detrás de Cloudflare con robots.txt gestionado: puede bloquear a los rastreadores de IA aunque el `robots.txt` del repositorio los permita. Para que `llms.txt` y `agentes.html` los lean los asistentes:

- Revisar en Cloudflare (Seguridad / bots) la sección de rastreadores de IA y permitir a los que se quiera.
- Comprobar con `curl -A "ClaudeBot" https://radarurbano.org/llms.txt` que responde 200.
