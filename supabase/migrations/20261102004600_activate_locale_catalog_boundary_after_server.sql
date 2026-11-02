-- Activate only after compatible core-catalog clients are deployed.
create function locale_catalog_private.guard()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 if not core_dictionary_private.has_context(tg_op||':'||tg_table_name)then raise exception using errcode='42501',message='Use el mantenimiento protegido del catalogo.';end if;
 perform locale_catalog_private.access(tg_table_name,case tg_op when'INSERT'then'create'when'UPDATE'then'edit'else'delete'end);
 if tg_op<>'INSERT'then perform locale_catalog_private.validate_change(tg_table_name,to_jsonb(old),case when tg_op='DELETE'then null else to_jsonb(new)end);end if;
 if tg_op='UPDATE'and((tg_table_name='languages'and to_jsonb(new)->'language_id'is distinct from to_jsonb(old)->'language_id')or(tg_table_name='timezones'and to_jsonb(new)->'timezone_id'is distinct from to_jsonb(old)->'timezone_id'))then raise exception using errcode='55000',message='Identificador inmutable.';end if;
 if tg_op='DELETE'then return old;end if;return new;
end$$;
revoke all on function locale_catalog_private.guard()from public,anon,authenticated,service_role;
create trigger locale_catalog_guard before insert or update or delete on public.languages for each row execute function locale_catalog_private.guard();
create trigger locale_catalog_guard before insert or update or delete on public.timezones for each row execute function locale_catalog_private.guard();
do $$declare t text;r record;s text;begin foreach t in array array['languages','timezones']loop
 for r in select policyname from pg_policies where schemaname='public'and tablename=t loop execute format('drop policy %I on public.%I',r.policyname,t);end loop;
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy dictionary_operational_read on public.%I for select to authenticated using((select public.app_user_id())is not null)',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 for r in select attname from pg_attribute where attrelid=format('public.%I',t)::regclass and attnum>0 and not attisdropped loop execute format('revoke all(%I)on public.%I from public,anon,authenticated,service_role',r.attname,t);end loop;
 execute format('grant select on public.%I to authenticated,service_role',t);
s:=pg_get_serial_sequence('public.'||t,case t when'languages'then'language_id'else'timezone_id'end);execute format('revoke all on sequence %s from public,anon,authenticated,service_role',s);
end loop;end$$;
notify pgrst,'reload schema';
