-- Otros pagos: the configured Administrative Approver follows all UP levels.
-- The explicitly requested backfill extends only requests still waiting at UP.
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Serialize the short policy cutover with submissions and approval decisions.
lock table public.solicitudes_pago,public.wf_instances,public.wf_instance_steps in exclusive mode;

create function payment_request_private.pr_up_administrative_approval_step(p_subsidiary_id bigint)
returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public,pg_temp as $function$
declare administrative_value text;resolved_user bigint;
begin
  select administrative_approver into administrative_value
    from public.subsidiaries where subsidiary_id=p_subsidiary_id for share;
  begin
    if administrative_value~'^user:[1-9][0-9]{0,18}$' then
      resolved_user:=split_part(administrative_value,':',2)::bigint;
    elsif administrative_value~'^employee:[1-9][0-9]{0,18}$' then
      select employee.user_id into resolved_user from public.employees employee
       where employee.employee_id=split_part(administrative_value,':',2)::bigint
         and employee.subsidiary_id=p_subsidiary_id and employee.is_active;
    end if;
  exception when numeric_value_out_of_range then resolved_user:=null;
  end;
  if resolved_user is null or not exists(
    select 1 from public.users account join public.user_subsidiaries scope using(user_id)
     where account.user_id=resolved_user and account.is_active and scope.subsidiary_id=p_subsidiary_id
       and exists(
         select 1 from public.user_roles membership join public.roles role on role.role_id=membership.role_id
          where membership.user_id=account.user_id and(
            lower(role.role_name)in('administrador','administrator','admin')
            or exists(select 1 from public.role_access_matrix access
                       where access.role_id=membership.role_id and access.can_view
                         and access.resource_key in('treasury:payment-requests','accounting:payment-requests'))
          )
       )
  )then
    raise exception using errcode='PRA01',
      message='Configure un Aprobador Administrativo activo y autorizado en la subsidiaria antes de enviar la solicitud.';
  end if;
  return jsonb_build_object('approverId',resolved_user,'roleId',null,
    'source','ADMINISTRATIVE','levelName','Aprobación administrativa',
    'reason','Aprobación administrativa posterior a Proyectos (UP).');
end
$function$;
revoke all on function payment_request_private.pr_up_administrative_approval_step(bigint) from public,anon,authenticated,service_role;

do $migration$
declare target regprocedure:='payment_request_private.pr_resolve_payment_request_approver(bigint)'::regprocedure;
  definition text;needle text;replacement text;
begin
  if(select md5(prosrc)from pg_proc where oid=target)is distinct from '69cba36f2552d27d1aeb28995adf93d4' then
    raise exception 'Unexpected payment request approval resolver source';
  end if;
  -- The recipient check follows the same published admin/view oracles as CxP.
  if(select md5(prosrc)from pg_proc where oid='public.app_is_admin()'::regprocedure)
      is distinct from '0b30cad8c0f3f8faf96823c18883505f'
    or(select md5(prosrc)from pg_proc where oid='public.security_assert_role_access(text,text)'::regprocedure)
      is distinct from 'df2f76788809016bdedd1bdd7195e944' then
    raise exception 'Unexpected approval role-view oracle source';
  end if;
  definition:=pg_get_functiondef(target);
  -- A valid UP must not disappear because an earlier fallback uses that user.
  needle:=$old$    order by id_centro_costo nulls first$old$;
  replacement:=$new$    order by case when direct_is_valid or default_is_valid then 0 else 1 end,
      id_centro_costo nulls first$new$;
  if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'Unexpected UP candidate ordering';
  end if;
  definition:=replace(definition,needle,replacement);
  -- With UP, the mandatory final step also covers internal lines. Preserve the
  -- existing internal/fallback behavior for routes without a valid UP.
  needle:=$old$  if has_internal then$old$;
  replacement:=$new$  if has_internal and direct_count=0 and fallback_count=0 then$new$;
  if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'Unexpected internal approval branch';
  end if;
  definition:=replace(definition,needle,replacement);
  needle:=$old$  if step_count=0 then$old$;
  replacement:=$new$  if direct_count>0 or fallback_count>0 then
    -- Do not deduplicate against UP users: the two responsibilities require
    -- separate decisions even when the configured person is the same.
    route_steps:=route_steps||jsonb_build_array(
      payment_request_private.pr_up_administrative_approval_step(header_row.id_subsidiaria)
    );
    step_count:=jsonb_array_length(route_steps);
  end if;

  if step_count=0 then$new$;
  if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'Unexpected approval completion branch';
  end if;
  execute replace(definition,needle,replacement);
end
$migration$;

do $backfill$
declare candidate record;last_step public.wf_instance_steps;admin_step jsonb;
  existing_steps jsonb;step_count integer;next_level integer;
begin
  for candidate in
    select r.id as request_id,i.id as instance_id,i.subsidiaria_id,i.approval_context
      from public.solicitudes_pago r
      join public.wf_instances i on i.entity_type='PAYMENT_REQUEST' and i.entity_id=r.id
        and i.subsidiaria_id=r.id_subsidiaria
      join public.wf_instance_steps s on s.instance_id=i.id and s.nivel=i.current_level
     where r.tipo_solicitud='OTROS' and r.estado='PENDIENTE_APROBACION'
       and i.workflow_id is null and i.status='EN_REVISION' and s.status='PENDIENTE'
       and(s.nombre_nivel='Aprobación Proyectos (UP)'
         or i.approval_context->'approvalSteps'->(s.nivel-1)->>'source' in('COST_CENTER','SUBSIDIARY'))
     order by r.id for update of r,i,s
  loop
    select *into strict last_step from public.wf_instance_steps
     where instance_id=candidate.instance_id order by nivel desc limit 1;
    -- A previously copied administrative step remains assigned to its original
    -- person; a later company configuration change must not reroute it.
    if last_step.status='PENDIENTE' and last_step.usuario_aprobador_id is not null
       and(last_step.nombre_nivel='Aprobación administrativa'
         or candidate.approval_context->'approvalSteps'->(last_step.nivel-1)->>'source'='ADMINISTRATIVE') then
      continue;
    end if;
    admin_step:=payment_request_private.pr_up_administrative_approval_step(candidate.subsidiaria_id);
    select count(*)::integer,max(nivel)+1 into step_count,next_level
      from public.wf_instance_steps where instance_id=candidate.instance_id;
    if next_level<>step_count+1 then raise exception 'Unexpected non-sequential approval levels';end if;
    if candidate.approval_context->'approvalSteps' is null
       or candidate.approval_context->'approvalSteps'='null'::jsonb then
      -- Legacy UP instances predate the copied approvalSteps array.
      select jsonb_agg(jsonb_build_object('approverId',s.usuario_aprobador_id,
        'roleId',s.rol_aprobador_id,'source',case when s.nombre_nivel='Aprobación Proyectos (UP)'
          then'LEGACY_UP'else'LEGACY'end,'levelName',s.nombre_nivel,
        'reason','Ruta de aprobación existente.')order by s.nivel)
        into existing_steps from public.wf_instance_steps s where s.instance_id=candidate.instance_id;
    elsif jsonb_typeof(candidate.approval_context->'approvalSteps')='array'
       and jsonb_array_length(candidate.approval_context->'approvalSteps')=step_count then
      existing_steps:=candidate.approval_context->'approvalSteps';
    else raise exception 'Unexpected copied approval route';end if;
    insert into public.wf_instance_steps(instance_id,nivel,nombre_nivel,
      usuario_aprobador_id,rol_aprobador_id,politica,required_count,status)
    values(candidate.instance_id,next_level,admin_step->>'levelName',
      (admin_step->>'approverId')::bigint,null,'CUALQUIERA',1,'PENDIENTE');
    update public.wf_instances set approval_context=approval_context||jsonb_build_object(
      'approvalSteps',existing_steps||jsonb_build_array(admin_step),'approvalRoute','MIXED',
      'approvalReason','Proyectos (UP), seguido de la aprobación administrativa.'),updated_at=now()
      where id=candidate.instance_id;
    update public.solicitudes_pago set approval_route_source='MIXED',version=version+1,updated_at=now()
      where id=candidate.request_id;
    insert into public.wf_historial_logs(instance_id,nivel,usuario_id,accion_tomada,comentario_motivo)
      values(candidate.instance_id,next_level,null,'RUTA_ACTUALIZADA',
        'Se agregó la aprobación administrativa posterior a Proyectos (UP) a la solicitud pendiente.');
    -- wf_act will notify the Administrative Approver when this level becomes
    -- current. Do not send notifications or advance the pending UP here.
  end loop;
end
$backfill$;
notify pgrst,'reload schema';
