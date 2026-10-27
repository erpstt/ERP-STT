-- Keep the existing report and notification contracts while extending their
-- third-party projection with the tax agency selected on a direct-payment line.
-- The guarded replacements intentionally fail when an upstream definition has
-- changed, instead of silently installing a partially compatible report.

do $migration$
declare
  definition text;
  needle text;
  replacement text;
begin
  definition:=pg_get_functiondef(
    'public.payment_request_report_options()'::regprocedure
  );

  if position('Agencia Tributaria' in definition)=0 then
    needle:=$old$
    select distinct 'Empleado',e.employee_id,trim(concat_ws(' ',e.first_name,e.last_name)),e.identification
    from employees e where e.subsidiary_id=sid
$old$;
    replacement:=$new$
    select distinct 'Empleado',e.employee_id,trim(concat_ws(' ',e.first_name,e.last_name)),e.identification
    from employees e where e.subsidiary_id=sid
    union all
    select distinct 'Agencia Tributaria',agency.tax_agency_id,agency.agency_name,agency.tax_id
    from tax_agencies agency
    join tax_agency_subsidiaries scope using(tax_agency_id)
    where scope.subsidiary_id=sid
$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo extender payment_request_report_options: bloque de terceros no encontrado.';
    end if;
    definition:=replace(definition,needle,replacement);
    execute definition;
  end if;

  definition:=pg_get_functiondef(
    'public.run_payment_request_report(jsonb)'::regprocedure
  );

  if position('id_agencia_tributaria' in definition)=0 then
    needle:=$old$filter_party_type not in('Proveedor','Cliente','Empleado')$old$;
    replacement:=$new$filter_party_type not in('Proveedor','Cliente','Empleado','Agencia Tributaria')$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo ampliar la validacion de tipo de tercero del reporte.';
    end if;
    definition:=replace(definition,needle,replacement);

    needle:=$old$        left join employees pe on pe.employee_id=sl.id_empleado
        where sl.id_solicitud=h.id and(concat_ws(' ',sl.concepto,si.invoice_number,ca.account_number,ca.account_name,pc.company_name,ps.company_name,pe.first_name,pe.last_name) ilike '%'||search_text||'%')))$old$;
    replacement:=$new$        left join employees pe on pe.employee_id=sl.id_empleado
        left join tax_agencies agency on agency.tax_agency_id=sl.id_agencia_tributaria
        where sl.id_solicitud=h.id and(concat_ws(' ',sl.concepto,si.invoice_number,ca.account_number,ca.account_name,pc.company_name,ps.company_name,pe.first_name,pe.last_name,agency.agency_name,agency.tax_id) ilike '%'||search_text||'%')))$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo ampliar la busqueda por agencia tributaria del reporte.';
    end if;
    definition:=replace(definition,needle,replacement);

    needle:=$old$   case when h.tipo_solicitud='CXP' then h.id_proveedor else coalesce(l.id_cliente,l.id_proveedor,l.id_empleado) end party_id,
   case when h.tipo_solicitud='CXP' then h.supplier_name else coalesce(pc.company_name,ps.company_name,trim(concat_ws(' ',pe.first_name,pe.last_name))) end party_name,
   case when h.tipo_solicitud='CXP' then h.supplier_tax_id else coalesce(pc.tax_id,ps.tax_id,pe.identification) end party_tax_id,$old$;
    replacement:=$new$   case when h.tipo_solicitud='CXP' then h.id_proveedor else coalesce(l.id_cliente,l.id_proveedor,l.id_empleado,l.id_agencia_tributaria) end party_id,
   case when h.tipo_solicitud='CXP' then h.supplier_name else coalesce(pc.company_name,ps.company_name,nullif(trim(concat_ws(' ',pe.first_name,pe.last_name)),''),agency.agency_name) end party_name,
   case when h.tipo_solicitud='CXP' then h.supplier_tax_id else coalesce(pc.tax_id,ps.tax_id,pe.identification,agency.tax_id) end party_tax_id,$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo ampliar la proyeccion de tercero del reporte.';
    end if;
    definition:=replace(definition,needle,replacement);

    needle:=$old$  left join employees pe on pe.employee_id=l.id_empleado
  left join cost_centers cc on cc.cost_center_id=l.id_centro_costo$old$;
    replacement:=$new$  left join employees pe on pe.employee_id=l.id_empleado
  left join tax_agencies agency on agency.tax_agency_id=l.id_agencia_tributaria
  left join cost_centers cc on cc.cost_center_id=l.id_centro_costo$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo enlazar la agencia tributaria en las lineas del reporte.';
    end if;
    definition:=replace(definition,needle,replacement);
    execute definition;
  end if;

  definition:=pg_get_functiondef(
    'public.expense_approval_email_snapshot(bigint,bigint,bigint)'::regprocedure
  );

  if position('id_agencia_tributaria' in definition)=0 then
    needle:=$old$        'tercero',line_data.party_name,
        'departamento',line_data.department_name,$old$;
    replacement:=$new$        'tercero',line_data.party_name,
        'tipoTercero',line_data.party_type,
        'departamento',line_data.department_name,$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo ampliar el tercero del correo de aprobacion.';
    end if;
    definition:=replace(definition,needle,replacement);

    needle:=$old$        l.id line_id,
        nullif(trim(concat_ws(' · ',account.account_number,account.account_name)),'') account_label,
        coalesce(customer.company_name,supplier.company_name,
          nullif(trim(concat_ws(' ',employee.first_name,employee.last_name)),''),'Sin tercero') party_name,$old$;
    replacement:=$new$        l.id line_id,
        l.tipo_tercero party_type,
        nullif(trim(concat_ws(' · ',account.account_number,account.account_name)),'') account_label,
        coalesce(customer.company_name,supplier.company_name,
          nullif(trim(concat_ws(' ',employee.first_name,employee.last_name)),''),
          agency.agency_name,'Sin tercero') party_name,$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo ampliar el nombre de tercero del correo de aprobacion.';
    end if;
    definition:=replace(definition,needle,replacement);

    needle:=$old$      left join public.suppliers supplier on supplier.supplier_id=l.id_proveedor
      left join public.employees employee on employee.employee_id=l.id_empleado
      left join public.cost_centers center on center.cost_center_id=l.id_centro_costo$old$;
    replacement:=$new$      left join public.suppliers supplier on supplier.supplier_id=l.id_proveedor
      left join public.employees employee on employee.employee_id=l.id_empleado
      left join public.tax_agencies agency on agency.tax_agency_id=l.id_agencia_tributaria
      left join public.cost_centers center on center.cost_center_id=l.id_centro_costo$new$;
    if position(needle in definition)=0 then
      raise exception 'No se pudo enlazar la agencia tributaria en el correo de aprobacion.';
    end if;
    definition:=replace(definition,needle,replacement);
    execute definition;
  end if;
end
$migration$;

comment on function public.payment_request_report_options() is
  'Opciones del reporte de solicitudes, incluidas agencias tributarias de la subsidiaria.';
comment on function public.run_payment_request_report(jsonb) is
  'Reporte auditable de solicitudes con filtro, busqueda y detalle de agencias tributarias.';
comment on function public.expense_approval_email_snapshot(bigint,bigint,bigint) is
  'Contexto del correo de aprobacion con el tercero, incluida la agencia tributaria.';

notify pgrst,'reload schema';
