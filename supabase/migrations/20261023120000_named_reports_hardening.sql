-- Hardening de reportes por nombre (report_subjects / report_evidence / submit_named_report).
--
-- ALCANCE: solo objetos definidos en 20260909_hospedaje_named_reports.sql, mas
-- las columnas de moderacion en `reports` (reports.status ya lo usa esa migracion).
-- NO se asume nada mas del esquema de `reports` (RLS, triggers y otras columnas no
-- estan en el repo).
--
-- Decisiones a destacar:
--  * Reportantes independientes: el esquema versionado NO tiene ip_hash en reports ni en
--    report_subjects (el README dice que reports lo tiene, pero no esta en SQL del repo, asi
--    que no se referencia). Se agrega report_subjects.reporter_hash, calculado en
--    submit_named_report() desde CF-Connecting-IP + sal (GUC app.settings.ip_hash_salt).
--    Si no hay sal o IP, reporter_hash queda NULL y ese reporte cuenta como reportante
--    propio (se usa report_id como clave) -> nunca cuenta menos que reportes.
--  * Tope 3/24h por nombre: cuenta reportantes DISTINTOS y un mismo reportante solo puede
--    reportar un nombre una vez cada 24h. Asi una sola persona hostil no puede llenar el
--    cupo del nombre y bloquear a reportantes genuinos (antes 3 reportes de 1 fuente
--    cerraban el nombre para todos).
--  * La vista publica deja de ser legible por anon; la lectura va por lookup_named().
--    ATENCION: index.html lee la vista directo (searchName); debe migrar a
--    supabase.rpc('lookup_named', { p_name }) ANTES o al mismo tiempo que se aplica esto.
--  * Nada de esto borra objetos de Storage; solo encola rutas (storage_purge_queue).

begin;

-- 1. Normalizacion ----------------------------------------------------------------

create extension if not exists unaccent;

-- unaccent() es STABLE; el wrapper con diccionario explicito es el patron estandar para
-- poder marcarla IMMUTABLE. Nota: tambien pliega la n con tilde a n.
create or replace function normalize_subject_name(p_name text)
returns text
language sql
immutable
strict
set search_path = public, extensions, pg_temp
as $$
  select lower(regexp_replace(btrim(unaccent('unaccent'::regdictionary, p_name)), '\s+', ' ', 'g'));
$$;

grant execute on function normalize_subject_name(text) to anon, authenticated;

-- 2. Columnas nuevas ----------------------------------------------------------------

alter table report_subjects add column if not exists reporter_hash text;
alter table report_evidence add column if not exists private_purge_queued_at timestamptz;

alter table reports add column if not exists reviewed_by text;
alter table reports add column if not exists reviewed_at timestamptz;
alter table reports add column if not exists decision_reason text;

-- Backfill: re-normaliza filas existentes con la nueva regla.
update report_subjects
set value_normalized = normalize_subject_name(value)
where value_normalized is distinct from normalize_subject_name(value);

-- 3. Constraints (NOT VALID + intento de VALIDATE: no rompen filas viejas) ----------------

do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('report_subjects', 'report_subjects_type_chk',
        $c$check (subject_type in ('person_name', 'business_name'))$c$),
      ('report_subjects', 'report_subjects_value_len_chk',
        $c$check (char_length(value) between 2 and 120)$c$),
      ('report_subjects', 'report_subjects_reference_url_chk',
        $c$check (reference_url is null or (reference_url ~* '^https://' and char_length(reference_url) <= 500))$c$),
      ('report_evidence', 'report_evidence_path_chk',
        $c$check (storage_path_private like 'pending/%' and storage_path_private not like '%..%' and char_length(storage_path_private) <= 300)$c$),
      ('reports', 'reports_description_len_chk',
        $c$check (description is null or char_length(description) <= 2000)$c$)
    ) as t(tbl, name, def)
  loop
    if not exists (select 1 from pg_constraint where conname = c.name) then
      execute format('alter table %I add constraint %I %s not valid', c.tbl, c.name, c.def);
    end if;
    begin
      execute format('alter table %I validate constraint %I', c.tbl, c.name);
    exception when check_violation then
      raise notice 'constraint % queda NOT VALID: hay filas existentes que lo incumplen; corregirlas y validar a mano', c.name;
    end;
  end loop;
end $$;

-- 4. Indices ----------------------------------------------------------------------------

create index if not exists report_subjects_value_created_idx
  on report_subjects (value_normalized, created_at);
-- Lo cubre el compuesto (prefijo value_normalized).
drop index if exists report_subjects_value_normalized_idx;

-- 5. Confianza: Wilson con p=1, n = reportantes independientes --------------------------------
-- Con p=1 la cota inferior de Wilson se reduce a n / (n + z^2), z = 1.96.
-- (la formula anterior sumaba el termino de error, lo que da una cota SUPERIOR).

create or replace function named_wilson_score(p_n bigint)
returns double precision
language sql
immutable
as $$
  select case when p_n <= 0 then 0::double precision
              else p_n::double precision / (p_n::double precision + power(1.96::double precision, 2)) end;
$$;

create or replace view named_report_confidence
with (security_invoker = true) as
select
  s.value_normalized,
  count(distinct r.id) as report_count,
  min(r.created_at) as first_reported_at,
  max(r.created_at) as last_reported_at,
  named_wilson_score(count(distinct coalesce(s.reporter_hash, s.report_id::text))) as wilson_score,
  count(distinct coalesce(s.reporter_hash, s.report_id::text)) as reporter_count
from report_subjects s
join reports r on r.id = s.report_id
where r.status = 'published'
group by s.value_normalized;

-- Lectura publica cerrada: la vista solo la usan roles de servicio / dueno.
revoke all on named_report_confidence from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on named_report_confidence to service_role;
  end if;
end $$;

-- RPC publica de busqueda: coincidencia exacta del normalizado, minimo 5 caracteres
-- normalizados, devuelve solo conteo de reportantes independientes y score. Siempre
-- una fila (0,0 si no hay nada). Corre como dueno de la funcion; la vista es
-- security_invoker, asi que se evalua con los privilegios del dueno, no de anon.
create or replace function lookup_named(p_name text)
returns table (report_count bigint, wilson_score double precision)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm text := public.normalize_subject_name(coalesce(p_name, ''));
begin
  if char_length(v_norm) < 5 then
    raise exception 'name_too_short' using errcode = '22023';
  end if;

  return query
  select c.reporter_count, c.wilson_score
  from public.named_report_confidence c
  where c.value_normalized = v_norm;

  if not found then
    return query select 0::bigint, 0::double precision;
  end if;
end;
$$;

revoke all on function lookup_named(text) from public;
grant execute on function lookup_named(text) to anon, authenticated;

-- 6. submit_named_report ---------------------------------------------------------------------

-- Hash no reversible del reportante. Sin sal configurada o sin IP devuelve NULL (nunca hashea
-- sin sal). Para IPv6 usa el prefijo /64. Configurar sal:
--   alter database postgres set "app.settings.ip_hash_salt" = '<secreto>';
create or replace function current_reporter_hash()
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_salt text := nullif(current_setting('app.settings.ip_hash_salt', true), '');
  v_ip text;
begin
  if v_salt is null then
    return null;
  end if;
  begin
    v_ip := nullif(nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip', '');
    if v_ip is not null and position(':' in v_ip) > 0 then
      v_ip := host(network(set_masklen(v_ip::inet, 64)));
    end if;
  exception when others then
    v_ip := null;
  end;
  if v_ip is null then
    return null;
  end if;
  return encode(sha256(convert_to(v_salt || ':' || v_ip, 'UTF8')), 'hex');
end;
$$;

revoke all on function current_reporter_hash() from public;

create or replace function submit_named_report(
  p_description text,
  p_category text,
  p_subject_type text,
  p_subject_value text,
  p_reference_url text default null,
  p_evidence_storage_path text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_report_id uuid;
  v_value_normalized text := public.normalize_subject_name(coalesce(p_subject_value, ''));
  v_reporter text := public.current_reporter_hash();
  v_distinct_reporters integer;
  v_same_reporter boolean;
begin
  if p_description is null or char_length(btrim(p_description)) < 5 then
    raise exception 'description_too_short';
  end if;
  if char_length(p_description) > 2000 then
    raise exception 'description_too_long';
  end if;
  if p_subject_type is null or p_subject_type not in ('person_name', 'business_name') then
    raise exception 'invalid_subject_type';
  end if;
  if char_length(v_value_normalized) < 2 or char_length(btrim(p_subject_value)) > 120 then
    raise exception 'subject_value_required';
  end if;
  if p_reference_url is not null
     and (p_reference_url !~* '^https://' or char_length(p_reference_url) > 500) then
    raise exception 'invalid_reference_url';
  end if;
  if p_evidence_storage_path is not null
     and (p_evidence_storage_path not like 'pending/%'
          or p_evidence_storage_path like '%..%'
          or char_length(p_evidence_storage_path) > 300) then
    raise exception 'invalid_evidence_path';
  end if;

  -- Rate-limit por nombre reportado, contando REPORTANTES DISTINTOS (no reportes):
  --  * un mismo reportante solo puede reportar este nombre una vez cada 24h;
  --  * el tope de 3 aplica a reportantes distintos, para que una sola fuente hostil no
  --    pueda llenar el cupo y bloquear a reportantes genuinos del mismo nombre.
  -- Limite conocido: reportantes sin hash (sin sal/IP) se cuentan cada uno como distinto.
  select count(distinct coalesce(reporter_hash, report_id::text)),
         coalesce(bool_or(reporter_hash is not null and reporter_hash = v_reporter), false)
    into v_distinct_reporters, v_same_reporter
  from report_subjects
  where value_normalized = v_value_normalized
    and created_at > now() - interval '24 hours';

  if v_same_reporter then
    raise exception 'duplicate_reporter_subject';
  end if;
  if v_distinct_reporters >= 3 then
    raise exception 'rate_limited_subject';
  end if;

  insert into reports (description, category, status)
  values (btrim(p_description), coalesce(p_category, 'hospedaje'), 'pending')
  returning id into v_report_id;

  insert into report_subjects (report_id, subject_type, value, value_normalized, reference_url, reporter_hash)
  values (v_report_id, p_subject_type, btrim(p_subject_value), v_value_normalized, p_reference_url, v_reporter);

  if p_evidence_storage_path is not null then
    insert into report_evidence (report_id, evidence_type, storage_path_private)
    values (v_report_id, 'image', p_evidence_storage_path);
  end if;

  return v_report_id;
end;
$$;

revoke all on function submit_named_report(text, text, text, text, text, text) from public;
grant execute on function submit_named_report(text, text, text, text, text, text) to anon, authenticated;

-- 7. Bitacora de moderacion ---------------------------------------------------------------------
-- El status vive en reports (no en report_subjects), asi que el trigger va ahi y solo
-- actua sobre reportes que tienen un report_subjects (reportes por nombre).

create table if not exists moderation_log (
  id bigint generated always as identity primary key,
  report_id uuid not null,        -- sin FK a proposito: la bitacora sobrevive al borrado del reporte
  action text not null,
  old_status text,
  new_status text,
  reason text,
  actor text not null,
  at timestamptz not null default now()
);

create index if not exists moderation_log_report_idx on moderation_log (report_id, at);

alter table moderation_log enable row level security;
revoke all on moderation_log from public, anon, authenticated;

create or replace function stamp_named_report_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from report_subjects where report_id = new.id) then
    new.reviewed_by := coalesce(auth.uid()::text, current_user);
    new.reviewed_at := now();
  end if;
  return new;
end;
$$;

create or replace function log_named_report_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from report_subjects where report_id = new.id) then
    insert into moderation_log (report_id, action, old_status, new_status, reason, actor)
    values (new.id, 'status_change', old.status, new.status, new.decision_reason,
            coalesce(auth.uid()::text, current_user));
  end if;
  return null;
end;
$$;

revoke all on function stamp_named_report_review() from public;
revoke all on function log_named_report_status_change() from public;

drop trigger if exists reports_stamp_named_review on reports;
create trigger reports_stamp_named_review
  before update of status on reports
  for each row when (old.status is distinct from new.status)
  execute function stamp_named_report_review();

drop trigger if exists reports_log_named_status on reports;
create trigger reports_log_named_status
  after update of status on reports
  for each row when (old.status is distinct from new.status)
  execute function log_named_report_status_change();

-- 8. Retencion ----------------------------------------------------------------------------------

create table if not exists storage_purge_queue (
  id bigint generated always as identity primary key,
  bucket text not null,
  path text not null,
  reason text not null,
  queued_at timestamptz not null default now(),
  purged_at timestamptz,
  unique (bucket, path)
);

alter table storage_purge_queue enable row level security;
revoke all on storage_purge_queue from public, anon, authenticated;

-- Reglas:
--  a) reportes con nombre en 'pending'/'rejected' por mas de 90 dias se borran (cascade a
--     subjects/evidence). Antiguedad = ultimo cambio de status en moderation_log, o created_at
--     si nunca cambio; asi un reporte expirado por el cron (published -> pending) no se purga
--     el mismo dia que expira y sigue siendo republicable 90 dias.
--  b) evidencia original (bucket evidence-private) se encola a los 30 dias de la decision
--     (published/rejected). Borrar en Storage lo hace un worker externo; aqui solo se marca.
-- Esta funcion NO toca storage.objects.
create or replace function purge_named_reports()
returns table (reports_deleted integer, evidence_queued integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer := 0;
  v_queued integer := 0;
begin
  -- b) evidencia original tras decision + 30 dias
  with decided as (
    select r.id,
           (select max(l.at) from moderation_log l
             where l.report_id = r.id and l.new_status in ('published', 'rejected')) as decided_at
    from reports r
    where exists (select 1 from report_subjects s where s.report_id = r.id)
  ), due as (
    select e.id as evidence_id, e.storage_path_private
    from report_evidence e
    join decided d on d.id = e.report_id
    where e.private_purge_queued_at is null
      and d.decided_at is not null
      and d.decided_at < now() - interval '30 days'
  ), ins as (
    insert into storage_purge_queue (bucket, path, reason)
    select 'evidence-private', storage_path_private, 'original_30d_after_decision' from due
    on conflict (bucket, path) do nothing
    returning 1
  ), mark as (
    update report_evidence e set private_purge_queued_at = now()
    from due where e.id = due.evidence_id
    returning 1
  )
  select (select count(*) from mark) into v_queued;

  -- a) reportes viejos sin publicar: encolar sus rutas y borrar
  create temporary table _purge_ids on commit drop as
  select r.id
  from reports r
  where r.status in ('pending', 'rejected')
    and exists (select 1 from report_subjects s where s.report_id = r.id)
    and coalesce((select max(l.at) from moderation_log l where l.report_id = r.id), r.created_at)
        < now() - interval '90 days';

  insert into storage_purge_queue (bucket, path, reason)
  select 'evidence-private', e.storage_path_private, 'report_purged_90d'
  from report_evidence e join _purge_ids p on p.id = e.report_id
  on conflict (bucket, path) do nothing;

  insert into storage_purge_queue (bucket, path, reason)
  select 'evidence-public', e.storage_path_public_derivative, 'report_purged_90d'
  from report_evidence e join _purge_ids p on p.id = e.report_id
  where e.storage_path_public_derivative is not null
  on conflict (bucket, path) do nothing;

  delete from reports where id in (select id from _purge_ids);
  get diagnostics v_deleted = row_count;

  drop table _purge_ids;

  return query select v_deleted, v_queued;
end;
$$;

revoke all on function purge_named_reports() from public, anon, authenticated;

select cron.schedule(
  'purge-named-reports',
  '30 8 * * *',
  $$select purge_named_reports();$$
) where not exists (
  select 1 from cron.job where jobname = 'purge-named-reports'
);

commit;
