create or replace function public.assign_customer_cost_center_code()
returns trigger
language plpgsql
set search_path=public
as $$
declare
  customer_name text;
  customer_prefix text;
  next_number integer;
begin
  if new.customer_id is null then
    raise exception 'Debe seleccionar un cliente para el centro de costos.';
  end if;
  if not exists(select 1 from public.entity_subsidiaries e where e.customer_id=new.customer_id and e.subsidiary_id=new.subsidiary_id) then
    raise exception 'El cliente seleccionado no pertenece a la subsidiaria indicada.';
  end if;
  if tg_op='UPDATE' and new.customer_id=old.customer_id then
    new.code:=old.code;
    return new;
  end if;
  perform pg_advisory_xact_lock(73001,new.customer_id::integer);
  select c.company_name into customer_name from public.customers c where c.customer_id=new.customer_id;
  customer_prefix:=upper(left(regexp_replace(coalesce(customer_name,''),'[^[:alnum:]]','','g'),4));
  if customer_prefix='' then customer_prefix:='CLI'; end if;
  select coalesce(max((regexp_match(cc.code,'-([0-9]+)$'))[1]::integer),0)+1
    into next_number from public.cost_centers cc where cc.customer_id=new.customer_id;
  new.code:=customer_prefix||'-'||lpad(next_number::text,4,'0');
  return new;
end;
$$;

alter table public.cost_centers disable trigger cost_center_auto_customer_code;
with numbered as (
  select cc.cost_center_id,
         upper(left(regexp_replace(coalesce(c.company_name,''),'[^[:alnum:]]','','g'),4)) prefix,
         row_number() over(partition by cc.customer_id order by cc.cost_center_id) sequence_number
  from public.cost_centers cc
  join public.customers c on c.customer_id=cc.customer_id
)
update public.cost_centers cc
set code=(case when n.prefix='' then 'CLI' else n.prefix end)||'-'||lpad(n.sequence_number::text,4,'0')
from numbered n where n.cost_center_id=cc.cost_center_id;
alter table public.cost_centers enable trigger cost_center_auto_customer_code;
