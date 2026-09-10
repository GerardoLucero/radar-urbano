-- Vertical "hospedaje/Airbnb": permite reportar a una PERSONA por nombre (no solo
-- telefono/GPS), con evidencia de imagen opcional. Generico para cualquier categoria
-- futura que necesite identificar a alguien por nombre, no exclusivo de hospedaje.
--
-- Contexto legal (legal-lead, 2026-09-09): un nombre real es mas identificable que un
-- numero de telefono -> exige moderacion humana antes de publicar. Estas tablas y la
-- funcion de abajo son la unica via de escritura para reportes que nombran a alguien,
-- precisamente para que ese "nunca auto-publicar" no dependa de que el frontend se
-- porte bien -- se aplica a nivel de base de datos.

create table if not exists report_subjects (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  subject_type text not null,              -- 'person_name' hoy; futuro: 'business_name', etc.
  value text not null,
  value_normalized text not null,          -- lower/trim, usado para corroboracion y rate-limit
  reference_url text,                      -- link del anuncio de Airbnb u otro contexto verificable
  created_at timestamptz not null default now()
);

create index if not exists report_subjects_value_normalized_idx on report_subjects (value_normalized);
create index if not exists report_subjects_report_id_idx on report_subjects (report_id);

create table if not exists report_evidence (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  evidence_type text not null,                     -- 'image' hoy; 'video'/'audio' reservados, no evaluados
  storage_path_private text not null,              -- bucket evidence-private, nunca publico
  storage_path_public_derivative text,             -- bucket evidence-public, solo tras moderacion manual
  exif_stripped boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists report_evidence_report_id_idx on report_evidence (report_id);

alter table report_subjects enable row level security;
alter table report_evidence enable row level security;

-- Sin policies de INSERT/SELECT/UPDATE para anon/authenticated a proposito: la unica
-- escritura permitida es via submit_named_report() (SECURITY DEFINER). Lectura publica
-- pasa por la vista named_report_confidence de abajo, nunca por la tabla directa.

-- Vista publica equivalente a phone_confidence, pero por nombre. Nunca expone la
-- evidencia ni el link del anuncio -- solo cuenta y confianza, igual que el resto del sitio.
create or replace view named_report_confidence as
select
  s.value_normalized,
  count(distinct r.id) as report_count,
  min(r.created_at) as first_reported_at,
  max(r.created_at) as last_reported_at,
  (
    (count(distinct r.id)::float / (count(distinct r.id)::numeric + 3.8416)::float)
    + 1.96 * sqrt(
        ((count(distinct r.id)::float / (count(distinct r.id)::numeric + 3.8416)::float)
          * (1 - (count(distinct r.id)::float / (count(distinct r.id)::numeric + 3.8416)::float)))
        / (count(distinct r.id)::numeric + 3.8416)::float
      )
  ) as wilson_score
from report_subjects s
join reports r on r.id = s.report_id
where r.status = 'published'
group by s.value_normalized;

-- RPC unica para reportar a una persona. SECURITY DEFINER: corre con privilegios del
-- dueno de la funcion (no del caller anon), por eso puede escribir en tablas sin policy
-- publica. status = 'pending' esta hardcodeado -- el caller NUNCA puede forzar 'published'.
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
set search_path = public
as $$
declare
  v_report_id uuid;
  v_value_normalized text := lower(trim(p_subject_value));
  v_recent_count integer;
begin
  if p_description is null or length(trim(p_description)) < 5 then
    raise exception 'description_too_short';
  end if;
  if p_subject_value is null or length(v_value_normalized) < 2 then
    raise exception 'subject_value_required';
  end if;

  -- Rate-limit adicional por nombre reportado (no solo por IP, que ya cubre
  -- pgrst.db_pre_request a nivel de todo el sitio): evita que varias personas/
  -- dispositivos coordinen un ataque de reportes contra el mismo nombre.
  select count(*) into v_recent_count
  from report_subjects
  where value_normalized = v_value_normalized
    and created_at > now() - interval '24 hours';

  if v_recent_count >= 3 then
    raise exception 'rate_limited_subject';
  end if;

  insert into reports (description, category, status)
  values (trim(p_description), coalesce(p_category, 'hospedaje'), 'pending')
  returning id into v_report_id;

  insert into report_subjects (report_id, subject_type, value, value_normalized, reference_url)
  values (v_report_id, p_subject_type, trim(p_subject_value), v_value_normalized, p_reference_url);

  if p_evidence_storage_path is not null then
    insert into report_evidence (report_id, evidence_type, storage_path_private)
    values (v_report_id, 'image', p_evidence_storage_path);
  end if;

  return v_report_id;
end;
$$;

revoke all on function submit_named_report from public;
grant execute on function submit_named_report to anon, authenticated;

-- Expiracion: un reporte con nombre que nunca recibio un segundo reporte corroborante
-- (mismo nombre, otro reporte publicado) se oculta a los 90 dias. No se borra -- vuelve
-- a 'pending', Gerardo puede republicarlo a mano si mas tarde se corrobora.
create or replace function expire_uncorroborated_named_reports() returns void
language sql
as $$
  update reports r
  set status = 'pending'
  where r.status = 'published'
    and r.created_at < now() - interval '90 days'
    and exists (select 1 from report_subjects s where s.report_id = r.id)
    and (
      select count(distinct r2.id)
      from report_subjects s2
      join reports r2 on r2.id = s2.report_id and r2.status = 'published'
      where s2.value_normalized in (select value_normalized from report_subjects where report_id = r.id)
    ) < 2;
$$;

select cron.schedule(
  'expire-uncorroborated-named-reports',
  '0 8 * * *',
  $$select expire_uncorroborated_named_reports();$$
) where not exists (
  select 1 from cron.job where jobname = 'expire-uncorroborated-named-reports'
);
