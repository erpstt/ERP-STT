-- Activate after deploying the compatible RPC clients. No raw API reads.
create function global_configuration_private.guard()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if not core_dictionary_private.has_context(tg_op||':'||tg_table_name)then raise exception using errcode='42501',message='Use el mantenimiento protegido de configuracion.';end if;
 perform global_configuration_private.access(tg_table_name,case tg_op when'INSERT'then'create'when'UPDATE'then'edit'else'delete'end);
 if tg_op='UPDATE'and((tg_table_name='parameters'and row(to_jsonb(new)->'parameter_id',to_jsonb(new)->'parameter_key')is distinct from row(to_jsonb(old)->'parameter_id',to_jsonb(old)->'parameter_key'))or(tg_table_name='settings'and row(to_jsonb(new)->'setting_id',to_jsonb(new)->'setting_key',to_jsonb(new)->'scope')is distinct from row(to_jsonb(old)->'setting_id',to_jsonb(old)->'setting_key',to_jsonb(old)->'scope')))then raise exception using errcode='55000',message='Origen de configuracion inmutable.';end if;
 if tg_op='DELETE'then return old;end if;return new;
end$$;
revoke all on function global_configuration_private.guard()from public,anon,authenticated,service_role;
do $$declare t text;r record;s text;begin foreach t in array array['parameters','settings']loop
 execute format('create trigger global_configuration_guard before insert or update or delete on public.%I for each row execute function global_configuration_private.guard()',t);
 for r in select policyname from pg_policies where schemaname='public'and tablename=t loop execute format('drop policy %I on public.%I',r.policyname,t);end loop;
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy no_direct_configuration on public.%I for all to public using(false)with check(false)',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 for r in select attname from pg_attribute where attrelid=format('public.%I',t)::regclass and attnum>0 and not attisdropped loop execute format('revoke all(%I)on public.%I from public,anon,authenticated,service_role',r.attname,t);end loop;
 s:=pg_get_serial_sequence('public.'||t,case t when'parameters'then'parameter_id'else'setting_id'end);execute format('revoke all on sequence %s from public,anon,authenticated,service_role',s);
end loop;end$$;
notify pgrst,'reload schema';
