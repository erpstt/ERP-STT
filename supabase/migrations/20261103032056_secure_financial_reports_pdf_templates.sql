-- A-05/A-09: preserve business bodies, guard every exposed entry before its declarations.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema report_template_private;
revoke all on schema report_template_private from public,anon,authenticated,service_role;

create function report_template_private.enter(resource text,action text default 'view') returns bigint
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();uid bigint:=public.app_user_id();rid bigint:=public.app_active_role_id();
begin
 if auth.uid() is null or uid is null or rid is null or sid is null
  or not exists(select 1 from public.users where user_id=uid and is_active)
  or not exists(select 1 from public.user_roles where user_id=uid and role_id=rid)
  or not exists(select 1 from public.user_subsidiaries where user_id=uid and subsidiary_id=sid)
 then raise exception using errcode='42501',message='Seleccione usuario, rol y subsidiaria autorizados.';end if;
 perform public.security_assert_role_access(resource,'view');
 if action<>'view' then perform public.security_assert_role_access(resource,action);end if;
 return sid;
end$$;

create function report_template_private.validate_template(p jsonb) returns void language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint:=public.active_subsidiary_id();bid bigint;pid bigint;
begin
 if p is null or jsonb_typeof(p)<>'object' or jsonb_typeof(p->'schema') is distinct from 'object'
  or length((p->'schema')::text)>128000 then raise exception using errcode='22023',message='Diseño visual inválido.';end if;
 bid:=nullif(p->>'branchId','')::bigint;
 pid:=nullif(p->>'id','')::bigint;
 if pid is not null and not exists(select 1 from public.pdf_templates where id=pid and subsidiary_id=sid)
 then raise exception using errcode='42501',message='Plantilla no disponible en la subsidiaria activa.';end if;
 if bid is not null and not exists(select 1 from public.locations l left join public.location_subsidiaries ls using(location_id)
  where l.location_id=bid and (l.subsidiary_id=sid or ls.subsidiary_id=sid))
 then raise exception using errcode='42501',message='Sucursal no disponible en la subsidiaria activa.';end if;
end$$;
revoke all on all functions in schema report_template_private from public,anon,authenticated,service_role;

-- Direct writes cannot bypass the validated public template functions.
revoke all on table public.pdf_templates from anon,authenticated;

do $harden$
declare sig text;f record;src text;guard text;permission text;directives text;
begin
 foreach sig in array array['accounting_report_options()','accounting_report_options_bundle()','aging_report_options()','eight_column_balance_report_options()','payment_request_report_options()','pdf_template_clone(bigint)','pdf_template_compiled(bigint)','pdf_template_delete(bigint)','pdf_template_document_data(text,text)','pdf_template_options()','pdf_template_save(jsonb)','purchase_transaction_support(bigint)','run_accounting_report(text,jsonb)','run_aging_report(text,jsonb)','run_bank_balance_period_report(jsonb)','run_bank_reconciliation_report(jsonb)','run_eight_column_balance_report(jsonb)','run_general_journal_report(jsonb)','run_income_statement_matrix(jsonb)','run_intercompany_commercial_report(jsonb)','run_intercompany_loan_report(jsonb)','run_payment_request_report(jsonb)','run_pending_invoice_control_report(jsonb)','run_purchase_transaction_report(jsonb)','run_sales_transaction_report(jsonb)','run_settled_sales_invoice_report(jsonb)','run_settled_supplier_invoice_report(jsonb)','run_vat_declaration_report(jsonb)','settled_sales_invoice_report_options()','settled_supplier_invoice_report_options()','vat_declaration_report_options()','general_journal_options()','income_forecast_options(boolean)','income_forecast_save(jsonb)','income_forecast_source(jsonb)','income_statement_dimension_links()'] loop
  select p.oid,p.proname,p.prosrc,l.lanname into strict f from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure('public.'||sig);
  src:=f.prosrc;
  permission:=case when f.proname like 'pdf_template_%' then 'documents:pdf-templates' else 'reports:accounting-reports' end;
  guard:=format('perform report_template_private.enter(%L,%L);',permission,'view');
  if f.proname='pdf_template_save' then
   guard:=$save$perform report_template_private.enter('documents:pdf-templates',case when nullif(p->>'id','')is null then 'create' else 'edit' end);perform report_template_private.validate_template(p);$save$;
   if position($ref$p->>'compiled'$ref$ in src)=0 then raise exception 'Unexpected template save implementation';end if;
   src:=replace(src,$ref$p->>'compiled'$ref$,$empty$''$empty$);
  elsif f.proname='pdf_template_clone' then
   guard:=$clone$perform report_template_private.enter('documents:pdf-templates','create');$clone$;
   if position('orientation,visual_schema,html_compiled,app_user_id()' in src)=0 then raise exception 'Unexpected template clone implementation';end if;
   src:=replace(src,'orientation,visual_schema,html_compiled,app_user_id()',$clone_html$orientation,visual_schema,'',app_user_id()$clone_html$);
  elsif f.proname='pdf_template_delete' then guard:=$delete$perform report_template_private.enter('documents:pdf-templates','delete');$delete$;
  elsif f.proname='pdf_template_document_data' then
   guard:=guard||$document$perform report_template_private.enter(case p_type when 'FAC_VEN' then 'sales:invoices' when 'NC_VEN' then 'sales:credit-notes' when 'ND_VEN' then 'sales:debit-notes' when 'ORD_COM' then 'purchasing:orders' when 'PED_VEN' then 'sales:sales-orders' when 'COT_VEN' then 'sales:quotations' when 'SOL_PAG' then 'treasury:payment-requests' when 'REC_PAG' then 'sales:customer-payments' when 'ASI_DIA' then 'accounting:journals' else '__unsupported_document__' end,'view');$document$;
  end if;
  if f.proname in('pdf_template_clone','pdf_template_delete','pdf_template_compiled') then
   guard:=guard||$row$if not exists(select 1 from public.pdf_templates where id=p_id and subsidiary_id=public.active_subsidiary_id())then raise exception using errcode='42501',message='Plantilla no disponible en la subsidiaria activa.';end if;$row$;
  end if;
  if f.lanname='sql' then
   src:='begin '||guard||' return ('||regexp_replace(trim(src),';[[:space:]]*$','')||');end';
  elsif f.lanname='plpgsql' then
   -- Compiler directives apply to the whole function and must precede its outer block.
   directives:=substring(src from E'^((?:[[:space:]]*#[^\\n]+\\n)+)');
   if directives is not null then src:=substr(src,length(directives)+1);end if;
   src:=coalesce(directives,'')||'begin '||guard||E'\n'||trim(src)||case when right(trim(src),1)=';'then ''else ';'end||E'\nend';
  else raise exception 'Unexpected function language: %',sig;end if;
  execute format('create or replace function public.%s returns %s language plpgsql %s security definer set search_path=pg_catalog,public,pg_temp as %L',
    (select proname||'('||pg_get_function_arguments(oid)||')' from pg_proc where oid=f.oid),pg_get_function_result(f.oid),
    case (select provolatile from pg_proc where oid=f.oid) when 's'then 'stable' when 'i'then 'immutable'else 'volatile'end,src);
  execute 'revoke all on function public.'||sig||' from public,anon,service_role';
  execute 'grant execute on function public.'||sig||' to authenticated';
 end loop;
end$harden$;
notify pgrst,'reload schema';
