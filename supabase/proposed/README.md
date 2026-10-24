# supabase/proposed

Plantillas para REVISION. No son migraciones: esta carpeta no la lee `supabase db push`
y nada aqui debe ejecutarse tal cual.

El esquema base de `reports` (columnas, RLS, triggers, vistas `phone_confidence` y
`trending_clusters`, `db_pre_request`) no esta versionado en este repo. Los nombres de
columnas y objetos que aparecen en estas plantillas son SUPUESTOS tomados del README
y estan marcados con `ASSUMED`.

## Paso 0 obligatorio

```bash
supabase db dump --schema public,storage -f baseline.sql
```

1. Revisar RLS, grants y triggers reales con `reports_rls_checklist.md`.
2. Commitear el baseline como migracion inicial (`supabase migration new baseline`).
3. Recien entonces convertir cada plantilla en una migracion con timestamp, ajustando
   nombres de columnas al baseline, y aplicarla primero a staging.

## Archivos

| Archivo | Que propone |
|---|---|
| `reports_rpc_insert.sql` | RPC `submit_report` que reemplaza el insert directo del cliente |
| `reports_rls_checklist.md` | Consultas para verificar en el SQL editor |
| `trending_clusters_independent.sql` | Clusters contando ip_hash distintos, minimo 3 |
| `phone_lookup_rpc.sql` | `lookup_phone` en lugar de leer `phone_confidence` |
| `indexes.sql` | Indices parciales para reportes publicados |
| `ai_status.sql` | `ai_status` + reproceso cada 5 min |
