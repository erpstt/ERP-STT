-- La administracion de usuarios es global para el rol Administrador. Un rol
-- delegado con permiso de edicion conserva el alcance de la subsidiaria activa.
-- La autorizacion efectiva queda registrada antes de cualquier uso de
-- service_role y la auditoria final se enlaza con esa solicitud inmutable.

create or replace function public.security_prepare_user_password_recovery(
  p_user_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  actor_id bigint:=public.app_user_id();
  sid bigint:=public.active_subsidiary_id();
  target public.users%rowtype;
  target_in_active_subsidiary boolean:=false;
  global_administrator boolean:=false;
  authorization_scope text;
  recovery_path text;
begin
  if actor_id is null or sid is null then
    raise exception using errcode='42501',message='Debe iniciar sesion y seleccionar una subsidiaria autorizada.';
  end if;

  -- Se conserva la autorizacion de edicion existente. app_is_admin() solo es
  -- verdadero cuando el rol Administrador es el rol activo de la sesion.
  perform public.security_assert_role_access('security:users','edit');
  global_administrator:=coalesce(public.app_is_admin(),false);

  select account.*
    into target
  from public.users account
  where account.user_id=p_user_id
    and account.is_active;

  if not found then
    raise exception using errcode='22023',message='El usuario no esta disponible para recuperar su acceso.';
  end if;

  select exists(
    select 1
    from public.user_subsidiaries access
    where access.user_id=target.user_id
      and access.subsidiary_id=sid
  ) into target_in_active_subsidiary;

  if not global_administrator and not target_in_active_subsidiary then
    -- El mismo mensaje se utiliza para inexistentes, inactivos y fuera de
    -- alcance, evitando que un gestor delegado enumere usuarios por la RPC.
    raise exception using errcode='22023',message='El usuario no esta disponible para recuperar su acceso.';
  end if;

  authorization_scope:=case
    when target_in_active_subsidiary then 'SUBSIDIARY'
    else 'GLOBAL_ADMIN'
  end;
  recovery_path:=format(
    'security/users/%s/password-recovery?subsidiary=%s&scope=%s',
    target.user_id,
    sid,
    lower(authorization_scope)
  );

  if(
    select count(*)
    from public.activity_log
    where user_id=actor_id
      and activity_type='SOLICITUD_RECUPERACION_USUARIO'
      and "timestamp">=clock_timestamp()-interval '15 minutes'
  )>=10 then
    raise exception using errcode='22023',message='Se alcanzo el limite temporal de correos de recuperacion. Intente nuevamente mas tarde.';
  end if;
  if(
    select count(*)
    from public.activity_log
    where user_id=actor_id
      and activity_type='SOLICITUD_RECUPERACION_USUARIO'
      and path_accessed=recovery_path
      and "timestamp">=clock_timestamp()-interval '15 minutes'
  )>=3 then
    raise exception using errcode='22023',message='Ya se enviaron varias solicitudes para este usuario. Intente nuevamente mas tarde.';
  end if;

  insert into public.activity_log(user_id,activity_type,path_accessed)
  values(actor_id,'SOLICITUD_RECUPERACION_USUARIO',recovery_path);

  return jsonb_build_object(
    'actor_user_id',actor_id,
    -- La plantilla de correo sigue perteneciendo a la subsidiaria activa del
    -- administrador. No se concede acceso empresarial al destinatario.
    'subsidiary_id',sid,
    'authorization_scope',authorization_scope,
    'user_id',target.user_id,
    'email',target.email,
    'first_name',target.first_name,
    'last_name',target.last_name
  );
end;
$$;

create or replace function public.security_audit_user_password_notification(
  p_actor_user_id bigint,
  p_target_user_id bigint,
  p_subsidiary_id bigint,
  p_result text
)
returns boolean
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  normalized_result text:=upper(trim(coalesce(p_result,'')));
  subsidiary_path text:=format(
    'security/users/%s/password-recovery?subsidiary=%s&scope=subsidiary',
    p_target_user_id,
    p_subsidiary_id
  );
  global_path text:=format(
    'security/users/%s/password-recovery?subsidiary=%s&scope=global_admin',
    p_target_user_id,
    p_subsidiary_id
  );
  authorized_path text;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception using errcode='42501',message='Operacion reservada al servicio.';
  end if;
  if normalized_result not in('ENVIADO','ENVIADO_CON_ADVERTENCIA','ERROR') then
    raise exception using errcode='22023',message='El resultado de la notificacion no es valido.';
  end if;
  if not exists(select 1 from public.users where user_id=p_actor_user_id)
    or not exists(select 1 from public.users where user_id=p_target_user_id)
    or not exists(select 1 from public.subsidiaries where subsidiary_id=p_subsidiary_id) then
    raise exception using errcode='22023',message='No fue posible validar el contexto de la notificacion.';
  end if;

  -- La fila SOLICITUD_* solo puede ser creada por la RPC actor-scoped. De este
  -- modo el servicio no reconstruye permisos usando asignaciones mutables y la
  -- auditoria refleja el alcance que fue autorizado al iniciar el envio.
  select log.path_accessed
    into authorized_path
  from public.activity_log log
  where log.user_id=p_actor_user_id
    and log.activity_type='SOLICITUD_RECUPERACION_USUARIO'
    and log.path_accessed in(subsidiary_path,global_path)
    and log."timestamp">=clock_timestamp()-interval '1 hour'
  order by log."timestamp" desc
  limit 1;

  if authorized_path is null then
    raise exception using errcode='22023',message='No fue posible validar el contexto de la notificacion.';
  end if;

  insert into public.activity_log(user_id,activity_type,path_accessed)
  values(
    p_actor_user_id,
    'ENVIO_RECUPERACION_USUARIO_'||normalized_result,
    authorized_path
  );
  return true;
end;
$$;

comment on function public.security_prepare_user_password_recovery(bigint) is
  'Autoriza recuperar usuarios activos: Administrador puede operar globalmente; los demas editores solo dentro de la subsidiaria activa.';
comment on function public.security_audit_user_password_notification(bigint,bigint,bigint,text) is
  'Registra el resultado enlazado con la solicitud actor-scoped y conserva en el path si el alcance fue subsidiario o global administrativo.';

revoke all on function public.security_prepare_user_password_recovery(bigint) from public,anon;
revoke all on function public.security_audit_user_password_notification(bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.security_prepare_user_password_recovery(bigint) to authenticated;
grant execute on function public.security_audit_user_password_notification(bigint,bigint,bigint,text) to service_role;
