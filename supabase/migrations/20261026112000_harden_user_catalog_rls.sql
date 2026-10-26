-- El catálogo de usuarios no es el proveedor de identidad. Supabase Auth y el
-- backend de confianza crean las cuentas; los JWT de navegador solo pueden
-- consultar datos no sensibles y editar los campos de perfil autorizados.

-- Completa el vínculo de cuentas heredadas por identidad/correo. Los correos
-- ambiguos se omiten deliberadamente para no enlazar una identidad incorrecta.
update public.users account
set auth_user_id=identity.id
from auth.users identity
where account.auth_user_id is null
  and lower(account.email)=lower(identity.email)
  and not exists(
    select 1
    from public.users duplicate
    where duplicate.user_id<>account.user_id
      and lower(duplicate.email)=lower(account.email)
  )
  and not exists(
    select 1
    from public.users linked
    where linked.user_id<>account.user_id
      and linked.auth_user_id=identity.id
  );

-- El backend normaliza antes de guardar y esta restricción evita que una
-- escritura interna futura vuelva a introducir espacios o diferencias de
-- mayúsculas que rompan la correspondencia inequívoca con Supabase Auth.
do $$
begin
  if not exists(
    select 1
    from pg_constraint
    where conrelid='public.users'::regclass
      and conname='users_email_canonical_check'
  ) then
    alter table public.users
      add constraint users_email_canonical_check
      check(email=lower(btrim(email)));
  end if;
end;
$$;

-- La identidad ERP se resuelve exclusivamente por el UUID verificado por
-- Supabase Auth. El correo queda como dato de contacto, no como credencial.
create or replace function public.app_user_id() returns bigint
language sql stable security definer set search_path=public,pg_temp
as $$
  select account.user_id
  from public.users account
  where account.auth_user_id=auth.uid()
    and account.is_active
  limit 1
$$;

-- Una seleccion deja de ser valida inmediatamente si se desactiva el usuario
-- o se retira la asignacion, aunque sobreviva la fila de sesion anterior.
create or replace function public.app_active_role_id() returns bigint
language sql stable security definer set search_path=public,pg_temp
as $$
  select selected.role_id
  from public.user_role_sessions selected
  join public.users account on account.user_id=selected.user_id and account.is_active
  join public.user_roles membership
    on membership.user_id=selected.user_id
   and membership.role_id=selected.role_id
  where selected.session_id=public.app_session_id()
    and selected.user_id=public.app_user_id()
  limit 1
$$;

create or replace function public.active_subsidiary_id() returns bigint
language sql stable security definer set search_path=public,pg_temp
as $$
  select selected.subsidiary_id
  from public.user_company_sessions selected
  join public.users account on account.user_id=selected.user_id and account.is_active
  join public.user_subsidiaries membership
    on membership.user_id=selected.user_id
   and membership.subsidiary_id=selected.subsidiary_id
  where selected.session_id=public.app_session_id()
    and selected.user_id=public.app_user_id()
  limit 1
$$;

create or replace function public.security_resource_allowed(
  p_resource_key text,
  p_action text default 'view'
) returns boolean
language sql stable security definer set search_path=public,pg_temp
as $$
  select public.app_user_id() is not null
    and p_action in('view','create','edit','delete')
    and(
      public.app_is_admin()
      or exists(
        select 1
        from public.role_access_matrix access
        where access.role_id=public.app_active_role_id()
          and(
            access.resource_key='legacy:all'
            or(
              access.resource_key=p_resource_key
              and case p_action
                when 'view' then access.can_view
                when 'create' then access.can_create
                when 'edit' then access.can_edit
                when 'delete' then access.can_delete
                else false
              end
            )
          )
      )
    )
$$;

create or replace function public.security_role_is_assignable(p_role_id bigint)
returns boolean
language sql stable security definer set search_path=public,pg_temp
as $$
  select exists(
    select 1
    from public.roles role_record
    where role_record.role_id=p_role_id
      and not role_record.is_system_role
      and lower(btrim(role_record.role_name)) not in('administrador','administrator','admin')
  )
$$;

revoke all on function public.app_user_id() from public,anon;
revoke all on function public.app_active_role_id() from public,anon;
revoke all on function public.active_subsidiary_id() from public,anon;
revoke all on function public.security_resource_allowed(text,text) from public,anon;
revoke all on function public.security_role_is_assignable(bigint) from public,anon;
grant execute on function public.app_user_id() to authenticated,service_role;
grant execute on function public.app_active_role_id() to authenticated,service_role;
grant execute on function public.active_subsidiary_id() to authenticated,service_role;
grant execute on function public.security_resource_allowed(text,text) to authenticated,service_role;
grant execute on function public.security_role_is_assignable(bigint) to authenticated,service_role;

drop policy if exists security_select on public.users;
drop policy if exists security_insert on public.users;
drop policy if exists security_update on public.users;
drop policy if exists security_delete on public.users;
drop policy if exists users_select_authorized on public.users;
drop policy if exists users_update_authorized on public.users;

-- El propio usuario debe poder resolver su perfil durante el inicio de sesión,
-- antes de seleccionar un rol. La consulta global exige permiso de la matriz.
create policy users_select_authorized
on public.users
for select
to authenticated
using(
  user_id=public.app_user_id()
  or public.security_resource_allowed('security:users','view')
);

create policy users_update_authorized
on public.users
for update
to authenticated
using(
  public.security_resource_allowed('security:users','edit')
)
with check(
  public.security_resource_allowed('security:users','edit')
);

-- Quita los grants de tabla que anulaban la protección por columna. No se
-- permite crear/eliminar usuarios ni cambiar su identidad desde PostgREST.
revoke all privileges on table public.users from public,anon,authenticated;
revoke all privileges on sequence public.users_user_id_seq from public,anon,authenticated;

grant select(
  user_id,
  timezone_id,
  email,
  first_name,
  last_name,
  is_active,
  created_at,
  invitation_sent_at,
  invitation_accepted_at,
  created_by_name,
  created_by_email,
  actor_type,
  actor_source,
  execution_context_id,
  updated_by_name,
  updated_by_email,
  updated_actor_type,
  updated_actor_source,
  updated_execution_context_id
) on table public.users to authenticated;

grant update(
  timezone_id,
  first_name,
  last_name,
  is_active
) on table public.users to authenticated;

-- El alta sigue siendo una acción humana auditada, pero no requiere devolver a
-- authenticated el INSERT directo sobre users. El RPC comprueba nuevamente el
-- permiso dentro de la misma transacción y solo acepta una identidad que ya
-- exista en Supabase Auth con el mismo correo canónico.
create or replace function public.security_create_user(
  p_email text,
  p_auth_user_id uuid,
  p_first_name text,
  p_last_name text,
  p_timezone_id bigint default null,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  canonical_email text:=lower(btrim(coalesce(p_email,'')));
  identity_email text;
  created_user public.users%rowtype;
begin
  if public.app_user_id() is null then
    raise exception using errcode='42501',message='No fue posible identificar al usuario responsable.';
  end if;
  perform public.security_assert_role_access('security:users','create');
  if p_email is null or p_email<>canonical_email or length(canonical_email)>254 then
    raise exception using errcode='22023',message='El correo electrónico no es válido o no está normalizado.';
  end if;
  if nullif(btrim(p_first_name),'') is null or length(btrim(p_first_name))>120
    or nullif(btrim(p_last_name),'') is null or length(btrim(p_last_name))>120 then
    raise exception using errcode='22023',message='El nombre y los apellidos son obligatorios y no pueden exceder 120 caracteres.';
  end if;
  select lower(btrim(identity.email))
    into identity_email
  from auth.users identity
  where identity.id=p_auth_user_id;
  if identity_email is null or identity_email<>canonical_email then
    raise exception using errcode='22023',message='La identidad de acceso no corresponde al correo solicitado.';
  end if;
  insert into public.users(
    email,password_hash,auth_user_id,first_name,last_name,timezone_id,is_active,invitation_sent_at
  ) values(
    canonical_email,'auth:'||p_auth_user_id::text,p_auth_user_id,
    btrim(p_first_name),btrim(p_last_name),p_timezone_id,coalesce(p_is_active,true),null
  )
  returning * into created_user;
  return jsonb_build_object(
    'user_id',created_user.user_id,
    'email',created_user.email,
    'first_name',created_user.first_name,
    'last_name',created_user.last_name,
    'timezone_id',created_user.timezone_id,
    'is_active',created_user.is_active,
    'invitation_sent_at',created_user.invitation_sent_at,
    'invitation_accepted_at',created_user.invitation_accepted_at
  );
exception
  when unique_violation then
    raise exception using errcode='23505',message='Ya existe un usuario con ese correo electrónico o identidad de acceso.';
end;
$$;

create or replace function public.security_mark_user_invitation_sent(p_user_id bigint)
returns boolean
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if public.app_user_id() is null then
    raise exception using errcode='42501',message='No fue posible identificar al usuario responsable.';
  end if;
  perform public.security_assert_role_access('security:users','create');
  update public.users
  set invitation_sent_at=now()
  where user_id=p_user_id
    and auth_user_id is not null;
  if not found then
    raise exception using errcode='22023',message='El usuario indicado no existe o no tiene identidad de acceso.';
  end if;
  return true;
end;
$$;

revoke all on function public.security_create_user(text,uuid,text,text,bigint,boolean) from public,anon;
revoke all on function public.security_mark_user_invitation_sent(bigint) from public,anon;
grant execute on function public.security_create_user(text,uuid,text,text,bigint,boolean) to authenticated;
grant execute on function public.security_mark_user_invitation_sent(bigint) to authenticated;

-- Protege los catalogos que definen privilegios y alcance empresarial. Las
-- politicas heredadas USING(true) permitian autoasignarse roles o companias.
drop policy if exists security_select on public.roles;
drop policy if exists security_insert on public.roles;
drop policy if exists security_update on public.roles;
drop policy if exists security_delete on public.roles;
drop policy if exists roles_select_authorized on public.roles;
drop policy if exists roles_insert_authorized on public.roles;
drop policy if exists roles_update_authorized on public.roles;
drop policy if exists roles_delete_authorized on public.roles;

create policy roles_select_authorized on public.roles
for select to authenticated
using(public.app_user_id() is not null);

create policy roles_insert_authorized on public.roles
for insert to authenticated
with check(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:roles','create')
    and not is_system_role
    and lower(btrim(role_name)) not in('administrador','administrator','admin')
  )
);

create policy roles_update_authorized on public.roles
for update to authenticated
using(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:roles','edit')
    and not is_system_role
    and lower(btrim(role_name)) not in('administrador','administrator','admin')
  )
)
with check(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:roles','edit')
    and not is_system_role
    and lower(btrim(role_name)) not in('administrador','administrator','admin')
  )
);

create policy roles_delete_authorized on public.roles
for delete to authenticated
using(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:roles','delete')
    and not is_system_role
    and lower(btrim(role_name)) not in('administrador','administrator','admin')
  )
);

drop policy if exists security_select on public.user_roles;
drop policy if exists security_insert on public.user_roles;
drop policy if exists security_update on public.user_roles;
drop policy if exists security_delete on public.user_roles;
drop policy if exists user_roles_select_authorized on public.user_roles;
drop policy if exists user_roles_insert_authorized on public.user_roles;
drop policy if exists user_roles_update_authorized on public.user_roles;
drop policy if exists user_roles_delete_authorized on public.user_roles;

create policy user_roles_select_authorized on public.user_roles
for select to authenticated
using(
  user_id=public.app_user_id()
  or public.security_resource_allowed('security:user-roles','view')
);

create policy user_roles_insert_authorized on public.user_roles
for insert to authenticated
with check(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:user-roles','create')
    and user_id<>public.app_user_id()
    and public.security_role_is_assignable(role_id)
  )
);

create policy user_roles_update_authorized on public.user_roles
for update to authenticated
using(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:user-roles','edit')
    and user_id<>public.app_user_id()
    and public.security_role_is_assignable(role_id)
  )
)
with check(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:user-roles','edit')
    and user_id<>public.app_user_id()
    and public.security_role_is_assignable(role_id)
  )
);

create policy user_roles_delete_authorized on public.user_roles
for delete to authenticated
using(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:user-roles','delete')
    and user_id<>public.app_user_id()
    and public.security_role_is_assignable(role_id)
  )
);

drop policy if exists user_subsidiaries_access on public.user_subsidiaries;
drop policy if exists user_subsidiaries_select_authorized on public.user_subsidiaries;
drop policy if exists user_subsidiaries_insert_authorized on public.user_subsidiaries;
drop policy if exists user_subsidiaries_update_authorized on public.user_subsidiaries;
drop policy if exists user_subsidiaries_delete_authorized on public.user_subsidiaries;

create policy user_subsidiaries_select_authorized on public.user_subsidiaries
for select to authenticated
using(
  user_id=public.app_user_id()
  or public.security_resource_allowed('security:user-subsidiaries','view')
);

create policy user_subsidiaries_insert_authorized on public.user_subsidiaries
for insert to authenticated
with check(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:user-subsidiaries','create')
    and user_id<>public.app_user_id()
  )
);

create policy user_subsidiaries_update_authorized on public.user_subsidiaries
for update to authenticated
using(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:user-subsidiaries','edit')
    and user_id<>public.app_user_id()
  )
)
with check(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:user-subsidiaries','edit')
    and user_id<>public.app_user_id()
  )
);

create policy user_subsidiaries_delete_authorized on public.user_subsidiaries
for delete to authenticated
using(
  public.app_is_admin()
  or(
    public.security_resource_allowed('security:user-subsidiaries','delete')
    and user_id<>public.app_user_id()
  )
);

comment on policy users_select_authorized on public.users is
  'Permite leer el perfil propio o el catálogo con permiso security:users; password_hash y auth_user_id no tienen grant de lectura.';
comment on policy users_update_authorized on public.users is
  'Limita la edición del perfil a administradores o roles con security:users.can_edit; altas y bajas directas permanecen bloqueadas.';
comment on function public.security_create_user(text,uuid,text,text,bigint,boolean) is
  'Aprovisiona un usuario ERP enlazado a Supabase Auth tras validar security:users.create; devuelve únicamente campos no sensibles.';
comment on function public.security_mark_user_invitation_sent(bigint) is
  'Registra el envío de una invitación conservando al usuario humano como actor de auditoría.';

comment on function public.app_active_role_id() is
  'Devuelve el rol activo solo mientras la asignacion y el usuario continuen vigentes.';
comment on function public.active_subsidiary_id() is
  'Devuelve la subsidiaria activa solo mientras la asignacion y el usuario continuen vigentes.';
comment on function public.security_resource_allowed(text,text) is
  'Centraliza permisos de matriz con identidad, usuario y rol activo vigentes.';

notify pgrst,'reload schema';
