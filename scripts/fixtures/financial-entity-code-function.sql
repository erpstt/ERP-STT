CREATE OR REPLACE FUNCTION public.assign_financial_entity_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_table_name='financial_creditors' and (new.code is null or btrim(new.code)='') then
    new.code:='ACF-'||lpad(nextval('public.financial_creditor_code_seq')::text,8,'0');
  elsif tg_table_name='related_companies' and (new.code is null or btrim(new.code)='') then
    new.code:='INT-'||lpad(nextval('public.related_company_code_seq')::text,8,'0');
  end if;
  return new;
end;$function$;
