# Checklist de verificacion (SQL editor de Supabase, solo lectura)

Pegar cada consulta y anotar el resultado. Ninguna modifica datos.

## 1. Policies de `reports`
```sql
select policyname, cmd, roles, permissive, qual, with_check
from pg_policies where schemaname = 'public' and tablename = 'reports';

select relname, relrowsecurity, relforcerowsecurity
from pg_class where oid = 'public.reports'::regclass;
```
Esperado: RLS activo; ninguna policy de INSERT para anon cuyo `with_check` permita `status = 'published'`;
ninguna policy de UPDATE/DELETE para anon; SELECT para anon limitado a `status = 'published'`.

## 2. Grants de anon / authenticated
```sql
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where grantee in ('anon', 'authenticated') and table_schema = 'public'
order by table_name, grantee, privilege_type;

select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where grantee = 'anon' and table_schema = 'public' and table_name = 'reports';
```
Esperado: anon sin UPDATE/DELETE en ninguna tabla; SELECT en `reports` sin acceso a `ip_hash`
(si no se puede por columna, exponerlo solo via vistas).

## 3. `ip_hash` legible por anon?
```sql
select has_column_privilege('anon', 'public.reports', 'ip_hash', 'SELECT');
```
Esperado: false. Si es true, cualquiera puede correlacionar reportantes. Confirmar tambien
con la API: `GET /rest/v1/reports?select=ip_hash&limit=1` usando la anon key.

## 4. Buckets: publico y limites
```sql
select id, name, public, file_size_limit, allowed_mime_types from storage.buckets;
```
Esperado: `evidence-private` con `public = false`; `file_size_limit` definido (p. ej. 5 MB) y
`allowed_mime_types` = image/jpeg, image/png, image/webp en ambos.

## 5. Policies de storage
```sql
select policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'storage' and tablename = 'objects';
```
Esperado: anon solo INSERT en `evidence-private` con ruta `pending/%`; sin SELECT/UPDATE/DELETE de anon
sobre `evidence-private`; `evidence-public` solo SELECT.

## 6. db_pre_request (rate limit por IP)
```sql
select rolname, rolconfig from pg_roles where rolconfig::text like '%pgrst%';
```
Copiar el nombre de la funcion de `pgrst.db_pre_request` y revisar su codigo:
```sql
select pg_get_functiondef('public.<nombre>'::regproc);
```
Revisar:
- toma la IP de `request.headers ->> 'cf-connecting-ip'` (no de x-forwarded-for, que el cliente puede falsificar);
- el origen solo acepta trafico de Cloudflare (si no, ese header es falsificable);
- para IPv6 agrupa por /64 (p. ej. `set_masklen(ip::inet, 64)`), no por direccion completa.

## 7. Sal / HMAC de ip_hash
```sql
select p.proname from pg_proc p
where p.pronamespace = 'public'::regnamespace and pg_get_functiondef(p.oid) ilike '%ip_hash%';

select name from vault.decrypted_secrets;   -- solo nombres; NO seleccionar decrypted_secret
show app.settings.ip_hash_salt;             -- si responde, la sal esta en un GUC de la base
```
Esperado: `hmac(ip, secreto, 'sha256')` (no `sha256(ip || sal)` con la sal escrita en el codigo) y el
secreto en Vault o en secreto de Edge Function, no en el cuerpo de la funcion ni en el repo.

## 8. Vistas publicas
```sql
select c.relname, c.reloptions, has_table_privilege('anon', c.oid, 'SELECT') as anon_select
from pg_class c where c.relname in ('phone_confidence', 'trending_clusters', 'named_report_confidence');
```
Esperado: `reloptions` con `security_invoker=true` (o definer deliberado y documentado); revisar que
no expongan `ip_hash`, `description` ni coordenadas exactas de reportes no publicados.

## 9. Funciones SECURITY DEFINER
```sql
select n.nspname, p.proname, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname = 'public';
```
Esperado: todas con `search_path` fijo en `proconfig`; `anon_exec` true solo en las RPC publicas previstas.
