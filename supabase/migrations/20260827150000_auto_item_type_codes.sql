create sequence if not exists public.item_type_code_seq;

do $$
declare current_max bigint;
begin
  select coalesce(max(substring(type_code from '^TA-([0-9]{8})$')::bigint),0)
    into current_max
    from public.item_types
   where type_code ~ '^TA-[0-9]{8}$';
  if current_max=0 then
    perform setval('public.item_type_code_seq',1,false);
  else
    perform setval('public.item_type_code_seq',current_max,true);
  end if;
end$$;

alter table public.item_types
  alter column type_code set default ('TA-'||lpad(nextval('public.item_type_code_seq')::text,8,'0'));
