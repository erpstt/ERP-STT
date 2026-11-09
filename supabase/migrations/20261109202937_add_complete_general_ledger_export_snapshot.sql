-- Export the published ledger calculation in one database snapshot. Existing
-- interactive and scheduled calculations, original currencies and writers are
-- intentionally unchanged.
do $guard$
declare dependency record;
begin
 for dependency in select * from(values
  ('public.run_accounting_report(text,jsonb)','49cc0831bffdd2eb2d24728faaa6b816'),
  ('public.run_accounting_report_before_intercompany_commercial(text,jsonb)','fa9aa5c18c8993d4bb497b76d3ab4ebd'),
  ('public.run_accounting_report_before_intercompany_loans(text,jsonb)','63c4bc948586aa92bddacda13a0ff909'),
  ('report_delivery_private.run_accounting_report(text,jsonb)','e3983615e7de9ed565c50ac3d1a7d294'),
  ('report_delivery_private.run_accounting_report_before_intercompany_commercial(text,jsonb)','02148d4531886eff25c8caef8ae569d5'),
  ('report_delivery_private.run_accounting_report_before_intercompany_loans(text,jsonb)','63c4bc948586aa92bddacda13a0ff909'),
  ('report_template_private.enter(text,text)','91fc047935f066b30e29a30452fed82b')
 )expected(signature,source_md5) loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(dependency.signature) and md5(prosrc)=dependency.source_md5)then
   raise exception 'Unexpected complete ledger export dependency: %',dependency.signature;
  end if;
 end loop;
 if to_regprocedure('report_delivery_private.general_ledger_export_rows(jsonb)')is not null
  or to_regprocedure('public.run_general_ledger_export(jsonb)')is not null then
  raise exception 'Complete ledger export already exists';
 end if;
 if not exists(select 1 from pg_namespace where nspname='report_delivery_private'
   and pg_get_userbyid(nspowner)='postgres'
   and not exists(select 1 from aclexplode(coalesce(nspacl,acldefault('n',nspowner)))a where a.grantee<>nspowner))then
  raise exception 'Unexpected private report schema privileges';
 end if;
end $guard$;

do $derive$
declare
 original text;declarations text;common text;ledger_query text;body text;
 begin_at integer;ledger_at integer;next_at integer;needle text;replacement text;
 begin_marker text:=E'\nbegin\n';
 ledger_marker text:=E'\n if p_report=''general-ledger'' then\n';
 next_marker text:=E'\n elsif p_report=''journal'' then\n';
begin
 select prosrc into original from pg_proc where oid='public.run_accounting_report_before_intercompany_loans(text,jsonb)'::regprocedure;
 begin_at:=strpos(original,begin_marker);ledger_at:=strpos(original,ledger_marker);next_at:=strpos(original,next_marker);
 if begin_at<=0 or ledger_at<=begin_at or next_at<=ledger_at then raise exception 'Missing complete ledger branch boundaries';end if;
 declarations:=left(original,begin_at-1);
 common:=substr(original,begin_at+length(begin_marker),ledger_at-begin_at-length(begin_marker));
 ledger_query:=substr(original,ledger_at+length(ledger_marker),next_at-ledger_at-length(ledger_marker));
 needle:='order by account_number,date,id limit page_size offset offset_no';
 if(length(ledger_query)-length(replace(ledger_query,needle,'')))/length(needle)<>1 then raise exception 'Unexpected ledger export pagination boundary';end if;
 ledger_query:=replace(ledger_query,needle,'order by account_number,date,id');
 needle:='jsonb_agg(to_jsonb(numbered)-''total_count''-''signed_movement'')';
 replacement:='jsonb_agg(to_jsonb(numbered)-''total_count''-''signed_movement'' order by account_number,date,id)';
 if(length(ledger_query)-length(replace(ledger_query,needle,'')))/length(needle)<>1 then raise exception 'Unexpected ledger export row boundary';end if;
 ledger_query:=replace(ledger_query,needle,replacement);
 needle:='''page'',page_no,''pageSize'',page_size,';
 if(length(ledger_query)-length(replace(ledger_query,needle,'')))/length(needle)<>1 then raise exception 'Unexpected ledger export page metadata boundary';end if;
 ledger_query:=replace(ledger_query,needle,'');
 body:=declarations||$declarations$
 p_report constant text:='general-ledger';
 export_context jsonb;export_subsidiary jsonb;export_currency jsonb;export_book jsonb;
begin
 if jsonb_typeof(p_filters)is distinct from 'object' then raise exception using errcode='22023',message='Seleccione filtros del Libro Mayor válidos.';end if;
 if jsonb_typeof(p_filters->'subsidiaryIds')is distinct from 'array' then raise exception using errcode='22023',message='Seleccione una subsidiaria para exportar el Libro Mayor.';end if;
 if jsonb_array_length(p_filters->'subsidiaryIds')<>1 then raise exception using errcode='22023',message='Seleccione una sola subsidiaria para exportar el Libro Mayor.';end if;
 -- Page controls have no meaning in a complete export, including stale values.
 p_filters:=p_filters-'page'-'pageSize';
$declarations$||common||$validation$
 if date_from>date_to then raise exception using errcode='22023',message='Revise las fechas del Libro Mayor.';end if;
 select jsonb_build_object('id',s.subsidiary_id,'name',s.name),
   jsonb_build_object('id',c.currency_id,'code',c.currency_code,'name',c.name)
 into export_subsidiary,export_currency from public.subsidiaries s
 join public.currencies c on c.currency_id=s.currency_id where s.subsidiary_id=sids[1];
 if export_subsidiary is null then raise exception using errcode='22023',message='No se pudo resolver la moneda local de la subsidiaria.';end if;
 if book_id is not null then
  select jsonb_build_object('id',b.accounting_book_id,'name',b.book_name) into export_book
  from public.accounting_books b where b.accounting_book_id=book_id and b.subsidiary_id=sids[1];
  if export_book is null then raise exception using errcode='42501',message='Seleccione un libro de la subsidiaria autorizada.';end if;
 end if;
$validation$||ledger_query||$result$
 export_context:=jsonb_build_object(
  'subsidiary',export_subsidiary,'localCurrency',export_currency,'book',export_book,'bookId',book_id,
  'dateFrom',date_from,'dateTo',date_to,
  'filters',jsonb_build_object('subsidiaryIds',to_jsonb(sids),'bookId',book_id,'dateFrom',date_from,'dateTo',date_to,
   'accountId',filter_account_id,'accountIds',to_jsonb(filter_account_ids),'accountFrom',filter_account_from,'accountTo',filter_account_to,
   'entityType',filter_entity_type,'entityId',filter_entity_id,'costCenterId',filter_cost_center_id));
 return result||jsonb_build_object('snapshotFingerprint',md5(jsonb_build_object('data',result,'context',export_context)::text),
  'context',export_context||jsonb_build_object('generatedAt',statement_timestamp()));
end
$result$;
 execute 'create function report_delivery_private.general_ledger_export_rows(p_filters jsonb default ''{}''::jsonb) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public,pg_temp as '||quote_literal(body);
end $derive$;

revoke all on function report_delivery_private.general_ledger_export_rows(jsonb) from public,anon,authenticated,service_role;

create function public.run_general_ledger_export(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp
as $function$
begin
 perform report_template_private.enter('reports:accounting-reports','view');
 return report_delivery_private.general_ledger_export_rows(p_filters);
end
$function$;
revoke all on function public.run_general_ledger_export(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.run_general_ledger_export(jsonb) to authenticated;
notify pgrst,'reload schema';
