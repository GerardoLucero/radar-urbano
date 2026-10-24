-- PROPUESTA. Hoy un fallo de la IA (corroborate-report) deja el reporte sin clasificar y sin
-- rastro. Se agrega un estado explicito y un cron que reintenta.
-- ASSUMED: la Edge Function corroborate-report acepta POST con {report_id}. La URL y la clave de
-- servicio van en Vault (nombres 'corroborate_report_url' y 'service_role_key'), NUNCA en este
-- archivo. Requiere extensiones pg_cron y pg_net.

begin;

alter table reports add column if not exists ai_status text not null default 'pending'
  check (ai_status in ('pending', 'processing', 'done', 'failed'));
alter table reports add column if not exists ai_attempts integer not null default 0;
alter table reports add column if not exists ai_updated_at timestamptz;

-- Ojo: el default 'pending' marcaria TODOS los reportes existentes como pendientes de IA.
-- Al convertir en migracion, hacer backfill a 'done' de los ya procesados antes de activar el cron.

create index if not exists reports_ai_retry_idx
  on reports (created_at) where ai_status in ('pending', 'failed');

-- La Edge Function debe actualizar ai_status = 'done' | 'failed' al terminar.

create or replace function reprocess_ai_reports() returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  r record;
begin
  for r in
    select id from reports
    where ai_status in ('pending', 'failed')
      and ai_attempts < 5
      and created_at < now() - interval '5 minutes'
    order by created_at
    limit 20
  loop
    update reports set ai_status = 'processing', ai_updated_at = now(), ai_attempts = ai_attempts + 1
    where id = r.id;
    perform net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'corroborate_report_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      ),
      body := jsonb_build_object('report_id', r.id)
    );
    v_count := v_count + 1;
  end loop;

  -- 'processing' colgado por mas de 15 minutos vuelve a 'failed' para reintento.
  update reports set ai_status = 'failed'
  where ai_status = 'processing' and ai_updated_at < now() - interval '15 minutes';

  return v_count;
end;
$$;

revoke all on function reprocess_ai_reports() from public, anon, authenticated;

select cron.schedule('reprocess-ai-reports', '*/5 * * * *', $$select reprocess_ai_reports();$$)
where not exists (select 1 from cron.job where jobname = 'reprocess-ai-reports');

commit;
