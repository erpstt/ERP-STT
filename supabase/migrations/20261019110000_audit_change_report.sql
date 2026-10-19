-- Reporte de calidad: modificaciones y eliminaciones por mes.
-- La salida conserva la trazabilidad funcional y omite metadatos técnicos y secretos.

create index if not exists audit_log_change_report_idx
  on public.audit_log("timestamp" desc,action,user_id,entity_type);
create index if not exists change_log_report_event_idx
  on public.change_log(audit_log_id,change_id);
create index if not exists deleted_records_report_event_idx
  on public.deleted_records(audit_log_id,deleted_id desc)
  where audit_log_id is not null;

create or replace function public.audit_change_action_code(p_action text)
returns text
language sql
immutable
parallel safe
set search_path=pg_catalog
as $$
  select case upper(trim(coalesce(p_action,'')))
    when 'MODIFICACION' then 'MODIFICACION'
    when 'MODIFICACIÓN' then 'MODIFICACION'
    when 'UPDATE' then 'MODIFICACION'
    when 'UPDATED' then 'MODIFICACION'
    when 'MODIFIED' then 'MODIFICACION'
    when 'ELIMINACION' then 'ELIMINACION'
    when 'ELIMINACIÓN' then 'ELIMINACION'
    when 'DELETE' then 'ELIMINACION'
    when 'DELETED' then 'ELIMINACION'
  end
$$;

create or replace function public.audit_change_is_technical_field(p_field text)
returns boolean
language sql
immutable
parallel safe
set search_path=pg_catalog
as $$
  select lower(trim(coalesce(p_field,'')))=any(array[
    'updated_at','updated_by','updated_by_id','updated_by_email','updated_by_name',
    'updated_actor_type','updated_actor_source','updated_execution_context_id',
    'modified_at','modified_by','modified_by_id','modified_by_email','modified_by_name',
    'created_by','created_by_id','created_by_email','created_by_name',
    'actor_type','actor_source','execution_context_id'
  ])
  or lower(trim(coalesce(p_field,'')))~'^(last_)?(updated|modified)_(at|by|by_id|by_email|by_name)$'
$$;

create or replace function public.audit_change_is_sensitive_field(p_field text)
returns boolean
language sql
immutable
parallel safe
set search_path=pg_catalog
as $$
  select lower(trim(coalesce(p_field,'')))~
    '(^|_)(password|hash|secret|token|api_key|private_key|credential|smtp|authorization|session|cookie|file_data|binary_data|contenido_archivo|archivo_contenido|base64)($|_)'
$$;

create or replace function public.audit_change_field_label(p_field text)
returns text
language sql
immutable
parallel safe
set search_path=pg_catalog
as $$
  select case lower(trim(coalesce(p_field,'')))
    when 'is_active' then 'Activo'
    when 'is_inactive' then 'Inactivo'
    when 'status' then 'Estado'
    when 'status_id' then 'Estado'
    when 'name' then 'Nombre'
    when 'description' then 'Descripción'
    when 'notes' then 'Notas'
    when 'note' then 'Nota'
    when 'subsidiary_id' then 'Subsidiaria'
    when 'department_id' then 'Departamento'
    when 'cost_center_id' then 'Centro de costos'
    when 'class_id' then 'Clase'
    when 'location_id' then 'Ubicación'
    when 'currency_id' then 'Moneda'
    when 'customer_id' then 'Cliente'
    when 'supplier_id' then 'Proveedor'
    when 'employee_id' then 'Empleado'
    when 'account_id' then 'Cuenta contable'
    when 'total_amount' then 'Importe total'
    when 'amount' then 'Importe'
    when 'balance_due' then 'Saldo pendiente'
    when 'due_date' then 'Fecha de vencimiento'
    when 'email' then 'Correo electrónico'
    when 'phone' then 'Teléfono'
    else initcap(replace(trim(coalesce(p_field,'')),'_',' '))
  end
$$;

create or replace function public.audit_change_entity_meta(p_entity_type text,p_source_module text default null)
returns jsonb
language plpgsql
immutable
parallel safe
set search_path=pg_catalog
as $$
declare
  entity_name text:=lower(trim(coalesce(p_entity_type,'')));
  module_code text;
  module_label text;
  entity_label text;
begin
  module_code:=case
    when entity_name~'^(users|roles|permissions|role_|user_|sessions|devices|login_history|password_history|api_keys|oauth_clients)' then 'security'
    when entity_name~'^(subsidiaries|branches|departments|department_|classes|class_|cost_centers|locations|location_|employees|countries|currencies|languages|timezones)' then 'organization'
    when entity_name~'^(journal|journal_|gl_impact|chart_accounts|account_group|account_|accounting_books|fiscal_periods|fiscal_years|opening_|allocation_rules|fx_revaluation)' then 'accounting'
    when entity_name~'^(bank|cash|cashbox)' then 'banking'
    when entity_name~'^(invoice|sales_|credit_note|debit_note|customer_payment|customer_advance|quotation|sales_order|delivery|price_list)' then 'sales'
    when entity_name~'^(supplier_|purchase_|goods_receipt|payment_batch|bank_payment_formats)' then 'purchasing'
    when entity_name~'^(customers|suppliers|entity_)' then 'entities'
    when entity_name~'^(products|product_|item_|stock|stock_|warehouse|bins|barcode|uom)' then 'inventory'
    when entity_name~'^(expense|expense_)' then 'expenses'
    when entity_name~'^(tax_|fiscal_calendar|holidays)' then 'tax'
    when entity_name~'^(presupuestos|budget|income_forecast)' then 'planning'
    when entity_name~'^(consolidated_|intercompany_)' then 'consolidation'
    when entity_name~'^(solicitudes_pago|approval|approval_|workflow|workflow_)' then 'workflow'
    when entity_name~'^(documents|document_|folders)' then 'documents'
    when entity_name~'^(settings|parameters|number_sequences|status|transaction_types|payment_terms|payment_methods|series)' then 'configuration'
    else coalesce(nullif(nullif(lower(trim(p_source_module)),''),'public'),'other')
  end;

  module_label:=case module_code
    when 'security' then 'Seguridad'
    when 'organization' then 'Organización'
    when 'accounting' then 'Contabilidad'
    when 'banking' then 'Bancos y tesorería'
    when 'sales' then 'Ventas y cuentas por cobrar'
    when 'purchasing' then 'Compras y cuentas por pagar'
    when 'entities' then 'Entidades'
    when 'inventory' then 'Inventario'
    when 'expenses' then 'Gastos'
    when 'tax' then 'Fiscal'
    when 'planning' then 'Planificación y presupuesto'
    when 'consolidation' then 'Consolidación'
    when 'workflow' then 'Flujos y aprobaciones'
    when 'documents' then 'Documentos'
    when 'configuration' then 'Configuración'
    when 'public' then 'Otros registros'
    when 'other' then 'Otros registros'
    else initcap(replace(module_code,'_',' '))
  end;

  entity_label:=case entity_name
    when 'invoice' then 'Facturas de venta'
    when 'sales_invoice_line' then 'Líneas de factura de venta'
    when 'credit_note' then 'Notas de crédito de clientes'
    when 'debit_note' then 'Notas de débito de clientes'
    when 'customer_payment' then 'Cobros de clientes'
    when 'supplier_invoice' then 'Facturas de proveedores'
    when 'supplier_invoice_line' then 'Líneas de factura de proveedor'
    when 'supplier_credit_note' then 'Notas de crédito de proveedores'
    when 'supplier_debit_note' then 'Notas de débito de proveedores'
    when 'supplier_payment' then 'Pagos a proveedores'
    when 'journal' then 'Asientos contables'
    when 'journal_line' then 'Líneas de asiento contable'
    when 'chart_accounts' then 'Plan de cuentas'
    when 'customers' then 'Clientes'
    when 'suppliers' then 'Proveedores'
    when 'employees' then 'Empleados'
    when 'subsidiaries' then 'Subsidiarias'
    when 'departments' then 'Departamentos'
    when 'cost_centers' then 'Centros de costos'
    when 'classes' then 'Clases'
    when 'locations' then 'Ubicaciones'
    when 'users' then 'Usuarios'
    when 'roles' then 'Roles'
    when 'role_access_matrix' then 'Permisos por rol'
    when 'products' then 'Productos y servicios'
    when 'expense' then 'Solicitudes de gasto'
    when 'solicitudes_pago' then 'Solicitudes de pago'
    when 'tax_calendar_events' then 'Obligaciones del calendario tributario'
    when 'tax_obligation_types' then 'Obligaciones tributarias'
    when 'budget' then 'Presupuestos'
    when 'presupuestos_encabezado' then 'Presupuestos'
    else initcap(replace(entity_name,'_',' '))
  end;

  return jsonb_build_object(
    'moduleCode',module_code,
    'moduleLabel',module_label,
    'entityLabel',coalesce(nullif(entity_label,''),'Registro')
  );
end
$$;

create or replace function public.audit_change_try_jsonb(p_value text)
returns jsonb
language plpgsql
immutable
parallel safe
set search_path=pg_catalog
as $$
begin
  if nullif(trim(p_value),'') is null then return '{}'::jsonb; end if;
  return p_value::jsonb;
exception when others then
  return jsonb_build_object('detalle',left(p_value,500));
end
$$;

create or replace function public.audit_change_sanitize_snapshot(p_snapshot jsonb)
returns jsonb
language sql
immutable
parallel safe
set search_path=pg_catalog,public
as $$
  select case when jsonb_typeof(coalesce(p_snapshot,'{}'::jsonb))<>'object' then '{}'::jsonb
    else coalesce((
      select jsonb_object_agg(item.key,
        case
          when jsonb_typeof(item.value)='string' and length(item.value#>>'{}')>500
            then to_jsonb(left(item.value#>>'{}',500)||'…')
          else item.value
        end order by item.key)
      from jsonb_each(coalesce(p_snapshot,'{}'::jsonb))item
      where not public.audit_change_is_technical_field(item.key)
        and not public.audit_change_is_sensitive_field(item.key)
    ),'{}'::jsonb)
  end
$$;

create or replace function public.audit_change_report_options()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  uid bigint:=public.app_user_id();
  result jsonb;
begin
  if uid is null then
    raise exception using errcode='42501',message='La sesión no identifica un usuario.';
  end if;
  perform public.security_assert_role_access('audit:change-report','view');

  with event_base as(
    select a.log_id,a."timestamp" occurred_at,
      public.audit_change_action_code(a.action) action_code,
      coalesce(a.user_id,deleted.deleted_by_user_id) actor_user_id,
      a.entity_type,
      public.audit_change_entity_meta(a.entity_type,a.module) meta
    from public.audit_log a
    left join lateral(
      select record.deleted_by_user_id
      from public.deleted_records record
      where record.audit_log_id=a.log_id
      order by record.deleted_id desc limit 1
    )deleted on true
    where public.audit_change_action_code(a.action)is not null
      and(
        public.audit_change_action_code(a.action)='ELIMINACION'
        or exists(
          select 1 from public.change_log change
          where change.audit_log_id=a.log_id
            and not public.audit_change_is_technical_field(change.field_name)
            and not public.audit_change_is_sensitive_field(change.field_name)
        )
      )
  ),user_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.user_id,'name',option.display_name,'email',option.email,'isActive',option.is_active,
      'recordCount',option.record_count
    )order by option.display_name,option.email),'[]'::jsonb)value
    from(
      select u.user_id,
        coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email)display_name,
        u.email,u.is_active,count(*)::integer record_count
      from event_base event join public.users u on u.user_id=event.actor_user_id
      group by u.user_id,u.first_name,u.last_name,u.email,u.is_active
    )option
  ),module_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.module_code,'label',option.module_label,'recordCount',option.record_count
    )order by option.module_label),'[]'::jsonb)value
    from(
      select event.meta->>'moduleCode'module_code,event.meta->>'moduleLabel'module_label,
        count(*)::integer record_count
      from event_base event
      group by event.meta->>'moduleCode',event.meta->>'moduleLabel'
    )option
  ),entity_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.entity_type,'label',option.entity_label,'module',option.module_code,
      'recordCount',option.record_count
    )order by option.entity_label,option.entity_type),'[]'::jsonb)value
    from(
      select event.entity_type,event.meta->>'entityLabel'entity_label,
        event.meta->>'moduleCode'module_code,count(*)::integer record_count
      from event_base event
      group by event.entity_type,event.meta->>'entityLabel',event.meta->>'moduleCode'
    )option
  ),month_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.month_id,'year',option.year_value,'month',option.month_value,
      'recordCount',option.record_count
    )order by option.month_id desc),'[]'::jsonb)value
    from(
      select to_char(date_trunc('month',event.occurred_at at time zone 'America/Costa_Rica'),'YYYY-MM')month_id,
        extract(year from event.occurred_at at time zone 'America/Costa_Rica')::integer year_value,
        extract(month from event.occurred_at at time zone 'America/Costa_Rica')::integer month_value,
        count(*)::integer record_count
      from event_base event
      group by 1,2,3
    )option
  )
  select jsonb_build_object(
    'defaultMonth',to_char(current_timestamp at time zone 'America/Costa_Rica','YYYY-MM'),
    'timeZone','America/Costa_Rica',
    'actions',jsonb_build_array(
      jsonb_build_object('id','','label','Todas las acciones'),
      jsonb_build_object('id','UPDATE','label','Modificados'),
      jsonb_build_object('id','DELETE','label','Eliminados')
    ),
    'users',user_options.value,
    'modules',module_options.value,
    'entityTypes',entity_options.value,
    'months',month_options.value,
    'pageSizes',jsonb_build_array(25,50,100,200)
  )into result
  from user_options,module_options,entity_options,month_options;

  return result;
end
$$;

create or replace function public.run_audit_change_report(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  uid bigint:=public.app_user_id();
  filters jsonb:=coalesce(p_filters,'{}'::jsonb);
  month_text text:=coalesce(nullif(trim(filters->>'month'),''),to_char(current_timestamp at time zone 'America/Costa_Rica','YYYY-MM'));
  month_start date;
  month_end date;
  user_filter bigint;
  action_filter text:=upper(coalesce(nullif(trim(filters->>'action'),''),'ALL'));
  module_filter text:=lower(nullif(trim(filters->>'module'),''));
  entity_filter text:=lower(nullif(trim(filters->>'entityType'),''));
  search_filter text:=lower(trim(coalesce(filters->>'search','')));
  page_number integer:=1;
  page_size integer:=50;
  result jsonb;
begin
  if uid is null then
    raise exception using errcode='42501',message='La sesión no identifica un usuario.';
  end if;
  perform public.security_assert_role_access('audit:change-report','view');

  if jsonb_typeof(filters)<>'object' then raise exception 'Los filtros del reporte no son válidos.'; end if;
  if month_text!~'^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'El mes debe tener el formato AAAA-MM.'; end if;
  month_start:=to_date(month_text||'-01','YYYY-MM-DD');
  if to_char(month_start,'YYYY-MM')<>month_text then raise exception 'El mes seleccionado no es válido.'; end if;
  month_end:=(month_start+interval '1 month')::date;

  if nullif(trim(filters->>'userId'),'')is not null then
    if trim(filters->>'userId')!~'^\d+$' then raise exception 'El usuario seleccionado no es válido.'; end if;
    user_filter:=(filters->>'userId')::bigint;
  end if;
  if action_filter not in('ALL','MODIFICACION','MODIFICACIÓN','UPDATE','UPDATED','MODIFIED','ELIMINACION','ELIMINACIÓN','DELETE','DELETED')then
    raise exception 'La acción seleccionada no es válida.';
  end if;
  if action_filter<>'ALL'then action_filter:=public.audit_change_action_code(action_filter); end if;
  if length(coalesce(module_filter,''))>80 or length(coalesce(entity_filter,''))>120 then
    raise exception 'El módulo o tipo de registro seleccionado no es válido.';
  end if;
  if length(search_filter)>200 then raise exception 'La búsqueda no puede superar 200 caracteres.'; end if;

  if nullif(trim(filters->>'page'),'')is not null then
    if trim(filters->>'page')!~'^\d+$'then raise exception 'La página no es válida.';end if;
    page_number:=(filters->>'page')::integer;
  end if;
  if nullif(trim(filters->>'pageSize'),'')is not null then
    if trim(filters->>'pageSize')!~'^\d+$'then raise exception 'El tamaño de página no es válido.';end if;
    page_size:=(filters->>'pageSize')::integer;
  end if;
  if page_number<1 then raise exception 'La página debe ser mayor que cero.'; end if;
  if page_size<1 or page_size>500 then raise exception 'El tamaño de página debe estar entre 1 y 500.'; end if;

  with event_source as(
    select a.log_id,a."timestamp"occurred_at,
      public.audit_change_action_code(a.action)action_code,
      a.user_id,
      a.entity_type,a.entity_id,a.entity_key,a.description,a.result,a.ip_address::text ip_address,
      a.execution_context_id,
      a.created_by_name,a.created_by_email,a.actor_type,a.actor_source,
      deleted.deleted_id,deleted.deleted_by_user_id,deleted.reason,
      public.audit_change_sanitize_snapshot(
        public.audit_change_try_jsonb(deleted.record_data_json)
      )deleted_snapshot,
      coalesce(changes.items,'[]'::jsonb)changes,
      coalesce(changes.change_count,0)::integer change_count,
      public.audit_change_entity_meta(a.entity_type,a.module)meta
    from public.audit_log a
    left join lateral(
      select record.deleted_id,record.deleted_by_user_id,record.reason,record.record_data_json
      from public.deleted_records record
      where record.audit_log_id=a.log_id
      order by record.deleted_id desc limit 1
    )deleted on true
    left join lateral(
      select jsonb_agg(jsonb_build_object(
        'id',change.change_id,
        'field',change.field_name,
        'fieldLabel',public.audit_change_field_label(change.field_name),
        'oldValue',case when length(coalesce(change.old_value,''))>1000 then left(change.old_value,1000)||'…' else change.old_value end,
        'newValue',case when length(coalesce(change.new_value,''))>1000 then left(change.new_value,1000)||'…' else change.new_value end,
        'changeType',coalesce(nullif(change.change_type,''),'MODIFICACION')
      )order by change.change_id)items,count(*)::integer change_count
      from public.change_log change
      where change.audit_log_id=a.log_id
        and not public.audit_change_is_technical_field(change.field_name)
        and not public.audit_change_is_sensitive_field(change.field_name)
    )changes on true
    where a."timestamp">=month_start::timestamp at time zone 'America/Costa_Rica'
      and a."timestamp"<month_end::timestamp at time zone 'America/Costa_Rica'
      and public.audit_change_action_code(a.action)is not null
  ),business_events as(
    select source.*,
      coalesce(source.user_id,source.deleted_by_user_id)actor_user_id,
      coalesce(nullif(source.created_by_name,''),
        nullif(trim(concat_ws(' ',actor.first_name,actor.last_name)),''),
        nullif(source.created_by_email,''),actor.email,'Proceso del sistema')actor_name,
      coalesce(nullif(source.created_by_email,''),actor.email,'sistema@gentia.local')actor_email,
      coalesce(nullif(source.actor_type,''),case when actor.user_id is null then 'SYSTEM_JOB'else'HUMAN'end)actor_kind,
      coalesce(nullif(source.actor_source,''),'Gentia ERP')actor_origin
    from event_source source
    left join public.users actor on actor.user_id=coalesce(source.user_id,source.deleted_by_user_id)
    where source.action_code='ELIMINACION'or source.change_count>0
  ),filtered as(
    select event.*
    from business_events event
    where(user_filter is null or event.actor_user_id=user_filter)
      and(action_filter='ALL'or event.action_code=action_filter)
      and(module_filter is null or event.meta->>'moduleCode'=module_filter)
      and(entity_filter is null or lower(event.entity_type)=entity_filter)
      and(search_filter=''or lower(concat_ws(' ',
        event.actor_name,event.actor_email,event.entity_type,event.meta->>'entityLabel',
        event.entity_key,event.entity_id::text,event.description,event.changes::text,
        event.deleted_snapshot::text,event.reason
      ))like'%'||search_filter||'%')
  ),totals as(
    select count(*)::integer record_count,
      count(*)filter(where action_code='MODIFICACION')::integer modified_count,
      count(*)filter(where action_code='ELIMINACION')::integer deleted_count,
      coalesce(sum(change_count),0)::integer changed_field_count,
      count(distinct coalesce(actor_user_id::text,actor_email))::integer user_count,
      count(distinct entity_type)::integer entity_type_count,
      count(distinct coalesce(nullif(execution_context_id,''),log_id::text))::integer operation_count
    from filtered
  ),by_user as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',metric.actor_user_id,'name',metric.actor_name,'email',metric.actor_email,
      'modified',metric.modified_count,'deleted',metric.deleted_count,
      'events',metric.record_count,'records',metric.record_count,
      'operations',metric.operation_count,'changedFields',metric.changed_field_count
    )order by metric.record_count desc,metric.actor_name),'[]'::jsonb)value,
      (array_agg(metric.actor_name order by metric.record_count desc,metric.actor_name))[1]most_active_user
    from(
      select actor_user_id,actor_name,actor_email,count(*)::integer record_count,
        count(*)filter(where action_code='MODIFICACION')::integer modified_count,
        count(*)filter(where action_code='ELIMINACION')::integer deleted_count,
        coalesce(sum(change_count),0)::integer changed_field_count,
        count(distinct coalesce(nullif(execution_context_id,''),log_id::text))::integer operation_count
      from filtered group by actor_user_id,actor_name,actor_email
    )metric
  ),by_module as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'module',metric.module_code,'code',metric.module_code,'label',metric.module_label,
      'modified',metric.modified_count,'deleted',metric.deleted_count,
      'events',metric.record_count,'records',metric.record_count
    )order by metric.record_count desc,metric.module_label),'[]'::jsonb)value
    from(
      select meta->>'moduleCode'module_code,meta->>'moduleLabel'module_label,
        count(*)::integer record_count,
        count(*)filter(where action_code='MODIFICACION')::integer modified_count,
        count(*)filter(where action_code='ELIMINACION')::integer deleted_count
      from filtered group by meta->>'moduleCode',meta->>'moduleLabel'
    )metric
  ),by_day as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'date',metric.day_value,'modified',metric.modified_count,
      'deleted',metric.deleted_count,'events',metric.record_count,'records',metric.record_count
    )order by metric.day_value),'[]'::jsonb)value
    from(
      select (occurred_at at time zone 'America/Costa_Rica')::date day_value,count(*)::integer record_count,
        count(*)filter(where action_code='MODIFICACION')::integer modified_count,
        count(*)filter(where action_code='ELIMINACION')::integer deleted_count
      from filtered group by 1
    )metric
  ),paged as(
    select * from filtered
    order by occurred_at desc,log_id desc
    limit page_size offset(page_size*(page_number-1))
  )
  select jsonb_build_object(
    'header',jsonb_build_object(
      'title','Registros modificados y eliminados',
      'month',month_text,'dateFrom',month_start,'dateTo',(month_end-1),
      'periodLabel',month_text,
      'timeZone','America/Costa_Rica','generatedAt',current_timestamp,
      'filterDescription',concat_ws(' · ',
        case when user_filter is null then 'Todos los usuarios'else'Usuario seleccionado'end,
        case when action_filter='ALL'then'Modificados y eliminados'
          when action_filter='MODIFICACION'then'Solo modificados'else'Solo eliminados'end,
        coalesce(module_filter,'Todos los módulos')
      ),
      'filters',jsonb_build_object(
        'userId',user_filter,'action',action_filter,'module',module_filter,
        'entityType',entity_filter,'search',search_filter
      )
    ),
    'summary',jsonb_build_object(
      'recordCount',totals.record_count,
      'totalEvents',totals.record_count,
      'modifiedCount',totals.modified_count,
      'deletedCount',totals.deleted_count,
      'changedFieldCount',totals.changed_field_count,
      'fieldChanges',totals.changed_field_count,
      'changedFields',totals.changed_field_count,
      'userCount',totals.user_count,
      'usersCount',totals.user_count,
      'entityTypeCount',totals.entity_type_count,
      'operationCount',totals.operation_count,
      'mostActiveUser',by_user.most_active_user,
      'deletionRate',case when totals.record_count=0 then 0
        else round(totals.deleted_count::numeric*100/totals.record_count,2)end,
      'byUser',by_user.value,'byModule',by_module.value,'byDay',by_day.value
    ),
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'auditId',row.log_id,
      'auditLogId',row.log_id,
      'deletedRecordId',row.deleted_id,
      'timestamp',row.occurred_at,
      'occurredAt',row.occurred_at,
      'executionContextId',row.execution_context_id,
      'action',row.action_code,
      'actionLabel',case row.action_code when'MODIFICACION'then'Modificado'else'Eliminado'end,
      'actor',jsonb_build_object(
        'id',row.actor_user_id,'name',row.actor_name,'email',row.actor_email,
        'type',row.actor_kind,'actorType',row.actor_kind,'source',row.actor_origin
      ),
      'module',row.meta->>'moduleCode',
      'moduleLabel',row.meta->>'moduleLabel',
      'entityType',row.entity_type,
      'entityLabel',row.meta->>'entityLabel',
      'entityId',row.entity_id,
      'entityKey',coalesce(row.entity_key,row.entity_id::text),
      'recordLabel',coalesce(
        nullif(row.deleted_snapshot->>'invoice_number',''),
        nullif(row.deleted_snapshot->>'document_number',''),
        nullif(row.deleted_snapshot->>'journal_number',''),
        nullif(row.deleted_snapshot->>'request_number',''),
        nullif(row.deleted_snapshot->>'reference_number',''),
        nullif(row.deleted_snapshot->>'code',''),
        nullif(row.deleted_snapshot->>'name',''),
        (select nullif(change->>'newValue','')from jsonb_array_elements(row.changes)change
          where change->>'field'in('invoice_number','document_number','journal_number','request_number','reference_number','code','name')limit 1),
        row.meta->>'entityLabel'
      ),
      'description',row.description,
      'result',row.result,
      'ipAddress',row.ip_address,
      'changeCount',row.change_count,
      'fieldsChangedCount',row.change_count,
      'changes',row.changes,
      'deletedSnapshot',case when row.action_code='ELIMINACION'then row.deleted_snapshot end,
      'deletionReason',case when row.action_code='ELIMINACION'then row.reason end
    )order by row.occurred_at desc,row.log_id desc)from paged row),'[]'::jsonb),
    'total',totals.record_count,
    'page',page_number,
    'pageSize',page_size,
    'totalPages',case when totals.record_count=0 then 0 else ceil(totals.record_count::numeric/page_size)::integer end
  )into result
  from totals,by_user,by_module,by_day;

  return result;
end
$$;

comment on function public.audit_change_report_options() is
  'Filtros autorizados para el reporte mensual de registros modificados y eliminados.';
comment on function public.run_audit_change_report(jsonb) is
  'Reporte mensual paginado de modificaciones y eliminaciones, con actor, campos antes/después y snapshot de eliminados sanitizado.';

revoke all on function public.audit_change_action_code(text) from public,anon,authenticated;
revoke all on function public.audit_change_is_technical_field(text) from public,anon,authenticated;
revoke all on function public.audit_change_is_sensitive_field(text) from public,anon,authenticated;
revoke all on function public.audit_change_field_label(text) from public,anon,authenticated;
revoke all on function public.audit_change_entity_meta(text,text) from public,anon,authenticated;
revoke all on function public.audit_change_try_jsonb(text) from public,anon,authenticated;
revoke all on function public.audit_change_sanitize_snapshot(jsonb) from public,anon,authenticated;
revoke all on function public.audit_change_report_options() from public,anon;
revoke all on function public.run_audit_change_report(jsonb) from public,anon;

grant execute on function public.audit_change_report_options() to authenticated,service_role;
grant execute on function public.run_audit_change_report(jsonb) to authenticated,service_role;

-- La política histórica permitía leer las bitácoras completas a cualquier sesión
-- autenticada. El reporte usa funciones autorizadas y sanitizadas; los catálogos
-- técnicos conservan lectura directa únicamente cuando el rol activo tiene el
-- permiso de Auditoría correspondiente.
create or replace function public.audit_has_direct_read(p_resource_key text)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select public.app_is_admin()or exists(
    select 1
    from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and access.can_view
      and access.resource_key in('legacy:all',p_resource_key)
  )
$$;
revoke all on function public.audit_has_direct_read(text) from public,anon;
grant execute on function public.audit_has_direct_read(text) to authenticated,service_role;

drop policy if exists audit_select on public.audit_log;
drop policy if exists audit_select on public.change_log;
drop policy if exists audit_select on public.event_log;
drop policy if exists audit_select on public.activity_log;
drop policy if exists audit_select on public.deleted_records;
create policy audit_select on public.audit_log for select to authenticated
  using(public.audit_has_direct_read('audit:audit-logs'));
create policy audit_select on public.change_log for select to authenticated
  using(public.audit_has_direct_read('audit:change-logs'));
create policy audit_select on public.event_log for select to authenticated
  using(public.audit_has_direct_read('audit:event-logs'));
create policy audit_select on public.activity_log for select to authenticated
  using(public.audit_has_direct_read('audit:activity-logs'));
create policy audit_select on public.deleted_records for select to authenticated
  using(public.audit_has_direct_read('audit:deleted-records'));

notify pgrst,'reload schema';
