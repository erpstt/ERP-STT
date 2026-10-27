begin;

-- Direct tax payments need a typed third party all the way from the request
-- through the bank document and its accounting journal.
alter table public.solicitudes_pago_lineas
  add column if not exists id_agencia_tributaria bigint
  references public.tax_agencies(tax_agency_id);
alter table public.bank_check_line
  add column if not exists tax_agency_id bigint
  references public.tax_agencies(tax_agency_id);
alter table public.journal_line
  add column if not exists tax_agency_id bigint
  references public.tax_agencies(tax_agency_id);

alter table public.solicitudes_pago_lineas
  drop constraint if exists solicitudes_pago_lineas_tipo_tercero_check;
alter table public.solicitudes_pago_lineas
  add constraint solicitudes_pago_lineas_tipo_tercero_check
  check(tipo_tercero in(
    'Cliente','Proveedor','Empleado','Agencia Tributaria'
  ));

alter table public.solicitudes_pago_lineas
  drop constraint if exists solicitudes_pago_lineas_check1;
alter table public.solicitudes_pago_lineas
  drop constraint if exists solicitudes_pago_lineas_single_party_check;
alter table public.solicitudes_pago_lineas
  add constraint solicitudes_pago_lineas_single_party_check
  check(num_nonnulls(
    id_cliente,id_proveedor,id_empleado,id_agencia_tributaria
  )<=1);

alter table public.journal_line
  drop constraint if exists journal_line_entity_type_allowed;
alter table public.journal_line
  add constraint journal_line_entity_type_allowed
  check(entity_type is null or entity_type in(
    'Cliente','Proveedor','Empleado','Agencia Tributaria'
  ));

create index if not exists solicitudes_pago_lineas_tax_agency_idx
  on public.solicitudes_pago_lineas(id_agencia_tributaria,id_solicitud)
  where id_agencia_tributaria is not null;
create index if not exists bank_check_line_tax_agency_idx
  on public.bank_check_line(tax_agency_id,check_id)
  where tax_agency_id is not null;
create index if not exists journal_line_tax_agency_idx
  on public.journal_line(tax_agency_id,journal_id)
  where tax_agency_id is not null;

create or replace function public.pr_validate(p_id bigint)
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  header_row public.solicitudes_pago%rowtype;
  line_row public.solicitudes_pago_lineas%rowtype;
  line_count integer:=0;
  total_amount numeric:=0;
  reserved_amount numeric:=0;
begin
  select * into strict header_row
  from public.solicitudes_pago
  where id=p_id and id_subsidiaria=public.pr_access();

  if not exists(
    select 1 from public.subsidiary_currencies
    where subsidiary_id=header_row.id_subsidiaria
      and currency_id=header_row.id_moneda
  )and header_row.id_moneda<>(
    select currency_id from public.subsidiaries
    where subsidiary_id=header_row.id_subsidiaria
  )then
    raise exception 'La moneda no esta autorizada para la subsidiaria.';
  end if;

  if header_row.tipo_solicitud='CXP'and not exists(
    select 1 from public.suppliers supplier
    where supplier.supplier_id=header_row.id_proveedor
      and(
        supplier.primary_subsidiary_id=header_row.id_subsidiaria
        or exists(
          select 1 from public.entity_subsidiaries scope
          where scope.supplier_id=supplier.supplier_id
            and scope.subsidiary_id=header_row.id_subsidiaria
        )
      )
  )then
    raise exception 'Proveedor no autorizado para esta subsidiaria.';
  end if;

  for line_row in
    select * from public.solicitudes_pago_lineas
    where id_solicitud=header_row.id
  loop
    line_count:=line_count+1;
    total_amount:=total_amount+line_row.monto;

    if header_row.tipo_solicitud='CXP'then
      perform pg_advisory_xact_lock(hashtextextended(
        'payment-request-invoice:'||line_row.id_factura_proveedor,0
      ));
      if not exists(
        select 1 from public.supplier_invoice invoice
        where invoice.invoice_id=line_row.id_factura_proveedor
          and invoice.subsidiary_id=header_row.id_subsidiaria
          and invoice.supplier_id=header_row.id_proveedor
          and invoice.currency_id=header_row.id_moneda
      )then
        raise exception 'Seleccione facturas del proveedor y de la misma moneda.';
      end if;
      select coalesce(sum(other_line.monto),0)
      into reserved_amount
      from public.solicitudes_pago_lineas other_line
      join public.solicitudes_pago other_request
        on other_request.id=other_line.id_solicitud
      where other_line.id_factura_proveedor=line_row.id_factura_proveedor
        and other_request.id<>header_row.id
        and other_request.estado in(
          'BORRADOR','PENDIENTE_APROBACION','APROBADO'
        );
      if line_row.monto>
        public.pr_invoice_balance(line_row.id_factura_proveedor)-reserved_amount
      then
        raise exception
          'La factura % tiene saldo reservado por otra Solicitud de Pago pendiente o aprobada.',
          line_row.id_factura_proveedor;
      end if;
    else
      if not public.pr_allowed_account(line_row.id_cuenta_contable)then
        raise exception
          'Cuenta no habilitada para solicitudes de pago. Seleccione una cuenta permitida de Activo/Pasivo o una cuenta de Costo/Gasto autorizada.';
      end if;
      if nullif(trim(line_row.concepto),'')is null then
        raise exception 'Indique el concepto de cada imputacion.';
      end if;
      if line_row.tipo_tercero is null
        or(line_row.tipo_tercero='Cliente'and line_row.id_cliente is null)
        or(line_row.tipo_tercero='Proveedor'and line_row.id_proveedor is null)
        or(line_row.tipo_tercero='Empleado'and line_row.id_empleado is null)
        or(line_row.tipo_tercero='Agencia Tributaria'
          and line_row.id_agencia_tributaria is null)
      then
        raise exception 'Seleccione el tercero de cada imputacion.';
      end if;
      if line_row.id_cliente is not null and not exists(
        select 1 from public.customers customer
        where customer.customer_id=line_row.id_cliente
          and(
            customer.primary_subsidiary_id=header_row.id_subsidiaria
            or exists(
              select 1 from public.entity_subsidiaries scope
              where scope.customer_id=customer.customer_id
                and scope.subsidiary_id=header_row.id_subsidiaria
            )
          )
      )then
        raise exception 'Cliente fuera de la subsidiaria.';
      end if;
      if line_row.id_proveedor is not null and not exists(
        select 1 from public.suppliers supplier
        where supplier.supplier_id=line_row.id_proveedor
          and(
            supplier.primary_subsidiary_id=header_row.id_subsidiaria
            or exists(
              select 1 from public.entity_subsidiaries scope
              where scope.supplier_id=supplier.supplier_id
                and scope.subsidiary_id=header_row.id_subsidiaria
            )
          )
      )then
        raise exception 'Proveedor fuera de la subsidiaria.';
      end if;
      if line_row.id_empleado is not null and not exists(
        select 1 from public.employees employee
        where employee.employee_id=line_row.id_empleado
          and employee.subsidiary_id=header_row.id_subsidiaria
          and employee.is_active
      )then
        raise exception 'Empleado fuera de la subsidiaria o inactivo.';
      end if;
      if line_row.id_agencia_tributaria is not null and not exists(
        select 1
        from public.tax_agency_subsidiaries scope
        join public.tax_agencies agency using(tax_agency_id)
        join public.subsidiaries subsidiary
          on subsidiary.subsidiary_id=scope.subsidiary_id
        where scope.tax_agency_id=line_row.id_agencia_tributaria
          and scope.subsidiary_id=header_row.id_subsidiaria
          and agency.country_id=subsidiary.country_id
      )then
        raise exception
          'La agencia tributaria no pertenece a la subsidiaria seleccionada.';
      end if;
      if line_row.id_centro_costo is not null and not exists(
        select 1 from public.cost_centers cost_center
        where cost_center.cost_center_id=line_row.id_centro_costo
          and cost_center.subsidiary_id=header_row.id_subsidiaria
      )then
        raise exception 'Centro de costo fuera de la subsidiaria.';
      end if;
    end if;
  end loop;

  if line_count=0 or total_amount<>header_row.total then
    raise exception 'La solicitud requiere lineas y un total consistente.';
  end if;
end
$$;

create or replace function public.pr_options()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.pr_access();
  result jsonb;
begin
  select jsonb_build_object(
    'userId',public.app_user_id(),
    'admin',public.app_is_admin(),
    'canApprove',public.pr_can_approve(),
    'canExecute',public.pr_can_execute(),
    'company',(select name from public.subsidiaries where subsidiary_id=sid),
    'baseCurrencyId',(
      select currency_id from public.subsidiaries where subsidiary_id=sid
    ),
    'currencies',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',currency.currency_id,'name',currency.currency_code
      )order by currency.currency_code)
      from public.currencies currency
      where currency.currency_id in(
        select subsidiary_currency.currency_id
        from public.subsidiary_currencies subsidiary_currency
        where subsidiary_currency.subsidiary_id=sid
        union
        select subsidiary.currency_id
        from public.subsidiaries subsidiary
        where subsidiary.subsidiary_id=sid
      )
    ),'[]'::jsonb),
    'suppliers',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',supplier.supplier_id,
        'name',concat_ws(' / ',supplier.company_name,supplier.tax_id)
      )order by supplier.company_name)
      from public.suppliers supplier
      where supplier.primary_subsidiary_id=sid
        or exists(
          select 1 from public.entity_subsidiaries scope
          where scope.supplier_id=supplier.supplier_id
            and scope.subsidiary_id=sid
        )
    ),'[]'::jsonb),
    'customers',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',customer.customer_id,'name',customer.company_name
      )order by customer.company_name)
      from public.customers customer
      where customer.primary_subsidiary_id=sid
        or exists(
          select 1 from public.entity_subsidiaries scope
          where scope.customer_id=customer.customer_id
            and scope.subsidiary_id=sid
        )
    ),'[]'::jsonb),
    'employees',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',employee.employee_id,
        'name',concat_ws(' ',employee.first_name,employee.last_name)
      )order by employee.first_name,employee.last_name)
      from public.employees employee
      where employee.subsidiary_id=sid and employee.is_active
    ),'[]'::jsonb),
    'taxAgencies',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',agency.tax_agency_id,
        'name',agency.agency_name,
        'taxId',agency.tax_id,
        'countryId',agency.country_id
      )order by agency.agency_name)
      from public.tax_agency_subsidiaries scope
      join public.tax_agencies agency using(tax_agency_id)
      join public.subsidiaries subsidiary
        on subsidiary.subsidiary_id=scope.subsidiary_id
      where scope.subsidiary_id=sid
        and agency.country_id=subsidiary.country_id
    ),'[]'::jsonb),
    'users',coalesce((
      select jsonb_agg(jsonb_build_object('id',account.user_id,'name',account.email))
      from public.users account
      join public.user_subsidiaries scope using(user_id)
      where scope.subsidiary_id=sid
    ),'[]'::jsonb),
    'accounts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',account.account_id,
        'name',account.account_number||' / '||account.account_name
      )order by account.account_number)
      from public.chart_accounts account
      where public.pr_allowed_account(account.account_id)
    ),'[]'::jsonb),
    'costCenters',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',cost_center.cost_center_id,'name',cost_center.name
      )order by cost_center.name)
      from public.cost_centers cost_center
      where cost_center.subsidiary_id=sid
    ),'[]'::jsonb),
    'banks',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',bank_account.bank_account_id,
        'name',concat_ws(
          ' / ',bank.bank_name,bank_account.account_number,currency.currency_code
        ),
        'currencyId',bank_account.currency_id
      )order by bank.bank_name,bank_account.account_number)
      from public.bank_account bank_account
      join public.banks bank using(bank_id)
      join public.currencies currency using(currency_id)
      where bank_account.subsidiary_id=sid
        and not coalesce(bank_account.is_credit_card,false)
    ),'[]'::jsonb),
    'rates',coalesce((
      select jsonb_agg(jsonb_build_object(
        'currencyId',rate.from_currency_id,
        'date',rate.effective_date,
        'rate',rate.spot_rate
      )order by rate.effective_date desc)
      from public.exchange_rates rate
      where rate.to_currency_id=(
        select currency_id from public.subsidiaries where subsidiary_id=sid
      )
    ),'[]'::jsonb)
  )into result;
  return result;
end
$$;

create or replace function public.pr_save_without_budget(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.pr_access();
  header_row public.solicitudes_pago%rowtype;
  line jsonb;
  request_id bigint;
  transaction_type_key bigint;
  request_number text;
  request_total numeric;
  request_type text:=p->>'type';
begin
  if request_type is null or request_type not in('CXP','OTROS')then
    raise exception 'Seleccione el tipo de solicitud.';
  end if;
  if nullif(p->>'plannedDate','')is null
    or nullif(trim(p->>'concept'),'')is null
  then
    raise exception 'Indique fecha programada y concepto.';
  end if;
  if jsonb_typeof(p->'lines')is distinct from 'array'
    or jsonb_array_length(p->'lines')=0
    or jsonb_array_length(p->'lines')>500
  then
    raise exception 'Agregue entre 1 y 500 lineas.';
  end if;
  select sum((item->>'amount')::numeric)
  into request_total
  from jsonb_array_elements(p->'lines')item;
  if request_total is null or request_total<=0 or request_total>1000000000000 then
    raise exception 'Importe no valido.';
  end if;

  if nullif(p->>'id','')is not null then
    select * into header_row
    from public.solicitudes_pago
    where id=(p->>'id')::bigint and id_subsidiaria=sid
    for update;
    if header_row.id is null
      or header_row.estado not in('BORRADOR','RECHAZADO')
      or(
        header_row.id_solicitante<>public.app_user_id()
        and not public.app_is_admin()
      )
    then
      raise exception 'No puede modificar esta solicitud.';
    end if;
    if header_row.version is distinct from(p->>'version')::integer then
      raise exception 'La solicitud cambio. Vuelva a abrirla.';
    end if;
    request_id:=header_row.id;
    update public.solicitudes_pago
    set tipo_solicitud=request_type,
        id_moneda=(p->>'currencyId')::bigint,
        id_proveedor=case when request_type='CXP'
          then(p->>'supplierId')::bigint end,
        fecha_pago_programada=(p->>'plannedDate')::date,
        concepto=trim(p->>'concept'),
        total=request_total,
        estado='BORRADOR',
        version=version+1,
        updated_at=now()
    where id=request_id;
    delete from public.solicitudes_pago_lineas
    where id_solicitud=request_id;
  else
    select transaction_type_id into transaction_type_key
    from public.transaction_types where abbreviation='SOL_PAG';
    begin
      request_number:=public.next_transaction_number(transaction_type_key,sid);
    exception when others then
      request_number:='SOL_PAG-'||to_char(
        clock_timestamp(),'YYYYMMDDHH24MISSMS'
      );
    end;
    insert into public.solicitudes_pago(
      numero,id_subsidiaria,id_moneda,tipo_solicitud,
      fecha_pago_programada,id_solicitante,id_proveedor,concepto,total
    )values(
      request_number,sid,(p->>'currencyId')::bigint,request_type,
      (p->>'plannedDate')::date,public.app_user_id(),
      case when request_type='CXP'then(p->>'supplierId')::bigint end,
      trim(p->>'concept'),request_total
    )returning id into request_id;
  end if;

  for line in select value from jsonb_array_elements(p->'lines')loop
    insert into public.solicitudes_pago_lineas(
      id_solicitud,id_factura_proveedor,id_cuenta_contable,tipo_tercero,
      id_cliente,id_proveedor,id_empleado,id_agencia_tributaria,
      id_centro_costo,concepto,monto
    )values(
      request_id,
      case when request_type='CXP'then(line->>'invoiceId')::bigint end,
      case when request_type='OTROS'then(line->>'accountId')::bigint end,
      case when request_type='OTROS'then line->>'entityType'end,
      case when request_type='OTROS'and line->>'entityType'='Cliente'
        then(line->>'entityId')::bigint end,
      case when request_type='OTROS'and line->>'entityType'='Proveedor'
        then(line->>'entityId')::bigint end,
      case when request_type='OTROS'and line->>'entityType'='Empleado'
        then(line->>'entityId')::bigint end,
      case when request_type='OTROS'
        and line->>'entityType'='Agencia Tributaria'
        then(line->>'entityId')::bigint end,
      case when request_type='OTROS'
        then nullif(line->>'costCenterId','')::bigint end,
      line->>'concept',(line->>'amount')::numeric
    );
  end loop;

  perform public.pr_validate(request_id);
  insert into public.solicitudes_pago_eventos(
    id_solicitud,usuario,accion
  )values(request_id,public.app_user_id(),'GUARDAR_BORRADOR');
  return jsonb_build_object('id',request_id);
end
$$;

create or replace function public.pr_detail(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  header_row public.solicitudes_pago%rowtype;
begin
  select * into header_row
  from public.solicitudes_pago
  where id=(p->>'id')::bigint and id_subsidiaria=public.pr_access();
  if header_row.id is null then
    raise exception 'Solicitud no encontrada.';
  end if;
  return jsonb_build_object(
    'header',to_jsonb(header_row),
    'lines',coalesce((
      select jsonb_agg(
        to_jsonb(line)||jsonb_build_object(
          'invoiceNumber',invoice.invoice_number,
          'invoiceDate',invoice.invoice_date,
          'invoiceDueDate',invoice.due_date,
          'invoiceTotal',invoice.total_amount,
          'accountName',account.account_number||' / '||account.account_name,
          'party',coalesce(
            customer.company_name,supplier.company_name,
            nullif(trim(concat_ws(
              ' ',employee.first_name,employee.last_name
            )),''),
            agency.agency_name
          ),
          'costCenter',cost_center.name
        )order by line.id
      )
      from public.solicitudes_pago_lineas line
      left join public.supplier_invoice invoice
        on invoice.invoice_id=line.id_factura_proveedor
      left join public.chart_accounts account
        on account.account_id=line.id_cuenta_contable
      left join public.customers customer
        on customer.customer_id=line.id_cliente
      left join public.suppliers supplier
        on supplier.supplier_id=line.id_proveedor
      left join public.employees employee
        on employee.employee_id=line.id_empleado
      left join public.tax_agencies agency
        on agency.tax_agency_id=line.id_agencia_tributaria
      left join public.cost_centers cost_center
        on cost_center.cost_center_id=line.id_centro_costo
      where line.id_solicitud=header_row.id
    ),'[]'::jsonb),
    'events',coalesce((
      select jsonb_agg(
        to_jsonb(event)||jsonb_build_object('user',account.email)
        order by event.id
      )
      from public.solicitudes_pago_eventos event
      join public.users account on account.user_id=event.usuario
      where event.id_solicitud=header_row.id
    ),'[]'::jsonb)
  );
end
$$;

-- Preserve the established bank transaction implementation. The wrapper
-- enriches only Agencia Tributaria lines after the existing atomic posting.
do $$
begin
  if to_regprocedure(
    'public.save_bank_check_transfer_without_tax_agency(jsonb,bigint)'
  )is null then
    alter function public.save_bank_check_transfer(jsonb,bigint)
      rename to save_bank_check_transfer_without_tax_agency;
  end if;
end
$$;

revoke all on function
  public.save_bank_check_transfer_without_tax_agency(jsonb,bigint)
from public,anon,authenticated;

create or replace function public.save_bank_check_transfer(
  p_payload jsonb,
  p_check_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.active_subsidiary_id();
  source_line record;
  result jsonb;
  check_key bigint;
  journal_key bigint;
begin
  for source_line in
    select item.value line,item.ordinality::integer line_number
    from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb))
      with ordinality item(value,ordinality)
    where item.value->>'entity_type'='Agencia Tributaria'
  loop
    if nullif(source_line.line->>'entity_id','')is null then
      raise exception 'Seleccione la agencia tributaria de cada imputacion.';
    end if;
    if not exists(
      select 1
      from public.tax_agency_subsidiaries scope
      join public.tax_agencies agency using(tax_agency_id)
      join public.subsidiaries subsidiary
        on subsidiary.subsidiary_id=scope.subsidiary_id
      where scope.tax_agency_id=(source_line.line->>'entity_id')::bigint
        and scope.subsidiary_id=sid
        and agency.country_id=subsidiary.country_id
    )then
      raise exception
        'La agencia tributaria no pertenece a la subsidiaria seleccionada.';
    end if;
  end loop;

  result:=public.save_bank_check_transfer_without_tax_agency(
    p_payload,p_check_id
  );
  check_key:=(result->>'checkId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  update public.bank_check_line target
  set tax_agency_id=(source.line->>'entity_id')::bigint
  from(
    select item.value line,item.ordinality::integer line_number
    from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb))
      with ordinality item(value,ordinality)
    where item.value->>'entity_type'='Agencia Tributaria'
  )source
  where target.check_id=check_key
    and target.line_number=source.line_number;

  perform set_config('nexo.defer_journal_gl_sync','on',true);
  with numbered_lines as(
    select line.journal_line_id,
      row_number()over(order by line.journal_line_id)::integer line_number
    from public.journal_line line
    where line.journal_id=journal_key
      and line.debit>0 and line.credit=0
  ),agency_lines as(
    select item.value line,item.ordinality::integer line_number
    from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb))
      with ordinality item(value,ordinality)
    where item.value->>'entity_type'='Agencia Tributaria'
  )
  update public.journal_line target
  set tax_agency_id=(agency.line->>'entity_id')::bigint
  from numbered_lines numbered
  join agency_lines agency using(line_number)
  where target.journal_line_id=numbered.journal_line_id;
  perform set_config('nexo.defer_journal_gl_sync','off',true);

  return result;
exception when others then
  perform set_config('nexo.defer_journal_gl_sync','off',true);
  raise;
end
$$;

create or replace function public.pr_execute_without_budget(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  sid bigint:=public.pr_access();
  header_row public.solicitudes_pago%rowtype;
  bank_row public.bank_account%rowtype;
  payment_date date:=(p->>'date')::date;
  exchange_rate numeric:=(p->>'rate')::numeric;
  period_key bigint;
  payment_data jsonb;
  result jsonb;
  journal_key bigint;
  transaction_key bigint;
  payment_beneficiary text;
  payment_method text:=p->>'method';
begin
  if not public.pr_can_execute()then
    raise exception 'Solo Tesoreria o un administrador puede ejecutar pagos.';
  end if;
  select * into header_row
  from public.solicitudes_pago
  where id=(p->>'id')::bigint and id_subsidiaria=sid
  for update;
  if header_row.id is null then
    raise exception 'Solicitud no encontrada.';
  end if;
  if header_row.estado='APLICADO'then
    return jsonb_build_object('id',header_row.id,'journalId',header_row.journal_id);
  end if;
  if header_row.estado<>'APROBADO'
    or header_row.version is distinct from(p->>'version')::integer
  then
    raise exception
      'Solo puede ejecutar una solicitud aprobada y actualizada.';
  end if;
  if payment_method is null
    or payment_method not in('TRANSFERENCIA','CHEQUE','SINPE')
    or nullif(trim(p->>'reference'),'')is null
  then
    raise exception 'Seleccione metodo y referencia bancaria.';
  end if;
  if payment_date is null or exchange_rate is null
    or exchange_rate<=0 or exchange_rate>1000000000
  then
    raise exception 'Indique fecha real de pago y tipo de cambio positivo.';
  end if;

  select * into bank_row
  from public.bank_account
  where bank_account_id=(p->>'bankId')::bigint
    and subsidiary_id=sid
    and not coalesce(is_credit_card,false)
  for update;
  if bank_row.bank_account_id is null
    or bank_row.currency_id<>header_row.id_moneda
  then
    raise exception
      'Seleccione un banco de la subsidiaria en la moneda de la solicitud.';
  end if;
  if header_row.id_moneda=(
    select currency_id from public.subsidiaries where subsidiary_id=sid
  )and exchange_rate<>1 then
    raise exception 'La moneda funcional requiere tasa 1.';
  end if;
  select fiscal_period_id into period_key
  from public.fiscal_periods
  where subsidiary_id=sid
    and payment_date between start_date and end_date
    and not is_closed and not gl_closed and not is_inactive
    and(header_row.tipo_solicitud<>'CXP'or not ap_closed)
  order by start_date desc
  limit 1 for update;
  if period_key is null then
    raise exception 'No existe periodo contable abierto para ejecutar el pago.';
  end if;

  lock table public.supplier_payment_application,
    public.supplier_credit_note,public.supplier_debit_note
    in share row exclusive mode;
  perform 1 from public.supplier_invoice
  where invoice_id in(
    select id_factura_proveedor
    from public.solicitudes_pago_lineas
    where id_solicitud=header_row.id
  )order by invoice_id for update;
  perform public.pr_validate(header_row.id);

  if header_row.tipo_solicitud='CXP'then
    select jsonb_agg(jsonb_build_object(
      'invoice_id',id_factura_proveedor,'amount',monto
    ))into payment_data
    from public.solicitudes_pago_lineas
    where id_solicitud=header_row.id;
    perform set_config('nexo.payment_request_id',header_row.id::text,true);
    result:=public.save_supplier_payment(jsonb_build_object(
      'date',payment_date,'rate',exchange_rate,'period_id',period_key,
      'supplier_id',header_row.id_proveedor,
      'account_id',bank_row.bank_account_id,
      'reference',p->>'reference',
      'memo',header_row.numero||' / '||header_row.concepto||' / '||payment_method,
      'applications',payment_data
    ));
    perform set_config('nexo.payment_request_id','',true);
    journal_key:=(result->>'journalId')::bigint;
    select transaction_id into transaction_key
    from public.supplier_payment
    where payment_id=(result->>'id')::bigint;
    update public."transaction"
    set transaction_type_id=(
      select transaction_type_id from public.transaction_types
      where abbreviation='PAG_PRO'
    )where transaction_id=transaction_key;
    update public.solicitudes_pago
    set payment_id=(result->>'id')::bigint
    where id=header_row.id;
  else
    select jsonb_agg(jsonb_build_object(
      'account_id',id_cuenta_contable,
      'amount',monto,
      'entity_type',tipo_tercero,
      'entity_id',coalesce(
        id_cliente,id_proveedor,id_empleado,id_agencia_tributaria
      ),
      'cost_center_id',id_centro_costo,
      'note',concepto
    )order by id)into payment_data
    from public.solicitudes_pago_lineas
    where id_solicitud=header_row.id;
    select case
      when count(distinct concat_ws(
        ':',line.tipo_tercero,
        coalesce(
          line.id_cliente,line.id_proveedor,line.id_empleado,
          line.id_agencia_tributaria
        )::text
      ))=1 then max(coalesce(
        customer.company_name,supplier.company_name,
        nullif(trim(concat_ws(
          ' ',employee.first_name,employee.last_name
        )),''),
        agency.agency_name
      ))
      else header_row.concepto
    end into payment_beneficiary
    from public.solicitudes_pago_lineas line
    left join public.customers customer
      on customer.customer_id=line.id_cliente
    left join public.suppliers supplier
      on supplier.supplier_id=line.id_proveedor
    left join public.employees employee
      on employee.employee_id=line.id_empleado
    left join public.tax_agencies agency
      on agency.tax_agency_id=line.id_agencia_tributaria
    where line.id_solicitud=header_row.id;
    payment_beneficiary:=coalesce(
      nullif(trim(payment_beneficiary),''),header_row.concepto
    );
    result:=public.save_bank_check_transfer(jsonb_build_object(
      'payment_type',case when payment_method='SINPE'
        then'TRANSFERENCIA'else payment_method end,
      'payment_date',payment_date,
      'exchange_rate',exchange_rate,
      'fiscal_period_id',period_key,
      'bank_account_id',bank_row.bank_account_id,
      'currency_id',header_row.id_moneda,
      'bank_reference',p->>'reference',
      'beneficiary',payment_beneficiary,
      'memo',header_row.numero||' / '||header_row.concepto||' / '||payment_method,
      'lines',payment_data
    ));
    journal_key:=(result->>'journalId')::bigint;
    update public.solicitudes_pago
    set check_id=(result->>'checkId')::bigint
    where id=header_row.id;
  end if;

  update public.solicitudes_pago
  set estado='APLICADO',journal_id=journal_key,
      metodo_pago=payment_method,referencia_bancaria=p->>'reference',
      aplicado_por=public.app_user_id(),aplicado_at=now(),
      version=version+1,updated_at=now()
  where id=header_row.id;
  insert into public.solicitudes_pago_eventos(
    id_solicitud,usuario,accion,nota
  )values(
    header_row.id,public.app_user_id(),'APLICADO',
    payment_method||' / '||(p->>'reference')
  );
  return jsonb_build_object('id',header_row.id,'journalId',journal_key);
end
$$;

revoke all on function public.pr_validate(bigint),public.pr_save_without_budget(jsonb),
  public.pr_execute_without_budget(jsonb)
from public,anon,authenticated;
revoke all on function public.pr_options(),public.pr_detail(jsonb),
  public.save_bank_check_transfer(jsonb,bigint)
from public,anon;
grant execute on function public.pr_options(),public.pr_detail(jsonb),
  public.save_bank_check_transfer(jsonb,bigint)
to authenticated;

commit;

notify pgrst,'reload schema';
