CREATE OR REPLACE FUNCTION public.pr_execute_without_budget(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      'department_id',id_departamento,
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
    result:=bank_check_private.save_bank_check_transfer(jsonb_build_object(
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
$function$;
