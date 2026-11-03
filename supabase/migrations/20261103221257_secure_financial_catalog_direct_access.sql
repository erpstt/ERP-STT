-- Process 74: role/context checks for direct reads and the existing book CRUD path.
set local lock_timeout='5s';
set local statement_timeout='60s';

create schema finance_catalog_private;
revoke all on schema finance_catalog_private from public,anon,authenticated,service_role;
grant usage on schema finance_catalog_private to authenticated;

create function finance_catalog_private.allowed(resource text,action text default 'view')
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
begin
 if resource not in ('banking:bank-accounts','accounting:accounting-books')
  or action not in ('view','create','edit','delete') or resource is null or action is null
 then return false;end if;
 perform report_template_private.enter(resource,action);
 return true;
exception when insufficient_privilege then return false;
end$$;
revoke all on all functions in schema finance_catalog_private from public,anon,authenticated,service_role;
grant execute on function finance_catalog_private.allowed(text,text) to authenticated;

revoke all on table public.bank_account,public.accounting_books from anon;

alter policy company_select on public.bank_account using (
 subsidiary_id=(select public.active_subsidiary_id_without_report_context())
 and (select finance_catalog_private.allowed('banking:bank-accounts','view'))
);
alter policy company_select on public.accounting_books using (
 subsidiary_id=(select public.active_subsidiary_id_without_report_context())
 and (select finance_catalog_private.allowed('accounting:accounting-books','view'))
);
-- Books are maintained through the existing authenticated PostgREST CRUD path.
-- Check both old and new row scope; an edit cannot move a book to another company.
alter policy company_insert on public.accounting_books with check (
 subsidiary_id=(select public.active_subsidiary_id_without_report_context())
 and (select finance_catalog_private.allowed('accounting:accounting-books','create'))
);
alter policy company_update on public.accounting_books using (
 subsidiary_id=(select public.active_subsidiary_id_without_report_context())
 and (select finance_catalog_private.allowed('accounting:accounting-books','edit'))
) with check (
 subsidiary_id=(select public.active_subsidiary_id_without_report_context())
 and (select finance_catalog_private.allowed('accounting:accounting-books','edit'))
);
alter policy company_delete on public.accounting_books using (
 subsidiary_id=(select public.active_subsidiary_id_without_report_context())
 and (select finance_catalog_private.allowed('accounting:accounting-books','delete'))
);
notify pgrst,'reload schema';
