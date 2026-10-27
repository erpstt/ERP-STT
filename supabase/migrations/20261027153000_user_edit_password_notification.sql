-- Recuperación iniciada por un administrador desde Editar usuario.
-- Autoriza al actor y al objetivo antes de que el servidor use service_role.

alter table public.configuraciones_correos
  drop constraint if exists configuraciones_correos_tipo_notificacion_check;

alter table public.configuraciones_correos
  add constraint configuraciones_correos_tipo_notificacion_check
  check(tipo_notificacion in(
    'PAGO_PROVEEDOR',
    'ESTADO_CUENTA',
    'FACTURA_VENTA',
    'SOLICITUD_GASTO_APROBACION',
    'USUARIO_INVITACION',
    'USUARIO_RECUPERACION'
  ));

insert into public.configuraciones_correos(
  id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo,updated_by_email
)
select subsidiary_id,
  'USUARIO_RECUPERACION',
  'Recupera tu acceso a GENTIA ERP · {{empresa_nombre}}',
  '<p>Hola <strong>{{usuario_nombre}}</strong>,</p><p>Un administrador solicitó la recuperación de tu acceso a GENTIA ERP para el correo <strong>{{usuario_correo}}</strong>.</p><p>Utiliza el botón para definir una nueva contraseña. El enlace es confidencial, de un solo uso y vence el {{fecha_expiracion}}.</p>',
  true,
  'sistema'
from public.subsidiaries
on conflict(id_subsidiaria,tipo_notificacion) do nothing;

create or replace function public.user_password_recovery_email_ensure_template(
  p_subsidiary_id bigint
)
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if p_subsidiary_id is null or not exists(
    select 1 from public.subsidiaries
    where subsidiary_id=p_subsidiary_id and is_active
  ) then
    raise exception using errcode='22023',message='La subsidiaria indicada no existe o está inactiva.';
  end if;
  insert into public.configuraciones_correos(
    id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo,updated_by_email
  )values(
    p_subsidiary_id,
    'USUARIO_RECUPERACION',
    'Recupera tu acceso a GENTIA ERP · {{empresa_nombre}}',
    '<p>Hola <strong>{{usuario_nombre}}</strong>,</p><p>Un administrador solicitó la recuperación de tu acceso a GENTIA ERP para el correo <strong>{{usuario_correo}}</strong>.</p><p>Utiliza el botón para definir una nueva contraseña. El enlace es confidencial, de un solo uso y vence el {{fecha_expiracion}}.</p>',
    true,
    'sistema'
  )on conflict(id_subsidiaria,tipo_notificacion)do nothing;
end;
$$;

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
  recovery_path text;
begin
  if actor_id is null or sid is null then
    raise exception using errcode='42501',message='Debe iniciar sesión y seleccionar una subsidiaria autorizada.';
  end if;

  perform public.security_assert_role_access('security:users','edit');

  select account.*
    into target
  from public.users account
  join public.user_subsidiaries access
    on access.user_id=account.user_id
   and access.subsidiary_id=sid
  where account.user_id=p_user_id
    and account.is_active
    and account.auth_user_id is not null;

  if not found then
    raise exception using errcode='22023',message='El usuario no está disponible para recuperar su acceso.';
  end if;

  recovery_path:=format('security/users/%s/password-recovery?subsidiary=%s',target.user_id,sid);
  if(
    select count(*)
    from public.activity_log
    where user_id=actor_id
      and activity_type='SOLICITUD_RECUPERACION_USUARIO'
      and "timestamp">=clock_timestamp()-interval '15 minutes'
  )>=10 then
    raise exception using errcode='22023',message='Se alcanzó el límite temporal de correos de recuperación. Intente nuevamente más tarde.';
  end if;
  if(
    select count(*)
    from public.activity_log
    where user_id=actor_id
      and activity_type='SOLICITUD_RECUPERACION_USUARIO'
      and path_accessed=recovery_path
      and "timestamp">=clock_timestamp()-interval '15 minutes'
  )>=3 then
    raise exception using errcode='22023',message='Ya se enviaron varias solicitudes para este usuario. Intente nuevamente más tarde.';
  end if;

  insert into public.activity_log(user_id,activity_type,path_accessed)
  values(actor_id,'SOLICITUD_RECUPERACION_USUARIO',recovery_path);

  return jsonb_build_object(
    'actor_user_id',actor_id,
    'subsidiary_id',sid,
    'user_id',target.user_id,
    'email',target.email,
    'first_name',target.first_name,
    'last_name',target.last_name
  );
end;
$$;

create or replace function public.user_password_recovery_email_settings(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  uid bigint:=public.app_user_id();
  sid bigint:=public.active_subsidiary_id();
  action_name text:=lower(trim(coalesce(p_action,'')));
  cfg public.configuraciones_correos%rowtype;
  subject_value text;
  body_value text;
  invalid_variable text;
  can_edit boolean:=false;
begin
  if uid is null or sid is null or not exists(
    select 1
    from public.users account
    join public.user_subsidiaries access on access.user_id=account.user_id
    where account.user_id=uid
      and account.is_active
      and access.subsidiary_id=sid
  ) then
    raise exception using errcode='42501',message='Debe iniciar sesión y seleccionar una subsidiaria autorizada.';
  end if;

  if action_name not in('get','save','delivery') then
    raise exception using errcode='22023',message='Acción inválida.';
  end if;

  perform public.security_assert_role_access(
    case when action_name='delivery' then 'security:users'
         else 'configuration:notification-templates' end,
    case when action_name='save' then 'edit'
         when action_name='delivery' then 'edit'
         else 'view' end
  );

  can_edit:=public.app_is_admin()or exists(
    select 1 from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and(
        access.resource_key='legacy:all'
        or(access.resource_key='configuration:notification-templates'and access.can_edit)
      )
  );

  perform public.user_password_recovery_email_ensure_template(sid);

  if action_name='save' then
    subject_value:=trim(coalesce(p_payload->>'subject',''));
    body_value:=coalesce(p_payload->>'body','');
    if length(subject_value)not between 1 and 200
      or subject_value~E'[\r\n]'
      or length(body_value)not between 1 and 20000 then
      raise exception using errcode='22023',message='La plantilla de recuperación no es válida.';
    end if;
    if subject_value~*'\{\{[[:space:]]*enlace_recuperacion[[:space:]]*\}\}' then
      raise exception using errcode='22023',message='La variable {{enlace_recuperacion}} solo puede utilizarse en el cuerpo del correo.';
    end if;
    select matched.captures[1]
      into invalid_variable
    from regexp_matches(
      subject_value||E'\n'||body_value,
      '\{\{[[:space:]]*([^{}]+?)[[:space:]]*\}\}',
      'g'
    )as matched(captures)
    where trim(matched.captures[1])<>all(array[
      'empresa_nombre','usuario_nombre','usuario_correo',
      'enlace_recuperacion','fecha_expiracion'
    ]::text[])
    limit 1;
    if invalid_variable is not null then
      raise exception using errcode='22023',message='Variable no permitida en la plantilla: {{'||trim(invalid_variable)||'}}.';
    end if;
    update public.configuraciones_correos
    set asunto_template=subject_value,
        cuerpo_template=body_value,
        activo=coalesce((p_payload->>'active')::boolean,false),
        updated_by_email=(select email from public.users where user_id=uid),
        updated_at=clock_timestamp()
    where id_subsidiaria=sid and tipo_notificacion='USUARIO_RECUPERACION';
  end if;

  select *
    into cfg
  from public.configuraciones_correos
  where id_subsidiaria=sid
    and tipo_notificacion='USUARIO_RECUPERACION';

  return jsonb_build_object(
    'template',to_jsonb(cfg),
    'subsidiary',(
      select jsonb_build_object('id',subsidiary_id,'name',name,'logo',logo_url)
      from public.subsidiaries
      where subsidiary_id=sid
    ),
    'canEdit',can_edit,
    'variables',jsonb_build_array(
      'empresa_nombre','usuario_nombre','usuario_correo',
      'enlace_recuperacion','fecha_expiracion'
    )
  );
end;
$$;

drop function if exists public.security_audit_user_password_notification(bigint,text);

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
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception using errcode='42501',message='Operación reservada al servicio.';
  end if;
  if normalized_result not in('ENVIADO','ENVIADO_CON_ADVERTENCIA','ERROR') then
    raise exception using errcode='22023',message='El resultado de la notificación no es válido.';
  end if;
  if not exists(
    select 1
    from public.users actor
    join public.user_subsidiaries actor_access
      on actor_access.user_id=actor.user_id
     and actor_access.subsidiary_id=p_subsidiary_id
    join public.users target on target.user_id=p_target_user_id
    join public.user_subsidiaries target_access
      on target_access.user_id=target.user_id
     and target_access.subsidiary_id=p_subsidiary_id
    where actor.user_id=p_actor_user_id
  ) then
    raise exception using errcode='22023',message='No fue posible validar el contexto de la notificación.';
  end if;

  insert into public.activity_log(user_id,activity_type,path_accessed)
  values(
    p_actor_user_id,
    'ENVIO_RECUPERACION_USUARIO_'||normalized_result,
    format('security/users/%s/password-recovery?subsidiary=%s',p_target_user_id,p_subsidiary_id)
  );
  return true;
end;
$$;

-- Consume todos los enlaces abiertos del mismo correo en una sola operación.
-- El advisory lock evita que dos enlaces concurrentes sean aceptados a la vez.
create or replace function public.consume_password_recovery_grant(
  p_state_hash text,
  p_email_hash text
)
returns boolean
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  matched_email_hash text;
  affected integer;
  consumed_time timestamptz:=clock_timestamp();
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Operación reservada al servicio.' using errcode='42501';
  end if;
  if p_state_hash!~'^[a-f0-9]{64}$' or p_email_hash!~'^[a-f0-9]{64}$' then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_email_hash,0));
  select email_hash
    into matched_email_hash
  from public.password_recovery_grants
  where state_hash=p_state_hash
    and email_hash=p_email_hash
    and consumed_at is null
    and expires_at>consumed_time;
  if not found then
    return false;
  end if;

  update public.password_recovery_grants
     set consumed_at=consumed_time
   where email_hash=matched_email_hash
     and consumed_at is null;
  get diagnostics affected=row_count;
  return affected>0;
end;
$$;

comment on function public.security_prepare_user_password_recovery(bigint) is
  'Valida permiso de edición, subsidiaria activa y objetivo antes de preparar una recuperación administrativa.';
comment on function public.user_password_recovery_email_settings(text,jsonb) is
  'Administra la plantilla de recuperación y la entrega al servidor con permiso security:users.edit.';
comment on function public.security_audit_user_password_notification(bigint,bigint,bigint,text) is
  'Registra, solo desde el servidor, el resultado del correo sin almacenar enlaces, tokens ni contraseñas.';
comment on function public.consume_password_recovery_grant(text,text) is
  'Consume de forma serializada todos los enlaces abiertos del correo al utilizar correctamente uno de ellos.';

revoke all on function public.security_prepare_user_password_recovery(bigint) from public,anon;
revoke all on function public.user_password_recovery_email_ensure_template(bigint) from public,anon,authenticated;
revoke all on function public.user_password_recovery_email_settings(text,jsonb) from public,anon;
revoke all on function public.security_audit_user_password_notification(bigint,bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.consume_password_recovery_grant(text,text) from public,anon,authenticated;
grant execute on function public.security_prepare_user_password_recovery(bigint) to authenticated;
grant execute on function public.user_password_recovery_email_settings(text,jsonb) to authenticated;
grant execute on function public.security_audit_user_password_notification(bigint,bigint,bigint,text) to service_role;
grant execute on function public.consume_password_recovery_grant(text,text) to service_role;

notify pgrst,'reload schema';
