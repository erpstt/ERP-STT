-- Preserve company financial-statement presentation when saved or delivered.
-- Only the BS/IS USD branch uses the private, read-only presentation calculator.
set local lock_timeout='5s';
set local statement_timeout='30s';
do $patch$
declare
 target oid;item record;prior record;after_metadata record;definition text;i integer;
 signatures text[]:=array['public.scheduled_report_validate_options(bigint,text,jsonb)','public.scheduled_report_manage(text,jsonb)','public.scheduled_report_snapshot_v2(bigint,text,date,jsonb,bigint)'];
 hashes text[]:=array['064611a5c82003438e99d38544213fad','516639ec0b486ccabb1ea05be1ecf374','e57e2653ff20a1388a8e48bf20481aab'];
begin
 if to_regprocedure('report_delivery_private.run_financial_statement_presentation(text,jsonb,bigint)')is null then
  raise exception 'Install company financial-statement presentation first.';
 end if;
 for i in 1..array_length(signatures,1)loop
  target:=to_regprocedure(signatures[i]);
  if target is null or not exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=target and l.lanname='plpgsql' and p.prosecdef and md5(p.prosrc)=hashes[i])
  then raise exception 'Unexpected scheduled report source; review before migrating: %',signatures[i];end if;
 end loop;
 for item in select * from(values
  (signatures[1],$old$ if not exists(select 1 from scheduled_report_catalog where code=p_kind)$old$,
   $new$ if coalesce(p_options->>'presentationCurrency','LOCAL')not in('LOCAL','USD')then raise exception using errcode='22023',message='Seleccione moneda local o USD para el reporte.';end if;
 if p_options->>'presentationCurrency'='USD'and p_kind not in('balance-sheet','income-statement')then raise exception using errcode='22023',message='La presentación en USD corresponde a los estados de situación financiera y resultados.';end if;
 if not exists(select 1 from scheduled_report_catalog where code=p_kind)$new$),
  (signatures[2],$old$'bankAccountId',nullif(opts->>'bankAccountId','')::bigint)where id=$old$,
   $new$'bankAccountId',nullif(opts->>'bankAccountId','')::bigint)||case when opts?'presentationCurrency'then jsonb_build_object('presentationCurrency',opts->>'presentationCurrency')else '{}'::jsonb end where id=$new$),
  (signatures[3],$old$'pageSize',250);$old$,
   $new$'pageSize',250,'presentationCurrency',coalesce(p_options->>'presentationCurrency','LOCAL'));$new$),
  (signatures[3],$old$ when 'pending-invoice-control'then report:=$old$,
   $new$ when 'balance-sheet','income-statement'then
 if p_options->>'presentationCurrency'='USD'then
 report:=report_delivery_private.run_financial_statement_presentation(p_kind,filters,case when coalesce(auth.role(),'')='service_role'then p_owner else app_user_id()end);
 else report:=report_delivery_private.run_accounting_report(p_kind,filters);end if;
 when 'pending-invoice-control'then report:=$new$),
  (signatures[3],$old$'currency',(select c.currency_code from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=p_sid)$old$,
   $new$'currency',case when p_kind in('balance-sheet','income-statement')and p_options->>'presentationCurrency'='USD'then report->>'presentationCurrencyCode'else(select c.currency_code from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=p_sid)end$new$)
 )v(signature,needle,replacement)loop
  target:=to_regprocedure(item.signature);
  select proowner,proacl,proconfig,provolatile,prosecdef,proisstrict,proparallel into strict prior from pg_proc where oid=target;
  definition:=pg_get_functiondef(target);
  if (length(definition)-length(replace(definition,item.needle,'')))<>length(item.needle)
  then raise exception 'Unexpected scheduled report projection: %',item.signature;end if;
  execute replace(definition,item.needle,item.replacement);
  select proowner,proacl,proconfig,provolatile,prosecdef,proisstrict,proparallel into strict after_metadata from pg_proc where oid=target;
  if after_metadata is distinct from prior then raise exception 'Scheduled report metadata changed: %',item.signature;end if;
 end loop;
end
$patch$;
notify pgrst,'reload schema';
