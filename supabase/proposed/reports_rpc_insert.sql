-- PROPUESTA, no ejecutable tal cual. Verificar contra `supabase db dump` (ver README).
-- Objetivo: que el cliente deje de hacer INSERT directo en `reports` y use una RPC que:
--   * fija status = 'pending' (el cliente nunca elige el status),
--   * valida longitudes/rangos,
--   * toma ip_hash del servidor (no del cliente),
--   * se apoya en GRANT por columna / sin INSERT directo para anon.
--
-- Turnstile NO se verifica en SQL. Flujo: el navegador manda el token a una Edge Function,
-- que valida contra Cloudflare con su secreto y, solo si es valido, llama a esta RPC con
-- service_role. Por eso la RPC NO se concede a anon: solo a service_role.

begin;

create or replace function submit_report(
  p_description text,
  p_category text,
  p_phone text default null,           -- ASSUMED: reports.phone
  p_lat double precision default null, -- ASSUMED: reports.lat / reports.lon
  p_lon double precision default null,
  p_location_text text default null,   -- ASSUMED: reports.location_text
  p_ip_hash text default null          -- lo calcula la Edge Function, nunca el navegador
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_description is null or char_length(btrim(p_description)) < 5 or char_length(p_description) > 2000 then
    raise exception 'invalid_description';
  end if;
  if p_category is null or char_length(p_category) > 60 then
    raise exception 'invalid_category';
  end if;
  if p_phone is not null and p_phone !~ '^\+?[0-9]{8,15}$' then
    raise exception 'invalid_phone';
  end if;
  if (p_lat is null) <> (p_lon is null) then
    raise exception 'lat_lon_pair_required';
  end if;
  if p_lat is not null and (p_lat not between 14 and 33 or p_lon not between -119 and -86) then
    raise exception 'coordinates_out_of_range';   -- bounding box aproximado de Mexico
  end if;
  if p_location_text is not null and char_length(p_location_text) > 200 then
    raise exception 'invalid_location_text';
  end if;

  insert into reports (description, category, phone, lat, lon, location_text, ip_hash, status)
  values (btrim(p_description), p_category, p_phone, p_lat, p_lon, p_location_text, p_ip_hash, 'pending')
  returning id into v_id;
  -- Si hoy los reportes de telefono/GPS se publican solos tras la IA (corroborate-report),
  -- esa transicion la sigue haciendo la Edge Function con service_role, no el cliente.

  return v_id;
end;
$$;

revoke all on function submit_report(text, text, text, double precision, double precision, text, text) from public, anon, authenticated;
grant execute on function submit_report(text, text, text, double precision, double precision, text, text) to service_role;

-- Cerrar el insert directo (SOLO cuando la Edge Function ya este en produccion y el
-- index.html la use):
--
--   revoke insert, update, delete on reports from anon, authenticated;
--
-- Alternativa transitoria con GRANT por columna (el cliente no puede escribir status,
-- ip_hash ni duplicate_of):
--
--   revoke insert on reports from anon;
--   grant insert (description, category, phone, lat, lon, location_text) on reports to anon;
--
-- y la policy de INSERT debe tener WITH CHECK (status is null or status = 'pending') mas un
-- trigger BEFORE INSERT que fuerce status = 'pending' e ip_hash del servidor.

commit;
