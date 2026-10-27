begin;

-- Las solicitudes de pago de imputación directa no dependen de un flujo
-- genérico previamente creado. La ruta se materializa con la configuración
-- operativa de la subsidiaria y de las dimensiones elegidas en sus líneas.
alter table public.solicitudes_pago
  drop constraint if exists solicitudes_pago_approval_route_source_check;
alter table public.solicitudes_pago
  add constraint solicitudes_pago_approval_route_source_check check(
    approval_route_source is null or approval_route_source in(
      'STANDARD','COST_CENTER','SUBSIDIARY','MIXED',
      'ADMINISTRATIVE','TAX_SUPERVISOR','ADMIN_FALLBACK'
    )
  );

create or replace function public.pr_payment_request_admin_route(
  p_subsidiary_id bigint,
  p_reason text
)returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  admin_user_id bigint;
begin
  -- Assign a concrete administrator from this subsidiary.  A role-level step
  -- would notify every administrator in the system because wf_notify_level
  -- does not scope role recipients by subsidiary.
  select account.user_id
    into admin_user_id
    from public.users account
    join public.user_roles membership on membership.user_id=account.user_id
    join public.roles role on role.role_id=membership.role_id
    join public.user_subsidiaries scope
      on scope.user_id=account.user_id
     and scope.subsidiary_id=p_subsidiary_id
   where account.is_active
     and lower(role.role_name)in('administrador','administrator','admin')
   order by account.user_id,role.role_id
   limit 1;

  if admin_user_id is null then
    raise exception
      'No existe un aprobador configurado ni un usuario administrador activo con acceso a la subsidiaria.';
  end if;

  return jsonb_build_object(
    'dynamic',true,
    'approverId',admin_user_id,
    'roleId',null,
    'source','ADMIN_FALLBACK',
    'levelName','Aprobación administrativa',
    'centerCount',0,
    'reason',p_reason,
    'steps',jsonb_build_array(jsonb_build_object(
      'approverId',admin_user_id,
      'roleId',null,
      'source','ADMIN_FALLBACK',
      'levelName','Aprobación administrativa',
      'reason',p_reason
    ))
  );
end
$$;

create or replace function public.pr_resolve_payment_request_approver(
  p_request_id bigint
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  header_row public.solicitudes_pago%rowtype;
  subsidiary_row public.subsidiaries%rowtype;
  client_row record;
  resolved_user bigint;
  candidate_user bigint;
  admin_user bigint;
  administrative_value text;
  admin_route jsonb;
  route_steps jsonb:='[]'::jsonb;
  approver_ids bigint[]:='{}'::bigint[];
  first_step jsonb;
  route_source text;
  has_tax_agency boolean:=false;
  has_internal boolean:=false;
  client_count integer:=0;
  direct_count integer:=0;
  fallback_count integer:=0;
  missing_count integer:=0;
  step_count integer:=0;
begin
  select * into header_row
    from public.solicitudes_pago
   where id=p_request_id
     and id_subsidiaria=public.active_subsidiary_id()
   for update;
  if header_row.id is null then raise exception 'Solicitud no encontrada.';end if;

  if header_row.tipo_solicitud<>'OTROS' then
    return jsonb_build_object(
      'dynamic',false,'approverId',null,'roleId',null,
      'source','STANDARD','levelName',null,'centerCount',0,
      'steps','[]'::jsonb
    );
  end if;

  select * into strict subsidiary_row
    from public.subsidiaries
   where subsidiary_id=header_row.id_subsidiaria;

  if exists(
    select 1
      from public.solicitudes_pago_lineas line
      join public.departments department
        on department.department_id=line.id_departamento
     where line.id_solicitud=header_row.id
       and department.is_inactive
  )then
    raise exception 'La solicitud contiene un departamento inactivo.';
  end if;
  if exists(
    select 1
      from public.solicitudes_pago_lineas line
      join public.cost_centers center
        on center.cost_center_id=line.id_centro_costo
     where line.id_solicitud=header_row.id
       and center.is_inactive
  )then
    raise exception 'La solicitud contiene un centro de costos inactivo.';
  end if;

  select exists(
    select 1
      from public.solicitudes_pago_lineas line
     where line.id_solicitud=header_row.id
       and line.tipo_tercero='Agencia Tributaria'
  )into has_tax_agency;

  -- La naturaleza tributaria domina cualquier dimensión analítica.
  if has_tax_agency then
    resolved_user:=subsidiary_row.tax_supervisor_user_id;
    if resolved_user is null or not exists(
      select 1
        from public.users account
        join public.user_subsidiaries scope using(user_id)
       where account.user_id=resolved_user
         and account.is_active
         and scope.subsidiary_id=header_row.id_subsidiaria
    )then
      return public.pr_payment_request_admin_route(
        header_row.id_subsidiaria,
        'La subsidiaria no tiene un Supervisor tributario activo y autorizado.'
      );
    end if;
    return jsonb_build_object(
      'dynamic',true,'approverId',resolved_user,'roleId',null,
      'source','TAX_SUPERVISOR','levelName','Supervisión tributaria',
      'centerCount',0,'reason','La solicitud contiene una Agencia Tributaria.',
      'steps',jsonb_build_array(jsonb_build_object(
        'approverId',resolved_user,'roleId',null,
        'source','TAX_SUPERVISOR','levelName','Supervisión tributaria',
        'reason','La solicitud contiene una Agencia Tributaria.'
      ))
    );
  end if;

  -- Cada aprobador UP distinto se convierte en un nivel secuencial. Las
  -- líneas que no tengan un UP directo autorizado intentan primero el UP por
  -- defecto y solo entonces el administrador autorizado de la subsidiaria.
  for client_row in
    with client_lines as(
      select distinct
        line.id_centro_costo,
        center.up_approver_id direct_approver,
        subsidiary_row.default_up_approver_id default_approver
      from public.solicitudes_pago_lineas line
      left join public.departments department
        on department.department_id=line.id_departamento
      left join public.cost_centers center
        on center.cost_center_id=line.id_centro_costo
      where line.id_solicitud=header_row.id
        and(
          lower(coalesce(department.type,''))='cliente'
          or upper(coalesce(center.cost_center_type,''))='CLIENTE'
        )
    ),authorized_approvers as(
      select client_lines.*,
        direct_approver is not null and exists(
          select 1
          from public.users account
          join public.user_subsidiaries scope using(user_id)
          where account.user_id=direct_approver
            and account.is_active
            and scope.subsidiary_id=header_row.id_subsidiaria
        ) direct_is_valid,
        default_approver is not null and exists(
          select 1
          from public.users account
          join public.user_subsidiaries scope using(user_id)
          where account.user_id=default_approver
            and account.is_active
            and scope.subsidiary_id=header_row.id_subsidiaria
        ) default_is_valid
      from client_lines
    )
    select id_centro_costo,
      case
        when direct_is_valid then direct_approver
        when default_is_valid then default_approver
      end resolved_approver,
      case
        when direct_is_valid then'COST_CENTER'
        when default_is_valid then'SUBSIDIARY'
        else'ADMIN_FALLBACK'
      end resolution_source
    from authorized_approvers
    order by id_centro_costo nulls first
  loop
    client_count:=client_count+1;
    candidate_user:=client_row.resolved_approver;
    if client_row.resolution_source='COST_CENTER' then
      direct_count:=direct_count+1;
    elsif client_row.resolution_source='SUBSIDIARY' then
      fallback_count:=fallback_count+1;
    else
      missing_count:=missing_count+1;
      if admin_user is null then
        admin_route:=public.pr_payment_request_admin_route(
          header_row.id_subsidiaria,
          'Un departamento Cliente no tiene Aprobador Proyectos (UP) directo ni por defecto activo y autorizado.'
        );
        admin_user:=nullif(admin_route->>'approverId','')::bigint;
      end if;
      candidate_user:=admin_user;
    end if;

    if array_position(approver_ids,candidate_user) is null then
      approver_ids:=array_append(approver_ids,candidate_user);
      step_count:=step_count+1;
      route_steps:=route_steps||jsonb_build_array(jsonb_build_object(
        'approverId',candidate_user,
        'roleId',null,
        'source',client_row.resolution_source,
        'levelName',case
          when client_row.resolution_source='ADMIN_FALLBACK'
            then'Aprobación administrativa de respaldo'
          else'Aprobación Proyectos (UP)'
        end,
        'reason','Aprobación de líneas con departamento Cliente.'
      ));
    end if;
  end loop;

  select exists(
    select 1
    from public.solicitudes_pago_lineas line
    join public.departments department
      on department.department_id=line.id_departamento
    where line.id_solicitud=header_row.id
      and lower(coalesce(department.type,''))='interno'
  )into has_internal;

  if has_internal then
    administrative_value:=subsidiary_row.administrative_approver;
    resolved_user:=null;
    if administrative_value~'^user:[1-9][0-9]*$' then
      resolved_user:=split_part(administrative_value,':',2)::bigint;
    elsif administrative_value~'^employee:[1-9][0-9]*$' then
      select employee.user_id into resolved_user
      from public.employees employee
      where employee.employee_id=split_part(administrative_value,':',2)::bigint
        and employee.is_active;
    end if;

    if resolved_user is null or not exists(
      select 1
      from public.users account
      join public.user_subsidiaries scope using(user_id)
      where account.user_id=resolved_user
        and account.is_active
        and scope.subsidiary_id=header_row.id_subsidiaria
    )then
      if admin_user is null then
        admin_route:=public.pr_payment_request_admin_route(
          header_row.id_subsidiaria,
          'La subsidiaria no tiene un Aprobador Administrativo activo y autorizado.'
        );
        admin_user:=nullif(admin_route->>'approverId','')::bigint;
      end if;
      candidate_user:=admin_user;
      route_source:='ADMIN_FALLBACK';
    else
      candidate_user:=resolved_user;
      route_source:='ADMINISTRATIVE';
    end if;

    if array_position(approver_ids,candidate_user) is null then
      approver_ids:=array_append(approver_ids,candidate_user);
      step_count:=step_count+1;
      route_steps:=route_steps||jsonb_build_array(jsonb_build_object(
        'approverId',candidate_user,
        'roleId',null,
        'source',route_source,
        'levelName',case when route_source='ADMIN_FALLBACK'
          then'Aprobación administrativa de respaldo'
          else'Aprobación administrativa'
        end,
        'reason','Aprobación de líneas con departamento Interno.'
      ));
    end if;
  end if;

  if step_count=0 then
    return public.pr_payment_request_admin_route(
      header_row.id_subsidiaria,
      'No fue posible resolver la ruta a partir de las dimensiones de la solicitud.'
    );
  end if;

  first_step:=route_steps->0;
  route_source:=case
    when step_count>1 or(client_count>0 and has_internal)
      or(direct_count>0 and fallback_count>0)
      or(missing_count>0 and(direct_count>0 or fallback_count>0))
      then'MIXED'
    else first_step->>'source'
  end;

  return jsonb_build_object(
    'dynamic',true,
    'approverId',nullif(first_step->>'approverId','')::bigint,
    'roleId',null,
    'source',route_source,
    'levelName',case when route_source='MIXED'
      then'Ruta de aprobación combinada'
      else first_step->>'levelName'
    end,
    'centerCount',client_count,
    'stepCount',step_count,
    'reason',case when route_source='MIXED'
      then'La solicitud requiere aprobaciones de más de una dimensión o configuración.'
      else first_step->>'reason'
    end,
    'steps',route_steps
  );
end
$$;

-- Conserva el contrato consumido por integraciones y pruebas anteriores.
create or replace function public.pr_resolve_up_approver(p_request_id bigint)
returns jsonb
language sql
security definer
set search_path=public,pg_temp
as $$
  select public.pr_resolve_payment_request_approver(p_request_id)
$$;

create or replace function public.wf_start_entity_without_budget(
  p_entity_type text,
  p_entity_id bigint,
  p_context jsonb default '{}'
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  document_data jsonb;
  workflow_row public.wf_workflows%rowtype;
  instance_row public.wf_instances%rowtype;
  rule_row public.wf_rules%rowtype;
  next_level integer;
  context_value jsonb;
  request_header public.solicitudes_pago%rowtype;
  route jsonb;
  route_steps jsonb:='[]'::jsonb;
  route_step jsonb;
  expected_version integer;
  route_user bigint;
  route_role bigint;
  route_label text;
  route_level integer:=0;
  dynamic_route boolean:=false;
begin
  document_data:=public.wf_entity_data(p_entity_type,p_entity_id);
  if(document_data->>'subsidiaryId')::bigint<>public.active_subsidiary_id()then
    raise exception 'Documento fuera de la subsidiaria activa.';
  end if;
  context_value:=document_data||coalesce(p_context,'{}'::jsonb);

  if p_entity_type='PAYMENT_REQUEST' then
    select * into request_header
      from public.solicitudes_pago
     where id=p_entity_id
       and id_subsidiaria=public.active_subsidiary_id()
     for update;
    if request_header.id is null then raise exception 'Solicitud no encontrada.';end if;
    expected_version:=nullif(p_context->>'requestVersion','')::integer;
    if expected_version is not null
       and request_header.version is distinct from expected_version then
      raise exception
        'La solicitud cambió después de pedir la aprobación presupuestaria. Envíela nuevamente.';
    end if;
    if request_header.estado not in('BORRADOR','RECHAZADO')
       or(
         request_header.id_solicitante<>public.app_user_id()
         and not public.app_is_admin()
       )then
      raise exception 'No puede enviar esta solicitud a aprobación.';
    end if;

    perform public.pr_validate(request_header.id);
    route:=public.pr_resolve_payment_request_approver(request_header.id);
    route_user:=nullif(route->>'approverId','')::bigint;
    route_role:=nullif(route->>'roleId','')::bigint;
    route_label:=coalesce(nullif(route->>'levelName',''),'Aprobación');
    route_steps:=coalesce(route->'steps','[]'::jsonb);
    dynamic_route:=coalesce((route->>'dynamic')::boolean,false);

    update public.solicitudes_pago set
      assigned_approver_id=route_user,
      approval_route_source=route->>'source',
      approval_routed_at=now(),
      version=version+1,
      updated_at=now()
    where id=request_header.id;

    context_value:=context_value||jsonb_build_object(
      'approvalRoute',route->>'source',
      'assignedApproverId',route->'approverId',
      'assignedRoleId',route->'roleId',
      'approvalSteps',route_steps,
      'approvalReason',route->>'reason'
    );
  end if;

  select * into instance_row
    from public.wf_instances
   where entity_type=p_entity_type and entity_id=p_entity_id
   for update;
  if found and instance_row.status not in('BORRADOR','RECHAZADO','CANCELADO')then
    if p_entity_type='PAYMENT_REQUEST' then
      raise exception 'La solicitud ya tiene un flujo de aprobación vigente.';
    end if;
    return jsonb_build_object('id',instance_row.id,'status',instance_row.status);
  end if;
  if found then delete from public.wf_instances where id=instance_row.id;end if;

  if p_entity_type='PAYMENT_REQUEST' and dynamic_route then
    if jsonb_typeof(route_steps)<>'array'
       or jsonb_array_length(route_steps)=0 then
      raise exception 'La ruta de aprobación calculada no contiene niveles válidos.';
    end if;
    insert into public.wf_instances(
      workflow_id,subsidiaria_id,entity_type,entity_id,amount,
      approval_context,current_level,status,requested_by
    )values(
      null,public.active_subsidiary_id(),p_entity_type,p_entity_id,
      (document_data->>'amount')::numeric,context_value,1,'EN_REVISION',
      public.app_user_id()
    )returning * into instance_row;
    route_level:=0;
    for route_step in
      select value from jsonb_array_elements(route_steps)
    loop
      route_user:=nullif(route_step->>'approverId','')::bigint;
      route_role:=nullif(route_step->>'roleId','')::bigint;
      if(route_user is null)=(route_role is null)then
        raise exception 'Un nivel de la ruta no identifica un usuario o rol válido.';
      end if;
      route_level:=route_level+1;
      insert into public.wf_instance_steps(
        instance_id,nivel,nombre_nivel,rol_aprobador_id,
        usuario_aprobador_id,politica,required_count
      )values(
        instance_row.id,route_level,
        coalesce(nullif(route_step->>'levelName',''),'Aprobación'),
        route_role,route_user,'CUALQUIERA',1
      );
    end loop;
    perform public.wf_apply_entity_status(
      p_entity_type,p_entity_id,'PENDIENTE_APROBACION'
    );
    perform public.wf_notify_level(instance_row.id);
    insert into public.wf_historial_logs(
      instance_id,nivel,usuario_id,accion_tomada,comentario_motivo
    )values(
      instance_row.id,1,public.app_user_id(),'ENVIADO',
      'Solicitud enrutada: '||route_label
    );
    return jsonb_build_object(
      'id',instance_row.id,'status','EN_REVISION','currentLevel',1,
      'approvalRoute',route->>'source',
      'assignedApproverId',route->'approverId',
      'assignedRoleId',route->'roleId',
      'approvalRouteSource',route->>'source',
      'approvalSteps',route_steps,
      'approvalStepCount',route_level,
      'clientCostCenterCount',coalesce((route->>'centerCount')::integer,0)
    );
  end if;

  -- Los otros tipos documentales y Pago de CxP conservan los flujos genéricos.
  select * into workflow_row
    from public.wf_workflows
   where subsidiaria_id=public.active_subsidiary_id()
     and entity_type=p_entity_type
     and estado_activo
   order by id desc
   limit 1;
  if not found then
    raise exception 'No existe un flujo de aprobación activo para este tipo de documento.';
  end if;

  insert into public.wf_instances(
    workflow_id,subsidiaria_id,entity_type,entity_id,amount,
    approval_context,current_level,status,requested_by
  )values(
    workflow_row.id,public.active_subsidiary_id(),p_entity_type,p_entity_id,
    (document_data->>'amount')::numeric,context_value,1,
    'PENDIENTE_APROBACION',public.app_user_id()
  )returning * into instance_row;

  for rule_row in
    select * from public.wf_rules
     where workflow_id=workflow_row.id
       and(
         condicion_monto_min is null
         or(document_data->>'amount')::numeric>=condicion_monto_min
       )
       and(
         condicion_monto_max is null
         or(document_data->>'amount')::numeric<=condicion_monto_max
       )
       and(
         departamento_id is null
         or(context_value->>'departmentId')::bigint=departamento_id
       )
       and(
         centro_costo_id is null
         or(context_value->>'costCenterId')::bigint=centro_costo_id
       )
       and(
         porcentaje_descuento_min is null
         or coalesce((context_value->>'discountPercent')::numeric,0)
            >porcentaje_descuento_min
       )
       and(
         tipo_desembolso is null
         or context_value->>'paymentType'=tipo_desembolso
       )
     order by nivel
  loop
    insert into public.wf_instance_steps(
      instance_id,nivel,nombre_nivel,rol_aprobador_id,
      usuario_aprobador_id,politica,required_count
    )values(
      instance_row.id,rule_row.nivel,rule_row.nombre_nivel,
      rule_row.rol_aprobador_id,rule_row.usuario_aprobador_id,
      rule_row.politica,
      case
        when rule_row.politica='TODOS'
         and rule_row.rol_aprobador_id is not null then greatest((
          select count(*)
            from public.user_roles membership
            join public.users account using(user_id)
           where membership.role_id=rule_row.rol_aprobador_id
             and account.is_active
        ),1)
        else 1
      end
    );
  end loop;

  select min(nivel) into next_level
    from public.wf_instance_steps
   where instance_id=instance_row.id;
  if next_level is null then
    update public.wf_instances set
      status='APROBADO',current_level=null,completed_at=now()
    where id=instance_row.id;
    perform public.wf_apply_entity_status(p_entity_type,p_entity_id,'APROBADO');
  else
    update public.wf_instances set
      current_level=next_level,status='EN_REVISION'
    where id=instance_row.id;
    perform public.wf_apply_entity_status(
      p_entity_type,p_entity_id,'PENDIENTE_APROBACION'
    );
    perform public.wf_notify_level(instance_row.id);
  end if;
  insert into public.wf_historial_logs(
    instance_id,nivel,usuario_id,accion_tomada,comentario_motivo
  )values(
    instance_row.id,next_level,public.app_user_id(),'ENVIADO',
    'Documento enviado a aprobación'
  );
  return jsonb_build_object(
    'id',instance_row.id,'status',(
      select status from public.wf_instances where id=instance_row.id
    ),'currentLevel',next_level
  );
end
$$;

-- Mantiene el encabezado alineado con el nivel vigente de las rutas dinámicas
-- de Solicitudes de Pago. No modifica flujos genéricos ni otros documentos.
create or replace function public.pr_sync_dynamic_current_approver()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  current_approver bigint;
begin
  if new.entity_type='PAYMENT_REQUEST' and new.workflow_id is null then
    if new.status='EN_REVISION'
       and new.current_level is not null
       and(
         new.current_level is distinct from old.current_level
         or new.status is distinct from old.status
       )then
      select step.usuario_aprobador_id into current_approver
      from public.wf_instance_steps step
      where step.instance_id=new.id
        and step.nivel=new.current_level;

      if current_approver is not null then
        update public.solicitudes_pago
        set assigned_approver_id=current_approver,
            updated_at=now()
        where id=new.entity_id
          and assigned_approver_id is distinct from current_approver;
      end if;
    elsif new.status in('APROBADO','RECHAZADO','CANCELADO')
       and new.status is distinct from old.status then
      update public.solicitudes_pago
      set assigned_approver_id=null,
          updated_at=now()
      where id=new.entity_id
        and assigned_approver_id is not null;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists pr_sync_dynamic_current_approver_trigger
on public.wf_instances;
create trigger pr_sync_dynamic_current_approver_trigger
after update of current_level,status on public.wf_instances
for each row execute function public.pr_sync_dynamic_current_approver();

comment on function public.pr_resolve_payment_request_approver(bigint) is
  'Agencia Tributaria domina; las demás líneas generan niveles UP y Administrativos secuenciales, deduplicados por usuario.';

revoke all on function
  public.pr_payment_request_admin_route(bigint,text),
  public.pr_resolve_payment_request_approver(bigint),
  public.pr_resolve_up_approver(bigint),
  public.wf_start_entity_without_budget(text,bigint,jsonb),
  public.pr_sync_dynamic_current_approver()
from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
