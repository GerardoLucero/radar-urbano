# Runbook operativo

Guía para quien opere Radar Urbano. No contiene valores de secretos: solo nombres, dueños y procedimientos.

## 1. Restaurar un backup

El backup nocturno (`backup.yml`) es un `pg_dump` cifrado con `age`. Procedimiento completo y prueba mensual en `docs/restore.md`.

Incidente real, en orden:
1. Declarar el incidente y pausar la recepción de reportes si hace falta (sección 4).
2. Descargar el último artefacto `db-backup` y descifrarlo con la clave privada de `age`.
3. Crear un proyecto Supabase nuevo o vaciar el afectado; restaurar con `pg_restore`.
4. Reaplicar las migraciones de `supabase/migrations/` posteriores a la fecha del backup.
5. Recrear secretos de las funciones (sección 2) y volver a desplegarlas.
6. Si el proyecto cambió de URL: actualizar `SUPABASE_URL` y la llave anon en `index.html` y los secretos de GitHub.
7. Storage (imágenes) no está en el volcado: restaurar desde la copia manual de los buckets si existe; si no, los reportes quedan sin imagen y se deja constancia en la bitácora.
8. Verificar con el smoke test (`Deploy` > `smoke`) y un reporte de prueba.

## 2. Rotar secretos

Inventario de cuentas y secretos. La columna Propietario es la persona responsable de rotarlo; completar nombres reales.

| Secreto / cuenta | Dónde vive | Propietario | Rotación sugerida |
|---|---|---|---|
| Cuenta GitHub (repo, Pages, Actions) | GitHub | Gerardo | 2FA obligatorio; revisar tokens cada 6 meses |
| Cuenta Cloudflare (DNS, WAF, Turnstile) | Cloudflare | Gerardo | 2FA; llave de recuperación guardada |
| Cuenta Supabase (proyecto `ifcgwnbaiozuvjorkcoc`) | Supabase | Gerardo | 2FA |
| `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEYS` | Secretos de Edge Functions | Gerardo | Ante sospecha de fuga o cada 6 meses |
| `SUPABASE_DB_URL` (contraseña de la base) | Secreto de GitHub (backup) | Gerardo | Cada 6 meses; tras rotar, actualizar el secreto |
| `SUPABASE_ANON_KEY` | Pública en `index.html`; secreto de GitHub para pruebas | Gerardo | Solo si se revoca |
| `NVIDIA_NIM_API_KEY` | Secreto de Edge Functions | Gerardo | Cada 6 meses o ante fuga |
| Llave del proveedor alterno de IA (Groq), si se usa | Secreto de Edge Functions | Gerardo | Igual |
| `RESEND_API_KEY` y `ALERT_EMAIL` | Secretos de Edge Functions | Gerardo | Cada 6 meses |
| `FUNCTION_SECRET` | Secreto de Edge Functions | Gerardo | Cada 6 meses |
| Sal de `ip_hash` | Configuración de la base | Gerardo | No rotar sin plan: invalida el límite por huella; rotar solo ante fuga |
| `BACKUP_AGE_RECIPIENT` (pública) y clave privada `age` | Pública: GitHub. Privada: gestor de contraseñas | Gerardo + segundo administrador | Al cambiar de custodio |
| `NTFY_TOPIC` | Secreto de GitHub | Gerardo | Si se sospecha que alguien lo conoce |
| `SUPABASE_HEALTH_URL`, `SUPABASE_URL` | Secretos de GitHub | Gerardo | Si cambia el proyecto |
| Turnstile (clave de sitio y secreta) | Cloudflare y secreto de función | Gerardo | Ante abuso |

Procedimiento genérico: generar el valor nuevo, guardarlo en el gestor de contraseñas, actualizar el secreto (GitHub: Settings > Secrets; Supabase: `supabase secrets set NOMBRE` o Dashboard > Edge Functions > Secrets), volver a desplegar la función afectada, comprobar con el smoke test, revocar el valor anterior en el proveedor, registrar la fecha.

## 3. Si cae el modelo de IA (NVIDIA NIM)

Síntomas: reportes sin categoría, `corroborate-report` con errores, resúmenes de zona vacíos.
1. Confirmar en los logs de la función (Dashboard > Edge Functions > Logs) y en el estado del proveedor.
2. Los reportes nuevos siguen guardándose; sin clasificación quedan como categoría genérica y los reportes con nombre siguen en `pending` (nunca se auto-publican).
3. Si hay un proveedor alterno configurado (Groq), cambiar el secreto de modelo/endpoint y redesplegar.
4. Si no, dejar degradar: la búsqueda y el mapa funcionan sin IA. Anotar los reportes sin clasificar para reprocesarlos al volver el servicio.
5. Si la caída pasa de 24 h, avisar en el sitio (banner) y revisar manualmente la cola de moderación.

## 4. Desactivar el formulario de nombres

Es el interruptor de emergencia ante abuso, un reclamo masivo o un riesgo legal.
1. Preferente: revocar el permiso de ejecución de la función de escritura en SQL Editor, por ejemplo `revoke execute on function submit_named_report from anon;` (confirmar el nombre y la firma exactos de la función antes de ejecutar). El formulario queda inoperante sin tocar el frontend.
2. Alternativa visual: ocultar el botón en `index.html` con un PR de emergencia (requiere deploy).
3. Registrar en la bitácora quién, cuándo y por qué. Para reactivar: `grant execute on function submit_named_report to anon;`.

## 5. Despublicar un reporte por solicitud legal o judicial

1. Registrar la solicitud (fecha, autoridad o persona, número de oficio) y acusar recibo en 72 h.
2. Despublicar primero: `update reports set status = 'pending' where id = '<id>';` y, si hay derivado de imagen, retirar el archivo de `evidence-public` y poner en `null` `report_evidence.storage_path_public_derivative`.
3. Escribir la entrada en `moderation_log` (acción `unpublish`, motivo, referencia al oficio).
4. No borrar el original ni la bitácora: pueden ser evidencia. Aplicar conservación legal (bloqueo) si la autoridad lo pide.
5. Escalar a Legal antes de entregar datos a cualquier autoridad. Entregar solo lo que el requerimiento pida.
6. Responder al solicitante según `MODERATION.md`.

## 6. Acceso de emergencia y segundo administrador

- Debe existir un **segundo administrador de confianza** con acceso a GitHub (rol Admin), Cloudflare y Supabase (rol Owner/Admin), con 2FA propio.
- Las claves de recuperación 2FA y la clave privada de `age` están en un gestor de contraseñas compartido o en un sobre sellado con el segundo administrador.
- Probar el acceso del segundo administrador cada 6 meses.
- Si Gerardo no está disponible: el segundo administrador puede (a) desactivar el formulario (sección 4), (b) despublicar reportes, (c) restaurar un backup.

## 7. Checklist de Cloudflare

Verificar tras cualquier cambio de DNS o de proxy:

- [ ] DNS de `radarurbano.org` con proxy activo (nube naranja).
- [ ] SSL/TLS > Overview: modo **Full (strict)**.
- [ ] SSL/TLS > Edge Certificates: **Always Use HTTPS** activo.
- [ ] **HSTS** activado (max-age 6 meses o más; includeSubDomains solo si todos los subdominios usan HTTPS).
- [ ] Rules > Transform Rules > Modify Response Header, con estas cabeceras:
  - `Content-Security-Policy`: restringir a `'self'` más los orígenes usados: `unpkg.com`, `esm.sh`, `*.tile.openstreetmap.org`, el proyecto Supabase (`*.supabase.co`) y Turnstile (`challenges.cloudflare.com`). Empezar en `Content-Security-Policy-Report-Only` y pasar a enforcing sin errores.
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: geolocation=(self), camera=(), microphone=()`
- [ ] **Turnstile** configurado para el formulario de reportes, con su verificación del lado del servidor.
- [ ] Lectura de IP real: las funciones deben usar la cabecera `CF-Connecting-IP` (no `X-Forwarded-For`) para calcular `ip_hash`, y solo confiar en ella si la petición llegó por Cloudflare.
- [ ] WAF: reglas administradas activas y límite de peticiones en las rutas de escritura.
- [ ] Email Routing o buzón activo para `contacto@radarurbano.org`.

## 8. Monitoreo

- `health.yml` revisa el sitio (y `/health` si hay `SUPABASE_HEALTH_URL`) cada 15 minutos y avisa por ntfy solo si falla.
- Keep-alive diario evita la pausa del proyecto Supabase por inactividad.
- `backup.yml` corre cada noche; si falla, avisa por ntfy. Revisar a mano que el último artefacto no tenga más de 2 días.
