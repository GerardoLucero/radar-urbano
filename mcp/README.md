# Servidor MCP de Radar Urbano

Servidor [MCP](https://modelcontextprotocol.io) por stdio para que un asistente de IA pueda **consultar un número** y **preparar un reporte** que la persona usuaria confirma. No necesita cuenta ni llaves propias.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `consultar_numero` | Cuántas personas distintas reportaron un número y cuándo fue el último reporte. Solo lectura. |
| `preparar_reporte` | Devuelve un enlace a Radar Urbano con el formulario prellenado. **No envía nada**: la persona lo abre, lo revisa y lo envía. |

Reglas que las herramientas imponen: "sin reportes" nunca se presenta como "seguro", los reportes se marcan como no verificados, y no existe herramienta para reportar personas por nombre ni para enviar reportes sin confirmación humana.

## Uso

```bash
cd mcp
npm install
npm test
```

Configuración de un cliente MCP (por ejemplo Claude Desktop):

```json
{
  "mcpServers": {
    "radar-urbano": {
      "command": "node",
      "args": ["/ruta/a/radar-urbano/mcp/server.mjs"]
    }
  }
}
```

## Cómo funciona

- `consultar_numero` hace una consulta de solo lectura a la vista pública `phone_confidence` con la llave publicable del sitio (pública por diseño; el acceso lo limita RLS).
- `preparar_reporte` solo construye una URL (`/?reportar=1&telefono=...&descripcion=...&zona=...`) que el sitio interpreta para prellenar el formulario. Ver [agentes.html](https://radarurbano.org/agentes.html).

## Pendiente

- Publicar el servidor en npm para usarlo con `npx`.
- Una herramienta de resumen de zona, cuando la Edge Function `summarize-zone` esté desplegada con los modelos actuales.
- Escritura directa por agentes con llave propia y cuota (diseñada, no implementada: ver `docs/agentes.md`).
