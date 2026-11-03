
-- Restore internal delivery reuse without granting access to protected public report RPCs.
set local lock_timeout='5s';set local statement_timeout='60s';
create schema report_delivery_private;
revoke all on schema report_delivery_private from public,anon,authenticated,service_role;
do $copy$
declare item record;f record;src text;directives text;prefix text:=E'begin perform report_template_private.enter(''reports:accounting-reports'',''view'');\n';names text[]:=array['run_accounting_report','run_accounting_report_before_intercompany_commercial','run_accounting_report_before_intercompany_loans','run_aging_report','run_aging_report_before_consolidation','run_aging_report_before_original_currency_reconciliation','run_bank_balance_period_report','run_bank_reconciliation_report','run_general_journal_report','run_intercompany_commercial_report','run_intercompany_loan_report','run_pending_invoice_control_report','run_purchase_transaction_report','run_sales_transaction_report'];name text;
begin
 for item in select * from(values ('run_accounting_report(text,jsonb)',true),('run_accounting_report_before_intercompany_commercial(text,jsonb)',false),('run_accounting_report_before_intercompany_loans(text,jsonb)',false),('run_aging_report(text,jsonb)',true),('run_aging_report_before_consolidation(text,jsonb)',false),('run_aging_report_before_original_currency_reconciliation(text,jsonb)',false),('run_bank_balance_period_report(jsonb)',true),('run_bank_reconciliation_report(jsonb)',true),('run_general_journal_report(jsonb)',true),('run_intercompany_commercial_report(jsonb)',true),('run_intercompany_loan_report(jsonb)',true),('run_pending_invoice_control_report(jsonb)',true),('run_purchase_transaction_report(jsonb)',true),('run_sales_transaction_report(jsonb)',true))v(signature,guarded)loop
  select p.oid,p.proname,p.prosrc,p.provolatile,l.lanname into strict f from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure('public.'||item.signature);
  if f.lanname<>'plpgsql'then raise exception 'Unexpected delivery calculation language';end if;
  src:=f.prosrc;
  if item.guarded then
   directives:=substring(src from E'^((?:[[:space:]]*#[^\n]+\n)+)');
   if directives is not null then src:=substr(src,length(directives)+1);end if;
   if left(src,length(prefix))<>prefix or right(src,4)<>E'\nend'then raise exception 'Unexpected guarded report body: %',item.signature;end if;
   src:=coalesce(directives,'')||left(substr(src,length(prefix)+1),length(substr(src,length(prefix)+1))-4);
  end if;
  foreach name in array names loop
   src:=regexp_replace(src,'(^|[^a-zA-Z0-9_.])(?:public[.])?'||name||'([[:space:]]*[(])',E'\\1report_delivery_private.'||name||E'\\2','g');
  end loop;
  execute format('create function report_delivery_private.%s returns %s language plpgsql %s security definer set search_path=pg_catalog,public,pg_temp as %L',
   (select proname||'('||pg_get_function_arguments(oid)||')'from pg_proc where oid=f.oid),pg_get_function_result(f.oid),case f.provolatile when's'then'stable'when'i'then'immutable'else'volatile'end,src);
 end loop;
end$copy$;
revoke all on all functions in schema report_delivery_private from public,anon,authenticated,service_role;
-- These three existing entry points retain their previous ACLs and actor/owner/scope checks.
do $redirect$
declare sig text;f record;src text;name text;names text[]:=array['run_accounting_report','run_accounting_report_before_intercompany_commercial','run_accounting_report_before_intercompany_loans','run_aging_report','run_aging_report_before_consolidation','run_aging_report_before_original_currency_reconciliation','run_bank_balance_period_report','run_bank_reconciliation_report','run_general_journal_report','run_intercompany_commercial_report','run_intercompany_loan_report','run_pending_invoice_control_report','run_purchase_transaction_report','run_sales_transaction_report'];
begin
 foreach sig in array array['statement_snapshot(bigint,bigint,date)','scheduled_report_snapshot(bigint,text,date)','scheduled_report_snapshot_v2(bigint,text,date,jsonb,bigint)']loop
  select oid,proname,prosrc,provolatile into strict f from pg_proc where oid=to_regprocedure('public.'||sig);src:=f.prosrc;
  foreach name in array names loop
   src:=regexp_replace(src,'(^|[^a-zA-Z0-9_.])(?:public[.])?'||name||'([[:space:]]*[(])',E'\\1report_delivery_private.'||name||E'\\2','g');
  end loop;
  if src=f.prosrc then raise exception 'Delivery entry has no report dependency: %',sig;end if;
  execute format('create or replace function public.%s returns %s language plpgsql %s security definer set search_path=pg_catalog,public,pg_temp as %L',
   (select proname||'('||pg_get_function_arguments(oid)||')'from pg_proc where oid=f.oid),pg_get_function_result(f.oid),case f.provolatile when's'then'stable'else'volatile'end,src);
 end loop;
end$redirect$;
notify pgrst,'reload schema';
