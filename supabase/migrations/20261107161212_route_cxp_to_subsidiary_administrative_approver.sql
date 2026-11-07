-- New CxP submissions use the subsidiary's current administrative approver.
-- Existing instances, their copied steps, and configured standard workflows are untouched.
set local lock_timeout='5s';
set local statement_timeout='60s';

do $migration$
declare
  target regprocedure:='payment_request_private.pr_resolve_payment_request_approver(bigint)'::regprocedure;
  definition text;
  needle text:=$old$  if header_row.tipo_solicitud<>'OTROS' then
    return jsonb_build_object(
      'dynamic',false,'approverId',null,'roleId',null,
      'source','STANDARD','levelName',null,'centerCount',0,
      'steps','[]'::jsonb
    );
  end if;$old$;
  replacement text:=$new$  if header_row.tipo_solicitud='CXP' then
    -- Snapshot only the explicit configuration for this company. No generic
    -- administrator fallback and no role/name lookup may replace that choice.
    select * into strict subsidiary_row
      from public.subsidiaries
     where subsidiary_id=header_row.id_subsidiaria
     for share;
    administrative_value:=subsidiary_row.administrative_approver;
    resolved_user:=null;
    begin
      if administrative_value~'^user:[1-9][0-9]{0,18}$' then
        resolved_user:=split_part(administrative_value,':',2)::bigint;
      elsif administrative_value~'^employee:[1-9][0-9]{0,18}$' then
        select employee.user_id into resolved_user
          from public.employees employee
         where employee.employee_id=split_part(administrative_value,':',2)::bigint
           and employee.subsidiary_id=header_row.id_subsidiaria
           and employee.is_active;
      end if;
    exception when numeric_value_out_of_range then
      resolved_user:=null;
    end;

    if resolved_user is null or not exists(
      select 1 from public.users account
      join public.user_subsidiaries scope using(user_id)
      where account.user_id=resolved_user and account.is_active
        and scope.subsidiary_id=header_row.id_subsidiaria
        and exists(
          -- Declarative equivalent of the published role-view oracle. The
          -- chosen user must have an assigned role they can actually use.
          select 1 from public.user_roles membership
          join public.roles role on role.role_id=membership.role_id
          where membership.user_id=account.user_id
            and(
              lower(role.role_name)in('administrador','administrator','admin')
              or exists(
                select 1 from public.role_access_matrix access
                where access.role_id=membership.role_id and access.can_view
                  and access.resource_key in(
                    'treasury:payment-requests','accounting:payment-requests'
                  )
              )
            )
        )
    )then
      raise exception using errcode='PRA01',
        message='Configure un Aprobador Administrativo activo y autorizado en la subsidiaria antes de enviar la solicitud.';
    end if;

    return jsonb_build_object(
      'dynamic',true,'approverId',resolved_user,'roleId',null,
      'source','ADMINISTRATIVE','levelName','Aprobación administrativa',
      'centerCount',0,
      'reason','Aprobador Administrativo configurado en la subsidiaria para Pago de CxP.',
      'steps',jsonb_build_array(jsonb_build_object(
        'approverId',resolved_user,'roleId',null,'source','ADMINISTRATIVE',
        'levelName','Aprobación administrativa',
        'reason','Aprobador Administrativo configurado en la subsidiaria para Pago de CxP.'
      ))
    );
  end if;$new$;
begin
  if (select md5(prosrc) from pg_proc where oid=target)
       is distinct from '970bc6f38da922670b44664760658212' then
    raise exception 'Unexpected CxP approval resolver source';
  end if;
  -- Match the published admin/view oracle used declaratively above. No JWT,
  -- active role, session context, grant, or identity is substituted here.
  if (select md5(prosrc) from pg_proc where oid='public.app_is_admin()'::regprocedure)
       is distinct from '0b30cad8c0f3f8faf96823c18883505f'
     or (select md5(prosrc) from pg_proc where oid='public.security_assert_role_access(text,text)'::regprocedure)
       is distinct from 'df2f76788809016bdedd1bdd7195e944' then
    raise exception 'Unexpected approval role-view oracle source';
  end if;
  definition:=pg_get_functiondef(target);
  if position(needle in definition)=0 then
    raise exception 'Missing original standard CxP routing branch';
  end if;
  execute replace(definition,needle,replacement);
end
$migration$;
notify pgrst,'reload schema';
