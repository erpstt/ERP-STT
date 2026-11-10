-- Explicitly configure one technical permission for the caller's active role.
-- Installation never grants a permission or changes a fiscal period.
set local lock_timeout='5s';
do $guard$declare item record;actual text;begin
  for item in select * from(values
    ('access_admin_private.actor()','f459f14ee190a10f3f48ad655b608801'),
    ('access_admin_private.central()','2f75856c6c4e3d80b8a2ff251c075561'),
    ('access_admin_private.access(text,text)','8725395583288a3dabe9ec39afe669b0'),
    ('access_admin_private.allowed(text,text)','996e6857b3c4d74877fdbdc408eed7bf'),
    ('access_admin_private.matrix_revision(bigint)','8407d37581e9f2f47c9a6b202e6b4cfe'),
    ('public.app_user_id()','cd0d2c51e48fc57710a19bfd69ad3208'),
    ('public.app_active_role_id()','636cf36a793bef66b1dc8ec1b66f367b'),
    ('public.active_subsidiary_id()','49104d91b9f738494af73d925158a3cf')
  )v(signature,expected)loop
    select md5(prosrc) into actual from pg_proc where oid=to_regprocedure(item.signature);
    if actual is distinct from item.expected then raise exception 'Reviewed closure-permission authority changed: %',item.signature;end if;
  end loop;
  if not exists(select 1 from pg_trigger where tgrelid='public.role_permissions'::regclass and tgname='central_row_audit' and not tgisinternal and tgenabled in('O','A') and tgfoid='public.capture_row_audit()'::regprocedure)
    or not exists(select 1 from pg_trigger where tgrelid='public.role_permissions'::regclass and tgname='zzzz_actor_stamp' and not tgisinternal and tgenabled in('O','A') and tgfoid='public.stamp_actor_audit()'::regprocedure)
    or not exists(select 1 from pg_trigger where tgrelid='public.role_permissions'::regclass and tgname='actor_no_truncate' and not tgisinternal and tgenabled in('O','A') and tgfoid='public.reject_audit_truncate()'::regprocedure)then
    raise exception 'Reviewed closure-permission audit boundary unavailable';
  end if;
end$guard$;
-- Older installations already have this code. Preserve its full row and ID.
insert into public.permissions(code,module,description,is_operational)
select 'CONF_PERIODOS_FISCALES_CERRAR','Configuración','Permite ejecutar el cierre o reapertura de períodos fiscales',false
where not exists(select 1 from public.permissions where code='CONF_PERIODOS_FISCALES_CERRAR');
create schema fiscal_closure_permission_private;
revoke all on schema fiscal_closure_permission_private from public,anon,authenticated,service_role;

create function fiscal_closure_permission_private.options() returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog,public,pg_temp as $$
declare active_role bigint; role_name text; closure_permission bigint; enabled boolean;
begin
  begin
    perform access_admin_private.access('role-access-matrix','edit');
  exception when insufficient_privilege then
    return jsonb_build_object('canConfigure',false);
  end;
  active_role:=public.app_active_role_id();
  select r.role_name into role_name from public.roles r where r.role_id=active_role;
  select p.permission_id into closure_permission from public.permissions p where p.code='CONF_PERIODOS_FISCALES_CERRAR';
  if active_role is null or role_name is null or closure_permission is null then
    raise exception using errcode='55000',message='La configuración del permiso de cierre no está disponible.';
  end if;
  select exists(select 1 from public.role_permissions rp where rp.role_id=active_role and rp.permission_id=closure_permission) into enabled;
  return jsonb_build_object('canConfigure',true,'enabled',enabled,
    'revision',access_admin_private.matrix_revision(active_role),
    'role',jsonb_build_object('id',active_role,'name',role_name));
end$$;

create function fiscal_closure_permission_private.set_permission(p_enabled boolean,p_revision text) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog,public,pg_temp set lock_timeout='5s' as $$
declare active_role bigint; closure_permission bigint; enabled boolean; affected integer;
begin
  perform access_admin_private.access('role-access-matrix','edit');
  if p_enabled is null or p_revision is null or p_revision!~'^[a-f0-9]{32}$' then
    raise exception using errcode='22023',message='Indique el permiso y una revisión vigente.';
  end if;
  perform pg_advisory_xact_lock(793152,1);
  -- Re-read authority after the shared access-administration mutex.
  perform access_admin_private.access('role-access-matrix','edit');
  active_role:=public.app_active_role_id();
  perform 1 from public.roles r where r.role_id=active_role for share;
  if not found or p_revision is distinct from access_admin_private.matrix_revision(active_role) then
    raise exception using errcode='55000',message='La configuración del rol cambió. Consúltela nuevamente.';
  end if;
  select p.permission_id into closure_permission from public.permissions p where p.code='CONF_PERIODOS_FISCALES_CERRAR' for share;
  if closure_permission is null then
    raise exception using errcode='55000',message='La configuración del permiso de cierre no está disponible.';
  end if;
  select exists(select 1 from public.role_permissions rp where rp.role_id=active_role and rp.permission_id=closure_permission) into enabled;
  if p_enabled and not enabled then
    insert into public.role_permissions(role_id,permission_id) values(active_role,closure_permission);
  elsif not p_enabled and enabled then
    delete from public.role_permissions rp where rp.role_id=active_role and rp.permission_id=closure_permission;
    get diagnostics affected=row_count;
    if affected<>1 then raise exception using errcode='55000',message='La configuración del rol cambió. Consúltela nuevamente.';end if;
  end if;
  return fiscal_closure_permission_private.options();
end$$;

create function public.fiscal_closure_permission_options() returns jsonb
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select fiscal_closure_permission_private.options()
$$;
create function public.set_fiscal_closure_permission(p_enabled boolean,p_revision text) returns jsonb
language sql volatile security definer set search_path=pg_catalog,public,pg_temp as $$
  select fiscal_closure_permission_private.set_permission(p_enabled,p_revision)
$$;
revoke all on function fiscal_closure_permission_private.options(),fiscal_closure_permission_private.set_permission(boolean,text) from public,anon,authenticated,service_role;
revoke all on function public.fiscal_closure_permission_options(),public.set_fiscal_closure_permission(boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.fiscal_closure_permission_options(),public.set_fiscal_closure_permission(boolean,text) to authenticated;
notify pgrst,'reload schema';
