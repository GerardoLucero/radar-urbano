# Radar Urbano: funcionalidades y detalle tecnico

Documento de detalle. El resumen esta en el [README](../README.md).

Radar comunitario de seguridad en México: fraudes telefónicos, robos, asaltos y más. Reporta en segundos, consulta antes de contestar o de pasar por una zona. Sitio: [radarurbano.org](https://radarurbano.org).

## Cómo funciona

- **Buscar**: escribe un número y ve si ya lo reportaron, con un score de confianza (una cota que crece con el conteo de reportes únicos; no es un intervalo de Wilson clásico).
- **Reportar**: describe qué pasó — nada más. Sin dropdown de categorías, sin registro. La IA decide sola de qué tipo de incidente se trata a partir del texto.
- **Ubicación**: para incidentes sin número (robo, asalto), un botón usa el GPS del navegador (difuminado a ~1km antes de guardarse); si no hay permiso, una zona/colonia escrita a mano se geocodifica del lado del servidor.
- **Seguridad de mi zona**: botón flotante que centra el mapa en tu ubicación real y genera un resumen en lenguaje natural (IA) de lo reportado cerca — usa reportes en vivo si los hay, y si no, cae en el contexto histórico oficial (SESNSP) de tu municipio en vez de decir "no sabemos nada".
- **Tendencias emergentes**: proactivo, sin que preguntes — si 3+ reportes distintos caen en el mismo punto (~1km) en menos de 7 días, se marca con un ícono pulsante ⚠️ y aparece un aviso automático al cargar el mapa.
- **Mapa**: capa de fraude telefónico agregado por región (LADA), incidentes físicos individuales con ubicación aproximada, contexto histórico oficial (SESNSP) de fondo, y tendencias emergentes. Filtro de ventana de tiempo (slider de días en el header) y por categoría (chips dinámicos). Toggle para ver como mapa de calor. Los puntos más recientes se ven más opacos/grandes (recencia visual); eventos duplicados reportados por varias personas se fusionan en uno con contador de confirmaciones.

## Hospedaje / Airbnb (reportar a una persona por nombre)

Vertical agregado el 2026-09-09 para reemplazar el "no le rentes a X" que hoy se pierde en WhatsApp. Distinto al resto del sitio en un punto clave: identifica a una PERSONA por nombre, no un teléfono o una zona — eso es más identificable y exige moderación humana antes de publicar (ver `MODERATION.md`).

- Botón "Hospedaje / Airbnb" en el mapa abre un formulario: nombre de la persona, link del anuncio (opcional), descripción, imagen de evidencia (opcional, ej. captura de conversación).
- Escritura solo vía la función `submit_named_report()` (Postgres, `SECURITY DEFINER`) — nunca inserción directa a tabla, así el cliente no puede forzar `status='published'` aunque quisiera.
- Todo reporte con nombre entra en `status='pending'` y se queda ahí hasta que un moderador lo revisa a mano en Supabase Studio (sin panel dedicado en esta v1) — ver `MODERATION.md` para el checklist.
- Imagen: el original sube a un bucket privado (`evidence-private`, sin lectura pública); solo el derivado recortado/redactado que el moderador sube a mano llega al bucket público (`evidence-public`).
- Rate-limit adicional por nombre reportado (máx. 3 reportes/24h con el mismo nombre) además del rate-limit por IP que ya cubre todo el sitio.
- Búsqueda por nombre (vista `named_report_confidence`) solo cuenta reportes ya publicados — igual de anónima que la búsqueda por teléfono, nunca expone la evidencia ni el link del anuncio.
- Expiración automática: un reporte sin un segundo reporte que lo corrobore se oculta a los 90 días (`pg_cron`, diario).
- Modelo de datos genérico a propósito (`report_subjects`, `report_evidence`) — reutilizable para cualquier categoría futura que necesite identificar a alguien por nombre, no exclusivo de hospedaje.

## Arquitectura

- Frontend: HTML/JS estático en GitHub Pages, dominio propio `radarurbano.org` detrás de Cloudflare (WAF + proxy, origen nunca expuesto)
- Datos: Supabase (Postgres + RLS) — proyecto `ifcgwnbaiozuvjorkcoc`
- IA (cascada Groq `openai/gpt-oss-120b` con NVIDIA NIM `openai/gpt-oss-20b` de respaldo; los modelos se cambian editando `models.json`, sin redesplegar), usos distintos:
  - **Clasificación + extracción de entidades**: todo reporte nuevo se etiqueta solo (categoría abierta, no un catálogo fijo) y se le extraen hora del día / arma / vehículo mencionados, sin pedirle más campos al usuario
  - **Corroboración** (solo fraude telefónico, que tiene una identidad natural — el número): compara descripciones de reportes repetidos del mismo número; si contradicen entre sí, el reporte pasa a revisión manual en vez de publicarse directo
  - **Fusión de duplicados** (incidentes físicos): reportes muy cercanos en tiempo/lugar se comparan por texto; si describen el mismo evento, se enlazan (`duplicate_of`) en vez de aparecer como puntos repetidos
  - **Resumen de zona**: bajo demanda, resume en 2-3 frases los reportes cercanos a una ubicación
- Geocoding: Nominatim (OpenStreetMap) del lado del servidor, tanto para el seed de LADAs como para `location_text` cuando no hay GPS
- Contexto de incidencia delictiva oficial (SESNSP): tablas `municipio_coordinates` + `sesnsp_municipal_crime`, top 400 municipios por volumen de delitos (no los ~2478 exhaustivos — la mayoría son poblados de cientos de habitantes irrelevantes para el mapa). Fuente: espejo comunitario en GitHub ([lapanquecita/incidencia-delictiva](https://github.com/lapanquecita/incidencia-delictiva)) porque los endpoints oficiales (datos.gob.mx, gob.mx/sesnsp) bloquean tráfico automatizado (Akamai WAF, links de SharePoint frágiles). `pg_cron` + Edge Function `ingest-sesnsp` refrescan esto automáticamente el día 3 de cada mes a las 09:00 UTC
- Confianza: puntaje acotado según el conteo de reportes únicos por número. Es una cota por conteo, no un intervalo de confianza de Wilson clásico; no debe leerse como probabilidad
- Deploy: GitHub Actions publica en GitHub Pages, en cada push a `main`, solo el contenido de `_site/` (página, `CNAME`, páginas legales, sitemap, robots); no se publican README, docs, `supabase/` ni `.github/`. Un smoke test posterior comprueba el sitio
- CI en cada PR: html-validate, sintaxis del JS embebido, gitleaks, `deno check` de las funciones y validación del sitemap. Acciones fijadas por SHA de commit y actualizadas por Dependabot
- Operación: monitoreo con ntfy (`health.yml`, cada 15 min), keep-alive diario de Supabase y backup nocturno cifrado (`backup.yml`). Ver `RUNBOOK.md` y `docs/restore.md`
- Anti-abuso: rate limit de 8 reportes/hora por IP (PostgREST `pgrst.db_pre_request`) + `ip_hash` (sha256 + salt, nunca la IP cruda) en cada reporte para detectar patrones de la misma fuente

## Estado

- [x] Schema multi-categoría (`reports` con teléfono opcional, ubicación GPS/texto, categoría abierta por IA, `duplicate_of`)
- [x] Frontend reestructurado: acciones flotantes pareadas (buscar / zona / reportar), slider de días en header, filtros de categoría, toggle de calor
- [x] Dominio propio `radarurbano.org` detrás de Cloudflare (WAF, proxy, origen oculto)
- [x] Seed completo de `lada_coordinates`: 397 códigos LADA de México
- [x] Edge Function `corroborate-report`: geocoding + clasificación + entidades + corroboración (teléfono) + fusión de duplicados (incidentes físicos), probado con pruebas automaticas
- [x] Edge Function `summarize-zone`: resumen de seguridad por zona bajo demanda
- [x] Rate limiting por IP (8/hora) + `ip_hash` no reversible por reporte
- [x] Recencia visual + heatmap + confirmación de duplicados en el mapa
- [x] Capa de contexto SESNSP: 400 municipios, carga inicial hecha + `pg_cron` mensual (`ingest-sesnsp`), probado con pruebas automaticas
- [ ] Mostrar la capa SESNSP en el mapa del frontend (los datos ya están en la base, falta el layer visual)
- [x] Borradores de aviso de privacidad, términos y procedimiento ARCO (`privacidad.html`, `terminos.html`, `arco.html`)
- [ ] **Revisión por un abogado de los borradores legales y del riesgo de difamación — pendiente, sitio ya público con reportes reales**
- [x] CI, monitoreo y backups cifrados definidos en `.github/workflows/`
- [ ] Configurar los secretos de CI (ver más abajo) y el checklist de Cloudflare de `RUNBOOK.md`
- [ ] Activar "Enforce HTTPS" en GitHub Pages cuando el certificado de origen termine de emitirse
- [ ] Clustering de marcadores (diferido hasta que haya más volumen de reportes reales)

## Documentos legales y operativos

- Borradores: [aviso de privacidad](https://radarurbano.org/privacidad.html), [términos](https://radarurbano.org/terminos.html), [derechos ARCO](https://radarurbano.org/arco.html)
- `MODERATION.md`: protocolo de moderación, baja, apelación y bitácora
- `RUNBOOK.md`: restauración, rotación de secretos, incidentes, checklist de Cloudflare
- `docs/restore.md`: restauración de prueba del backup

## Secretos de CI

Se configuran en GitHub > Settings > Secrets and variables > Actions. Todos son opcionales: si faltan, el paso correspondiente se omite con un aviso.

| Secreto | Usado por | Para qué |
|---|---|---|
| `NTFY_TOPIC` | health, backup | Tópico de ntfy para avisos de caída (sin datos personales) |
| `SUPABASE_HEALTH_URL` | health | URL de la función `/health` |
| `SUPABASE_URL` | health, deploy | Keep-alive diario y smoke test de API |
| `SUPABASE_ANON_KEY` | health, deploy | Llave anon para la consulta barata |
| `SUPABASE_DB_URL` | backup | Cadena de conexión para `pg_dump` |
| `BACKUP_AGE_RECIPIENT` | backup | Clave pública `age` con la que se cifra el volcado |
