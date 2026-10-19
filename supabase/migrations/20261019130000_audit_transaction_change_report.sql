-- Presenta la auditoria de calidad como documentos transaccionales.
-- Los catalogos, sesiones, telemetria y tablas auxiliares no forman parte
-- del reporte principal. Los cambios repetidos de un mismo documento dentro
-- de una ejecucion se consolidan en una sola fila.

create or replace function public.audit_change_transaction_entity_types()
returns text[]
language sql
immutable
parallel safe
set search_path=pg_catalog
as $$
  select array[
    'quotation','sales_order','sales_document','delivery','invoice',
    'credit_note','debit_note','customer_payment',
    'purchase_requisition','purchase_quote','purchase_order','purchase_document',
    'goods_receipt','supplier_invoice','supplier_credit_note','supplier_debit_note',
    'supplier_payment','solicitudes_pago','payment_batches',
    'journal','transaction','fx_revaluation_runs','pending_invoice_reversal',
    'opening_balance_runs',
    'bank_transaction','bank_statement','bank_reconciliation',
    'quadratic_bank_reconciliations','bank_transfer','bank_check','bank_deposit',
    'bank_fee','cash_transaction','cash_opening','cash_closing','cash_transfer',
    'expense','expense_payment',
    'stock_adjustment','stock_transfer',
    'asset_depreciation','asset_transfer','asset_disposal','asset_maintenance',
    'asset_revaluation','asset_impairment',
    'tax_calendar_events',
    'presupuestos_encabezado','presupuestos_modificaciones',
    'intercompany_eliminations'
  ]::text[]
$$;

create or replace function public.audit_change_transaction_meta(p_entity_type text)
returns jsonb
language plpgsql
immutable
parallel safe
set search_path=pg_catalog
as $$
declare
  entity_name text:=lower(trim(coalesce(p_entity_type,'')));
  group_code text;
  group_label text;
  type_label text;
  display_priority integer:=10;
begin
  case entity_name
    when 'quotation' then group_code:='sales'; group_label:='Ventas y cuentas por cobrar'; type_label:='Cotizacion de venta';
    when 'sales_order' then group_code:='sales'; group_label:='Ventas y cuentas por cobrar'; type_label:='Pedido de venta';
    when 'sales_document' then group_code:='sales'; group_label:='Ventas y cuentas por cobrar'; type_label:='Documento de venta';
    when 'delivery' then group_code:='sales'; group_label:='Ventas y cuentas por cobrar'; type_label:='Entrega de venta';
    when 'invoice' then group_code:='sales'; group_label:='Ventas y cuentas por cobrar'; type_label:='Factura de venta';
    when 'credit_note' then group_code:='sales'; group_label:='Ventas y cuentas por cobrar'; type_label:='Nota de credito de cliente';
    when 'debit_note' then group_code:='sales'; group_label:='Ventas y cuentas por cobrar'; type_label:='Nota de debito de cliente';
    when 'customer_payment' then group_code:='sales'; group_label:='Ventas y cuentas por cobrar'; type_label:='Cobro de cliente';

    when 'purchase_requisition' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Solicitud de compra';
    when 'purchase_quote' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Cotizacion de proveedor';
    when 'purchase_order' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Orden de compra';
    when 'purchase_document' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Documento de compra';
    when 'goods_receipt' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Recepcion de compra';
    when 'supplier_invoice' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Factura de proveedor';
    when 'supplier_credit_note' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Nota de credito de proveedor';
    when 'supplier_debit_note' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Nota de debito de proveedor';
    when 'supplier_payment' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Pago a proveedor';
    when 'solicitudes_pago' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Solicitud de pago';
    when 'payment_batches' then group_code:='purchasing'; group_label:='Compras y cuentas por pagar'; type_label:='Lote de pago';

    when 'journal' then group_code:='accounting'; group_label:='Contabilidad'; type_label:='Asiento de diario'; display_priority:=80;
    when 'transaction' then group_code:='accounting'; group_label:='Contabilidad'; type_label:='Transaccion contable'; display_priority:=90;
    when 'fx_revaluation_runs' then group_code:='accounting'; group_label:='Contabilidad'; type_label:='Revaluacion cambiaria';
    when 'pending_invoice_reversal' then group_code:='accounting'; group_label:='Contabilidad'; type_label:='Reversion de pendiente de facturar';
    when 'opening_balance_runs' then group_code:='accounting'; group_label:='Contabilidad'; type_label:='Carga de saldos iniciales';

    when 'bank_transaction' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Movimiento bancario'; display_priority:=70;
    when 'bank_statement' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Estado bancario';
    when 'bank_reconciliation' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Conciliacion bancaria';
    when 'quadratic_bank_reconciliations' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Prueba de efectivo';
    when 'bank_transfer' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Transferencia bancaria';
    when 'bank_check' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Cheque bancario';
    when 'bank_deposit' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Deposito bancario';
    when 'bank_fee' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Cargo bancario';
    when 'cash_transaction' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Movimiento de caja';
    when 'cash_opening' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Apertura de caja';
    when 'cash_closing' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Cierre de caja';
    when 'cash_transfer' then group_code:='treasury'; group_label:='Bancos y tesoreria'; type_label:='Transferencia entre cajas';

    when 'expense' then group_code:='expenses'; group_label:='Gastos'; type_label:='Solicitud de gasto';
    when 'expense_payment' then group_code:='expenses'; group_label:='Gastos'; type_label:='Pago de gasto';
    when 'stock_adjustment' then group_code:='inventory'; group_label:='Inventario'; type_label:='Ajuste de inventario';
    when 'stock_transfer' then group_code:='inventory'; group_label:='Inventario'; type_label:='Traslado de inventario';

    when 'asset_depreciation' then group_code:='fixed_assets'; group_label:='Activos fijos'; type_label:='Depreciacion de activo fijo';
    when 'asset_transfer' then group_code:='fixed_assets'; group_label:='Activos fijos'; type_label:='Traslado de activo fijo';
    when 'asset_disposal' then group_code:='fixed_assets'; group_label:='Activos fijos'; type_label:='Baja de activo fijo';
    when 'asset_maintenance' then group_code:='fixed_assets'; group_label:='Activos fijos'; type_label:='Mantenimiento de activo fijo';
    when 'asset_revaluation' then group_code:='fixed_assets'; group_label:='Activos fijos'; type_label:='Revaluacion de activo fijo';
    when 'asset_impairment' then group_code:='fixed_assets'; group_label:='Activos fijos'; type_label:='Deterioro de activo fijo';

    when 'tax_calendar_events' then group_code:='tax'; group_label:='Fiscal'; type_label:='Obligacion tributaria';
    when 'presupuestos_encabezado' then group_code:='planning'; group_label:='Planificacion y presupuesto'; type_label:='Version de presupuesto';
    when 'presupuestos_modificaciones' then group_code:='planning'; group_label:='Planificacion y presupuesto'; type_label:='Modificacion presupuestaria';
    when 'intercompany_eliminations' then group_code:='consolidation'; group_label:='Consolidacion'; type_label:='Eliminacion intercompania';
    else return null;
  end case;

  return jsonb_build_object(
    'groupCode',group_code,
    'groupLabel',group_label,
    'typeCode',entity_name,
    'typeLabel',type_label,
    'priority',display_priority,
    -- Aliases retained for clients that used the first version of the report.
    'moduleCode',group_code,
    'moduleLabel',group_label,
    'entityLabel',type_label
  );
end
$$;

-- Los registros historicos pueden contener identificadores vacios o no numericos.
-- La auditoria no debe fallar por un dato legado que no pueda convertirse a bigint.
create or replace function public.audit_change_try_bigint(p_value text)
returns bigint
language plpgsql
immutable
parallel safe
set search_path=pg_catalog
as $$
begin
  if nullif(trim(p_value),'') is null or trim(p_value)!~'^\d+$' then
    return null;
  end if;
  return trim(p_value)::bigint;
exception when numeric_value_out_of_range or invalid_text_representation then
  return null;
end
$$;

-- Rebuild the row as it existed immediately after a specific audit event.
-- The current business row is only a terminal state: every later audited
-- change is reversed before its values are used.  A later delete snapshot is
-- equally valid as a terminal state.  If the lifecycle cannot be proven (for
-- example, the key was recreated or neither row nor snapshot exists), return
-- NULL so subsidiary authorization fails closed.
create or replace function public.audit_change_historical_row(
  p_entity_type text,
  p_entity_id bigint,
  p_entity_key text,
  p_anchor_log_id bigint,
  p_exact_deleted_snapshot jsonb default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  entity_name text:=lower(trim(coalesce(p_entity_type,'')));
  identity_key text:=nullif(trim(coalesce(p_entity_key,'')),'');
  target_table regclass;
  pk_column text;
  key_value text;
  terminal_row jsonb;
  historical_row jsonb;
  boundary_log_id bigint;
  recreation_log_id bigint;
  field_change record;
begin
  if jsonb_typeof(coalesce(p_exact_deleted_snapshot,'{}'::jsonb))='object'
    and p_exact_deleted_snapshot<>'{}'::jsonb then
    return p_exact_deleted_snapshot;
  end if;
  if p_anchor_log_id is null
    or(identity_key is null and p_entity_id is null)
    or entity_name='' then
    return null;
  end if;

  target_table:=to_regclass(format('public.%I',entity_name));
  if target_table is null then return null; end if;
  select attribute.attname into pk_column
  from pg_catalog.pg_index index_data
  join lateral unnest(index_data.indkey)with ordinality key_data(attnum,position)on true
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid=index_data.indrelid and attribute.attnum=key_data.attnum
  where index_data.indrelid=target_table and index_data.indisprimary
  order by key_data.position limit 1;
  if pk_column is null then return null; end if;

  key_value:=case when identity_key is not null and position('=' in identity_key)>0
    then nullif(split_part(split_part(identity_key,'=',2),',',1),'')end;
  key_value:=coalesce(key_value,p_entity_id::text);
  if key_value is null then return null; end if;

  select later_event.log_id,public.audit_change_try_jsonb(deleted.record_data_json)
    into boundary_log_id,terminal_row
  from public.audit_log later_event
  join lateral(
    select record.record_data_json
    from public.deleted_records record
    where record.audit_log_id=later_event.log_id
    order by record.deleted_id desc limit 1
  )deleted on true
  where later_event.entity_type=entity_name
    and later_event.log_id>p_anchor_log_id
    and later_event.action in('ELIMINACION','DELETE','DELETED')
    and(
      (identity_key is not null and later_event.entity_key=identity_key)
      or(identity_key is null and later_event.entity_id=p_entity_id)
    )
  order by later_event.log_id limit 1;

  select min(later_event.log_id)into recreation_log_id
  from public.audit_log later_event
  where later_event.entity_type=entity_name
    and later_event.log_id>p_anchor_log_id
    and later_event.action in('CREACION','INSERT','CREATED')
    and(
      (identity_key is not null and later_event.entity_key=identity_key)
      or(identity_key is null and later_event.entity_id=p_entity_id)
    );
  if recreation_log_id is not null
    and(boundary_log_id is null or recreation_log_id<boundary_log_id)then
    return null;
  end if;

  if boundary_log_id is null then
    execute format('select to_jsonb(row_data) from %s row_data where %I::text=$1 limit 1',
      target_table,pk_column)using key_value into terminal_row;
  end if;
  if terminal_row is null
    or jsonb_typeof(coalesce(terminal_row,'{}'::jsonb))<>'object'
    or terminal_row='{}'::jsonb then
    return null;
  end if;
  historical_row:=terminal_row;

  for field_change in
    select change.field_name,change.old_value
    from public.audit_log later_event
    join public.change_log change on change.audit_log_id=later_event.log_id
    where later_event.entity_type=entity_name
      and later_event.log_id>p_anchor_log_id
      and(boundary_log_id is null or later_event.log_id<boundary_log_id)
      and later_event.action in('MODIFICACION','UPDATE','UPDATED','MODIFIED')
      and(
        (identity_key is not null and later_event.entity_key=identity_key)
        or(identity_key is null and later_event.entity_id=p_entity_id)
      )
    order by later_event.log_id desc,change.change_id desc
  loop
    historical_row:=jsonb_set(
      historical_row,array[field_change.field_name],
      coalesce(to_jsonb(field_change.old_value),'null'::jsonb),true
    );
  end loop;
  return historical_row;
end
$$;

create or replace function public.audit_change_transaction_identity(
  p_entity_type text,
  p_entity_id bigint,
  p_entity_key text,
  p_deleted_snapshot jsonb,
  p_changes jsonb,
  p_anchor_log_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  entity_name text:=lower(trim(coalesce(p_entity_type,'')));
  key_value text;
  source_row jsonb;
  related_row jsonb;
  source_related_row jsonb;
  target_related_row jsonb;
  field_name text;
  document_number text;
  document_transaction_id text;
  journal_id text;
  creator_id text;
  creator_name text;
  creator_email text;
  creation_id text;
  creation_name text;
  creation_email text;
  subsidiary_ids bigint[]:='{}'::bigint[];
  subsidiary_names text[]:='{}'::text[];
  primary_subsidiary_id bigint;
  source_subsidiary_id bigint;
  target_subsidiary_id bigint;
  meta jsonb:=public.audit_change_transaction_meta(p_entity_type);
begin
  if meta is null then return null; end if;
  key_value:=case when position('=' in coalesce(p_entity_key,''))>0
    then nullif(split_part(split_part(p_entity_key,'=',2),',',1),'')end;
  key_value:=coalesce(key_value,p_entity_id::text);
  source_row:=coalesce(public.audit_change_historical_row(
    entity_name,p_entity_id,p_entity_key,p_anchor_log_id,p_deleted_snapshot
  ),'{}'::jsonb);

  if entity_name='tax_calendar_events' then
    document_number:=nullif(concat_ws(' / ',nullif(source_row->>'tax_type_code',''),nullif(source_row->>'period','')),'');
  elsif entity_name='quadratic_bank_reconciliations' then
    document_number:=nullif(concat_ws('-',nullif(source_row->>'period_year',''),
      lpad(coalesce(nullif(source_row->>'period_month',''),'0'),2,'0')),'-00');
  end if;

  if document_number is null then
    foreach field_name in array array[
      'invoice_number','cn_number','dn_number','payment_number','numero','batch_number',
      'journal_number','tran_number','document_number','quote_number','so_number',
      'delivery_number','requisition_number','po_number','receipt_number',
      'transfer_number','check_number','deposit_number','fee_number','expense_number',
      'adjustment_number','disposal_number','maintenance_number','asset_number',
      'reference_number','filing_reference_number','nombre_version','budget_name'
    ] loop
      document_number:=nullif(trim(source_row->>field_name),'');
      exit when document_number is not null;
    end loop;
  end if;

  if document_number is null then
    foreach field_name in array array[
      'invoice_number','cn_number','dn_number','payment_number','numero','batch_number',
      'journal_number','tran_number','document_number','quote_number','so_number',
      'delivery_number','requisition_number','po_number','receipt_number',
      'transfer_number','check_number','deposit_number','fee_number','expense_number',
      'adjustment_number','reference_number','filing_reference_number','nombre_version'
    ] loop
      select coalesce(nullif(item->>'newValue',''),nullif(item->>'oldValue',''))
        into document_number
      from jsonb_array_elements(coalesce(p_changes,'[]'::jsonb)) item
      where item->>'field'=field_name
      order by coalesce(public.audit_change_try_bigint(item->>'id'),0) desc
      limit 1;
      exit when document_number is not null;
    end loop;
  end if;

  if document_number is null then
    document_number:=coalesce(
      nullif(key_value,''),
      nullif(p_entity_id::text,''),
      nullif(p_entity_key,''),
      'Sin referencia'
    );
    if document_number<>'Sin referencia' then
      document_number:=(meta->>'typeLabel')||' #'||document_number;
    end if;
  end if;

  document_transaction_id:=nullif(source_row->>'transaction_id','');
  if document_transaction_id is null and entity_name='transaction' then
    document_transaction_id:=coalesce(nullif(key_value,''),p_entity_id::text);
  end if;
  journal_id:=nullif(source_row->>'journal_id','');
  if journal_id is null and entity_name='journal' then
    journal_id:=coalesce(nullif(key_value,''),p_entity_id::text);
  end if;

  primary_subsidiary_id:=public.audit_change_try_bigint(coalesce(
    source_row->>'subsidiary_id',source_row->>'id_subsidiaria'
  ));

  if entity_name in('asset_transfer','intercompany_eliminations') then
    source_subsidiary_id:=public.audit_change_try_bigint(
      coalesce(source_row->>'source_subsidiary_id',source_row->>'from_subsidiary_id')
    );
    target_subsidiary_id:=public.audit_change_try_bigint(
      coalesce(source_row->>'target_subsidiary_id',source_row->>'to_subsidiary_id')
    );
    if source_subsidiary_id is not null and target_subsidiary_id is not null then
      subsidiary_ids:=array(
        select distinct scope_id
        from unnest(array[source_subsidiary_id,target_subsidiary_id])as scope(scope_id)
        order by scope_id
      );
    end if;
  elsif entity_name='bank_transfer' then
    source_related_row:=public.audit_change_historical_row(
      'bank_account',public.audit_change_try_bigint(source_row->>'from_account_id'),null,
      p_anchor_log_id,null
    );
    target_related_row:=public.audit_change_historical_row(
      'bank_account',public.audit_change_try_bigint(source_row->>'to_account_id'),null,
      p_anchor_log_id,null
    );
    source_subsidiary_id:=public.audit_change_try_bigint(source_related_row->>'subsidiary_id');
    target_subsidiary_id:=public.audit_change_try_bigint(target_related_row->>'subsidiary_id');
    if source_subsidiary_id is not null and target_subsidiary_id is not null then
      subsidiary_ids:=array(
        select distinct scope_id
        from unnest(array[source_subsidiary_id,target_subsidiary_id])as scope(scope_id)
        order by scope_id
      );
    end if;
  elsif entity_name='cash_transfer' then
    source_related_row:=public.audit_change_historical_row(
      'cashbox',public.audit_change_try_bigint(source_row->>'from_cashbox_id'),null,
      p_anchor_log_id,null
    );
    target_related_row:=public.audit_change_historical_row(
      'cashbox',public.audit_change_try_bigint(source_row->>'to_cashbox_id'),null,
      p_anchor_log_id,null
    );
    source_subsidiary_id:=public.audit_change_try_bigint(source_related_row->>'subsidiary_id');
    target_subsidiary_id:=public.audit_change_try_bigint(target_related_row->>'subsidiary_id');
    if source_subsidiary_id is not null and target_subsidiary_id is not null then
      subsidiary_ids:=array(
        select distinct scope_id
        from unnest(array[source_subsidiary_id,target_subsidiary_id])as scope(scope_id)
        order by scope_id
      );
    end if;
  elsif entity_name='stock_transfer' then
    source_related_row:=public.audit_change_historical_row(
      'locations',public.audit_change_try_bigint(source_row->>'source_location_id'),null,
      p_anchor_log_id,null
    );
    target_related_row:=public.audit_change_historical_row(
      'locations',public.audit_change_try_bigint(source_row->>'target_location_id'),null,
      p_anchor_log_id,null
    );
    source_subsidiary_id:=public.audit_change_try_bigint(source_related_row->>'subsidiary_id');
    target_subsidiary_id:=public.audit_change_try_bigint(target_related_row->>'subsidiary_id');
    if source_subsidiary_id is not null and target_subsidiary_id is not null then
      subsidiary_ids:=array(
        select distinct scope_id
        from unnest(array[source_subsidiary_id,target_subsidiary_id])as scope(scope_id)
        order by scope_id
      );
    end if;
  elsif primary_subsidiary_id is not null then
    subsidiary_ids:=array[primary_subsidiary_id];
  end if;

  if cardinality(subsidiary_ids)=0
    and entity_name not in(
      'asset_transfer','intercompany_eliminations','bank_transfer','cash_transfer','stock_transfer'
    ) then
    case entity_name
      when 'credit_note' then
        related_row:=public.audit_change_historical_row('invoice',
          public.audit_change_try_bigint(source_row->>'invoice_id'),null,p_anchor_log_id,null);
      when 'debit_note' then
        related_row:=public.audit_change_historical_row('invoice',
          public.audit_change_try_bigint(source_row->>'invoice_id'),null,p_anchor_log_id,null);
      when 'supplier_credit_note' then
        related_row:=public.audit_change_historical_row('supplier_invoice',
          public.audit_change_try_bigint(source_row->>'invoice_id'),null,p_anchor_log_id,null);
      when 'supplier_debit_note' then
        related_row:=public.audit_change_historical_row('supplier_invoice',
          public.audit_change_try_bigint(source_row->>'invoice_id'),null,p_anchor_log_id,null);
      when 'customer_payment' then
        related_row:=public.audit_change_historical_row('bank_account',
          public.audit_change_try_bigint(source_row->>'bank_account_id'),null,p_anchor_log_id,null);
      when 'supplier_payment' then
        related_row:=public.audit_change_historical_row('bank_account',
          public.audit_change_try_bigint(source_row->>'bank_account_id'),null,p_anchor_log_id,null);
      when 'goods_receipt' then
        related_row:=public.audit_change_historical_row('purchase_order',
          public.audit_change_try_bigint(source_row->>'po_id'),null,p_anchor_log_id,null);
      when 'delivery' then
        related_row:=public.audit_change_historical_row('sales_order',
          public.audit_change_try_bigint(source_row->>'so_id'),null,p_anchor_log_id,null);
      when 'bank_transaction' then
        related_row:=public.audit_change_historical_row('bank_account',
          public.audit_change_try_bigint(source_row->>'bank_account_id'),null,p_anchor_log_id,null);
      when 'bank_statement' then
        related_row:=public.audit_change_historical_row('bank_account',
          public.audit_change_try_bigint(source_row->>'bank_account_id'),null,p_anchor_log_id,null);
      when 'bank_reconciliation' then
        related_row:=public.audit_change_historical_row('bank_account',
          public.audit_change_try_bigint(source_row->>'bank_account_id'),null,p_anchor_log_id,null);
      when 'bank_check' then
        related_row:=public.audit_change_historical_row('bank_account',
          public.audit_change_try_bigint(source_row->>'bank_account_id'),null,p_anchor_log_id,null);
      when 'bank_deposit' then
        related_row:=public.audit_change_historical_row('bank_account',
          public.audit_change_try_bigint(source_row->>'bank_account_id'),null,p_anchor_log_id,null);
      when 'cash_transaction' then
        related_row:=public.audit_change_historical_row('cashbox',
          public.audit_change_try_bigint(source_row->>'cashbox_id'),null,p_anchor_log_id,null);
      when 'cash_opening' then
        related_row:=public.audit_change_historical_row('cashbox',
          public.audit_change_try_bigint(source_row->>'cashbox_id'),null,p_anchor_log_id,null);
      when 'cash_closing' then
        related_row:=public.audit_change_historical_row('cashbox',
          public.audit_change_try_bigint(source_row->>'cashbox_id'),null,p_anchor_log_id,null);
      when 'expense_payment' then
        related_row:=public.audit_change_historical_row('expense',
          public.audit_change_try_bigint(source_row->>'expense_id'),null,p_anchor_log_id,null);
      when 'stock_adjustment' then
        related_row:=public.audit_change_historical_row('locations',
          public.audit_change_try_bigint(source_row->>'location_id'),null,p_anchor_log_id,null);
      when 'asset_depreciation' then
        related_row:=public.audit_change_historical_row('asset',
          public.audit_change_try_bigint(source_row->>'asset_id'),null,p_anchor_log_id,null);
      when 'asset_disposal' then
        related_row:=public.audit_change_historical_row('asset',
          public.audit_change_try_bigint(source_row->>'asset_id'),null,p_anchor_log_id,null);
      when 'asset_maintenance' then
        related_row:=public.audit_change_historical_row('asset',
          public.audit_change_try_bigint(source_row->>'asset_id'),null,p_anchor_log_id,null);
      when 'asset_revaluation' then
        related_row:=public.audit_change_historical_row('asset',
          public.audit_change_try_bigint(source_row->>'asset_id'),null,p_anchor_log_id,null);
      when 'asset_impairment' then
        related_row:=public.audit_change_historical_row('asset',
          public.audit_change_try_bigint(source_row->>'asset_id'),null,p_anchor_log_id,null);
      when 'pending_invoice_reversal' then
        related_row:=public.audit_change_historical_row('journal',
          public.audit_change_try_bigint(source_row->>'source_journal_id'),null,p_anchor_log_id,null);
      else null;
    end case;
    primary_subsidiary_id:=public.audit_change_try_bigint(coalesce(
      related_row->>'subsidiary_id',related_row->>'id_subsidiaria'
    ));
    if primary_subsidiary_id is not null then subsidiary_ids:=array[primary_subsidiary_id]; end if;
  end if;

  if cardinality(subsidiary_ids)=0
    and entity_name not in(
      'asset_transfer','intercompany_eliminations','bank_transfer','cash_transfer','stock_transfer'
    )
    and document_transaction_id is not null and document_transaction_id~'^\d+$' then
    related_row:=public.audit_change_historical_row(
      'transaction',document_transaction_id::bigint,null,p_anchor_log_id,null
    );
    primary_subsidiary_id:=public.audit_change_try_bigint(related_row->>'subsidiary_id');
    if primary_subsidiary_id is not null then subsidiary_ids:=array[primary_subsidiary_id]; end if;
  end if;

  if cardinality(subsidiary_ids)>0 then
    select coalesce(array_agg(subsidiary.name order by subsidiary.name),'{}'::text[])
      into subsidiary_names
    from public.subsidiaries subsidiary
    where subsidiary.subsidiary_id=any(subsidiary_ids);
  end if;

  creator_id:=coalesce(nullif(source_row->>'created_by_id',''),nullif(source_row->>'created_by',''));
  creator_name:=nullif(source_row->>'created_by_name','');
  creator_email:=nullif(source_row->>'created_by_email','');
  if lower(coalesce(creator_email,''))like'legacy-%@nexo.invalid'
    or lower(coalesce(creator_name,''))like'registro historico:%'
    or lower(coalesce(creator_name,''))like'registro histórico:%' then
    creator_id:=null;
    creator_name:=null;
    creator_email:=null;
  end if;

  if creator_name is null or creator_email is null then
    select
      coalesce(nullif(created_event.created_by_id,''),created_event.user_id::text),
      coalesce(case when lower(coalesce(created_event.created_by_name,''))like'registro hist%:%'
          then null else nullif(created_event.created_by_name,'')end,
        nullif(trim(concat_ws(' ',creator.first_name,creator.last_name)),''),creator.email),
      coalesce(case when lower(coalesce(created_event.created_by_email,''))like'legacy-%@nexo.invalid'
          then null else nullif(created_event.created_by_email,'')end,creator.email)
    into creation_id,creation_name,creation_email
    from public.audit_log created_event
    left join public.users creator on creator.user_id=created_event.user_id
    where created_event.entity_type=entity_name
      and created_event.action='CREACION'
      and(
        (p_entity_key is not null and created_event.entity_key=p_entity_key)
        or(p_entity_key is null and p_entity_id is not null and created_event.entity_id=p_entity_id)
      )
    order by created_event."timestamp",created_event.log_id
    limit 1;
    creator_id:=coalesce(creator_id,creation_id);
    creator_name:=coalesce(creator_name,creation_name);
    creator_email:=coalesce(creator_email,creation_email);
  end if;

  return jsonb_build_object(
    'documentNumber',document_number,
    'transactionId',document_transaction_id,
    'journalId',journal_id,
    'subsidiaryId',case when cardinality(subsidiary_ids)=1 then subsidiary_ids[1]end,
    'subsidiaryIds',to_jsonb(subsidiary_ids),
    'subsidiaryName',case when cardinality(subsidiary_names)=1 then subsidiary_names[1]end,
    'subsidiaryNames',to_jsonb(subsidiary_names),
    'documentCreator',jsonb_build_object(
      'id',creator_id,
      'name',coalesce(creator_name,'Autor historico no disponible'),
      'email',creator_email
    )
  );
end
$$;

create or replace function public.audit_change_transaction_identities_related(
  p_left jsonb,p_right jsonb
)
returns boolean
language sql
immutable
parallel safe
set search_path=pg_catalog
as $$
  select(
    nullif(p_left->>'transactionId','')is not null
    and p_left->>'transactionId'=p_right->>'transactionId'
  )or(
    nullif(p_left->>'journalId','')is not null
    and p_left->>'journalId'=p_right->>'journalId'
  )
$$;

-- Child records are folded into their business document. They never become
-- standalone rows in the quality report.
create or replace function public.audit_change_transaction_child_entity_types()
returns text[]
language sql
immutable
parallel safe
set search_path=pg_catalog
as $$
  select array[
    'sales_invoice_line','sales_note_line',
    'supplier_invoice_line','supplier_note_line',
    'journal_line',
    'customer_payment_application','supplier_payment_application',
    'customer_advance_application','supplier_advance_application'
  ]::text[]
$$;

create or replace function public.audit_change_transaction_parent(
  p_entity_type text,
  p_entity_id bigint,
  p_entity_key text,
  p_snapshot jsonb,
  p_execution_context_id text,
  p_anchor_log_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  source_type text:=lower(trim(coalesce(p_entity_type,'')));
  source_id bigint:=p_entity_id;
  source_row jsonb;
  root_type text;
  root_id bigint;
  root_key text;
  source_label text;
  source_summary text;
  item_label text;
  item_row jsonb;
  parent_field text;
begin
  if source_type=any(public.audit_change_transaction_entity_types()) then
    return jsonb_build_object(
      'isChild',false,
      'rootEntityType',source_type,
      'rootEntityId',p_entity_id,
      'rootEntityKey',p_entity_key,
      'sourceEntityType',source_type,
      'sourceEntityId',p_entity_id,
      'sourceEntityKey',p_entity_key
    );
  end if;
  if not(source_type=any(public.audit_change_transaction_child_entity_types())) then return null; end if;

  if source_id is null then
    begin source_id:=split_part(split_part(coalesce(p_entity_key,''),'=',2),',',1)::bigint;
    exception when others then source_id:=null; end;
  end if;

  source_row:=public.audit_change_historical_row(
    source_type,source_id,p_entity_key,p_anchor_log_id,p_snapshot
  );
  source_row:=coalesce(source_row,'{}'::jsonb);

  case source_type
    when 'sales_invoice_line' then
      root_type:='invoice'; parent_field:='invoice_id';
      source_label:='Linea de factura #'||coalesce(source_id::text,'sin numero');
      select concat_ws(' - ',nullif(product.item_code,''),nullif(product.display_name,''))
        into item_label from public.products product
        where product.product_id=nullif(source_row->>'product_id','')::bigint;
    when 'sales_note_line' then
      root_type:=case upper(coalesce(source_row->>'note_kind',''))when'CREDIT'then'credit_note'when'DEBIT'then'debit_note'end;
      parent_field:='note_id'; source_label:='Linea de nota #'||coalesce(source_id::text,'sin numero');
      select concat_ws(' - ',nullif(product.item_code,''),nullif(product.display_name,''))
        into item_label from public.products product
        where product.product_id=nullif(source_row->>'product_id','')::bigint;
    when 'supplier_invoice_line' then
      root_type:='supplier_invoice'; parent_field:='invoice_id';
      source_label:='Linea de factura #'||coalesce(source_id::text,'sin numero');
      select concat_ws(' - ',nullif(account.account_number,''),nullif(account.account_name,''))
        into item_label from public.chart_accounts account
        where account.account_id=nullif(source_row->>'account_id','')::bigint;
    when 'supplier_note_line' then
      root_type:=case upper(coalesce(source_row->>'note_kind',''))when'CREDIT'then'supplier_credit_note'when'DEBIT'then'supplier_debit_note'end;
      parent_field:='note_id'; source_label:='Linea de nota #'||coalesce(source_id::text,'sin numero');
      select concat_ws(' - ',nullif(account.account_number,''),nullif(account.account_name,''))
        into item_label from public.chart_accounts account
        where account.account_id=nullif(source_row->>'account_id','')::bigint;
    when 'journal_line' then
      root_type:='journal'; parent_field:='journal_id';
      source_label:='Partida contable #'||coalesce(source_id::text,'sin numero');
      select concat_ws(' - ',nullif(account.account_number,''),nullif(account.account_name,''))
        into item_label from public.chart_accounts account
        where account.account_id=nullif(source_row->>'account_id','')::bigint;
    when 'customer_payment_application' then
      root_type:='customer_payment'; parent_field:='payment_id';
      item_row:=public.audit_change_historical_row('invoice',
        public.audit_change_try_bigint(source_row->>'invoice_id'),null,p_anchor_log_id,null);
      item_label:=nullif(item_row->>'invoice_number','');
      source_label:='Aplicacion a factura'||case when item_label is null then' #'||coalesce(source_id::text,'sin numero')else' '||item_label end;
    when 'supplier_payment_application' then
      root_type:='supplier_payment'; parent_field:='payment_id';
      item_row:=public.audit_change_historical_row('supplier_invoice',
        public.audit_change_try_bigint(source_row->>'invoice_id'),null,p_anchor_log_id,null);
      item_label:=nullif(item_row->>'invoice_number','');
      source_label:='Aplicacion a factura'||case when item_label is null then' #'||coalesce(source_id::text,'sin numero')else' '||item_label end;
    when 'customer_advance_application' then
      root_type:='customer_payment'; parent_field:='payment_id';
      source_label:='Aplicacion de anticipo #'||coalesce(source_id::text,'sin numero');
    when 'supplier_advance_application' then
      root_type:='supplier_payment'; parent_field:='payment_id';
      source_label:='Aplicacion de anticipo #'||coalesce(source_id::text,'sin numero');
    else return null;
  end case;

  if nullif(source_row->>parent_field,'')~'^\d+$' then root_id:=(source_row->>parent_field)::bigint; end if;

  -- The execution context is only usable when it identifies exactly one
  -- compatible root. Batches with multiple documents deliberately fail closed.
  if root_id is null and nullif(p_execution_context_id,'')is not null then
    select min(candidate.entity_type),min(candidate.entity_id),min(candidate.entity_key)
      into root_type,root_id,root_key
    from(
      select event.entity_type,event.entity_id,event.entity_key
      from public.audit_log event
      where event.execution_context_id=p_execution_context_id
        and event.entity_id is not null
        and(
          (source_type='sales_invoice_line'and event.entity_type='invoice')
          or(source_type='sales_note_line'and event.entity_type in('credit_note','debit_note'))
          or(source_type='supplier_invoice_line'and event.entity_type='supplier_invoice')
          or(source_type='supplier_note_line'and event.entity_type in('supplier_credit_note','supplier_debit_note'))
          or(source_type='journal_line'and event.entity_type='journal')
          or(source_type in('customer_payment_application','customer_advance_application')and event.entity_type='customer_payment')
          or(source_type in('supplier_payment_application','supplier_advance_application')and event.entity_type='supplier_payment')
        )
      group by event.entity_type,event.entity_id,event.entity_key
    )candidate
    having count(*)=1;
  end if;
  if root_type is null or root_id is null then return null; end if;

  if root_key is null then
    root_key:=case root_type
      when'invoice'then'invoice_id=' when'credit_note'then'cn_id=' when'debit_note'then'dn_id='
      when'supplier_invoice'then'invoice_id=' when'supplier_credit_note'then'cn_id='
      when'supplier_debit_note'then'dn_id=' when'journal'then'journal_id='
      when'customer_payment'then'payment_id=' when'supplier_payment'then'payment_id='
    end||root_id::text;
  end if;
  if nullif(item_label,'')is not null and position(item_label in source_label)=0 then
    source_label:=source_label||' · '||item_label;
  end if;
  source_summary:=concat_ws(' · ',nullif(item_label,''),
    case when nullif(source_row->>'quantity','')is not null then'Cantidad '||(source_row->>'quantity')end,
    case when nullif(source_row->>'amount','')is not null then'Importe '||(source_row->>'amount')end,
    case when coalesce(nullif(source_row->>'debit',''),'0')::numeric<>0 then'Debito '||(source_row->>'debit')end,
    case when coalesce(nullif(source_row->>'credit',''),'0')::numeric<>0 then'Credito '||(source_row->>'credit')end,
    nullif(source_row->>'note','')
  );

  return jsonb_build_object(
    'isChild',true,
    'rootEntityType',root_type,
    'rootEntityId',root_id,
    'rootEntityKey',root_key,
    'sourceEntityType',source_type,
    'sourceEntityId',source_id,
    'sourceEntityKey',p_entity_key,
    'sourceLabel',source_label,
    'sourceSummary',coalesce(nullif(source_summary,''),source_label)
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  return null;
end
$$;

create or replace function public.audit_change_transaction_child_changes(
  p_entity_type text,
  p_entity_id bigint,
  p_action text,
  p_changes jsonb,
  p_parent jsonb
)
returns jsonb
language plpgsql
immutable
parallel safe
set search_path=pg_catalog
as $$
declare
  items jsonb:=coalesce(p_changes,'[]'::jsonb);
  child_key text:=coalesce(p_parent->>'sourceEntityId',p_entity_id::text,'sin-id');
  source_type text:=coalesce(p_parent->>'sourceEntityType',lower(trim(coalesce(p_entity_type,''))));
  source_label text:=coalesce(p_parent->>'sourceLabel','Detalle #'||child_key);
  source_summary text:=coalesce(p_parent->>'sourceSummary',source_label);
  normalized_action text:=upper(trim(coalesce(p_action,'')));
  result jsonb;
  event_label text;
begin
  if not coalesce((p_parent->>'isChild')::boolean,false)then return items;end if;
  if jsonb_typeof(items)='array'and jsonb_array_length(items)>0 then
    select coalesce(jsonb_agg(
      item.value||jsonb_build_object(
        'field',source_type||':'||child_key||':'||coalesce(item.value->>'field','detalle'),
        'fieldLabel',source_label||' · '||coalesce(item.value->>'fieldLabel','Detalle'),
        'sourceEntityType',source_type,
        'sourceEntityId',p_parent->'sourceEntityId',
        'sourceLabel',source_label,
        'scope','detail'
      )order by item.ordinality),'[]'::jsonb)into result
    from jsonb_array_elements(items)with ordinality item(value,ordinality);
    return result;
  end if;
  if normalized_action not in('CREACION','INSERT','CREATED','ELIMINACION','DELETE','DELETED')then
    return'[]'::jsonb;
  end if;
  event_label:=case
    when source_type like'%application'and normalized_action in('ELIMINACION','DELETE','DELETED')then source_label||' retirada'
    when source_type like'%application'then source_label||' registrada'
    when source_type='journal_line'and normalized_action in('ELIMINACION','DELETE','DELETED')then source_label||' retirada'
    when source_type='journal_line'then source_label||' agregada'
    when normalized_action in('ELIMINACION','DELETE','DELETED')then source_label||' eliminada'
    else source_label||' agregada'end;
  return jsonb_build_array(jsonb_build_object(
    'id',null,
    'field',source_type||':'||child_key||case when normalized_action in('ELIMINACION','DELETE','DELETED')then':__removed'else':__added'end,
    'fieldLabel',event_label,
    'oldValue',case when normalized_action in('ELIMINACION','DELETE','DELETED')then source_summary end,
    'newValue',case when normalized_action in('CREACION','INSERT','CREATED')then source_summary end,
    'changeType','MODIFICACION',
    'sourceEntityType',source_type,
    'sourceEntityId',p_parent->'sourceEntityId',
    'sourceLabel',source_label,
    'scope','detail'
  ));
end
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
    when 'estado' then 'Estado'
    when 'name' then 'Nombre'
    when 'description' then 'Descripcion'
    when 'notes' then 'Notas'
    when 'note' then 'Nota'
    when 'memo' then 'Concepto'
    when 'concept' then 'Concepto'
    when 'concepto' then 'Concepto'
    when 'invoice_number' then 'Numero de factura'
    when 'cn_number' then 'Numero de nota de credito'
    when 'dn_number' then 'Numero de nota de debito'
    when 'payment_number' then 'Numero de pago'
    when 'journal_number' then 'Numero de asiento'
    when 'tran_number' then 'Numero de transaccion'
    when 'document_number' then 'Numero de documento'
    when 'numero' then 'Numero de solicitud'
    when 'reference_number' then 'Numero de referencia'
    when 'bank_reference' then 'Referencia bancaria'
    when 'invoice_date' then 'Fecha de factura'
    when 'note_date' then 'Fecha de nota'
    when 'payment_date' then 'Fecha de pago'
    when 'journal_date' then 'Fecha del asiento'
    when 'tran_date' then 'Fecha de transaccion'
    when 'filing_date' then 'Fecha de presentacion'
    when 'due_date' then 'Fecha de vencimiento'
    when 'subsidiary_id' then 'Subsidiaria'
    when 'id_subsidiaria' then 'Subsidiaria'
    when 'department_id' then 'Departamento'
    when 'cost_center_id' then 'Centro de costos'
    when 'class_id' then 'Clase'
    when 'location_id' then 'Ubicacion'
    when 'currency_id' then 'Moneda'
    when 'customer_id' then 'Cliente'
    when 'supplier_id' then 'Proveedor'
    when 'employee_id' then 'Empleado'
    when 'assigned_user_id' then 'Responsable'
    when 'account_id' then 'Cuenta contable'
    when 'product_id' then 'Producto o servicio'
    when 'quantity' then 'Cantidad'
    when 'unit_price' then 'Precio unitario'
    when 'tax_code_id' then 'Codigo de impuesto'
    when 'tax_rate' then 'Tarifa de impuesto'
    when 'tax_amount' then 'Importe de impuesto'
    when 'gross_amount' then 'Total con impuestos'
    when 'debit' then 'Debito'
    when 'credit' then 'Credito'
    when 'debit_fx' then 'Debito en moneda original'
    when 'credit_fx' then 'Credito en moneda original'
    when 'application_date' then 'Fecha de aplicacion'
    when 'service_month' then 'Mes de servicio'
    when 'service_country_id' then 'Pais de servicio'
    when 'total_amount' then 'Importe total'
    when 'subtotal_amount' then 'Subtotal'
    when 'tax_total' then 'Impuestos'
    when 'withholding_total' then 'Retenciones'
    when 'receivable_amount' then 'Cuenta por cobrar'
    when 'payable_amount' then 'Cuenta por pagar'
    when 'amount' then 'Importe'
    when 'amount_paid' then 'Importe pagado'
    when 'amount_received' then 'Importe cobrado'
    when 'balance_due' then 'Saldo pendiente'
    when 'exchange_rate' then 'Tipo de cambio'
    when 'tax_type_code' then 'Tipo de impuesto'
    when 'period' then 'Periodo fiscal'
    when 'filing_reference_number' then 'Referencia de presentacion'
    when 'document_type' then 'Tipo de respaldo'
    when 'document_url' then 'Documento de respaldo'
    when 'external_link' then 'Enlace externo'
    when 'unificar_lineas_pdf' then 'Unificar lineas en el PDF'
    when 'unificar_lineas_pdf_descripcion' then 'Descripcion unificada del PDF'
    when 'email' then 'Correo electronico'
    when 'phone' then 'Telefono'
    else initcap(replace(trim(coalesce(p_field,'')),'_',' '))
  end
$$;

revoke all on function public.audit_change_transaction_entity_types() from public,anon,authenticated;
revoke all on function public.audit_change_transaction_child_entity_types() from public,anon,authenticated;
revoke all on function public.audit_change_transaction_meta(text) from public,anon,authenticated;
revoke all on function public.audit_change_try_bigint(text) from public,anon,authenticated;
revoke all on function public.audit_change_historical_row(text,bigint,text,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.audit_change_transaction_identity(text,bigint,text,jsonb,jsonb,bigint) from public,anon,authenticated;
revoke all on function public.audit_change_transaction_identities_related(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.audit_change_transaction_parent(text,bigint,text,jsonb,text,bigint) from public,anon,authenticated;
revoke all on function public.audit_change_transaction_child_changes(text,bigint,text,jsonb,jsonb) from public,anon,authenticated;

-- El predicado queda autocontenido. Asi el indice no depende de poder reemplazar
-- audit_change_transaction_entity_types() en migraciones posteriores.
drop index if exists public.audit_log_transaction_change_idx;
create index audit_log_transaction_change_idx
  on public.audit_log("timestamp" desc,entity_type,action)
  include(log_id,user_id,entity_id,entity_key,execution_context_id)
  where action in(
    'MODIFICACION','UPDATE','UPDATED','MODIFIED',
    'ELIMINACION','DELETE','DELETED'
  ) and entity_type in(
    'quotation','sales_order','sales_document','delivery','invoice',
    'credit_note','debit_note','customer_payment',
    'purchase_requisition','purchase_quote','purchase_order','purchase_document',
    'goods_receipt','supplier_invoice','supplier_credit_note','supplier_debit_note',
    'supplier_payment','solicitudes_pago','payment_batches',
    'journal','transaction','fx_revaluation_runs','pending_invoice_reversal',
    'opening_balance_runs','bank_transaction','bank_statement','bank_reconciliation',
    'quadratic_bank_reconciliations','bank_transfer','bank_check','bank_deposit',
    'bank_fee','cash_transaction','cash_opening','cash_closing','cash_transfer',
    'expense','expense_payment','stock_adjustment','stock_transfer',
    'asset_depreciation','asset_transfer','asset_disposal','asset_maintenance',
    'asset_revaluation','asset_impairment','tax_calendar_events',
    'presupuestos_encabezado','presupuestos_modificaciones','intercompany_eliminations'
  );

drop index if exists public.audit_log_transaction_child_change_idx;
create index audit_log_transaction_child_change_idx
  on public.audit_log("timestamp" desc,entity_type,action)
  include(log_id,user_id,entity_id,entity_key,execution_context_id)
  where action in(
    'CREACION','INSERT','CREATED',
    'MODIFICACION','UPDATE','UPDATED','MODIFIED',
    'ELIMINACION','DELETE','DELETED'
  )and entity_type in(
    'sales_invoice_line','sales_note_line',
    'supplier_invoice_line','supplier_note_line','journal_line',
    'customer_payment_application','supplier_payment_application',
    'customer_advance_application','supplier_advance_application'
  );

create index if not exists audit_log_execution_creation_idx
  on public.audit_log(execution_context_id,entity_type,entity_id)
  where execution_context_id is not null
    and action in('CREACION','INSERT','CREATED');

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
    raise exception using errcode='42501',message='La sesion no identifica un usuario.';
  end if;
  perform public.security_assert_role_access('audit:change-report','view');

  with source_events as materialized(
    select
      a.log_id,
      a."timestamp" occurred_at,
      coalesce(a.user_id,deleted.deleted_by_user_id) actor_user_id,
      a.action source_action,
      a.entity_type source_entity_type,
      a.entity_id source_entity_id,
      a.entity_key source_entity_key,
      a.execution_context_id,
      public.audit_change_try_jsonb(deleted.record_data_json) deleted_snapshot,
      parent.value parent
    from public.audit_log a
    left join lateral(
      select record.deleted_by_user_id,record.record_data_json
      from public.deleted_records record
      where record.audit_log_id=a.log_id
      order by record.deleted_id desc
      limit 1
    )deleted on true
    cross join lateral(
      select public.audit_change_transaction_parent(
        a.entity_type,a.entity_id,a.entity_key,
        public.audit_change_try_jsonb(deleted.record_data_json),a.execution_context_id,a.log_id
      )value
    )parent
    where(
      (a.entity_type=any(public.audit_change_transaction_entity_types())
        and a.action in(
          'MODIFICACION','UPDATE','UPDATED','MODIFIED',
          'ELIMINACION','DELETE','DELETED'
        )
        and(a.action in('ELIMINACION','DELETE','DELETED')or exists(
          select 1 from public.change_log change
          where change.audit_log_id=a.log_id
            and not public.audit_change_is_technical_field(change.field_name)
            and not public.audit_change_is_sensitive_field(change.field_name)
        )))
      or(a.entity_type=any(public.audit_change_transaction_child_entity_types())
        and a.action in(
          'CREACION','INSERT','CREATED',
          'MODIFICACION','UPDATE','UPDATED','MODIFIED',
          'ELIMINACION','DELETE','DELETED'
        )
        and(a.action not in('MODIFICACION','UPDATE','UPDATED','MODIFIED')or exists(
          select 1 from public.change_log change
          where change.audit_log_id=a.log_id
            and not public.audit_change_is_technical_field(change.field_name)
            and not public.audit_change_is_sensitive_field(change.field_name)
        )))
      )
  ),raw_events as materialized(
    select
      event.log_id,event.occurred_at,event.actor_user_id,
      event.parent->>'rootEntityType' entity_type,
      public.audit_change_try_bigint(event.parent->>'rootEntityId')entity_id,
      event.parent->>'rootEntityKey' entity_key,
      event.execution_context_id,
      coalesce(nullif(event.execution_context_id,''),'audit:'||event.log_id::text)operation_key,
      coalesce(nullif(event.parent->>'rootEntityKey',''),event.parent->>'rootEntityId','audit:'||event.log_id::text)entity_identity,
      coalesce((event.parent->>'isChild')::boolean,false)is_child,
      case when coalesce((event.parent->>'isChild')::boolean,false)then'MODIFICACION'
        else public.audit_change_action_code(event.source_action)end action_code,
      public.audit_change_transaction_meta(event.parent->>'rootEntityType')meta,
      case when coalesce((event.parent->>'isChild')::boolean,false)then'{}'::jsonb
        else event.deleted_snapshot end deleted_snapshot
    from source_events event
    where event.parent is not null
      and not(
        coalesce((event.parent->>'isChild')::boolean,false)
        and event.source_action in('CREACION','INSERT','CREATED')
        and(event.execution_context_id is null or exists(
          select 1 from public.audit_log created_root
          where created_root.execution_context_id=event.execution_context_id
            and created_root.entity_type=event.parent->>'rootEntityType'
            and created_root.entity_id=public.audit_change_try_bigint(event.parent->>'rootEntityId')
            and created_root.action in('CREACION','INSERT','CREATED')
        ))
      )
  ),identified_raw_events as materialized(
    select event.*,identity.value identity
    from raw_events event
    cross join lateral(
      select public.audit_change_transaction_identity(
        event.entity_type,event.entity_id,event.entity_key,
        event.deleted_snapshot,'[]'::jsonb,event.log_id
      )value
    )identity
  ),prioritized_events as materialized(
    select event.*
    from identified_raw_events event
    where not exists(
      select 1 from identified_raw_events preferred
      where preferred.operation_key=event.operation_key
        and (preferred.meta->>'priority')::integer<(event.meta->>'priority')::integer
        and public.audit_change_transaction_identities_related(preferred.identity,event.identity)
    )
  ),collapsed_events as materialized(
    select
      event.operation_key,event.entity_type,event.entity_identity,event.meta,
      max(event.occurred_at) occurred_at,
      (array_agg(event.log_id order by event.occurred_at desc,event.log_id desc))[1]log_id,
      (array_agg(event.actor_user_id order by event.occurred_at desc,event.log_id desc)
        filter(where event.actor_user_id is not null))[1] actor_user_id,
      (array_agg(event.entity_id order by event.occurred_at desc,event.log_id desc)
        filter(where event.entity_id is not null))[1] entity_id,
      (array_agg(event.entity_key order by event.occurred_at desc,event.log_id desc)
        filter(where event.entity_key is not null))[1] entity_key,
      coalesce(
        (array_agg(event.action_code order by event.occurred_at desc,event.log_id desc)
          filter(where not event.is_child))[1],
        'MODIFICACION'
      )action_code,
      coalesce(
        (jsonb_agg(event.deleted_snapshot order by event.occurred_at desc,event.log_id desc)
          filter(where event.action_code='ELIMINACION'))->0,
        '{}'::jsonb
      ) deleted_snapshot,
      count(*)::integer consolidated_event_count
    from prioritized_events event
    group by event.operation_key,event.entity_type,event.entity_identity,event.meta
  ),identified_events as materialized(
    select event.*,identity.value identity
    from collapsed_events event
    cross join lateral(
      select public.audit_change_transaction_identity(
        event.entity_type,event.entity_id,event.entity_key,event.deleted_snapshot,
        '[]'::jsonb,event.log_id
      ) value
    )identity
  ),authorized_events as materialized(
    select event.*
    from identified_events event
    where jsonb_array_length(coalesce(event.identity->'subsidiaryIds','[]'::jsonb))>0
      and not exists(
      select 1
      from jsonb_array_elements_text(coalesce(event.identity->'subsidiaryIds','[]'::jsonb)) required_id
      where not exists(
        select 1 from public.user_subsidiaries access
        where access.user_id=uid
          and access.subsidiary_id=public.audit_change_try_bigint(required_id.value)
      )
    )
  ),user_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.user_id,'name',option.display_name,'email',option.email,
      'isActive',option.is_active,'recordCount',option.record_count
    )order by option.display_name,option.email),'[]'::jsonb)value
    from(
      select u.user_id,
        coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email)display_name,
        u.email,u.is_active,count(*)::integer record_count
      from authorized_events event
      join public.users u on u.user_id=event.actor_user_id
      group by u.user_id,u.first_name,u.last_name,u.email,u.is_active
    )option
  ),group_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.group_code,'label',option.group_label,'recordCount',option.record_count
    )order by option.group_label),'[]'::jsonb)value
    from(
      select event.meta->>'groupCode'group_code,event.meta->>'groupLabel'group_label,
        count(*)::integer record_count
      from authorized_events event
      group by event.meta->>'groupCode',event.meta->>'groupLabel'
    )option
  ),type_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',option.entity_type,'label',option.type_label,
      'group',option.group_code,'module',option.group_code,
      'recordCount',option.record_count
    )order by option.type_label,option.entity_type),'[]'::jsonb)value
    from(
      select event.entity_type,event.meta->>'typeLabel'type_label,
        event.meta->>'groupCode'group_code,count(*)::integer record_count
      from authorized_events event
      group by event.entity_type,event.meta->>'typeLabel',event.meta->>'groupCode'
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
      from authorized_events event
      group by 1,2,3
    )option
  ),subsidiary_options as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',subsidiary.subsidiary_id,'name',subsidiary.name
    )order by subsidiary.name),'[]'::jsonb)value
    from public.user_subsidiaries access
    join public.subsidiaries subsidiary using(subsidiary_id)
    where access.user_id=uid and subsidiary.is_active
  )
  select jsonb_build_object(
    'defaultMonth',to_char(current_timestamp at time zone 'America/Costa_Rica','YYYY-MM'),
    'timeZone','America/Costa_Rica',
    'scope','authorized_subsidiaries',
    'actions',jsonb_build_array(
      jsonb_build_object('id','','label','Todas las acciones'),
      jsonb_build_object('id','UPDATE','label','Modificadas'),
      jsonb_build_object('id','DELETE','label','Eliminadas')
    ),
    'users',user_options.value,
    'subsidiaries',subsidiary_options.value,
    'transactionGroups',group_options.value,
    'transactionTypes',type_options.value,
    'modules',group_options.value,
    'entityTypes',type_options.value,
    'months',month_options.value,
    'pageSizes',jsonb_build_array(25,50,100,200)
  )into result
  from user_options,group_options,type_options,month_options,subsidiary_options;

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
  month_text text:=coalesce(nullif(trim(filters->>'month'),''),
    to_char(current_timestamp at time zone 'America/Costa_Rica','YYYY-MM'));
  month_start date;
  month_end date;
  user_filter bigint;
  subsidiary_filter bigint;
  action_filter text:=upper(coalesce(nullif(trim(filters->>'action'),''),'ALL'));
  group_filter text:=lower(coalesce(
    nullif(trim(filters->>'transactionGroup'),''),nullif(trim(filters->>'module'),'')
  ));
  type_filter text:=lower(coalesce(
    nullif(trim(filters->>'transactionType'),''),nullif(trim(filters->>'entityType'),'')
  ));
  search_filter text:=lower(trim(coalesce(filters->>'search','')));
  page_number integer:=1;
  page_size integer:=50;
  result jsonb;
begin
  if uid is null then
    raise exception using errcode='42501',message='La sesion no identifica un usuario.';
  end if;
  perform public.security_assert_role_access('audit:change-report','view');

  if jsonb_typeof(filters)<>'object' then raise exception 'Los filtros del reporte no son validos.'; end if;
  if month_text!~'^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'El mes debe tener el formato AAAA-MM.'; end if;
  month_start:=to_date(month_text||'-01','YYYY-MM-DD');
  if to_char(month_start,'YYYY-MM')<>month_text then raise exception 'El mes seleccionado no es valido.'; end if;
  month_end:=(month_start+interval '1 month')::date;

  if nullif(trim(filters->>'userId'),'')is not null then
    if trim(filters->>'userId')!~'^\d+$' then raise exception 'El usuario seleccionado no es valido.'; end if;
    user_filter:=(filters->>'userId')::bigint;
  end if;
  if nullif(trim(filters->>'subsidiaryId'),'')is not null then
    if trim(filters->>'subsidiaryId')!~'^\d+$' then raise exception 'La subsidiaria seleccionada no es valida.'; end if;
    subsidiary_filter:=(filters->>'subsidiaryId')::bigint;
    if not exists(
      select 1 from public.user_subsidiaries access
      where access.user_id=uid and access.subsidiary_id=subsidiary_filter
    )then raise exception using errcode='42501',message='No tiene acceso a la subsidiaria seleccionada.';
    end if;
  end if;
  if action_filter not in(
    'ALL','MODIFICACION','MODIFICACIÓN','UPDATE','UPDATED','MODIFIED',
    'ELIMINACION','ELIMINACIÓN','DELETE','DELETED'
  )then raise exception 'La accion seleccionada no es valida.';
  end if;
  if action_filter<>'ALL'then action_filter:=public.audit_change_action_code(action_filter); end if;
  if length(coalesce(group_filter,''))>80 or length(coalesce(type_filter,''))>120 then
    raise exception 'El grupo o tipo de transaccion seleccionado no es valido.';
  end if;
  if type_filter is not null and not(type_filter=any(public.audit_change_transaction_entity_types()))then
    raise exception 'El tipo de transaccion seleccionado no pertenece al reporte.';
  end if;
  if length(search_filter)>200 then raise exception 'La busqueda no puede superar 200 caracteres.'; end if;

  if nullif(trim(filters->>'page'),'')is not null then
    if trim(filters->>'page')!~'^\d+$'then raise exception 'La pagina no es valida.';end if;
    page_number:=(filters->>'page')::integer;
  end if;
  if nullif(trim(filters->>'pageSize'),'')is not null then
    if trim(filters->>'pageSize')!~'^\d+$'then raise exception 'El tamano de pagina no es valido.';end if;
    page_size:=(filters->>'pageSize')::integer;
  end if;
  if page_number<1 then raise exception 'La pagina debe ser mayor que cero.'; end if;
  if page_size<1 or page_size>500 then raise exception 'El tamano de pagina debe estar entre 1 y 500.'; end if;

  with source_events as materialized(
    select
      a.log_id,a."timestamp" occurred_at,
      a.action source_action,
      coalesce(a.user_id,deleted.deleted_by_user_id)actor_user_id,
      coalesce(nullif(a.created_by_name,''),
        nullif(trim(concat_ws(' ',actor.first_name,actor.last_name)),''),
        nullif(a.created_by_email,''),actor.email,'Proceso del sistema')actor_name,
      coalesce(nullif(a.created_by_email,''),actor.email,'sistema@gentia.local')actor_email,
      coalesce(nullif(a.actor_type,''),case when actor.user_id is null then 'SYSTEM_JOB'else'HUMAN'end)actor_kind,
      coalesce(nullif(a.actor_source,''),'Gentia ERP')actor_origin,
      a.entity_type source_entity_type,a.entity_id source_entity_id,a.entity_key source_entity_key,
      a.description,a.result,a.ip_address::text ip_address,
      a.execution_context_id,
      deleted.deleted_id,deleted.reason,
      public.audit_change_try_jsonb(deleted.record_data_json)deleted_snapshot_raw,
      public.audit_change_sanitize_snapshot(
        public.audit_change_try_jsonb(deleted.record_data_json)
      )deleted_snapshot,
      coalesce(changes.items,'[]'::jsonb)changes,
      coalesce(changes.change_count,0)::integer change_count,
      parent.value parent
    from public.audit_log a
    left join lateral(
      select record.deleted_id,record.deleted_by_user_id,record.reason,record.record_data_json
      from public.deleted_records record
      where record.audit_log_id=a.log_id
      order by record.deleted_id desc limit 1
    )deleted on true
    left join public.users actor on actor.user_id=coalesce(a.user_id,deleted.deleted_by_user_id)
    left join lateral(
      select jsonb_agg(jsonb_build_object(
        'id',change.change_id,
        'field',change.field_name,
        'fieldLabel',public.audit_change_field_label(change.field_name),
        'oldValue',case when length(coalesce(change.old_value,''))>1000
          then left(change.old_value,1000)||'...'else change.old_value end,
        'newValue',case when length(coalesce(change.new_value,''))>1000
          then left(change.new_value,1000)||'...'else change.new_value end,
        'changeType',coalesce(nullif(change.change_type,''),'MODIFICACION')
      )order by change.change_id)items,count(*)::integer change_count
      from public.change_log change
      where change.audit_log_id=a.log_id
        and not public.audit_change_is_technical_field(change.field_name)
        and not public.audit_change_is_sensitive_field(change.field_name)
    )changes on true
    cross join lateral(
      select public.audit_change_transaction_parent(
        a.entity_type,a.entity_id,a.entity_key,
        public.audit_change_try_jsonb(deleted.record_data_json),a.execution_context_id,a.log_id
      )value
    )parent
    where a."timestamp">=month_start::timestamp at time zone 'America/Costa_Rica'
      and a."timestamp"<month_end::timestamp at time zone 'America/Costa_Rica'
      and(
        (a.entity_type=any(public.audit_change_transaction_entity_types())
          and a.action in(
            'MODIFICACION','UPDATE','UPDATED','MODIFIED',
            'ELIMINACION','DELETE','DELETED'
          )
          and(a.action in('ELIMINACION','DELETE','DELETED')or coalesce(changes.change_count,0)>0))
        or(a.entity_type=any(public.audit_change_transaction_child_entity_types())
          and a.action in(
            'CREACION','INSERT','CREATED',
            'MODIFICACION','UPDATE','UPDATED','MODIFIED',
            'ELIMINACION','DELETE','DELETED'
          )
          and(a.action not in('MODIFICACION','UPDATE','UPDATED','MODIFIED')or coalesce(changes.change_count,0)>0))
      )
  ),raw_events as materialized(
    select
      event.log_id,event.occurred_at,
      case when coalesce((event.parent->>'isChild')::boolean,false)then'MODIFICACION'
        else public.audit_change_action_code(event.source_action)end action_code,
      event.actor_user_id,event.actor_name,event.actor_email,event.actor_kind,event.actor_origin,
      event.parent->>'rootEntityType'entity_type,
      public.audit_change_try_bigint(event.parent->>'rootEntityId')entity_id,
      event.parent->>'rootEntityKey'entity_key,
      event.description,event.result,event.ip_address,event.execution_context_id,
      coalesce(nullif(event.execution_context_id,''),'audit:'||event.log_id::text)operation_key,
      coalesce(nullif(event.parent->>'rootEntityKey',''),event.parent->>'rootEntityId','audit:'||event.log_id::text)entity_identity,
      coalesce((event.parent->>'isChild')::boolean,false)is_child,
      case when coalesce((event.parent->>'isChild')::boolean,false)then null else event.deleted_id end deleted_id,
      case when coalesce((event.parent->>'isChild')::boolean,false)then null else event.reason end reason,
      case when coalesce((event.parent->>'isChild')::boolean,false)then'{}'::jsonb
        else event.deleted_snapshot_raw end deleted_snapshot_raw,
      case when coalesce((event.parent->>'isChild')::boolean,false)then'{}'::jsonb
        else event.deleted_snapshot end deleted_snapshot,
      public.audit_change_transaction_child_changes(
        event.source_entity_type,event.source_entity_id,event.source_action,event.changes,event.parent
      )changes,
      jsonb_array_length(public.audit_change_transaction_child_changes(
        event.source_entity_type,event.source_entity_id,event.source_action,event.changes,event.parent
      ))::integer change_count,
      public.audit_change_transaction_meta(event.parent->>'rootEntityType')meta
    from source_events event
    where event.parent is not null
      and not(
        coalesce((event.parent->>'isChild')::boolean,false)
        and event.source_action in('CREACION','INSERT','CREATED')
        and(event.execution_context_id is null or exists(
          select 1 from public.audit_log created_root
          where created_root.execution_context_id=event.execution_context_id
            and created_root.entity_type=event.parent->>'rootEntityType'
            and created_root.entity_id=public.audit_change_try_bigint(event.parent->>'rootEntityId')
            and created_root.action in('CREACION','INSERT','CREATED')
        ))
      )
  ),identified_raw_events as materialized(
    select event.*,identity.value identity
    from raw_events event
    cross join lateral(
      select public.audit_change_transaction_identity(
        event.entity_type,event.entity_id,event.entity_key,
        event.deleted_snapshot_raw,event.changes,event.log_id
      )value
    )identity
  ),prioritized_events as materialized(
    select event.*
    from identified_raw_events event
    where not exists(
      select 1 from identified_raw_events preferred
      where preferred.operation_key=event.operation_key
        and(preferred.meta->>'priority')::integer<(event.meta->>'priority')::integer
        and public.audit_change_transaction_identities_related(preferred.identity,event.identity)
    )
  ),expanded_changes as materialized(
    select event.operation_key,event.entity_type,event.entity_identity,
      event.occurred_at,event.log_id,change.value item
    from prioritized_events event
    cross join lateral jsonb_array_elements(event.changes)change(value)
  ),field_rollup as materialized(
    select expanded.operation_key,expanded.entity_type,expanded.entity_identity,
      expanded.item->>'field'field_name,
      max(expanded.item->>'fieldLabel')field_label,
      (array_agg(expanded.item->>'oldValue'
        order by expanded.occurred_at,expanded.log_id,expanded.item->>'id'))[1]old_value,
      (array_agg(expanded.item->>'newValue'
        order by expanded.occurred_at desc,expanded.log_id desc,expanded.item->>'id' desc))[1]new_value,
      max(expanded.item->>'changeType')change_type,
      count(*)::integer occurrences,
      max(public.audit_change_try_bigint(expanded.item->>'id'))change_id
    from expanded_changes expanded
    group by expanded.operation_key,expanded.entity_type,expanded.entity_identity,
      expanded.item->>'field'
  ),collapsed_changes as materialized(
    select rolled.operation_key,rolled.entity_type,rolled.entity_identity,
      jsonb_agg(jsonb_build_object(
        'id',rolled.change_id,
        'field',rolled.field_name,
        'fieldLabel',rolled.field_label,
        'oldValue',rolled.old_value,
        'newValue',rolled.new_value,
        'changeType',rolled.change_type,
        'occurrences',rolled.occurrences
      )order by rolled.field_label,rolled.field_name)items,
      count(*)::integer change_count
    from field_rollup rolled
    group by rolled.operation_key,rolled.entity_type,rolled.entity_identity
  ),collapsed_base as materialized(
    select
      event.operation_key,event.entity_type,event.entity_identity,event.meta,
      max(event.occurred_at)occurred_at,
      (array_agg(event.log_id order by event.occurred_at desc,event.log_id desc))[1]log_id,
      jsonb_agg(event.log_id order by event.occurred_at,event.log_id)audit_ids,
      count(*)::integer consolidated_event_count,
      coalesce(
        (array_agg(event.action_code order by event.occurred_at desc,event.log_id desc)
          filter(where not event.is_child))[1],
        'MODIFICACION'
      )action_code,
      (array_agg(event.actor_user_id order by event.occurred_at desc,event.log_id desc)
        filter(where event.actor_user_id is not null))[1]actor_user_id,
      (array_agg(event.actor_name order by event.occurred_at desc,event.log_id desc))[1]actor_name,
      (array_agg(event.actor_email order by event.occurred_at desc,event.log_id desc))[1]actor_email,
      (array_agg(event.actor_kind order by event.occurred_at desc,event.log_id desc))[1]actor_kind,
      (array_agg(event.actor_origin order by event.occurred_at desc,event.log_id desc))[1]actor_origin,
      (array_agg(event.entity_id order by event.occurred_at desc,event.log_id desc)
        filter(where event.entity_id is not null))[1]entity_id,
      (array_agg(event.entity_key order by event.occurred_at desc,event.log_id desc)
        filter(where event.entity_key is not null))[1]entity_key,
      (array_agg(event.description order by event.occurred_at desc,event.log_id desc))[1]description,
      (array_agg(event.result order by event.occurred_at desc,event.log_id desc))[1]result,
      (array_agg(event.ip_address order by event.occurred_at desc,event.log_id desc)
        filter(where event.ip_address is not null))[1]ip_address,
      (array_agg(event.execution_context_id order by event.occurred_at desc,event.log_id desc)
        filter(where event.execution_context_id is not null))[1]execution_context_id,
      (array_agg(event.deleted_id order by event.occurred_at desc,event.log_id desc)
        filter(where event.deleted_id is not null))[1]deleted_id,
      (array_agg(event.reason order by event.occurred_at desc,event.log_id desc)
        filter(where event.reason is not null))[1]reason,
      coalesce(
        (jsonb_agg(event.deleted_snapshot_raw order by event.occurred_at desc,event.log_id desc)
          filter(where event.action_code='ELIMINACION'))->0,
        '{}'::jsonb
      )deleted_snapshot_raw,
      coalesce(
        (jsonb_agg(event.deleted_snapshot order by event.occurred_at desc,event.log_id desc)
          filter(where event.action_code='ELIMINACION'))->0,
        '{}'::jsonb
      )deleted_snapshot
    from prioritized_events event
    group by event.operation_key,event.entity_type,event.entity_identity,event.meta
  ),collapsed_events as materialized(
    select base.*,
      coalesce(changes.items,'[]'::jsonb)changes,
      coalesce(changes.change_count,0)::integer change_count
    from collapsed_base base
    left join collapsed_changes changes
      using(operation_key,entity_type,entity_identity)
  ),identified_events as materialized(
    select event.*,identity.value identity
    from collapsed_events event
    cross join lateral(
      select public.audit_change_transaction_identity(
        event.entity_type,event.entity_id,event.entity_key,
        event.deleted_snapshot_raw,event.changes,event.log_id
      )value
    )identity
  ),authorized_events as materialized(
    select event.*
    from identified_events event
    where jsonb_array_length(coalesce(event.identity->'subsidiaryIds','[]'::jsonb))>0
      and not exists(
      select 1
      from jsonb_array_elements_text(coalesce(event.identity->'subsidiaryIds','[]'::jsonb))required_id
      where not exists(
        select 1 from public.user_subsidiaries access
        where access.user_id=uid
          and access.subsidiary_id=public.audit_change_try_bigint(required_id.value)
      )
    )
      and(subsidiary_filter is null or exists(
        select 1
        from jsonb_array_elements_text(coalesce(event.identity->'subsidiaryIds','[]'::jsonb))selected_id
        where public.audit_change_try_bigint(selected_id.value)=subsidiary_filter
      ))
  ),filtered as materialized(
    select event.*
    from authorized_events event
    where(user_filter is null or event.actor_user_id=user_filter)
      and(action_filter='ALL'or event.action_code=action_filter)
      and(group_filter is null or event.meta->>'groupCode'=group_filter)
      and(type_filter is null or event.entity_type=type_filter)
      and(search_filter=''or lower(concat_ws(' ',
        event.actor_name,event.actor_email,event.entity_type,event.meta->>'typeLabel',
        event.meta->>'groupLabel',event.identity->>'documentNumber',
        event.identity->>'subsidiaryName',event.identity->'subsidiaryNames',
        event.identity->'documentCreator',event.entity_key,event.entity_id::text,
        event.description,event.changes::text,event.deleted_snapshot::text,event.reason
      ))like'%'||search_filter||'%')
  ),totals as(
    select count(*)::integer record_count,
      count(*)filter(where action_code='MODIFICACION')::integer modified_count,
      count(*)filter(where action_code='ELIMINACION')::integer deleted_count,
      coalesce(sum(change_count),0)::integer changed_field_count,
      coalesce(sum(consolidated_event_count),0)::integer raw_audit_event_count,
      count(distinct coalesce(actor_user_id::text,actor_email))::integer user_count,
      count(distinct entity_type)::integer transaction_type_count,
      count(distinct operation_key)::integer operation_count
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
        count(distinct operation_key)::integer operation_count
      from filtered group by actor_user_id,actor_name,actor_email
    )metric
  ),by_group as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'group',metric.group_code,'code',metric.group_code,'label',metric.group_label,
      'modified',metric.modified_count,'deleted',metric.deleted_count,
      'events',metric.record_count,'records',metric.record_count
    )order by metric.record_count desc,metric.group_label),'[]'::jsonb)value
    from(
      select meta->>'groupCode'group_code,meta->>'groupLabel'group_label,
        count(*)::integer record_count,
        count(*)filter(where action_code='MODIFICACION')::integer modified_count,
        count(*)filter(where action_code='ELIMINACION')::integer deleted_count
      from filtered group by meta->>'groupCode',meta->>'groupLabel'
    )metric
  ),by_type as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'type',metric.type_code,'code',metric.type_code,'label',metric.type_label,
      'group',metric.group_code,'groupLabel',metric.group_label,
      'modified',metric.modified_count,'deleted',metric.deleted_count,
      'events',metric.record_count,'records',metric.record_count
    )order by metric.record_count desc,metric.type_label),'[]'::jsonb)value
    from(
      select entity_type type_code,meta->>'typeLabel'type_label,
        meta->>'groupCode'group_code,meta->>'groupLabel'group_label,
        count(*)::integer record_count,
        count(*)filter(where action_code='MODIFICACION')::integer modified_count,
        count(*)filter(where action_code='ELIMINACION')::integer deleted_count
      from filtered
      group by entity_type,meta->>'typeLabel',meta->>'groupCode',meta->>'groupLabel'
    )metric
  ),by_day as(
    select coalesce(jsonb_agg(jsonb_build_object(
      'date',metric.day_value,'modified',metric.modified_count,
      'deleted',metric.deleted_count,'events',metric.record_count,'records',metric.record_count
    )order by metric.day_value),'[]'::jsonb)value
    from(
      select(occurred_at at time zone 'America/Costa_Rica')::date day_value,
        count(*)::integer record_count,
        count(*)filter(where action_code='MODIFICACION')::integer modified_count,
        count(*)filter(where action_code='ELIMINACION')::integer deleted_count
      from filtered group by 1
    )metric
  ),paged as(
    select * from filtered
    order by meta->>'groupLabel',meta->>'typeLabel',occurred_at desc,log_id desc
    limit page_size offset(page_size*(page_number-1))
  )
  select jsonb_build_object(
    'header',jsonb_build_object(
      'title','Transacciones modificadas y eliminadas',
      'subtitle','Documentos de negocio consolidados por tipo de transaccion',
      'month',month_text,'dateFrom',month_start,'dateTo',(month_end-1),
      'periodLabel',month_text,'timeZone','America/Costa_Rica','generatedAt',current_timestamp,
      'scope','authorized_subsidiaries',
      'filterDescription',concat_ws(' / ',
        case when subsidiary_filter is null then 'Todas las subsidiarias autorizadas'
          else(select name from public.subsidiaries where subsidiary_id=subsidiary_filter)end,
        case when user_filter is null then 'Todos los usuarios'else'Usuario seleccionado'end,
        case when action_filter='ALL'then'Modificadas y eliminadas'
          when action_filter='MODIFICACION'then'Solo modificadas'else'Solo eliminadas'end,
        coalesce(group_filter,'Todos los grupos')
      ),
      'filters',jsonb_build_object(
        'userId',user_filter,'subsidiaryId',subsidiary_filter,'action',action_filter,
        'transactionGroup',group_filter,'transactionType',type_filter,
        'module',group_filter,'entityType',type_filter,'search',search_filter
      )
    ),
    'summary',jsonb_build_object(
      'recordCount',totals.record_count,'totalEvents',totals.record_count,
      'modifiedCount',totals.modified_count,'deletedCount',totals.deleted_count,
      'changedFieldCount',totals.changed_field_count,'fieldChanges',totals.changed_field_count,
      'changedFields',totals.changed_field_count,
      'rawAuditEventCount',totals.raw_audit_event_count,
      'consolidatedEventCount',greatest(totals.raw_audit_event_count-totals.record_count,0),
      'userCount',totals.user_count,'usersCount',totals.user_count,
      'entityTypeCount',totals.transaction_type_count,
      'transactionTypeCount',totals.transaction_type_count,
      'operationCount',totals.operation_count,
      'mostActiveUser',by_user.most_active_user,
      'deletionRate',case when totals.record_count=0 then 0
        else round(totals.deleted_count::numeric*100/totals.record_count,2)end,
      'byUser',by_user.value,
      'byTransactionGroup',by_group.value,
      'byTransactionType',by_type.value,
      'byModule',by_group.value,
      'byDay',by_day.value
    ),
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'auditId',row.log_id,'auditLogId',row.log_id,'auditIds',row.audit_ids,
      'consolidatedAuditEvents',row.consolidated_event_count,
      'deletedRecordId',case when row.action_code='ELIMINACION'then row.deleted_id end,
      'timestamp',row.occurred_at,'occurredAt',row.occurred_at,
      'executionContextId',row.execution_context_id,
      'operationKey',row.operation_key,
      'action',row.action_code,
      'actionLabel',case row.action_code when'MODIFICACION'then'Modificada'else'Eliminada'end,
      'actor',jsonb_build_object(
        'id',row.actor_user_id,'name',row.actor_name,'email',row.actor_email,
        'type',row.actor_kind,'actorType',row.actor_kind,'source',row.actor_origin
      ),
      'documentCreator',row.identity->'documentCreator',
      'createdBy',row.identity->'documentCreator',
      'subsidiaryId',row.identity->'subsidiaryId',
      'subsidiaryIds',row.identity->'subsidiaryIds',
      'subsidiaryName',row.identity->>'subsidiaryName',
      'subsidiaryNames',row.identity->'subsidiaryNames',
      'transactionGroup',row.meta->>'groupCode',
      'transactionGroupLabel',row.meta->>'groupLabel',
      'transactionType',row.entity_type,
      'transactionTypeLabel',row.meta->>'typeLabel',
      'transactionId',row.identity->>'transactionId',
      'journalId',row.identity->>'journalId',
      'documentNumber',row.identity->>'documentNumber',
      'documentReference',row.identity->>'documentNumber',
      'module',row.meta->>'groupCode','moduleLabel',row.meta->>'groupLabel',
      'entityType',row.entity_type,'entityLabel',row.meta->>'typeLabel',
      'entityId',row.entity_id,'entityKey',row.entity_key,
      'recordLabel',row.identity->>'documentNumber',
      'description',row.description,'result',row.result,'ipAddress',row.ip_address,
      'changeCount',row.change_count,'fieldsChangedCount',row.change_count,
      'changes',row.changes,
      'deletedSnapshot',case when row.action_code='ELIMINACION'then row.deleted_snapshot end,
      'deletionReason',case when row.action_code='ELIMINACION'then row.reason end
    )order by row.meta->>'groupLabel',row.meta->>'typeLabel',row.occurred_at desc,row.log_id desc)
      from paged row),'[]'::jsonb),
    'total',totals.record_count,'page',page_number,'pageSize',page_size,
    'totalPages',case when totals.record_count=0 then 0
      else ceil(totals.record_count::numeric/page_size)::integer end
  )into result
  from totals,by_user,by_group,by_type,by_day;

  return result;
end
$$;

-- Las primeras iteraciones de este reporte usaban firmas sin el punto
-- historico de auditoria. Despues de reemplazar los RPC principales ya no
-- existen dependencias sobre ellas y se eliminan para evitar caminos de
-- ejecucion obsoletos en instalaciones que actualizaron la funcion en vivo.
drop function if exists public.audit_change_transaction_identity(text,bigint,text,jsonb,jsonb);
drop function if exists public.audit_change_transaction_parent(text,bigint,text,jsonb,text);

comment on function public.audit_change_report_options() is
  'Filtros de documentos transaccionales auditados, limitados a las subsidiarias autorizadas.';
comment on function public.run_audit_change_report(jsonb) is
  'Reporte mensual consolidado de transacciones modificadas o eliminadas por usuario y subsidiaria.';

revoke all on function public.audit_change_report_options() from public,anon;
revoke all on function public.run_audit_change_report(jsonb) from public,anon;
grant execute on function public.audit_change_report_options() to authenticated,service_role;
grant execute on function public.run_audit_change_report(jsonb) to authenticated,service_role;

notify pgrst,'reload schema';


