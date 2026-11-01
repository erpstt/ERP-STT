-- Activate only after compatible core-catalog clients are deployed.
create function core_dictionary_private.guard()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 if not core_dictionary_private.has_context(tg_op||':'||tg_table_name)then raise exception using errcode='42501',message='Use el mantenimiento protegido del catalogo.';end if;
 perform core_dictionary_private.access(tg_table_name,case tg_op when'INSERT'then'create'when'UPDATE'then'edit'else'delete'end);
 if tg_op<>'INSERT'then perform core_dictionary_private.validate_change(tg_table_name,to_jsonb(old),case when tg_op='DELETE'then null else to_jsonb(new)end);end if;
 if tg_op='UPDATE'and((tg_table_name='countries'and to_jsonb(new)->'country_id'is distinct from to_jsonb(old)->'country_id')or(tg_table_name='currencies'and to_jsonb(new)->'currency_id'is distinct from to_jsonb(old)->'currency_id'))then raise exception using errcode='55000',message='Identificador inmutable.';end if;
 if tg_op='DELETE'then return old;end if;return new;
end$$;
revoke all on function core_dictionary_private.guard()from public,anon,authenticated,service_role;
create trigger core_dictionary_guard before insert or update or delete on public.countries for each row execute function core_dictionary_private.guard();
create trigger core_dictionary_guard before insert or update or delete on public.currencies for each row execute function core_dictionary_private.guard();
do $$declare t text;r record;begin foreach t in array array['countries','currencies']loop
 for r in select policyname from pg_policies where schemaname='public'and tablename=t loop execute format('drop policy %I on public.%I',r.policyname,t);end loop;
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy dictionary_operational_read on public.%I for select to authenticated using((select public.app_user_id())is not null)',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 for r in select attname from pg_attribute where attrelid=format('public.%I',t)::regclass and attnum>0 and not attisdropped loop execute format('revoke all(%I)on public.%I from public,anon,authenticated,service_role',r.attname,t);end loop;
 execute format('grant select on public.%I to authenticated,service_role',t);
end loop;end$$;
notify pgrst,'reload schema';
