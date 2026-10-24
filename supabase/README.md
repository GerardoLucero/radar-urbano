# supabase/

| Ruta | Estado |
|---|---|
| `migrations/20260909_hospedaje_named_reports.sql` | Ya aplicada en produccion |
| `migrations/20261023120000_named_reports_hardening.sql` | APLICABLE, sin aplicar. Revisar y probar en staging |
| `tests/named_reports.test.sql` | pgTAP para la migracion anterior. Sin ejecutar |
| `proposed/*` | PROPUESTAS, no ejecutables. Ver `proposed/README.md` |
| `functions/*` | Edge Functions (no tocadas aqui) |

## Como aplicar la migracion de hardening

1. Tener un proyecto de staging (rama de Supabase o proyecto aparte) con el mismo esquema que produccion.
   Si no existe, no aplicar directo a produccion.
2. Configurar la sal del hash de reportante, una vez por base:
   `alter database postgres set "app.settings.ip_hash_salt" = '<secreto>';`
   (sin ella los reportes no cuentan como independientes entre si; la migracion no falla).
3. `supabase link --project-ref <staging>` y `supabase db push --dry-run`, luego `supabase db push`.
4. `supabase test db` contra staging.
5. Verificar a mano: `select * from lookup_named('nombre de prueba');` y el aviso de constraints
   que hayan quedado NOT VALID (salida de `db push`).
6. Solo entonces repetir contra produccion.

## Orden y advertencias

- El frontend (`index.html`, `searchName`) lee hoy la vista `named_report_confidence` directo. Esta
  migracion revoca ese SELECT a anon, asi que el cambio del frontend a `supabase.rpc('lookup_named', { p_name })`
  debe estar desplegado antes o a la vez. La RPC devuelve `report_count` y `wilson_score`; ya no devuelve `last_reported_at`.
- La busqueda por nombre exige 5 o mas caracteres normalizados (el frontend hoy acepta 2).
- El normalizador pliega acentos y la n con tilde; el backfill reescribe `value_normalized` de filas existentes.
- Los constraints se crean `NOT VALID` y se intenta validarlos; si hay filas viejas que los incumplen quedan sin validar
  (solo aplican a filas nuevas) y se muestra un `NOTICE`.
- La subida de evidencia debe usar la ruta `pending/...` (el frontend actual ya lo hace).
- Agrega columnas y dos triggers a `reports` (`reviewed_by`, `reviewed_at`, `decision_reason`, y logging de cambios de status
  solo para reportes con `report_subjects`). No se pudo revisar si hay triggers existentes que interactuen.
- `purge_named_reports()` borra filas de reportes con nombre (pending/rejected > 90 dias) y solo ENCOLA rutas de Storage en
  `storage_purge_queue`; el borrado real en Storage requiere un worker/Edge Function aparte (no incluido).
- Para moderar, rellenar `decision_reason` en el mismo UPDATE que cambia el status:
  `update reports set status = 'published', decision_reason = '...' where id = '...';`
- Nada en esta carpeta se ha ejecutado contra una base de datos.
