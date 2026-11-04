-- Process 80: contain legacy catalog writes; preserve the operational purchase workflow.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema purchase_legacy_private;
revoke all on schema purchase_legacy_private from public,anon,authenticated,service_role;
grant usage on schema purchase_legacy_private to authenticated;

create function purchase_legacy_private.visible(resource text,p_key bigint)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 if auth.uid()is null or resource is null or p_key is null
  or resource not in('purchasing:requisitions','purchasing:quotes')then return false;end if;
 sid:=report_template_private.enter(resource,'view');
 if sid is distinct from public.active_subsidiary_id_without_report_context()then return false;end if;
 if resource='purchasing:requisitions'then return p_key=sid;end if;
 -- Legacy quotes have no company column. Never infer company from a shared supplier.
 -- Rows without an attributable transaction remain hidden, with no reclassification.
 return exists(select 1 from public."transaction"t
  where t.transaction_id=p_key and t.subsidiary_id=sid);
exception when insufficient_privilege then return false;
end$$;
revoke all on all functions in schema purchase_legacy_private from public,anon,authenticated,service_role;
grant execute on function purchase_legacy_private.visible(text,bigint)to authenticated;

revoke all on table public.purchase_requisition,public.purchase_quote from public,anon,authenticated;
grant select on table public.purchase_requisition,public.purchase_quote to authenticated;
do $columns_and_sequences$
declare item record;col record;seq text;
begin
 for item in select *from(values('purchase_requisition','requisition_id'),('purchase_quote','quote_id'))v(tbl,pk)loop
  for col in select attname from pg_attribute where attrelid=to_regclass(format('public.%I',item.tbl))and attnum>0 and not attisdropped loop
   execute format('revoke all(%I)on table public.%I from public,anon,authenticated restrict',col.attname,item.tbl);
  end loop;
  seq:=pg_get_serial_sequence(format('public.%I',item.tbl),item.pk);
  if seq is not null then execute format('revoke all on sequence %s from public,anon,authenticated restrict',seq);end if;
 end loop;
end$columns_and_sequences$;

alter policy company_select on public.purchase_requisition using(purchase_legacy_private.visible('purchasing:requisitions',subsidiary_id));
alter policy purchasing_select on public.purchase_quote using(purchase_legacy_private.visible('purchasing:quotes',transaction_id));
drop policy company_insert on public.purchase_requisition;
drop policy company_update on public.purchase_requisition;
drop policy company_delete on public.purchase_requisition;
drop policy purchasing_insert on public.purchase_quote;
drop policy purchasing_update on public.purchase_quote;
drop policy purchasing_delete on public.purchase_quote;
-- purchase_document, its lines, SECURITY DEFINER RPC, workflow and audit triggers stay unchanged.
notify pgrst,'reload schema';
