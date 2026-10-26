-- Plantilla editable para invitar a un usuario sin comunicar contraseñas.
-- El enlace de activación se genera fuera de la base y nunca se persiste aquí.

alter table public.configuraciones_correos
  drop constraint if exists configuraciones_correos_tipo_notificacion_check;

alter table public.configuraciones_correos
  add constraint configuraciones_correos_tipo_notificacion_check
  check(tipo_notificacion in(
    'PAGO_PROVEEDOR',
    'ESTADO_CUENTA',
    'FACTURA_VENTA',
    'SOLICITUD_GASTO_APROBACION',
    'USUARIO_INVITACION'
  ));

insert into public.configuraciones_correos(
  id_subsidiaria,
  tipo_notificacion,
  asunto_template,
  cuerpo_template,
  activo,
  updated_by_email
)
select
  subsidiary.subsidiary_id,
  'USUARIO_INVITACION',
  'Activa tu acceso a GENTIA ERP · {{empresa_nombre}}',
  '<p>Hola <strong>{{usuario_nombre}}</strong>,</p><p>Se creó una cuenta para ti en GENTIA ERP con el correo <strong>{{usuario_correo}}</strong>.</p><p>Utiliza el botón de activación para establecer tu contraseña personal. El enlace es confidencial, de un solo uso y vence el {{fecha_expiracion}}.</p>',
  true,
  'sistema'
from public.subsidiaries subsidiary
on conflict(id_subsidiaria,tipo_notificacion) do nothing;

create or replace function public.user_invitation_email_ensure_template(
  p_subsidiary_id bigint
)
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if p_subsidiary_id is null or not exists(
    select 1
    from public.subsidiaries subsidiary
    where subsidiary.subsidiary_id=p_subsidiary_id
      and subsidiary.is_active
  ) then
    raise exception using errcode='22023',message='La subsidiaria indicada no existe o está inactiva.';
  end if;

  insert into public.configuraciones_correos(
    id_subsidiaria,tipo_notificacion,asunto_template,cuerpo_template,activo,updated_by_email
  ) values(
    p_subsidiary_id,
    'USUARIO_INVITACION',
    'Activa tu acceso a GENTIA ERP · {{empresa_nombre}}',
    '<p>Hola <strong>{{usuario_nombre}}</strong>,</p><p>Se creó una cuenta para ti en GENTIA ERP con el correo <strong>{{usuario_correo}}</strong>.</p><p>Utiliza el botón de activación para establecer tu contraseña personal. El enlace es confidencial, de un solo uso y vence el {{fecha_expiracion}}.</p>',
    true,
    'sistema'
  ) on conflict(id_subsidiaria,tipo_notificacion) do nothing;
end;
$$;

create or replace function public.user_invitation_email_settings(
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
    case
      when action_name='delivery' then 'security:users'
      else 'configuration:notification-templates'
    end,
    case
      when action_name='save' then 'edit'
      when action_name='delivery' then 'create'
      else 'view'
    end
  );

  can_edit:=public.app_is_admin()or exists(
    select 1
    from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and(
        access.resource_key='legacy:all'
        or(
          access.resource_key='configuration:notification-templates'
          and access.can_edit
        )
      )
  );

  perform public.user_invitation_email_ensure_template(sid);

  if action_name='save' then
    subject_value:=trim(coalesce(p_payload->>'subject',''));
    body_value:=coalesce(p_payload->>'body','');
    if length(subject_value) not between 1 and 200
      or subject_value~E'[\r\n]'
      or length(body_value) not between 1 and 20000
    then
      raise exception using errcode='22023',message='La plantilla de invitación no es válida.';
    end if;

    if subject_value~*'\{\{[[:space:]]*enlace_activacion[[:space:]]*\}\}' then
      raise exception using errcode='22023',message='La variable {{enlace_activacion}} solo puede utilizarse en el cuerpo del correo.';
    end if;

    select matched.captures[1]
      into invalid_variable
    from regexp_matches(
      subject_value||E'\n'||body_value,
      '\{\{[[:space:]]*([^{}]+?)[[:space:]]*\}\}',
      'g'
    ) as matched(captures)
    where trim(matched.captures[1])<>all(array[
      'empresa_nombre','usuario_nombre','usuario_correo',
      'enlace_activacion','fecha_expiracion'
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
    where id_subsidiaria=sid
      and tipo_notificacion='USUARIO_INVITACION';
  end if;

  select *
    into cfg
  from public.configuraciones_correos
  where id_subsidiaria=sid
    and tipo_notificacion='USUARIO_INVITACION';

  return jsonb_build_object(
    'template',to_jsonb(cfg),
    'subsidiary',(
      select jsonb_build_object(
        'id',subsidiary_id,
        'name',name,
        'logo',logo_url
      )
      from public.subsidiaries
      where subsidiary_id=sid
    ),
    'canEdit',can_edit,
    'variables',jsonb_build_array(
      'empresa_nombre','usuario_nombre','usuario_correo',
      'enlace_activacion','fecha_expiracion'
    )
  );
end;
$$;

comment on function public.user_invitation_email_settings(text,jsonb) is
  'Consulta o actualiza la plantilla de invitación de la subsidiaria activa; no genera ni almacena enlaces de activación.';

revoke all on function public.user_invitation_email_ensure_template(bigint) from public,anon,authenticated;
revoke all on function public.user_invitation_email_settings(text,jsonb) from public,anon,authenticated;
grant execute on function public.user_invitation_email_settings(text,jsonb) to authenticated;

notify pgrst,'reload schema';
