begin;

-- A cost center belongs to one analytical department.  Client centers keep
-- inheriting it from their customer, while internal centers now have an
-- explicit relationship that can be used by every transactional cascade.
alter table public.cost_centers
  add column if not exists department_id bigint
  references public.departments(department_id) on delete restrict;

create index if not exists cost_centers_department_idx
  on public.cost_centers(subsidiary_id,department_id,cost_center_type)
  where department_id is not null;

update public.cost_centers center
set department_id=customer.department_id
from public.customers customer
join public.departments department
  on department.department_id=customer.department_id
where center.customer_id=customer.customer_id
  and upper(center.cost_center_type)='CLIENTE'
  and center.department_id is null
  and not department.is_inactive
  and lower(department.type)='cliente'
  and(
    department.subsidiary_id=center.subsidiary_id
    or exists(
      select 1 from public.department_subsidiaries scope
      where scope.department_id=department.department_id
        and scope.subsidiary_id=center.subsidiary_id
    )
  );

create or replace function public.validate_cost_center_department()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

drop trigger if exists validate_cost_center_department_assignment
on public.cost_centers;
create trigger validate_cost_center_department_assignment
before insert or update of customer_id,department_id,cost_center_type,subsidiary_id
on public.cost_centers
for each row execute function public.validate_cost_center_department();

-- Keep the materialized relationship aligned with the customer master.  The
-- cost-center trigger above validates the new department independently for
-- every subsidiary; any invalid destination aborts the customer update and
-- therefore cannot leave a partially synchronized catalog.
create or replace function public.sync_customer_cost_center_department()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

drop trigger if exists sync_customer_cost_center_department_assignment
on public.customers;
create trigger sync_customer_cost_center_department_assignment
after update of department_id on public.customers
for each row
when(old.department_id is distinct from new.department_id)
execute function public.sync_customer_cost_center_department();

-- A direct-payment line owns its accounting department explicitly.  The
-- department type remains catalog data, so it cannot drift from the selected
-- department and does not need to be duplicated on the transaction.
alter table public.solicitudes_pago_lineas
  add column if not exists id_departamento bigint
  references public.departments(department_id) on delete restrict;

create index if not exists solicitudes_pago_lineas_department_idx
  on public.solicitudes_pago_lineas(id_departamento,id_solicitud)
  where id_departamento is not null;

-- Preserve open requests created before the explicit dimension existed.  A
-- value is copied only when every available historical source agrees on one
-- active department that belongs to the request subsidiary.  Supplier and tax
-- agency lines without such evidence intentionally remain unassigned so the
-- user must choose their accounting department.
with safe_department as(
  select line.id line_id,min(candidate.department_id) department_id
  from public.solicitudes_pago_lineas line
  join public.solicitudes_pago request on request.id=line.id_solicitud
  left join public.employees employee on employee.employee_id=line.id_empleado
  left join public.customers customer on customer.customer_id=line.id_cliente
  left join public.cost_centers center on center.cost_center_id=line.id_centro_costo
  left join public.customers center_customer
    on center_customer.customer_id=center.customer_id
  cross join lateral(
    values(employee.department_id),(customer.department_id),
      (center.department_id),(center_customer.department_id)
  )candidate(department_id)
  join public.departments department
    on department.department_id=candidate.department_id
   and not department.is_inactive
   and(
     department.subsidiary_id=request.id_subsidiaria
     or exists(
       select 1 from public.department_subsidiaries scope
       where scope.department_id=department.department_id
         and scope.subsidiary_id=request.id_subsidiaria
     )
   )
  where line.id_departamento is null
    and request.tipo_solicitud='OTROS'
    and request.estado in('BORRADOR','RECHAZADO','APROBADO')
    and candidate.department_id is not null
  group by line.id
  having count(distinct candidate.department_id)=1
)
update public.solicitudes_pago_lineas line
set id_departamento=safe_department.department_id
from safe_department
where line.id=safe_department.line_id
  and line.id_departamento is null;

do $migration$
declare
  definition text;
  needle text;
  replacement text;
begin
  definition:=pg_get_functiondef('public.pr_options()'::regprocedure);
  if position('''departments''' in definition)=0 then
    needle:=$old$    'costCenters',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',cost_center.cost_center_id,'name',cost_center.name
      )order by cost_center.name)
      from public.cost_centers cost_center
      where cost_center.subsidiary_id=sid
    ),'[]'::jsonb),$old$;
    replacement:=$new$    'departments',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',department.department_id,
        'name',department.name,
        'type',department.type
      )order by department.type,department.name)
      from public.departments department
      where not department.is_inactive
        and(
          department.subsidiary_id=sid
          or exists(
            select 1 from public.department_subsidiaries scope
            where scope.department_id=department.department_id
              and scope.subsidiary_id=sid
          )
        )
    ),'[]'::jsonb),
    'costCenters',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',cost_center.cost_center_id,
        'code',cost_center.code,
        'name',concat_ws(' / ',nullif(cost_center.code,''),cost_center.name),
        'type',cost_center.cost_center_type,
        'departmentId',coalesce(cost_center.department_id,customer.department_id)
      )order by cost_center.code,cost_center.name)
      from public.cost_centers cost_center
      left join public.customers customer
        on customer.customer_id=cost_center.customer_id
      where cost_center.subsidiary_id=sid
        and not cost_center.is_inactive
    ),'[]'::jsonb),$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo ampliar pr_options con las dimensiones de la solicitud.';
    end if;
    definition:=replace(definition,needle,replacement);
    execute definition;
  end if;

  definition:=pg_get_functiondef('public.pr_validate(bigint)'::regprocedure);
  if position('line_row.id_departamento' in definition)=0 then
    needle:=$old$      if line_row.id_centro_costo is not null and not exists(
        select 1 from public.cost_centers cost_center
        where cost_center.cost_center_id=line_row.id_centro_costo
          and cost_center.subsidiary_id=header_row.id_subsidiaria
      )then
        raise exception 'Centro de costo fuera de la subsidiaria.';
      end if;$old$;
    replacement:=$new$      if line_row.id_departamento is null then
        raise exception 'Seleccione el departamento de cada imputacion.';
      end if;
      if not exists(
        select 1 from public.departments department
        where department.department_id=line_row.id_departamento
          and not department.is_inactive
          and(
            department.subsidiary_id=header_row.id_subsidiaria
            or exists(
              select 1 from public.department_subsidiaries scope
              where scope.department_id=department.department_id
                and scope.subsidiary_id=header_row.id_subsidiaria
            )
          )
      )then
        raise exception 'Departamento fuera de la subsidiaria o inactivo.';
      end if;
      if line_row.id_centro_costo is not null and not exists(
        select 1
        from public.cost_centers cost_center
        left join public.customers owner
          on owner.customer_id=cost_center.customer_id
        join public.departments department
          on department.department_id=line_row.id_departamento
        where cost_center.cost_center_id=line_row.id_centro_costo
          and cost_center.subsidiary_id=header_row.id_subsidiaria
          and not cost_center.is_inactive
          and upper(cost_center.cost_center_type)=upper(department.type)
          and coalesce(cost_center.department_id,owner.department_id)
            =line_row.id_departamento
      )then
        raise exception 'El centro de costo no corresponde al tipo de departamento y departamento seleccionados.';
      end if;$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo ampliar pr_validate con el departamento de la linea.';
    end if;
    definition:=replace(definition,needle,replacement);
    execute definition;
  end if;

  definition:=pg_get_functiondef(
    'public.pr_save_without_budget(jsonb)'::regprocedure
  );
  if position('id_departamento' in definition)=0 then
    needle:=$old$      id_cliente,id_proveedor,id_empleado,id_agencia_tributaria,
      id_centro_costo,concepto,monto$old$;
    replacement:=$new$      id_cliente,id_proveedor,id_empleado,id_agencia_tributaria,
      id_departamento,id_centro_costo,concepto,monto$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo ampliar la lista de columnas de pr_save_without_budget.';
    end if;
    definition:=replace(definition,needle,replacement);

    needle:=$old$      case when request_type='OTROS'
        and line->>'entityType'='Agencia Tributaria'
        then(line->>'entityId')::bigint end,
      case when request_type='OTROS'
        then nullif(line->>'costCenterId','')::bigint end,$old$;
    replacement:=$new$      case when request_type='OTROS'
        and line->>'entityType'='Agencia Tributaria'
        then(line->>'entityId')::bigint end,
      case when request_type='OTROS'
        then nullif(line->>'departmentId','')::bigint end,
      case when request_type='OTROS'
        then nullif(line->>'costCenterId','')::bigint end,$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo persistir el departamento en pr_save_without_budget.';
    end if;
    definition:=replace(definition,needle,replacement);

    -- A missing transaction-number setup must be repaired, never hidden by a
    -- timestamp that looks like a valid business sequence.
    needle:=$old$    begin
      request_number:=public.next_transaction_number(transaction_type_key,sid);
    exception when others then
      request_number:='SOL_PAG-'||to_char(
        clock_timestamp(),'YYYYMMDDHH24MISSMS'
      );
    end;$old$;
    replacement:=$new$    request_number:=public.next_transaction_number(
      transaction_type_key,sid
    );$new$;
    if position(needle in definition)>0 then
      definition:=replace(definition,needle,replacement);
    end if;
    execute definition;
  end if;

  definition:=pg_get_functiondef('public.pr_detail(jsonb)'::regprocedure);
  if position('''departmentType''' in definition)=0 then
    needle:=$old$          'costCenter',cost_center.name
        )order by line.id$old$;
    replacement:=$new$          'departmentType',department.type,
          'department',department.name,
          'costCenter',case when cost_center.cost_center_id is null then null
            else concat_ws(' / ',nullif(cost_center.code,''),cost_center.name) end
        )order by line.id$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo ampliar la proyeccion de pr_detail.';
    end if;
    definition:=replace(definition,needle,replacement);
    needle:=$old$      left join public.cost_centers cost_center
        on cost_center.cost_center_id=line.id_centro_costo
      where line.id_solicitud=header_row.id$old$;
    replacement:=$new$      left join public.departments department
        on department.department_id=line.id_departamento
      left join public.cost_centers cost_center
        on cost_center.cost_center_id=line.id_centro_costo
      where line.id_solicitud=header_row.id$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo enlazar el departamento en pr_detail.';
    end if;
    definition:=replace(definition,needle,replacement);
    execute definition;
  end if;

  definition:=pg_get_functiondef(
    'public.pr_execute_without_budget(jsonb)'::regprocedure
  );
  if position('id_departamento' in definition)=0 then
    needle:=$old$      'cost_center_id',id_centro_costo,
      'note',concepto$old$;
    replacement:=$new$      'department_id',id_departamento,
      'cost_center_id',id_centro_costo,
      'note',concepto$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo propagar el departamento al pago y asiento.';
    end if;
    definition:=replace(definition,needle,replacement);
    execute definition;
  end if;

  definition:=pg_get_functiondef(
    'public.run_payment_request_report(jsonb)'::regprocedure
  );
  if position('coalesce(l.id_departamento,pe.department_id' in definition)=0 then
    needle:=$old$   coalesce(pe.department_id,pc.department_id,cc_customer.department_id) direct_department_id$old$;
    replacement:=$new$   coalesce(l.id_departamento,pe.department_id,pc.department_id,cc.department_id,cc_customer.department_id) direct_department_id$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo priorizar el departamento elegido en el reporte.';
    end if;
    definition:=replace(definition,needle,replacement);
    execute definition;
  end if;

  definition:=pg_get_functiondef(
    'public.expense_approval_email_snapshot(bigint,bigint,bigint)'::regprocedure
  );
  if position('l.id_departamento' in definition)=0 then
    needle:=$old$department.department_id=coalesce(
        employee.department_id,customer.department_id,center_customer.department_id
      )$old$;
    replacement:=$new$department.department_id=coalesce(
        l.id_departamento,employee.department_id,customer.department_id,
        center.department_id,center_customer.department_id
      )$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo priorizar el departamento elegido en el correo.';
    end if;
    definition:=replace(definition,needle,replacement);
    execute definition;
  end if;
end
$migration$;

comment on column public.solicitudes_pago_lineas.id_departamento is
  'Departamento contable seleccionado para la imputacion directa.';

comment on column public.cost_centers.department_id is
  'Departamento analitico propietario del centro de costos.';

commit;

notify pgrst,'reload schema';
