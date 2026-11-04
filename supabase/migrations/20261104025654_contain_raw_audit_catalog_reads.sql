-- Process 81: contain unscoped raw audit reads; keep scoped reports and capture intact.
set local lock_timeout='5s';
set local statement_timeout='60s';

revoke all on table public.audit_log,public.change_log,public.event_log,public.activity_log,public.deleted_records from public,anon,authenticated;
do $columns_and_sequences$
declare item record;col record;seq text;
begin
 for item in select *from(values
  ('audit_log','log_id'),('change_log','change_id'),('event_log','event_id'),
  ('activity_log','activity_id'),('deleted_records','deleted_id')
 )v(tbl,pk)loop
  for col in select attname from pg_attribute where attrelid=to_regclass(format('public.%I',item.tbl))and attnum>0 and not attisdropped loop
   execute format('revoke all(%I)on table public.%I from public,anon,authenticated restrict',col.attname,item.tbl);
  end loop;
  seq:=pg_get_serial_sequence(format('public.%I',item.tbl),item.pk);
  if seq is not null then execute format('revoke all on sequence %s from public,anon,authenticated restrict',seq);end if;
  -- Defense in depth if client SELECT is accidentally regranted later.
  execute format('alter policy audit_select on public.%I using(false)',item.tbl);
 end loop;
end$columns_and_sequences$;
-- No row updates/deletes, reclassification or producer/report/actor/role changes.
-- SECURITY DEFINER reports/capture retain their original owner and privileges.
notify pgrst,'reload schema';
