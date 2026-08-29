alter table public.cost_centers add column if not exists class_id bigint references public.classes(class_id) on delete restrict;
create index if not exists cost_centers_class_idx on public.cost_centers(class_id);

create or replace function public.validate_cost_center_class()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if new.class_id is not null and not exists(
    select 1 from public.class_subsidiaries cs
    where cs.class_id=new.class_id and cs.subsidiary_id=new.subsidiary_id
  ) then
    raise exception 'La clase seleccionada no pertenece a la subsidiaria del centro de costos.';
  end if;
  return new;
end;
$$;

drop trigger if exists cost_center_validate_class on public.cost_centers;
create trigger cost_center_validate_class
before insert or update of class_id,subsidiary_id on public.cost_centers
for each row execute function public.validate_cost_center_class();
