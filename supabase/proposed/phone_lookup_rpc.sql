-- PROPUESTA. Misma idea que lookup_named: cerrar la lectura directa de phone_confidence a anon
-- y exponer una RPC que exige el numero completo y devuelve solo conteo y score.
-- ASSUMED: phone_confidence(phone text, report_count bigint, wilson_score double precision).
-- Verificar con: select pg_get_viewdef('public.phone_confidence'::regclass, true);
-- Hay que decidir el formato canonico del telefono (solo digitos, con o sin 52) en UN solo
-- lugar; aqui se normaliza en la RPC.

create or replace function normalize_phone(p text)
returns text language sql immutable strict as $$
  select regexp_replace(p, '[^0-9]', '', 'g');
$$;

create or replace function lookup_phone(p_phone text)
returns table (report_count bigint, wilson_score double precision)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v text := public.normalize_phone(coalesce(p_phone, ''));
begin
  if char_length(v) < 10 then
    raise exception 'phone_too_short' using errcode = '22023';
  end if;
  return query
  select c.report_count, c.wilson_score
  from public.phone_confidence c
  where public.normalize_phone(c.phone) = v;
  if not found then
    return query select 0::bigint, 0::double precision;
  end if;
end;
$$;

revoke all on function lookup_phone(text) from public;
grant execute on function lookup_phone(text) to anon, authenticated;

-- Despues de migrar el frontend:
--   revoke select on phone_confidence from anon, authenticated;
-- Nota: comparar con normalize_phone(c.phone) no usa indice; si phone_confidence es una
-- vista sobre reports, considerar una columna phone_normalized indexada.
