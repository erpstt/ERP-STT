begin;

alter table public.cost_centers
  add column if not exists cost_center_type text,
  add column if not exists up_approver_id bigint references public.users(user_id) on delete restrict;

update public.cost_centers
   set cost_center_type=case when customer_id is null then 'INTERNO' else 'CLIENTE' end
 where cost_center_type is null;

alter table public.cost_centers alter column cost_center_type set default 'CLIENTE';
alter table public.cost_centers alter column cost_center_type set not null;
alter table public.cost_centers drop constraint if exists cost_centers_cost_center_type_check;
alter table public.cost_centers add constraint cost_centers_cost_center_type_check
  check(cost_center_type in('CLIENTE','INTERNO'));

alter table public.subsidiaries
  add column if not exists default_up_approver_id bigint references public.users(user_id) on delete restrict;

-- Normalize the existing textual "Aprobador Proyectos (UP)" when it points to an ERP user.
update public.subsidiaries s
   set default_up_approver_id=split_part(s.project_approver,':',2)::bigint
 where s.default_up_approver_id is null
   and s.project_approver~'^user:[1-9][0-9]*$'
   and exists(
     select 1 from public.users u
     join public.user_subsidiaries us using(user_id)
     where u.user_id=split_part(s.project_approver,':',2)::bigint
       and us.subsidiary_id=s.subsidiary_id
   );

update public.subsidiaries s
   set default_up_approver_id=e.user_id
  from public.employees e
 where s.default_up_approver_id is null
   and s.project_approver~'^employee:[1-9][0-9]*$'
   and e.employee_id=split_part(s.project_approver,':',2)::bigint
   and e.user_id is not null
   and e.subsidiary_id=s.subsidiary_id;

alter table public.solicitudes_pago
  add column if not exists assigned_approver_id bigint references public.users(user_id) on delete restrict,
  add column if not exists approval_route_source text,
  add column if not exists approval_routed_at timestamptz;

alter table public.solicitudes_pago drop constraint if exists solicitudes_pago_approval_route_source_check;
alter table public.solicitudes_pago add constraint solicitudes_pago_approval_route_source_check
  check(approval_route_source is null or approval_route_source in('STANDARD','COST_CENTER','SUBSIDIARY','MIXED'));

create index if not exists cost_centers_up_approver_idx
  on public.cost_centers(subsidiary_id,cost_center_type,up_approver_id);
create index if not exists subsidiaries_default_up_approver_idx
  on public.subsidiaries(default_up_approver_id) where default_up_approver_id is not null;
create index if not exists payment_requests_assigned_approver_idx
  on public.solicitudes_pago(id_subsidiaria,assigned_approver_id,estado)
  where assigned_approver_id is not null;

-- Replace the original catalog-wide policies for the two affected masters.
-- Cost centers are always scoped to the active company.  Subsidiaries remain
-- visible to their assigned users, while administrators retain catalog setup.
alter table public.cost_centers enable row level security;
drop policy if exists organization_select on public.cost_centers;
drop policy if exists organization_insert on public.cost_centers;
drop policy if exists organization_update on public.cost_centers;
drop policy if exists organization_delete on public.cost_centers;
drop policy if exists company_select on public.cost_centers;
drop policy if exists company_insert on public.cost_centers;
drop policy if exists company_update on public.cost_centers;
drop policy if exists company_delete on public.cost_centers;
create policy organization_select on public.cost_centers for select to authenticated
 using(subsidiary_id=public.active_subsidiary_id()and exists(
  select 1 from public.user_subsidiaries us
   where us.user_id=public.app_user_id()and us.subsidiary_id=cost_centers.subsidiary_id
 ));
create policy organization_insert on public.cost_centers for insert to authenticated
 with check(subsidiary_id=public.active_subsidiary_id()and exists(
  select 1 from public.user_subsidiaries us
   where us.user_id=public.app_user_id()and us.subsidiary_id=cost_centers.subsidiary_id
 ));
create policy organization_update on public.cost_centers for update to authenticated
 using(subsidiary_id=public.active_subsidiary_id()and exists(
  select 1 from public.user_subsidiaries us
   where us.user_id=public.app_user_id()and us.subsidiary_id=cost_centers.subsidiary_id
 ))with check(subsidiary_id=public.active_subsidiary_id()and exists(
  select 1 from public.user_subsidiaries us
   where us.user_id=public.app_user_id()and us.subsidiary_id=cost_centers.subsidiary_id
 ));
create policy organization_delete on public.cost_centers for delete to authenticated
 using(subsidiary_id=public.active_subsidiary_id()and exists(
  select 1 from public.user_subsidiaries us
   where us.user_id=public.app_user_id()and us.subsidiary_id=cost_centers.subsidiary_id
 ));

alter table public.subsidiaries enable row level security;
drop policy if exists organization_select on public.subsidiaries;
drop policy if exists organization_insert on public.subsidiaries;
drop policy if exists organization_update on public.subsidiaries;
drop policy if exists organization_delete on public.subsidiaries;
drop policy if exists company_select on public.subsidiaries;
drop policy if exists company_insert on public.subsidiaries;
drop policy if exists company_update on public.subsidiaries;
drop policy if exists company_delete on public.subsidiaries;
create policy organization_select on public.subsidiaries for select to authenticated
 using(public.app_is_admin()or exists(
  select 1 from public.user_subsidiaries us
   where us.user_id=public.app_user_id()and us.subsidiary_id=subsidiaries.subsidiary_id
 ));
create policy organization_insert on public.subsidiaries for insert to authenticated
 with check(public.app_is_admin());
create policy organization_update on public.subsidiaries for update to authenticated
 using(public.app_is_admin()or exists(
  select 1 from public.user_subsidiaries us
   where us.user_id=public.app_user_id()and us.subsidiary_id=subsidiaries.subsidiary_id
 ))with check(public.app_is_admin()or exists(
  select 1 from public.user_subsidiaries us
   where us.user_id=public.app_user_id()and us.subsidiary_id=subsidiaries.subsidiary_id
 ));
create policy organization_delete on public.subsidiaries for delete to authenticated
 using(public.app_is_admin());

insert into public.permissions(code,module,description) values
 ('ORG_UP_APPROVER_VIEW','Organización','Consultar centros de costo y asignaciones de aprobadores UP'),
 ('ORG_UP_APPROVER_MANAGE','Organización','Configurar y reasignar aprobadores UP')
on conflict(code)do update set module=excluded.module,description=excluded.description;

insert into public.role_permissions(role_id,permission_id)
select r.role_id,p.permission_id
  from public.roles r cross join public.permissions p
 where p.code in('ORG_UP_APPROVER_VIEW','ORG_UP_APPROVER_MANAGE')
   and lower(r.role_name) in('administrador','administrator','admin')
on conflict do nothing;

create table if not exists public.cost_center_up_approver_audit(
  id bigint generated always as identity primary key,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete restrict,
  previous_approver_id bigint not null references public.users(user_id) on delete restrict,
  new_approver_id bigint not null references public.users(user_id) on delete restrict,
  scope text not null check(scope in('SELECTED','ALL')),
  affected_count integer not null check(affected_count>0),
  cost_center_ids jsonb not null,
  changed_by bigint not null references public.users(user_id) on delete restrict,
  changed_at timestamptz not null default now()
);
create index if not exists cost_center_up_audit_scope_idx
  on public.cost_center_up_approver_audit(subsidiary_id,changed_at desc);
alter table public.cost_center_up_approver_audit enable row level security;
drop policy if exists cost_center_up_audit_read on public.cost_center_up_approver_audit;
create policy cost_center_up_audit_read on public.cost_center_up_approver_audit
 for select to authenticated
 using(subsidiary_id=public.active_subsidiary_id());
revoke all on public.cost_center_up_approver_audit from public,anon,authenticated;
grant select on public.cost_center_up_approver_audit to authenticated;

create or replace function public.up_approver_has_permission(p_code text)returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select public.app_is_admin()or exists(
  select 1 from public.role_permissions rp join public.permissions p using(permission_id)
   where rp.role_id=public.app_active_role_id()and p.code=p_code
 )
$$;

-- Reading the reassignment history requires both company access and the
-- dedicated read permission.  Keep this policy next to the permission helper
-- so the rule cannot silently broaden access when the audit table is queried
-- directly through PostgREST.
drop policy if exists cost_center_up_audit_read on public.cost_center_up_approver_audit;
create policy cost_center_up_audit_read on public.cost_center_up_approver_audit
 for select to authenticated
 using(
  subsidiary_id=public.active_subsidiary_id()
  and public.up_approver_has_permission('ORG_UP_APPROVER_VIEW')
 );

create or replace function public.up_approver_access(p_permission text)returns bigint
language plpgsql stable security definer set search_path=public,pg_temp as $$
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
end$$;

create or replace function public.validate_up_approver_assignment()returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
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
end$$;

drop trigger if exists validate_cost_center_up_approver on public.cost_centers;
create trigger validate_cost_center_up_approver
before insert or update of cost_center_type,up_approver_id,subsidiary_id on public.cost_centers
for each row execute function public.validate_up_approver_assignment();
drop trigger if exists validate_subsidiary_default_up_approver on public.subsidiaries;
create trigger validate_subsidiary_default_up_approver
before insert or update of default_up_approver_id on public.subsidiaries
for each row execute function public.validate_up_approver_assignment();

-- CLIENTE keeps the customer numbering; INTERNO receives a stable company sequence.
create or replace function public.assign_customer_cost_center_code()returns trigger
language plpgsql set search_path=public,pg_temp as $$
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
end$$;

drop trigger if exists cost_center_auto_customer_code on public.cost_centers;
create trigger cost_center_auto_customer_code
before insert or update of customer_id,subsidiary_id,cost_center_type,code on public.cost_centers
for each row execute function public.assign_customer_cost_center_code();

create or replace function public.up_approver_options()returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
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
end$$;

-- Lightweight selector used by the regular subsidiary/cost-center forms.
-- Viewing the company user directory does not grant permission to assign an
-- approver; the validation trigger enforces ORG_UP_APPROVER_MANAGE on writes.
create or replace function public.up_approver_selector_options()returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
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
end$$;

create or replace function public.up_cost_centers_by_approver(p_approver_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
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
end$$;

create or replace function public.up_reassign_cost_centers(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
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
end$$;

create or replace function public.pr_resolve_up_approver(p_request_id bigint)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.solicitudes_pago%rowtype;resolved_count integer;resolved_user bigint;
 direct_count integer;fallback_count integer;client_count integer;missing_center text;
begin
 select*into h from public.solicitudes_pago where id=p_request_id and id_subsidiaria=public.active_subsidiary_id()for update;
 if h.id is null then raise exception 'Solicitud no encontrada.';end if;
 if h.tipo_solicitud<>'OTROS'then return jsonb_build_object('approverId',null,'source','STANDARD','centerCount',0);end if;
 if exists(select 1 from public.solicitudes_pago_lineas l join public.cost_centers cc on cc.cost_center_id=l.id_centro_costo
   where l.id_solicitud=h.id and cc.is_inactive)then raise exception 'La solicitud contiene un centro de costos inactivo.';end if;
 select count(*),count(*)filter(where cc.up_approver_id is not null),count(*)filter(where cc.up_approver_id is null)
 into client_count,direct_count,fallback_count
 from(select distinct l.id_centro_costo from public.solicitudes_pago_lineas l where l.id_solicitud=h.id and l.id_centro_costo is not null)x
 join public.cost_centers cc on cc.cost_center_id=x.id_centro_costo
 where cc.cost_center_type='CLIENTE';
 if client_count=0 then return jsonb_build_object('approverId',null,'source','STANDARD','centerCount',0);end if;
 select cc.code||' · '||cc.name into missing_center
 from(select distinct l.id_centro_costo from public.solicitudes_pago_lineas l where l.id_solicitud=h.id)x
 join public.cost_centers cc on cc.cost_center_id=x.id_centro_costo
 join public.subsidiaries s on s.subsidiary_id=cc.subsidiary_id
 where cc.cost_center_type='CLIENTE'and coalesce(cc.up_approver_id,s.default_up_approver_id)is null limit 1;
 if missing_center is not null then raise exception
  'No se puede procesar la solicitud: el centro de costos % es de tipo CLIENTE y no tiene un Aprobador UP asignado ni existe un Aprobador UP por defecto en la subsidiaria.',missing_center;
 end if;
 select count(distinct coalesce(cc.up_approver_id,s.default_up_approver_id)),min(coalesce(cc.up_approver_id,s.default_up_approver_id))
 into resolved_count,resolved_user
 from(select distinct l.id_centro_costo from public.solicitudes_pago_lineas l where l.id_solicitud=h.id)x
 join public.cost_centers cc on cc.cost_center_id=x.id_centro_costo
 join public.subsidiaries s on s.subsidiary_id=cc.subsidiary_id
 where cc.cost_center_type='CLIENTE';
 if resolved_count>1 then raise exception
  'Los centros de costos CLIENTE seleccionados tienen aprobadores UP diferentes. Separe la solicitud por aprobador.';
 end if;
 if not exists(select 1 from public.users u join public.user_subsidiaries us using(user_id)
  where u.user_id=resolved_user and u.is_active and us.subsidiary_id=h.id_subsidiaria)then
  raise exception 'El Aprobador UP resuelto está inactivo o no tiene acceso a la subsidiaria.';
 end if;
 return jsonb_build_object('approverId',resolved_user,'source',case
  when direct_count>0 and fallback_count>0 then'MIXED'
  when direct_count>0 then'COST_CENTER'else'SUBSIDIARY'end,'centerCount',client_count);
end$$;

create or replace function public.pr_can_approve()returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select public.app_is_admin()
 or exists(select 1 from public.subsidiaries
  where subsidiary_id=public.pr_access()
    and administrative_approver='user:'||public.app_user_id())
$$;

-- The generic workflow RPC remains public for purchase and sales documents.
-- Payment requests must always enter through pr_submit so validation, UP
-- resolution and snapshotting happen in the same transaction.
create or replace function public.wf_start_entity(
 p_entity_type text,p_entity_id bigint,p_context jsonb default '{}'
)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_entity_type='PAYMENT_REQUEST'then
  raise exception using errcode='42501',
   message='Las solicitudes de pago deben enviarse desde la acción Enviar a aprobación.';
 end if;
 return public.budget_run('WORKFLOW_START',
  jsonb_build_object('entityType',p_entity_type,'context',coalesce(p_context,'{}'::jsonb)),p_entity_id);
end$$;

-- This is the implementation wrapped by budget_run. UP requests materialize a dynamic user step.
create or replace function public.wf_start_entity_without_budget(p_entity_type text,p_entity_id bigint,p_context jsonb default '{}')returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare d jsonb;w public.wf_workflows%rowtype;ins public.wf_instances%rowtype;r public.wf_rules%rowtype;n int;
 ctx jsonb;up_user bigint;request_header public.solicitudes_pago%rowtype;route jsonb;expected_version integer;
begin
 d:=public.wf_entity_data(p_entity_type,p_entity_id);
 if(d->>'subsidiaryId')::bigint<>public.active_subsidiary_id()then raise exception'Documento fuera de la subsidiaria activa.';end if;
 ctx:=d||coalesce(p_context,'{}');
 if p_entity_type='PAYMENT_REQUEST'then
  select*into request_header from public.solicitudes_pago
   where id=p_entity_id and id_subsidiaria=public.active_subsidiary_id()for update;
  if request_header.id is null then raise exception'Solicitud no encontrada.';end if;
  expected_version:=nullif(p_context->>'requestVersion','')::integer;
  if expected_version is not null and request_header.version is distinct from expected_version then
   raise exception'La solicitud cambió después de pedir la aprobación presupuestaria. Envíela nuevamente.';
  end if;
  if request_header.estado not in('BORRADOR','RECHAZADO')
    or(request_header.id_solicitante<>public.app_user_id()and not public.app_is_admin())then
   raise exception'No puede enviar esta solicitud a aprobación.';
  end if;
  perform public.pr_validate(request_header.id);
  route:=public.pr_resolve_up_approver(request_header.id);
  update public.solicitudes_pago set
   assigned_approver_id=nullif(route->>'approverId','')::bigint,
   approval_route_source=route->>'source',approval_routed_at=now(),version=version+1,updated_at=now()
   where id=request_header.id returning assigned_approver_id into up_user;
  ctx:=ctx||jsonb_build_object('approvalRoute',route->>'source','assignedApproverId',route->'approverId');
 end if;
 select*into ins from public.wf_instances where entity_type=p_entity_type and entity_id=p_entity_id for update;
 if found and ins.status not in('BORRADOR','RECHAZADO','CANCELADO')then
  if p_entity_type='PAYMENT_REQUEST'then raise exception'La solicitud ya tiene un flujo de aprobación vigente.';end if;
  return jsonb_build_object('id',ins.id,'status',ins.status);
 end if;
 if found then delete from public.wf_instances where id=ins.id;end if;
 if up_user is not null then
  insert into public.wf_instances(workflow_id,subsidiaria_id,entity_type,entity_id,amount,approval_context,current_level,status,requested_by)
  values(null,public.active_subsidiary_id(),p_entity_type,p_entity_id,(d->>'amount')::numeric,
   ctx||jsonb_build_object('approvalRoute','UP','assignedApproverId',up_user),1,'EN_REVISION',public.app_user_id())returning*into ins;
  insert into public.wf_instance_steps(instance_id,nivel,nombre_nivel,usuario_aprobador_id,politica,required_count)
  values(ins.id,1,'Aprobación Proyectos (UP)',up_user,'CUALQUIERA',1);
  perform public.wf_apply_entity_status(p_entity_type,p_entity_id,'PENDIENTE_APROBACION');
  perform public.wf_notify_level(ins.id);
  insert into public.wf_historial_logs(instance_id,nivel,usuario_id,accion_tomada,comentario_motivo)
  values(ins.id,1,public.app_user_id(),'ENVIADO','Solicitud enrutada al Aprobador Proyectos (UP)');
  return jsonb_build_object('id',ins.id,'status','EN_REVISION','currentLevel',1,
   'approvalRoute',route->>'source','assignedApproverId',route->'approverId',
   'approvalRouteSource',route->>'source','clientCostCenterCount',(route->>'centerCount')::integer);
 end if;
 select*into w from public.wf_workflows where subsidiaria_id=public.active_subsidiary_id()
  and entity_type=p_entity_type and estado_activo order by id desc limit 1;
 if not found then raise exception'No existe un flujo de aprobación activo para este tipo de documento.';end if;
 insert into public.wf_instances(workflow_id,subsidiaria_id,entity_type,entity_id,amount,approval_context,current_level,status,requested_by)
 values(w.id,public.active_subsidiary_id(),p_entity_type,p_entity_id,(d->>'amount')::numeric,ctx,1,'PENDIENTE_APROBACION',public.app_user_id())returning*into ins;
 for r in select*from public.wf_rules where workflow_id=w.id
  and(condicion_monto_min is null or(d->>'amount')::numeric>=condicion_monto_min)
  and(condicion_monto_max is null or(d->>'amount')::numeric<=condicion_monto_max)
  and(departamento_id is null or(ctx->>'departmentId')::bigint=departamento_id)
  and(centro_costo_id is null or(ctx->>'costCenterId')::bigint=centro_costo_id)
  and(porcentaje_descuento_min is null or coalesce((ctx->>'discountPercent')::numeric,0)>porcentaje_descuento_min)
  and(tipo_desembolso is null or ctx->>'paymentType'=tipo_desembolso)order by nivel loop
  insert into public.wf_instance_steps(instance_id,nivel,nombre_nivel,rol_aprobador_id,usuario_aprobador_id,politica,required_count)
  values(ins.id,r.nivel,r.nombre_nivel,r.rol_aprobador_id,r.usuario_aprobador_id,r.politica,
   case when r.politica='TODOS'and r.rol_aprobador_id is not null then greatest((select count(*)from public.user_roles ur join public.users u using(user_id)where ur.role_id=r.rol_aprobador_id and u.is_active),1)else 1 end);
 end loop;
 select min(nivel)into n from public.wf_instance_steps where instance_id=ins.id;
 if n is null then
  update public.wf_instances set status='APROBADO',current_level=null,completed_at=now()where id=ins.id;
  perform public.wf_apply_entity_status(p_entity_type,p_entity_id,'APROBADO');
 else
  update public.wf_instances set current_level=n,status='EN_REVISION'where id=ins.id;
  perform public.wf_apply_entity_status(p_entity_type,p_entity_id,'PENDIENTE_APROBACION');
  perform public.wf_notify_level(ins.id);
 end if;
 insert into public.wf_historial_logs(instance_id,nivel,usuario_id,accion_tomada,comentario_motivo)
 values(ins.id,n,public.app_user_id(),'ENVIADO','Documento enviado a aprobación');
 return(select jsonb_build_object('id',id,'status',status,'currentLevel',current_level)from public.wf_instances where id=ins.id)
  ||case when p_entity_type='PAYMENT_REQUEST'then jsonb_build_object(
   'approvalRoute',route->>'source','assignedApproverId',route->'approverId',
   'approvalRouteSource',route->>'source','clientCostCenterCount',(route->>'centerCount')::integer
  )else'{}'::jsonb end;
end$$;

create or replace function public.wf_apply_entity_status_without_budget(p_type text,p_id bigint,p_status text)returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare mapped_status text;
begin
 if p_type='PURCHASE_ORDER'then
  update public.purchase_document set status=p_status,updated_at=now()where document_id=p_id;
 elsif p_type='SALES_ORDER'then
  update public.sales_document set status=p_status,updated_at=now()where document_id=p_id;
 elsif p_type='PAYMENT_REQUEST'then
  mapped_status:=case p_status when'CANCELADO'then'ANULADO'else p_status end;
  update public.solicitudes_pago set estado=mapped_status,version=version+1,updated_at=now(),
   aprobado_por=case when mapped_status='APROBADO'then public.app_user_id()else aprobado_por end,
   aprobado_at=case when mapped_status='APROBADO'then now()else aprobado_at end
   where id=p_id;
  if found then insert into public.solicitudes_pago_eventos(id_solicitud,usuario,accion,nota)
   values(p_id,public.app_user_id(),mapped_status,case when mapped_status='PENDIENTE_APROBACION'then'Enviada al flujo de aprobación'else null end);end if;
 end if;
end$$;

create or replace function public.pr_submit(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=public.pr_access();h public.solicitudes_pago%rowtype;workflow jsonb;
begin
 select*into h from public.solicitudes_pago where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null then raise exception'Solicitud no encontrada.';end if;
 if h.version is distinct from(p->>'version')::integer then raise exception'La solicitud cambió. Vuelva a abrirla.';end if;
 if h.estado not in('BORRADOR','RECHAZADO')or(h.id_solicitante<>public.app_user_id()and not public.app_is_admin())then
  raise exception'No puede enviar esta solicitud a aprobación.';
 end if;
 workflow:=public.budget_run('WORKFLOW_START',
  jsonb_build_object('entityType','PAYMENT_REQUEST','context',jsonb_build_object('requestVersion',h.version)),h.id);
 return workflow||jsonb_build_object('id',h.id);
end$$;

create or replace function public.pr_transition(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=public.pr_access();h public.solicitudes_pago%rowtype;act text:=upper(p->>'transition');target text;allowed boolean;workflow_id bigint;
begin
 if act='SUBMIT'then return public.pr_submit(p);end if;
 select*into h from public.solicitudes_pago where id=(p->>'id')::bigint and id_subsidiaria=sid for update;
 if h.id is null then raise exception'Solicitud no encontrada.';end if;
 if h.version is distinct from(p->>'version')::integer then raise exception'La solicitud cambió. Vuelva a abrirla.';end if;
 select id into workflow_id from public.wf_instances
  where entity_type='PAYMENT_REQUEST'and entity_id=h.id
  order by id desc limit 1;
 if workflow_id is not null and act in('APPROVE','REJECT','CANCEL')then
  return public.wf_act(workflow_id,case act when'APPROVE'then'APROBAR'when'REJECT'then'RECHAZAR'else'CANCELAR'end,p->>'reason',null);
 end if;
 if act in('APPROVE','REJECT')then
  raise exception'La solicitud no tiene una instancia de aprobación vigente. Reenvíela al flujo antes de aprobar o rechazar.';
 end if;
 allowed:=case when h.assigned_approver_id is not null then h.assigned_approver_id=public.app_user_id()or public.app_is_admin()else public.pr_can_approve()end;
 if act='CANCEL'and h.estado in('BORRADOR','PENDIENTE_APROBACION','RECHAZADO','APROBADO')
  and((h.estado<>'APROBADO'and h.id_solicitante=public.app_user_id())or allowed)then target:='ANULADO';
 else raise exception'Acción no permitida para su usuario o para el estado actual.';end if;
 if act in('REJECT','CANCEL')and nullif(trim(p->>'reason'),'')is null then raise exception'Indique el motivo.';end if;
 update public.solicitudes_pago set estado=target,version=version+1,updated_at=now(),
  aprobado_por=case when target='APROBADO'then public.app_user_id()else aprobado_por end,
  aprobado_at=case when target='APROBADO'then now()else aprobado_at end where id=h.id;
 insert into public.solicitudes_pago_eventos(id_solicitud,usuario,accion,nota)
 values(h.id,public.app_user_id(),target,p->>'reason');
 return jsonb_build_object('id',h.id);
end$$;

revoke all on function public.up_approver_has_permission(text),public.up_approver_access(text),
 public.validate_up_approver_assignment(),public.pr_resolve_up_approver(bigint),public.pr_submit(jsonb),
 public.wf_start_entity_without_budget(text,bigint,jsonb),public.wf_apply_entity_status_without_budget(text,bigint,text)
 from public,anon,authenticated;
revoke all on function public.up_approver_options(),public.up_cost_centers_by_approver(bigint),
 public.up_approver_selector_options(),public.up_reassign_cost_centers(jsonb),public.pr_transition(jsonb),
 public.wf_start_entity(text,bigint,jsonb)from public,anon;
grant execute on function public.up_approver_options(),public.up_cost_centers_by_approver(bigint),
 public.up_approver_selector_options(),public.up_reassign_cost_centers(jsonb),public.pr_transition(jsonb),
 public.wf_start_entity(text,bigint,jsonb),public.up_approver_has_permission(text)to authenticated;

notify pgrst,'reload schema';
commit;
