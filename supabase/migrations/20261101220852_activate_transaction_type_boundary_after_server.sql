-- Activate only after the compatible server has been published.
create function transaction_type_private.guard()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if not core_dictionary_private.has_context(tg_op||':transaction_types')then raise exception using errcode='42501',message='Use el mantenimiento protegido del tipo.';end if;
 perform transaction_type_private.access(case tg_op when'INSERT'then'create'when'UPDATE'then'edit'else'delete'end);
 if tg_op='DELETE'then if transaction_type_private.used(old)then raise exception using errcode='55000',message='Tipo utilizado.';end if;return old;end if;
 if tg_op='UPDATE'and(row(new.transaction_type_id,new.code)is distinct from row(old.transaction_type_id,old.code)or(transaction_type_private.used(old)and row(new.abbreviation,new.name,new.module_category)is distinct from row(old.abbreviation,old.name,old.module_category)))then raise exception using errcode='55000',message='El tipo conserva identidad y clasificacion.';end if;return new;
end$$;
revoke all on function transaction_type_private.guard()from public,anon,authenticated,service_role;
create trigger transaction_type_boundary_guard before insert or update or delete on public.transaction_types for each row execute function transaction_type_private.guard();
do $$declare r record;begin
 for r in select policyname from pg_policies where schemaname='public'and tablename='transaction_types'loop execute format('drop policy %I on public.transaction_types',r.policyname);end loop;
 alter table public.transaction_types enable row level security;
 create policy transaction_type_operational_read on public.transaction_types for select to authenticated using((select public.app_user_id())is not null);
 revoke all on public.transaction_types from public,anon,authenticated,service_role;
 for r in select attname from pg_attribute where attrelid='public.transaction_types'::regclass and attnum>0 and not attisdropped loop execute format('revoke all(%I)on public.transaction_types from public,anon,authenticated,service_role',r.attname);end loop;
 grant select on public.transaction_types to authenticated,service_role;
 execute format('revoke all on sequence %s from public,anon,authenticated,service_role',pg_get_serial_sequence('public.transaction_types','transaction_type_id'));
end$$;
-- The raw insert adapter is no longer needed by API roles; protected RPCs run
-- as owner and retain the same authorized default without exposing nextval.
revoke execute on function sequence_security_private.transaction_type_code()from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
