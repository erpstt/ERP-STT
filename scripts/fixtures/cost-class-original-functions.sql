CREATE OR REPLACE FUNCTION public.assign_customer_cost_center_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare customer_name text;customer_prefix text;next_number integer;
begin
 if new.cost_center_type='INTERNO'then
  new.customer_id:=null;new.up_approver_id:=null;
  if tg_op='UPDATE'and old.cost_center_type='INTERNO'and new.subsidiary_id=old.subsidiary_id then
   new.code:=old.code;return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cost-center-internal:'||new.subsidiary_id,0));
  select coalesce(max((regexp_match(cc.code,'-([0-9]+)$'))[1]::integer),0)+1 into next_number
    from public.cost_centers cc
   where cc.subsidiary_id=new.subsidiary_id and cc.cost_center_type='INTERNO';
  new.code:='INT-'||lpad(new.subsidiary_id::text,4,'0')||'-'||lpad(next_number::text,4,'0');
  return new;
 end if;
 if new.customer_id is null then raise exception 'Debe seleccionar un cliente para el centro de costos tipo CLIENTE.';end if;
 if not exists(
  select 1 from public.entity_subsidiaries e
   where e.customer_id=new.customer_id and e.subsidiary_id=new.subsidiary_id
 )then raise exception 'El cliente seleccionado no pertenece a la subsidiaria indicada.';end if;
 if tg_op='UPDATE'and old.cost_center_type='CLIENTE'
    and new.customer_id=old.customer_id and new.subsidiary_id=old.subsidiary_id then
  new.code:=old.code;return new;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('cost-center-customer:'||new.customer_id,0));
 select c.company_name into customer_name from public.customers c where c.customer_id=new.customer_id;
 customer_prefix:=upper(left(regexp_replace(coalesce(customer_name,''),'[^[:alnum:]]','','g'),4));
 if customer_prefix=''then customer_prefix:='CLI';end if;
 select coalesce(max((regexp_match(cc.code,'-([0-9]+)$'))[1]::integer),0)+1 into next_number
   from public.cost_centers cc where cc.customer_id=new.customer_id;
 new.code:=customer_prefix||'-'||lpad(next_number::text,4,'0');
 return new;
end$function$;
CREATE OR REPLACE FUNCTION public.up_approver_access(p_permission text)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=public.active_subsidiary_id();
begin
 if public.app_user_id()is null or sid is null or not exists(
  select 1 from public.user_subsidiaries
   where user_id=public.app_user_id()and subsidiary_id=sid
 )then raise exception using errcode='42501',message='No tiene acceso a la subsidiaria activa.';end if;
 if not public.up_approver_has_permission(p_permission)then
  raise exception using errcode='42501',message=case p_permission
   when'ORG_UP_APPROVER_MANAGE'then'No tiene permiso para administrar aprobadores UP.'
   else'No tiene permiso para consultar aprobadores UP.'end;
 end if;
 return sid;
end$function$;
CREATE OR REPLACE FUNCTION public.validate_up_approver_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare chosen bigint;sid bigint;changed boolean;actor_sid bigint;
begin
 if tg_table_name='cost_centers'then
  sid:=new.subsidiary_id;chosen:=new.up_approver_id;
  if new.cost_center_type='INTERNO'then new.up_approver_id:=null;chosen:=null;end if;
  changed:=tg_op='INSERT'and chosen is not null
    or tg_op='UPDATE'and(
      chosen is distinct from old.up_approver_id
      or new.cost_center_type is distinct from old.cost_center_type
      or new.subsidiary_id is distinct from old.subsidiary_id
    );
 else
  sid:=new.subsidiary_id;chosen:=new.default_up_approver_id;
  changed:=tg_op='INSERT'and chosen is not null
    or tg_op='UPDATE'and chosen is distinct from old.default_up_approver_id;
 end if;
 if changed and public.app_user_id()is not null then
  actor_sid:=public.active_subsidiary_id();
  if tg_table_name='subsidiaries'and tg_op='INSERT'then
   if not public.app_is_admin()then
    raise exception using errcode='42501',message='Solo un administrador puede configurar el aprobador UP de una nueva subsidiaria.';
   end if;
  elsif sid is distinct from actor_sid
    or not exists(select 1 from public.user_subsidiaries us
      where us.user_id=public.app_user_id()and us.subsidiary_id=sid)
    or(tg_table_name='cost_centers'and tg_op='UPDATE'and old.subsidiary_id is distinct from actor_sid)then
   raise exception using errcode='42501',message='Solo puede configurar aprobadores UP en la subsidiaria activa.';
  end if;
  if not public.up_approver_has_permission('ORG_UP_APPROVER_MANAGE')then
   raise exception using errcode='42501',message='No tiene permiso para configurar aprobadores UP.';
  end if;
 end if;
 if chosen is not null and not exists(
  select 1 from public.users u join public.user_subsidiaries us using(user_id)
   where u.user_id=chosen and u.is_active and us.subsidiary_id=sid
 )then raise exception 'El aprobador UP debe ser un usuario activo con acceso a la subsidiaria.';end if;
 return new;
end$function$;
CREATE OR REPLACE FUNCTION public.up_reassign_cost_centers(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=public.up_approver_access('ORG_UP_APPROVER_MANAGE');current_id bigint;new_id bigint;
 reassign_all boolean;requested_ids bigint[];locked_ids bigint[];expected integer;audit_id bigint;
begin
 current_id:=nullif(p->>'current_approver_id','')::bigint;
 new_id:=nullif(p->>'new_approver_id','')::bigint;
 reassign_all:=coalesce((p->>'reassign_all')::boolean,false);
 if nullif(p->>'subsidiary_id','')::bigint is distinct from sid then
  raise exception using errcode='42501',message='La reasignación solo puede realizarse en la subsidiaria activa.';
 end if;
 if current_id is null or new_id is null then raise exception 'Seleccione el aprobador actual y el nuevo aprobador.';end if;
 if current_id=new_id then raise exception 'El nuevo aprobador debe ser diferente del aprobador actual.';end if;
 if not exists(select 1 from public.users u join public.user_subsidiaries us using(user_id)
   where u.user_id=new_id and u.is_active and us.subsidiary_id=sid)then
  raise exception 'El nuevo aprobador debe ser un usuario activo con acceso a la subsidiaria.';
 end if;
 if reassign_all then
  select array_agg(cost_center_id order by cost_center_id)into locked_ids
   from(select cost_center_id from public.cost_centers
    where subsidiary_id=sid and cost_center_type='CLIENTE'and up_approver_id=current_id
    order by cost_center_id for update)q;
 else
  select coalesce(array_agg(distinct value::bigint),'{}'::bigint[])into requested_ids
   from jsonb_array_elements_text(coalesce(p->'cost_center_ids','[]'::jsonb));
  expected:=coalesce(cardinality(requested_ids),0);
  if expected=0 then raise exception 'Seleccione al menos un centro de costos.';end if;
  select array_agg(cost_center_id order by cost_center_id)into locked_ids
   from(select cost_center_id from public.cost_centers
    where subsidiary_id=sid and cost_center_type='CLIENTE'and up_approver_id=current_id
      and cost_center_id=any(requested_ids)
    order by cost_center_id for update)q;
  if coalesce(cardinality(locked_ids),0)<>expected then
   raise exception 'Uno o más centros cambiaron desde la consulta. Actualice la lista antes de confirmar.';
  end if;
 end if;
 if coalesce(cardinality(locked_ids),0)=0 then raise exception 'No hay centros de costos para reasignar.';end if;
 update public.cost_centers set up_approver_id=new_id where cost_center_id=any(locked_ids);
 insert into public.cost_center_up_approver_audit(
  subsidiary_id,previous_approver_id,new_approver_id,scope,affected_count,cost_center_ids,changed_by
 )values(sid,current_id,new_id,case when reassign_all then'ALL'else'SELECTED'end,
  cardinality(locked_ids),to_jsonb(locked_ids),public.app_user_id())returning id into audit_id;
 return jsonb_build_object('updatedCount',cardinality(locked_ids),'auditId',audit_id,
  'message',cardinality(locked_ids)||' centro(s) de costos fueron reasignados correctamente.');
end$function$;
CREATE OR REPLACE FUNCTION public.validate_cost_center_department()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  customer_department bigint;
  department_type text;
  department_inactive boolean;
begin
  if upper(coalesce(new.cost_center_type,''))='CLIENTE' then
    select customer.department_id into customer_department
    from public.customers customer
    where customer.customer_id=new.customer_id;

    if customer_department is null then
      raise exception
        'El cliente del centro de costos debe tener un departamento asignado.';
    end if;
    if new.department_id is null then
      new.department_id:=customer_department;
    elsif new.department_id is distinct from customer_department then
      raise exception
        'El departamento del centro de costos debe coincidir con el departamento del cliente.';
    end if;
  elsif upper(coalesce(new.cost_center_type,''))='INTERNO' then
    if new.department_id is null then
      raise exception
        'Seleccione el departamento del centro de costos interno.';
    end if;
  else
    raise exception 'El tipo de centro de costos no es valido.';
  end if;

  select department.type,department.is_inactive
    into department_type,department_inactive
  from public.departments department
  where department.department_id=new.department_id
    and(
      department.subsidiary_id=new.subsidiary_id
      or exists(
        select 1 from public.department_subsidiaries scope
        where scope.department_id=department.department_id
          and scope.subsidiary_id=new.subsidiary_id
      )
    );

  if department_type is null or department_inactive then
    raise exception
      'El departamento del centro de costos no esta activo o no pertenece a la subsidiaria.';
  end if;
  if lower(department_type)<>lower(new.cost_center_type) then
    raise exception
      'El tipo del departamento no coincide con el tipo del centro de costos.';
  end if;
  return new;
end
$function$;
CREATE OR REPLACE FUNCTION public.sync_customer_cost_center_department()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.department_id is distinct from old.department_id then
    update public.cost_centers center
    set department_id=new.department_id
    where center.customer_id=new.customer_id
      and upper(center.cost_center_type)='CLIENTE'
      and center.department_id is distinct from new.department_id;
  end if;
  return new;
end
$function$;
CREATE OR REPLACE FUNCTION public.validate_cost_center_class()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.class_id is not null and not exists(
    select 1 from public.class_subsidiaries cs
    where cs.class_id=new.class_id and cs.subsidiary_id=new.subsidiary_id
  ) then
    raise exception 'La clase seleccionada no pertenece a la subsidiaria del centro de costos.';
  end if;
  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.up_approver_has_permission(p_code text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select public.app_is_admin()or exists(
  select 1 from public.role_permissions rp join public.permissions p using(permission_id)
   where rp.role_id=public.app_active_role_id()and p.code=p_code
 )
$function$;
CREATE OR REPLACE FUNCTION public.up_approver_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=public.up_approver_access('ORG_UP_APPROVER_VIEW');
begin
 return jsonb_build_object(
  'subsidiary',(select jsonb_build_object('id',subsidiary_id,'name',name)from public.subsidiaries where subsidiary_id=sid),
  'permissions',jsonb_build_object('view',true,'manage',public.up_approver_has_permission('ORG_UP_APPROVER_MANAGE')),
  'users',coalesce((select jsonb_agg(jsonb_build_object(
    'id',u.user_id,'name',trim(concat_ws(' ',u.first_name,u.last_name)),
    'email',u.email,'isActive',u.is_active
  )order by u.first_name,u.last_name,u.email)
   from public.users u join public.user_subsidiaries us using(user_id)
   where us.subsidiary_id=sid and(u.is_active or exists(
    select 1 from public.cost_centers cc where cc.subsidiary_id=sid and cc.up_approver_id=u.user_id
   ))),'[]'::jsonb),
  'summary',jsonb_build_object(
   'clientCenters',(select count(*)from public.cost_centers where subsidiary_id=sid and cost_center_type='CLIENTE'),
   'assignedCenters',(select count(*)from public.cost_centers where subsidiary_id=sid and cost_center_type='CLIENTE'and up_approver_id is not null),
   'unassignedCenters',(select count(*)from public.cost_centers where subsidiary_id=sid and cost_center_type='CLIENTE'and up_approver_id is null)
  )
 );
end$function$;
CREATE OR REPLACE FUNCTION public.up_cost_centers_by_approver(p_approver_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=public.up_approver_access('ORG_UP_APPROVER_VIEW');items jsonb;
begin
 if p_approver_id is null then raise exception 'Seleccione el aprobador UP actual.';end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',cc.cost_center_id,'code',cc.code,'name',cc.name,
  'subsidiaryId',cc.subsidiary_id,'subsidiaryName',s.name,
  'type',cc.cost_center_type,'isInactive',cc.is_inactive,
  'approverId',cc.up_approver_id,
  'approverName',trim(concat_ws(' ',u.first_name,u.last_name))
 )order by cc.code,cc.name),'[]'::jsonb)into items
 from public.cost_centers cc join public.subsidiaries s using(subsidiary_id)
 join public.users u on u.user_id=cc.up_approver_id
 where cc.subsidiary_id=sid and cc.cost_center_type='CLIENTE'
   and cc.up_approver_id=p_approver_id;
 return jsonb_build_object('items',items,'total',jsonb_array_length(items));
end$function$;
CREATE OR REPLACE FUNCTION public.up_approver_selector_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=public.active_subsidiary_id();
begin
 if public.app_user_id()is null or sid is null or not exists(
  select 1 from public.user_subsidiaries us
   where us.user_id=public.app_user_id()and us.subsidiary_id=sid
 )then raise exception using errcode='42501',message='No tiene acceso a la subsidiaria activa.';end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
  'id',u.user_id,'name',coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email),
  'email',u.email,'isActive',u.is_active
 )order by u.first_name,u.last_name,u.email)
 from public.users u join public.user_subsidiaries us using(user_id)
 where us.subsidiary_id=sid and u.is_active),'[]'::jsonb);
end$function$;
