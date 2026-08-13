alter table public.subsidiaries
  add column if not exists timezone_id bigint
  references public.timezones(timezone_id) on delete restrict;

update public.subsidiaries
set timezone_id=coalesce(
  (select timezone_id from public.timezones where is_active and lower(name) like '%costa rica%' order by timezone_id limit 1),
  (select timezone_id from public.timezones where is_active and utc_offset in ('UTC-06:00','-06:00') order by timezone_id limit 1),
  (select timezone_id from public.timezones where is_active order by timezone_id limit 1)
)
where timezone_id is null;

do $$
begin
  if exists(select 1 from public.subsidiaries where timezone_id is null) then
    raise exception 'Debe existir al menos una zona horaria activa antes de asignarla a las subsidiarias.';
  end if;
end $$;

alter table public.subsidiaries alter column timezone_id set not null;
create index if not exists subsidiaries_timezone_idx on public.subsidiaries(timezone_id);
