-- Defer only row-trigger GL rebuilds while the existing protected invoice
-- pipeline runs. Its explicit final synchronizations remain authoritative.
set local lock_timeout='5s';
set local statement_timeout='60s';
do $invoice_sync$
declare target regprocedure:='public.save_supplier_invoice(jsonb,bigint)'::regprocedure;definition text;needle text;replacement text;
begin
 if md5((select prosrc from pg_proc where oid=target))is distinct from'0798d0d741c5a5fa04f19842b26e2d47'then raise exception 'Reviewed supplier invoice entry point changed.';end if;
 definition:=pg_get_functiondef(target);
 needle:=$old$begin perform supplier_invoice_private.assert_write(target_invoice_id);return public.budget_run('FAC_PRO',payload,target_invoice_id);end$old$;
 replacement:=$new$declare previous_defer text;result jsonb;
begin
 perform supplier_invoice_private.assert_write(target_invoice_id);
 previous_defer:=current_setting('nexo.defer_journal_gl_sync',true);
 perform set_config('nexo.defer_journal_gl_sync','on',true);
 begin
  result:=public.budget_run('FAC_PRO',payload,target_invoice_id);
 exception when others then
  perform set_config('nexo.defer_journal_gl_sync',coalesce(previous_defer,''),true);
  raise;
 end;
 perform set_config('nexo.defer_journal_gl_sync',coalesce(previous_defer,''),true);
 return result;
end$new$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected supplier invoice entry point body.';end if;
 execute replace(definition,needle,replacement);
end$invoice_sync$;
