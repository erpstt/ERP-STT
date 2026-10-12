create table if not exists public.role_access_matrix(
  role_id bigint not null references public.roles(role_id) on delete cascade,
  resource_key text not null check(resource_key ~ '^[a-z0-9-]+:[a-z0-9-]+$'),
  can_view boolean not null default false,
  can_create boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  updated_by bigint references public.users(user_id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key(role_id,resource_key),
  check(not(can_create or can_edit or can_delete) or can_view)
);
create index if not exists role_access_matrix_role_idx on public.role_access_matrix(role_id);

alter table public.role_access_matrix enable row level security;
drop policy if exists role_access_matrix_select on public.role_access_matrix;
drop policy if exists role_access_matrix_manage on public.role_access_matrix;
create policy role_access_matrix_select on public.role_access_matrix for select to authenticated
using(public.app_is_admin() or role_id=public.app_active_role_id());
create policy role_access_matrix_manage on public.role_access_matrix for all to authenticated
using(public.app_is_admin()) with check(public.app_is_admin());

-- Los códigos técnicos son parte del sistema. Los usuarios los consultan, pero solo un
-- administrador puede cambiar sus asignaciones y ninguna pantalla los modifica directamente.
drop policy if exists security_insert on public.permissions;
drop policy if exists security_update on public.permissions;
drop policy if exists security_delete on public.permissions;
create policy security_insert on public.permissions for insert to authenticated with check(false);
create policy security_update on public.permissions for update to authenticated using(false)with check(false);
create policy security_delete on public.permissions for delete to authenticated using(false);
drop policy if exists security_select on public.role_permissions;
drop policy if exists security_insert on public.role_permissions;
drop policy if exists security_update on public.role_permissions;
drop policy if exists security_delete on public.role_permissions;
create policy security_select on public.role_permissions for select to authenticated using(public.app_is_admin()or role_id=public.app_active_role_id());
create policy security_insert on public.role_permissions for insert to authenticated with check(public.app_is_admin());
create policy security_update on public.role_permissions for update to authenticated using(public.app_is_admin())with check(public.app_is_admin());
create policy security_delete on public.role_permissions for delete to authenticated using(public.app_is_admin());
alter table public.permissions add column if not exists is_operational boolean not null default false;
update public.permissions p set is_operational=true where not p.is_operational and exists(select 1 from public.role_permissions rp where rp.permission_id=p.permission_id);

-- Conserva el acceso actual al activar la matriz. El administrador podrá restringir cada rol después.
insert into public.role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)
select r.role_id,x.resource_key,true,true,true,true
from public.roles r cross join lateral(values('legacy:all'))x(resource_key)
where not exists(select 1 from public.role_access_matrix existing where existing.role_id=r.role_id)
on conflict do nothing;

create or replace function public.security_role_access_matrix_data(p_role_id bigint default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare selected_role bigint:=p_role_id;result jsonb;
begin
 if not public.app_is_admin() then raise exception using errcode='42501',message='Solo un administrador puede configurar permisos por rol.';end if;
 if selected_role is null then select role_id into selected_role from public.roles order by case when lower(role_name)='contabilidad' then 0 else 1 end,role_name limit 1;end if;
 if not exists(select 1 from public.roles where role_id=selected_role)then raise exception'El rol seleccionado no existe.';end if;
 select jsonb_build_object(
  'roles',coalesce((select jsonb_agg(jsonb_build_object('roleId',r.role_id,'name',r.role_name,'description',r.description,'isSystemRole',r.is_system_role)order by r.role_name)from public.roles r),'[]'::jsonb),
  'selectedRoleId',selected_role,
  'grants',coalesce((select jsonb_agg(jsonb_build_object('resourceKey',m.resource_key,'canView',m.can_view,'canCreate',m.can_create,'canEdit',m.can_edit,'canDelete',m.can_delete)order by m.resource_key)from public.role_access_matrix m where m.role_id=selected_role),'[]'::jsonb),
  'specialPermissions',coalesce((select jsonb_agg(jsonb_build_object('permissionId',p.permission_id,'code',p.code,'module',p.module,'description',p.description,'enabled',rp.id is not null)order by p.module,p.code)from public.permissions p left join public.role_permissions rp on rp.permission_id=p.permission_id and rp.role_id=selected_role where p.is_operational),'[]'::jsonb),
  'isAdministratorRole',coalesce((select lower(trim(role_name)) in('administrador','administrator','admin')from public.roles where role_id=selected_role),false)
 )into result;
 return result;
end$$;

drop function if exists public.security_save_role_access_matrix(bigint,jsonb);
drop function if exists public.security_save_role_access_matrix(bigint,jsonb,bigint[]);
create function public.security_save_role_access_matrix(p_role_id bigint,p_entries jsonb,p_permission_ids bigint[] default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare item jsonb;count_saved integer:=0;
begin
 if not public.app_is_admin()then raise exception using errcode='42501',message='Solo un administrador puede configurar permisos por rol.';end if;
 if not exists(select 1 from public.roles where role_id=p_role_id)then raise exception'El rol seleccionado no existe.';end if;
 if jsonb_typeof(coalesce(p_entries,'[]'::jsonb))<>'array'then raise exception'La matriz de permisos no es válida.';end if;
 delete from public.role_access_matrix where role_id=p_role_id and resource_key<>'legacy:all';
 for item in select value from jsonb_array_elements(coalesce(p_entries,'[]'::jsonb))loop
  if coalesce(item->>'resourceKey','')!~'^[a-z0-9-]+:[a-z0-9-]+$'then raise exception'La opción de permiso no es válida.';end if;
  insert into public.role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete,updated_by,updated_at)
  values(p_role_id,item->>'resourceKey',coalesce((item->>'canView')::boolean,false),coalesce((item->>'canCreate')::boolean,false),coalesce((item->>'canEdit')::boolean,false),coalesce((item->>'canDelete')::boolean,false),public.app_user_id(),now());
  count_saved:=count_saved+1;
 end loop;
 delete from public.role_access_matrix where role_id=p_role_id and resource_key='legacy:all';
 if p_permission_ids is not null then
  if exists(select 1 from unnest(p_permission_ids)requested where not exists(select 1 from public.permissions p where p.permission_id=requested and p.is_operational))then raise exception'La selección contiene un permiso técnico no válido.';end if;
  delete from public.role_permissions target using public.permissions permission where target.role_id=p_role_id and permission.permission_id=target.permission_id and permission.is_operational;
  insert into public.role_permissions(role_id,permission_id)select p_role_id,requested from unnest(p_permission_ids)requested on conflict do nothing;
 end if;
 return jsonb_build_object('success',true,'saved',count_saved,'specialSaved',coalesce(array_length(p_permission_ids,1),0));
end$$;

create or replace function public.security_my_role_access()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object(
  'isAdmin',public.app_is_admin(),
  'grants',coalesce((select jsonb_agg(jsonb_build_object('resourceKey',m.resource_key,'canView',m.can_view,'canCreate',m.can_create,'canEdit',m.can_edit,'canDelete',m.can_delete))from public.role_access_matrix m where m.role_id=public.app_active_role_id()),'[]'::jsonb)
 )
$$;
create or replace function public.security_assert_role_access(p_resource_key text,p_action text default 'view')
returns void language plpgsql stable security definer set search_path=public,pg_temp as $$
declare allowed boolean:=false;
begin
 if public.app_is_admin()then return;end if;
 if p_action not in('view','create','edit','delete')then raise exception'La acción solicitada no es válida.';end if;
 select exists(select 1 from public.role_access_matrix m where m.role_id=public.app_active_role_id()and(
   m.resource_key='legacy:all' or(m.resource_key=p_resource_key and case p_action when'view'then m.can_view when'create'then m.can_create when'edit'then m.can_edit else m.can_delete end)
 ))into allowed;
 if not allowed then raise exception using errcode='42501',message='El rol activo no tiene permiso para realizar esta acción.';end if;
end$$;
grant execute on function public.security_role_access_matrix_data(bigint)to authenticated;
grant execute on function public.security_save_role_access_matrix(bigint,jsonb,bigint[])to authenticated;
grant execute on function public.security_my_role_access()to authenticated;
grant execute on function public.security_assert_role_access(text,text)to authenticated;
