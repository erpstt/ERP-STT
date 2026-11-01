-- Activate only after the compatible server has been published.
create function status_master_private.guard()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin
 if not core_dictionary_private.has_context(tg_op||':status')then raise exception using errcode='42501',message='Use el mantenimiento protegido del tipo.';end if;
 perform status_master_private.access(case tg_op when'INSERT'then'create'when'UPDATE'then'edit'else'delete'end);
 if tg_op='DELETE'then if status_master_private.used(old)then raise exception using errcode='55000',message='Tipo utilizado.';end if;return old;end if;
 if tg_op='UPDATE'and(row(new.status_id,new.code)is distinct from row(old.status_id,old.code)or(status_master_private.used(old)and row(new.code,new.name,new.module)is distinct from row(old.code,old.name,old.module)))then raise exception using errcode='55000',message='El estado conserva identidad y clasificacion.';end if;return new;
end$$;
revoke all on function status_master_private.guard()from public,anon,authenticated,service_role;
create trigger status_boundary_guard before insert or update or delete on public.status for each row execute function status_master_private.guard();
do $$declare r record;begin
 for r in select policyname from pg_policies where schemaname='public'and tablename='status'loop execute format('drop policy %I on public.status',r.policyname);end loop;
 alter table public.status enable row level security;
 create policy status_operational_read on public.status for select to authenticated using((select public.app_user_id())is not null);
 revoke all on public.status from public,anon,authenticated,service_role;
 for r in select attname from pg_attribute where attrelid='public.status'::regclass and attnum>0 and not attisdropped loop execute format('revoke all(%I)on public.status from public,anon,authenticated,service_role',r.attname);end loop;
 grant select on public.status to authenticated,service_role;
 execute format('revoke all on sequence %s from public,anon,authenticated,service_role',pg_get_serial_sequence('public.status','status_id'));
end$$;
notify pgrst,'reload schema';
