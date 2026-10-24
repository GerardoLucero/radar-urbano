-- pgTAP para 20261023120000_named_reports_hardening.sql
-- Correr contra STAGING (no produccion):  supabase test db
-- Todo corre dentro de una transaccion que termina en ROLLBACK.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

-- Normalizacion
select is(normalize_subject_name('José  Pérez'), 'jose perez', 'normaliza acentos, mayusculas y espacios');
select is(normalize_subject_name('  ANA   LUZ '), 'ana luz', 'recorta y colapsa espacios');

-- Wilson con p=1: n/(n+1.96^2); n=1 -> ~0.207
select is(round(named_wilson_score(1)::numeric, 3), 0.207, 'Wilson c=1 ~ 0.207');
select is(named_wilson_score(0), 0::double precision, 'Wilson n=0 = 0');

-- Permisos de anon
select ok(not has_table_privilege('anon', 'public.named_report_confidence', 'SELECT'),
  'anon no tiene SELECT en la vista');
select ok(has_function_privilege('anon', 'public.lookup_named(text)', 'EXECUTE'),
  'anon puede ejecutar lookup_named');
select ok(not has_function_privilege('anon', 'public.purge_named_reports()', 'EXECUTE'),
  'anon no puede ejecutar purge_named_reports');

-- Semilla via la RPC publica (como anon)
set local role anon;
select lives_ok(
  $$select submit_named_report('Descripcion de prueba suficiente', 'hospedaje', 'person_name', 'José  Pérez', 'https://example.com/a', null)$$,
  'anon puede reportar via submit_named_report'
);
select throws_ok(
  $$select submit_named_report('Descripcion de prueba suficiente', 'hospedaje', 'person_name', 'Otro Nombre', 'http://inseguro.example', null)$$,
  'invalid_reference_url', 'rechaza reference_url que no es https'
);
select throws_ok($$select * from named_report_confidence$$, '42501', 'anon no puede leer la vista');
select throws_ok($$select * from lookup_named('abc')$$, 'name_too_short', 'lookup_named exige >= 5 caracteres');
reset role;

-- anon no puede cambiar status (UPDATE silencioso por RLS o error de privilegios)
set local role anon;
do $$ begin
  update reports set status = 'published';
exception when others then null;
end $$;
reset role;
select is((select count(*) from reports where status = 'published')::int, 0,
  'anon no logro publicar ningun reporte');

-- Publicar como moderador (postgres) y verificar lookup + bitacora
update reports r set status = 'published', decision_reason = 'test'
from report_subjects s where s.report_id = r.id and s.value_normalized = 'jose perez';

select is((select count(*) from moderation_log where new_status = 'published' and reason = 'test')::int, 1,
  'moderation_log registra el cambio de status');

set local role anon;
select is(
  (select round(wilson_score::numeric, 3) from lookup_named('JOSE  PEREZ')),
  0.207, 'lookup_named devuelve ~0.207 con un reportante');
reset role;

select * from finish();
rollback;
