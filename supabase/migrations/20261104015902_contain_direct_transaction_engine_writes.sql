-- Process 78: generated transactions are read-only for application clients.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema transaction_access_private;
revoke all on schema transaction_access_private from public,anon,authenticated,service_role;
grant usage on schema transaction_access_private to authenticated;
create function transaction_access_private.visible(resource text,p_key bigint)returns boolean
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare sid bigint;
begin
 if auth.uid()is null or resource is null or p_key is null
  or resource not in('transaction-engine:transactions','transaction-engine:transaction-lines')then return false;end if;
 sid:=report_template_private.enter(resource,'view');
 if sid is distinct from public.active_subsidiary_id_without_report_context()then return false;end if;
 if resource='transaction-engine:transactions'then return p_key=sid;end if;
 return exists(select 1 from public."transaction"t where t.transaction_id=p_key and t.subsidiary_id=sid);
exception when insufficient_privilege then return false;
end$$;
revoke all on all functions in schema transaction_access_private from public,anon,authenticated,service_role;
grant execute on function transaction_access_private.visible(text,bigint)to authenticated;

revoke all on table public."transaction",public.transaction_line from public,anon,authenticated;
grant select on table public."transaction",public.transaction_line to authenticated;
do $columns_and_sequences$
declare item record;col record;seq text;
begin
 for item in select *from(values('transaction','transaction_id'),('transaction_line','transaction_line_id'))v(tbl,pk)loop
  for col in select attname from pg_attribute where attrelid=to_regclass(format('public.%I',item.tbl))and attnum>0 and not attisdropped loop
   execute format('revoke all(%I)on table public.%I from public,anon,authenticated restrict',col.attname,item.tbl);
  end loop;
  seq:=pg_get_serial_sequence(format('public.%I',item.tbl),item.pk);
  if seq is not null then execute format('revoke all on sequence %s from public,anon,authenticated restrict',seq);end if;
 end loop;
end$columns_and_sequences$;

alter policy company_select on public."transaction"using(transaction_access_private.visible('transaction-engine:transactions',subsidiary_id));
alter policy company_select on public.transaction_line using(transaction_access_private.visible('transaction-engine:transaction-lines',transaction_id));
drop policy company_insert on public."transaction";
drop policy company_update on public."transaction";
drop policy company_delete on public."transaction";
drop policy company_insert on public.transaction_line;
drop policy company_update on public.transaction_line;
drop policy company_delete on public.transaction_line;
-- Producer owners, SECURITY DEFINER business operations and installed triggers stay unchanged.
notify pgrst,'reload schema';
