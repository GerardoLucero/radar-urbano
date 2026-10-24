-- PROPUESTA. La vista real `trending_clusters` no esta en el repo: obtener su definicion con
--   select pg_get_viewdef('public.trending_clusters'::regclass, true);
-- y adaptar. Aqui solo se muestra la idea: un cluster "trending" requiere >= 3 fuentes
-- independientes (ip_hash distintos), no 3 reportes, y una ventana de espera para que un
-- reporte recien creado no dispare el cluster antes de moderarse/corroborarse.
--
-- ASSUMED: reports(id, lat, lon, category, created_at, status, ip_hash)

create or replace view trending_clusters_independent
with (security_invoker = true) as
select
  round(lat::numeric, 2) as lat_cell,   -- celda ~1 km; el cluster real puede usar otra rejilla
  round(lon::numeric, 2) as lon_cell,
  category,
  count(*) as report_count,
  count(distinct ip_hash) as independent_sources,
  max(created_at) as last_reported_at
from reports
where status = 'published'
  and created_at > now() - interval '7 days'
  and created_at < now() - interval '30 minutes'   -- ventana de espera
  and lat is not null and lon is not null
  and ip_hash is not null                          -- sin hash no se puede probar independencia
group by 1, 2, 3
having count(distinct ip_hash) >= 3;
