create sequence if not exists public.financial_creditor_code_seq;
create sequence if not exists public.related_company_code_seq;

do $$ declare max_value bigint;
begin
  select coalesce(max(substring(code from '^ACF-([0-9]{8})$')::bigint),0) into max_value from public.financial_creditors;
  if max_value=0 then perform setval('public.financial_creditor_code_seq',1,false);else perform setval('public.financial_creditor_code_seq',max_value,true);end if;
  select coalesce(max(substring(code from '^INT-([0-9]{8})$')::bigint),0) into max_value from public.related_companies;
  if max_value=0 then perform setval('public.related_company_code_seq',1,false);else perform setval('public.related_company_code_seq',max_value,true);end if;
end $$;

create or replace function public.assign_financial_entity_code()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_table_name='financial_creditors' and (new.code is null or btrim(new.code)='') then
    new.code:='ACF-'||lpad(nextval('public.financial_creditor_code_seq')::text,8,'0');
  elsif tg_table_name='related_companies' and (new.code is null or btrim(new.code)='') then
    new.code:='INT-'||lpad(nextval('public.related_company_code_seq')::text,8,'0');
  end if;
  return new;
end;$$;

drop trigger if exists financial_creditor_auto_code on public.financial_creditors;
create trigger financial_creditor_auto_code before insert on public.financial_creditors for each row execute function public.assign_financial_entity_code();
drop trigger if exists related_company_auto_code on public.related_companies;
create trigger related_company_auto_code before insert on public.related_companies for each row execute function public.assign_financial_entity_code();
