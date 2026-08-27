create sequence if not exists public.product_code_seq;

do $$declare current_max bigint;
begin
  select coalesce(max(substring(item_code from '^PRD-([0-9]{8})$')::bigint),0)
    into current_max from public.products where item_code ~ '^PRD-[0-9]{8}$';
  if current_max=0 then perform setval('public.product_code_seq',1,false);
  else perform setval('public.product_code_seq',current_max,true); end if;
end$$;

alter table public.products alter column item_code
  set default ('PRD-'||lpad(nextval('public.product_code_seq')::text,8,'0'));
