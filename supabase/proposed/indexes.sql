-- PROPUESTA. Indices parciales: el sitio solo consulta reportes publicados.
-- ASSUMED: reports(status, created_at, lat, lon). Confirmar con \d reports y EXPLAIN de las
-- consultas reales del frontend antes de crear.
-- CREATE INDEX CONCURRENTLY no corre dentro de una transaccion: al convertir esto en
-- migracion, un indice por archivo y sin begin/commit.

create index concurrently if not exists reports_published_created_idx
  on reports (created_at desc)
  where status = 'published';

create index concurrently if not exists reports_published_latlon_idx
  on reports (lat, lon)
  where status = 'published' and lat is not null and lon is not null;
