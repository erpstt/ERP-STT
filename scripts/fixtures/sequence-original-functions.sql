-- Reviewed production generator snapshots, for isolated tests only.
CREATE OR REPLACE FUNCTION public.reverse_pending_invoice_journal_before_service_dimensions(p_journal_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare src journal%rowtype;d date;amount numeric(24,6);foreign_amount numeric(24,6);ratio numeric(30,15);kind text;invoice_key bigint;reason text;period_key bigint;type_key bigint;status_key bigint;number text;transaction_key bigint;reversal_key bigint;memo_value text;
begin
 if not exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)where ur.user_id=app_user_id()and p.code='accounting:journal:reverse')then raise exception'No tiene permiso para reversar asientos.';end if;
 select*into src from journal where journal_id=p_journal_id and subsidiary_id in(select subsidiary_id from user_subsidiaries where user_id=app_user_id())for update;
 if src.journal_id is null or not(src.journal_number like'ASI_PEN-%'or src.journal_type='Asientos Pendientes de Facturar')then raise exception'El asiento seleccionado no es ASI_PEN.';end if;
 if src.status<>'CONTABILIZADO'or src.reversal_status in('REVERSADO_TOTAL','ANULADO')then raise exception'El asiento no tiene saldo disponible para reversar.';end if;
 d:=nullif(p_payload->>'reversalDate','')::date;amount:=nullif(p_payload->>'amount','')::numeric;kind:=p_payload->>'type';invoice_key:=nullif(p_payload->>'invoiceId','')::bigint;reason:=nullif(trim(p_payload->>'errorDescription'),'');
 if d is null or amount is null or amount<=0 then raise exception'Indique una fecha y un monto de reversión válidos.';end if;
 if amount>src.pending_balance_local+.000001 then raise exception'El monto a reversar (%) supera el saldo disponible pendiente del asiento (%).',to_char(amount,'FM999G999G999G990D00'),to_char(src.pending_balance_local,'FM999G999G999G990D00');end if;
 if kind not in('FACTURACION','ERROR_CORRECCION')then raise exception'Seleccione el tipo de reversión.';end if;
 if kind='FACTURACION'and(invoice_key is null or not exists(select 1 from invoice i where i.invoice_id=invoice_key and i.subsidiary_id=src.subsidiary_id and(not exists(select 1 from journal_line jl where jl.journal_id=src.journal_id and jl.customer_id is not null)or i.customer_id in(select jl.customer_id from journal_line jl where jl.journal_id=src.journal_id and jl.customer_id is not null))))then raise exception'Seleccione una factura de venta válida para el cliente del asiento.';end if;
 if kind='ERROR_CORRECCION'and(reason is null or length(reason)<15)then raise exception'La descripción del error debe contener al menos 15 caracteres.';end if;
 select fiscal_period_id into period_key from fiscal_periods where subsidiary_id=src.subsidiary_id and d between start_date and end_date and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)order by start_date desc limit 1 for update;
 if period_key is null then raise exception'No existe un período contable abierto para la fecha de reversión.';end if;
 select transaction_type_id into type_key from transaction_types where abbreviation='ASI_REV_PEN';select status_id into status_key from"transaction"where transaction_id=src.transaction_id;
 insert into number_sequences(scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length)values('Transacción',type_key,src.subsidiary_id,'ASI_REV_PEN-',0,8)on conflict(transaction_type_id,subsidiary_id)where scope_type='Transacción'do nothing;
 number:=next_transaction_number(type_key,src.subsidiary_id);ratio:=amount/src.pending_initial_local;foreign_amount:=round(src.pending_initial_foreign*ratio,6);memo_value:=case when kind='FACTURACION'then'Reversión de '||src.journal_number||' por factura '||(select invoice_number from invoice where invoice_id=invoice_key)else'Reversión de '||src.journal_number||': '||reason end;
 insert into"transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id)values(number,d,type_key,src.subsidiary_id,src.currency_id,src.exchange_rate,period_key,amount,status_key)returning transaction_id into transaction_key;
 insert into journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by,reversed_from_journal_id)values(number,d,transaction_key,src.subsidiary_id,src.currency_id,period_key,src.exchange_rate,memo_value,'Reversión de Pendiente de Facturar',amount,amount,'CONTABILIZADO',app_user_id(),src.journal_id)returning journal_id into reversal_key;
 insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,tax_code_id,tax_rate,gross_amount,note,entity_type,customer_id,supplier_id,employee_id,cost_center_id,financial_creditor_id,related_company_id)
 select reversal_key,account_id,round(credit*ratio,6),round(debit*ratio,6),round(credit_fx*ratio,6),round(debit_fx*ratio,6),department_id,class_id,location_id,tax_code_id,tax_rate,round(coalesce(gross_amount,0)*ratio,6),memo_value,entity_type,customer_id,supplier_id,employee_id,cost_center_id,financial_creditor_id,related_company_id from journal_line where journal_id=src.journal_id;
 perform sync_journal_gl_impacts(reversal_key);
 insert into pending_invoice_reversal(source_journal_id,reversal_journal_id,reversal_date,reversed_local,reversed_foreign,reversal_type,sales_invoice_id,error_description)values(src.journal_id,reversal_key,d,amount,foreign_amount,kind,case when kind='FACTURACION'then invoice_key end,case when kind='ERROR_CORRECCION'then reason end);
 perform set_config('app.pending_reversal_write','1',true);
 update journal set pending_reversed_local=pending_reversed_local+amount,pending_reversed_foreign=pending_reversed_foreign+foreign_amount,pending_balance_local=greatest(pending_initial_local-pending_reversed_local-amount,0),pending_balance_foreign=greatest(pending_initial_foreign-pending_reversed_foreign-foreign_amount,0),reversal_status=case when pending_initial_local-pending_reversed_local-amount<=.000001 then'REVERSADO_TOTAL'else'REVERSADO_PARCIAL'end where journal_id=src.journal_id;
 return jsonb_build_object('journalId',reversal_key,'number',number,'amount',amount,'remaining',greatest(src.pending_balance_local-amount,0));
end$function$;

CREATE OR REPLACE FUNCTION fx_revaluation_private.fx_post_journal(p_run bigint, p_date date, p_sign integer, p_note text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  run_row public.fx_revaluation_runs%rowtype;
  period_key bigint;
  local_currency bigint;
  transaction_type_key bigint;
  journal_key bigint;
  number_value text;
  item jsonb;
  amount_value numeric;
  total_value numeric;
  counterpart_account bigint;
begin
  if p_sign not in(-1,1)then
    raise exception 'Sentido de asiento inválido.';
  end if;
  select * into run_row from public.fx_revaluation_runs
  where run_id=p_run and subsidiary_id=fx_revaluation_private.fx_assert_access();
  if not found then raise exception 'Proceso no encontrado.';end if;
  select fiscal_period_id into period_key from public.fiscal_periods
  where subsidiary_id=run_row.subsidiary_id
    and p_date between start_date and end_date and not is_closed
    and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)
  order by start_date desc limit 1 for update;
  if period_key is null then
    raise exception 'El período de % debe estar abierto.',p_date;
  end if;
  select currency_id into local_currency from public.subsidiaries
  where subsidiary_id=run_row.subsidiary_id;
  select transaction_type_id into transaction_type_key
  from public.transaction_types where abbreviation='DIF_CAM';
  if transaction_type_key is null then
    raise exception 'Configure el tipo de transacción DIF_CAM.';
  end if;
  -- DIF_CAM was introduced after the original cross-subsidiary sequence seed.
  -- Create the missing sequence at first use, including for subsidiaries
  -- created after this migration, without resetting an existing counter.
  insert into public.number_sequences(
    scope_type,transaction_type_id,subsidiary_id,prefix,current_number,
    padding_length
  )values(
    'Transacción',transaction_type_key,run_row.subsidiary_id,'DIF_CAM-',0,8
  )on conflict(transaction_type_id,subsidiary_id)
    where scope_type='Transacción'
  do nothing;
  number_value:=public.next_transaction_number(
    transaction_type_key,run_row.subsidiary_id
  );
  select sum(abs((entry->>'signedAdjustment')::numeric))into total_value
  from jsonb_array_elements(run_row.snapshot)entry;
  if coalesce(total_value,0)<=0 then
    raise exception 'No hay ajustes por contabilizar.';
  end if;
  perform set_config('nexo.fx_posting','on',true);
  insert into public.journal(
    journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,
    exchange_rate,memo,journal_type,total_debit,total_credit,status,
    created_by,fx_revaluation_run_id
  )values(
    number_value,p_date,run_row.subsidiary_id,local_currency,period_key,1,
    p_note||' / Proceso '||run_row.run_id,'Asiento Diferencial Cambiario',
    total_value,total_value,'CONTABILIZADO',public.app_user_id(),run_row.run_id
  )returning journal_id into journal_key;
  for item in select value from jsonb_array_elements(run_row.snapshot)loop
    amount_value:=(item->>'signedAdjustment')::numeric;
    if amount_value=0 then continue;end if;
    counterpart_account:=case when amount_value>0
      then run_row.gain_account_id else run_row.loss_account_id end;
    amount_value:=amount_value*p_sign;
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,note,
      entity_type,customer_id,supplier_id,fx_source_key,
      related_company_id,original_currency_id
    )values(
      journal_key,(item->>'accountId')::bigint,greatest(amount_value,0),
      greatest(-amount_value,0),0,0,
      p_note||' '||coalesce(item->>'document',''),
      case item->>'sourceType' when'CxC'then'Cliente'
        when'CxP'then'Proveedor'end,
      case when item->>'sourceType'='CxC'
        then(item->>'entityId')::bigint end,
      case when item->>'sourceType'='CxP'
        then(item->>'entityId')::bigint end,
      item->>'sourceKey',nullif(item->>'relatedCompanyId','')::bigint,
      coalesce(nullif(item->>'currencyId','')::bigint,run_row.currency_id)
    );
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,note
    )values(
      journal_key,counterpart_account,greatest(-amount_value,0),
      greatest(amount_value,0),0,0,p_note||' - diferencial no realizado'
    );
  end loop;
  perform set_config('nexo.fx_posting','off',true);
  return journal_key;
end
$function$;

CREATE OR REPLACE FUNCTION public.next_transaction_number(target_type bigint, target_subsidiary bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result text;
  type_abbreviation text;
  canonical_max bigint;
begin
  if target_type is null or target_subsidiary is null then
    raise exception 'El tipo de transacción y la subsidiaria son obligatorios.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('transaction-number:'||target_type::text,0)
  );

  select abbreviation into type_abbreviation
  from public.transaction_types
  where transaction_type_id=target_type;

  if type_abbreviation is null then
    raise exception 'El tipo de transaccion indicado no existe.';
  end if;

  -- SOL_PAG usa un numero unico global aunque la configuracion se conserve
  -- por subsidiaria. Antes de incrementar, sincronice la fila seleccionada
  -- con el mayor consecutivo global para evitar recorrer miles de colisiones
  -- cuando una filial llevaba tiempo sin emitir solicitudes.
  if type_abbreviation='SOL_PAG' then
    select coalesce(max(
      (regexp_match(numero,'^SOL_PAG-([0-9]+)$'))[1]::bigint
    ),0) into canonical_max
    from public.solicitudes_pago
    where numero~'^SOL_PAG-[0-9]+$'
      and numero!~'^SOL_PAG-[0-9]{17}$';

    update public.number_sequences
    set current_number=greatest(current_number,canonical_max)
    where scope_type='Transacción'
      and transaction_type_id=target_type
      and subsidiary_id=target_subsidiary;
  end if;

  loop
    result:=null;
    update public.number_sequences
    set current_number=current_number+1
    where scope_type='Transacción'
      and transaction_type_id=target_type
      and subsidiary_id=target_subsidiary
    returning coalesce(prefix,'')||
      case
        when length(current_number::text)<padding_length
          then lpad(current_number::text,padding_length,'0')
        else current_number::text
      end||coalesce(suffix,'')
    into result;

    if result is null then
      if type_abbreviation is distinct from 'SOL_PAG' then
        raise exception
          'No existe una secuencia para el tipo de transacción y subsidiaria seleccionados.';
      end if;

      if not exists(
        select 1 from public.subsidiaries
        where subsidiary_id=target_subsidiary
      ) then
        raise exception 'La subsidiaria indicada no existe.';
      end if;

      select coalesce(max(
        (regexp_match(numero,'^SOL_PAG-([0-9]+)$'))[1]::bigint
      ),0) into canonical_max
      from public.solicitudes_pago
      where numero~'^SOL_PAG-[0-9]+$'
        and numero!~'^SOL_PAG-[0-9]{17}$';

      insert into public.number_sequences(
        scope_type,transaction_type_id,subsidiary_id,prefix,suffix,
        current_number,padding_length,allow_manual_update
      )values(
        'Transacción',target_type,target_subsidiary,'SOL_PAG-',null,
        canonical_max,8,false
      )
      on conflict(transaction_type_id,subsidiary_id)
        where scope_type='Transacción'
      do update set
        prefix='SOL_PAG-',
        suffix=null,
        current_number=greatest(
          public.number_sequences.current_number,
          excluded.current_number
        ),
        padding_length=8,
        allow_manual_update=false;

      continue;
    end if;

    exit when not exists(
      select 1 from public."transaction" where tran_number=result
    ) and not exists(
      select 1 from public.journal where journal_number=result
    ) and not exists(
      select 1 from public.supplier_payment where payment_number=result
    ) and not exists(
      select 1 from public.customer_payment where payment_number=result
    ) and not exists(
      select 1 from public.solicitudes_pago where numero=result
    );
  end loop;

  return result;
end
$function$;

CREATE OR REPLACE FUNCTION public.reverse_opening_pending_invoice_before_period_type(p_item_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
 item opening_pending_invoice_items%rowtype;run_row opening_balance_runs%rowtype;control_line opening_pending_invoice_lines%rowtype;counterpart_line opening_pending_invoice_lines%rowtype;
 run_key bigint;
 reversal_date_value date;amount_value numeric(24,6);foreign_value numeric(24,6);ratio numeric(30,15);kind text;invoice_key bigint;reason text;
 period_key bigint;type_key bigint;status_key bigint;book_key bigint;number_value text;transaction_key bigint;journal_key bigint;memo_value text;is_final boolean;
 support jsonb;supports jsonb;control_account bigint;counterpart_account bigint;
begin
 if not exists(select 1 from user_roles ur join role_permissions rp using(role_id)join permissions p using(permission_id)
  where ur.user_id=app_user_id()and p.code='accounting:journal:reverse')then raise exception 'No tiene permiso para reversar asientos.';end if;
 select i.run_id into run_key from opening_pending_invoice_items i join user_subsidiaries u using(subsidiary_id)
  where i.id=p_item_id and u.user_id=app_user_id();
 if run_key is null then raise exception 'El pendiente inicial no existe.';end if;
 -- Uniform lock order for posting/opening reversal/pending reversal: run first,
 -- then the auxiliary item.  Re-read both records after acquiring the locks.
 select *into run_row from opening_balance_runs where id=run_key and subsidiary_id=active_subsidiary_id()for update;
 select i.*into item from opening_pending_invoice_items i where i.id=p_item_id and i.run_id=run_key and i.subsidiary_id=run_row.subsidiary_id for update;
 if run_row.id is null or item.id is null then raise exception 'El pendiente inicial no existe o cambió de subsidiaria.';end if;
 if not item.is_active or run_row.status<>'POSTED'or item.reversal_status in('REVERSADO_TOTAL','ANULADO')then raise exception 'El pendiente inicial no tiene saldo disponible para reversar.';end if;
 reversal_date_value:=nullif(p_payload->>'reversalDate','')::date;amount_value:=nullif(p_payload->>'amount','')::numeric;
 kind:=p_payload->>'type';invoice_key:=nullif(p_payload->>'invoiceId','')::bigint;reason:=nullif(btrim(p_payload->>'errorDescription'),'');
 if reversal_date_value is null or reversal_date_value<=run_row.opening_date then raise exception 'La reversión debe ser posterior a la fecha de apertura.';end if;
 if amount_value is null or amount_value<=0 then raise exception 'Indique un monto de reversión válido.';end if;
 if amount_value>item.balance_local+.000001 then raise exception 'El monto a reversar (%) supera el saldo disponible (%).',amount_value,item.balance_local;end if;
 if kind not in('FACTURACION','ERROR_CORRECCION')then raise exception 'Seleccione el tipo de reversión.';end if;
 if kind='FACTURACION'and(invoice_key is null or not exists(select 1 from invoice i where i.invoice_id=invoice_key and i.subsidiary_id=item.subsidiary_id
  and i.customer_id=item.customer_id and date_trunc('month',i.invoice_date)=date_trunc('month',reversal_date_value)))then
  raise exception 'Seleccione una factura válida del cliente y del mismo mes de la reversión.';
 end if;
 if kind='ERROR_CORRECCION'and(reason is null or length(reason)<15)then raise exception 'La descripción del error debe contener al menos 15 caracteres.';end if;
 supports:=coalesce(p_payload->'supports','[]'::jsonb);
 if jsonb_typeof(supports)<>'array'then raise exception 'Los archivos de respaldo no son válidos.';end if;
 if jsonb_array_length(supports)>0 and kind<>'ERROR_CORRECCION'then raise exception 'Solo las reversiones por error / corrección permiten respaldos.';end if;
 for support in select value from jsonb_array_elements(supports)loop
  if support->>'support_type'='Enlace'then
   if nullif(btrim(support->>'display_name'),'')is null or coalesce(support->>'support_url','')!~*'^https?://[^[:space:]/?#]+[^[:space:]]*$'then raise exception 'Ingrese un enlace válido.';end if;
  elsif support->>'support_type'='Archivo'then
   if nullif(btrim(support->>'file_name'),'')is null or nullif(btrim(support->>'display_name'),'')is null or support->>'file_data'is null
    or coalesce((support->>'file_size')::bigint,-1)not between 0 and 5242880 then raise exception 'Archivo de respaldo inválido o superior a 5 MB.';end if;
  else raise exception 'Tipo de respaldo no válido.';end if;
 end loop;
 select *into control_line from opening_pending_invoice_lines where item_id=item.id and line_role='CONTROL';
 select *into counterpart_line from opening_pending_invoice_lines where item_id=item.id and line_role='COUNTERPART';
 select account_id into control_account from chart_accounts where account_number='113003';
 select account_id into counterpart_account from chart_accounts where account_number='413001';
 if control_line.account_id<>control_account or counterpart_line.account_id<>counterpart_account then raise exception 'La composición contable del pendiente fue modificada. Valide 113003 y 413001.';end if;
 select fiscal_period_id into period_key from fiscal_periods where subsidiary_id=item.subsidiary_id and reversal_date_value between start_date and end_date
  and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)order by start_date desc limit 1 for update;
 if period_key is null then raise exception 'No existe un período contable abierto para la fecha de reversión.';end if;
 select transaction_type_id into type_key from transaction_types where abbreviation='ASI_REV_PEN';
 if type_key is null then raise exception 'No existe el tipo de transacción ASI_REV_PEN.';end if;
 select status_id into status_key from status where code='APROBADO'and module='Transacciones'limit 1;
 if status_key is null then select status_id into status_key from status order by status_id limit 1;end if;
 if status_key is null then raise exception 'No existe un estado contable para registrar la reversión.';end if;
 select accounting_book_id into book_key from accounting_books where subsidiary_id=item.subsidiary_id and is_primary and is_active order by accounting_book_id limit 1;
 if book_key is null then raise exception 'Configure un libro contable principal activo.';end if;
 insert into number_sequences(scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length)
  values('Transacción',type_key,item.subsidiary_id,'ASI_REV_PEN-',0,8)
  on conflict(transaction_type_id,subsidiary_id)where scope_type='Transacción'do nothing;
 number_value:=next_transaction_number(type_key,item.subsidiary_id);is_final:=amount_value>=item.balance_local-.000001;
 if is_final then amount_value:=item.balance_local;foreign_value:=item.balance_foreign;
 else ratio:=amount_value/item.initial_local;foreign_value:=least(round(item.initial_foreign*ratio,6),item.balance_foreign);end if;
 memo_value:=case when kind='FACTURACION'then'Reversión de saldo inicial '||item.reference||' por factura '||(select invoice_number from invoice where invoice_id=invoice_key)
  else'Reversión de saldo inicial '||item.reference||': '||reason end;
 insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount,status_id,customer_id)
  values(number_value,reversal_date_value,type_key,item.subsidiary_id,item.currency_id,item.historical_exchange_rate,period_key,amount_value,status_key,item.customer_id)
  returning transaction_id into transaction_key;
 insert into journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by)
  values(number_value,reversal_date_value,transaction_key,item.subsidiary_id,item.currency_id,period_key,item.historical_exchange_rate,memo_value,'Reversión de Pendiente de Facturar',amount_value,amount_value,'CONTABILIZADO',app_user_id())
  returning journal_id into journal_key;
 -- Exact required entry: Dr 413001 / Cr 113003.  Dimensions and service
 -- attributes remain attached to their respective historical lines.
 insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,cost_center_id,financial_creditor_id,related_company_id,
  service_month,service_country_id,note,entity_type,customer_id,historical_exchange_rate,original_currency_id)
 values
  (journal_key,counterpart_account,amount_value,0,foreign_value,0,counterpart_line.department_id,counterpart_line.class_id,counterpart_line.location_id,counterpart_line.cost_center_id,counterpart_line.financial_creditor_id,counterpart_line.related_company_id,counterpart_line.service_month,counterpart_line.service_country_id,memo_value,'Cliente',item.customer_id,item.historical_exchange_rate,item.currency_id),
  (journal_key,control_account,0,amount_value,0,foreign_value,control_line.department_id,control_line.class_id,control_line.location_id,control_line.cost_center_id,control_line.financial_creditor_id,control_line.related_company_id,control_line.service_month,control_line.service_country_id,memo_value,'Cliente',item.customer_id,item.historical_exchange_rate,item.currency_id);
 -- journal_line triggers build ordinary impacts using the journal rate. Replace
 -- them with the frozen local/original snapshot so the control account clears
 -- exactly, including the last partial-reversal rounding residue.
 delete from gl_impact where transaction_id=transaction_key;
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id)
 values
  (transaction_key,counterpart_account,item.subsidiary_id,period_key,book_key,amount_value,0,foreign_value,0,reversal_date_value,item.currency_id),
  (transaction_key,control_account,item.subsidiary_id,period_key,book_key,0,amount_value,0,foreign_value,reversal_date_value,item.currency_id);
 insert into pending_invoice_reversal(source_opening_pending_id,reversal_journal_id,reversal_date,reversed_local,reversed_foreign,reversal_type,sales_invoice_id,error_description)
  values(item.id,journal_key,reversal_date_value,amount_value,foreign_value,kind,case when kind='FACTURACION'then invoice_key end,case when kind='ERROR_CORRECCION'then reason end);
 update opening_pending_invoice_items set reversed_local=reversed_local+amount_value,reversed_foreign=reversed_foreign+foreign_value,
  balance_local=greatest(initial_local-reversed_local-amount_value,0),balance_foreign=greatest(initial_foreign-reversed_foreign-foreign_value,0),
  reversal_status=case when initial_local-reversed_local-amount_value<=.000001 then'REVERSADO_TOTAL'else'REVERSADO_PARCIAL'end,
  updated_at=now(),updated_by=app_user_id()where id=item.id;
 for support in select value from jsonb_array_elements(supports)loop
  if support->>'support_type'='Enlace'then insert into journal_support(journal_id,support_type,display_name,support_url)
   values(journal_key,'Enlace',support->>'display_name',support->>'support_url');
  else insert into journal_support(journal_id,support_type,display_name,file_name,mime_type,file_size,file_data)
   values(journal_key,'Archivo',support->>'display_name',support->>'file_name',coalesce(support->>'mime_type','application/octet-stream'),(support->>'file_size')::bigint,support->>'file_data');end if;
 end loop;
 return jsonb_build_object('journalId',journal_key,'number',number_value,'amount',amount_value,'remaining',greatest(item.balance_local-amount_value,0),'openingPendingId',item.id);
end$function$;

CREATE OR REPLACE FUNCTION pending_invoice_private.pending_invoice_reclassification_execute(p_reclassification_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint:=public.active_subsidiary_id();
  uid bigint:=public.app_user_id();
  fiscal_year_value integer;
  existing_run public.pending_invoice_reclassification_runs%rowtype;
  run_key bigint;
  period_key bigint;
  type_key bigint;
  status_key bigint;
  book_key bigint;
  book_count integer:=0;
  current_control bigint;
  prior_control bigint;
  current_counterpart bigint;
  bridge_account bigint;
  configured_accounts integer;
  candidate record;
  control_line record;
  counterpart_line record;
  transaction_key bigint;
  journal_key bigint;
  number_value text;
  memo_value text;
  candidate_count integer;
  post_cutoff_reversals integer:=0;
  reconciliation_unbalanced integer:=0;
  local_total numeric(24,6):=0;
  local_debits numeric(24,6);
  local_credits numeric(24,6);
  bridge_debits numeric(24,6);
  bridge_credits numeric(24,6);
  foreign_debits numeric(24,6);
  foreign_credits numeric(24,6);
  bridge_foreign_debits numeric(24,6);
  bridge_foreign_credits numeric(24,6);
begin
  perform public.security_assert_role_access(
    'accounting:pending-invoice-reclassification','create'
  );
  if uid is null or sid is null or not exists(
    select 1 from public.user_subsidiaries access
    where access.user_id=uid and access.subsidiary_id=sid
  )then
    raise exception using errcode='42501',
      message='Seleccione una subsidiaria autorizada para ejecutar la reclasificación.';
  end if;
  if p_reclassification_date is null
    or extract(month from p_reclassification_date)<>1
    or extract(day from p_reclassification_date)<>1 then
    raise exception 'La reclasificación anual debe fecharse el 01 de enero.';
  end if;
  if p_reclassification_date>current_date then
    raise exception 'La reclasificación anual no puede ejecutarse con una fecha futura.';
  end if;
  fiscal_year_value:=extract(year from p_reclassification_date)::integer;

  -- One serialized execution per subsidiary and fiscal year.  The database
  -- unique key is the second line of defense and keeps retries idempotent.
  perform pg_advisory_xact_lock(hashtextextended(
    'pending-invoice-reclassification-subsidiary:'||sid,0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'pending-invoice-reclassification:'||sid||':'||fiscal_year_value,0
  ));
  select * into existing_run
  from public.pending_invoice_reclassification_runs run
  where run.subsidiary_id=sid and run.fiscal_year=fiscal_year_value
  for update;
  if existing_run.id is not null then
    if existing_run.status='POSTED'then
      return public.pending_invoice_reclassification_execution_result(existing_run.id)
        ||jsonb_build_object('alreadyExecuted',true);
    end if;
    raise exception 'La reclasificación del año % ya tiene una ejecución en proceso.',fiscal_year_value;
  end if;

  select period.fiscal_period_id into period_key
  from public.fiscal_periods period
  where period.subsidiary_id=sid
    and p_reclassification_date between period.start_date and period.end_date
    and not period.is_closed and not coalesce(period.gl_closed,false)
    and not coalesce(period.is_inactive,false)
  order by period.start_date desc limit 1 for update;
  if period_key is null then
    raise exception 'No existe un período contable abierto para el 01 de enero.';
  end if;
  select count(*)::integer into book_count
  from public.accounting_books book
  where book.subsidiary_id=sid and book.is_primary and book.is_active;
  if book_count<>1 then
    raise exception 'Debe existir exactamente un libro contable principal activo para la subsidiaria.';
  end if;
  select book.accounting_book_id into book_key
  from public.accounting_books book
  where book.subsidiary_id=sid and book.is_primary and book.is_active
  order by book.accounting_book_id limit 1;
  select transaction_type_id into type_key
  from public.transaction_types where abbreviation='ASI_RECL_PEN';
  select status_id into status_key
  from public.status where code='APROBADO'and module='Transacciones'limit 1;
  if type_key is null or status_key is null then
    raise exception 'No está configurado el tipo o estado contable de la reclasificación.';
  end if;

  select count(*),
    max(account.account_id)filter(where account.account_number='113003'),
    max(account.account_id)filter(where account.account_number='113004'),
    max(account.account_id)filter(where account.account_number='413001'),
    max(account.account_id)filter(where account.account_number='413002')
  into configured_accounts,current_control,prior_control,current_counterpart,bridge_account
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number in('113003','113004','413001','413002')
    and assignment.subsidiary_id=sid and assignment.is_active
    and account.accepts_entries and not account.is_inactive;
  if configured_accounts<>4 then
    raise exception 'Las cuentas 113003, 113004, 413001 y 413002 deben estar activas y asignadas a la subsidiaria.';
  end if;

  -- Writers touching these accounting facts take the same subsidiary advisory
  -- lock in their guards. Avoid row locks here: a row-level UPDATE already
  -- owns its tuple before its guard runs and the inverse order could deadlock.
  select count(*)::integer into post_cutoff_reversals
  from public.pending_invoice_reversal reversal
  where reversal.reversal_date>=p_reclassification_date
    and(
      exists(
        select 1 from public.journal source
        where source.journal_id=reversal.source_journal_id
          and source.subsidiary_id=sid
          and source.journal_date<p_reclassification_date
          and coalesce(source.pending_period_type,'ACTUAL')='ACTUAL'
          and coalesce(source.reversal_status,'PENDIENTE')<>'ANULADO'
      )
      or exists(
        select 1
        from public.opening_pending_invoice_items item
        join public.opening_balance_runs opening_run on opening_run.id=item.run_id
        where item.id=reversal.source_opening_pending_id
          and item.subsidiary_id=sid and item.period_type='ACTUAL'
          and opening_run.opening_date<p_reclassification_date
          and item.opening_reversed_at is null
      )
    );
  if post_cutoff_reversals>0 then
    raise exception 'Existen reversiones fechadas desde el 01 de enero. Corríjalas antes de ejecutar una reclasificación retroactiva.';
  end if;

  drop table if exists pg_temp.pending_reclass_candidate_snapshot;
  create temporary table pending_reclass_candidate_snapshot
  on commit drop as
  select * from public.pending_invoice_reclassification_candidates(
    sid,p_reclassification_date
  );

  select count(*)::integer into reconciliation_unbalanced
  from public.pending_invoice_reclassification_reconciliation(
    sid,p_reclassification_date
  )row where not row.balanced;
  if reconciliation_unbalanced>0 then
    raise exception 'El saldo del Mayor en 113003 no coincide con el auxiliar de pendientes al 01 de enero.';
  end if;

  if exists(
    select 1
    from public.journal source
    where source.subsidiary_id=sid
      and(source.journal_number like'ASI_PEN-%'
        or source.journal_type='Asientos Pendientes de Facturar')
      and coalesce(source.pending_period_type,'ACTUAL')='ACTUAL'
      and source.journal_date<p_reclassification_date
      and source.status='CONTABILIZADO'
      and source.reversal_status not in('REVERSADO_TOTAL','ANULADO')
      and(
        (select count(*)from public.journal_line line
          where line.journal_id=source.journal_id
            and line.account_id=current_control and line.debit>0)<>1
        or(select count(*)from public.journal_line line
          where line.journal_id=source.journal_id
            and line.account_id=current_counterpart and line.credit>0)<>1
        or(select count(*)from public.journal_line line
          where line.journal_id=source.journal_id)<>2
        or exists(select 1 from public.journal_line line
          where line.journal_id=source.journal_id
            and(line.tax_code_id is not null or coalesce(line.tax_rate,0)<>0))
        or(select count(distinct line.customer_id)from public.journal_line line
          where line.journal_id=source.journal_id and line.customer_id is not null)>1
        or source.transaction_id is null
        or(select count(*)from public.gl_impact impact
          where impact.transaction_id=source.transaction_id
            and impact.accounting_book_id=book_key)<>2
        or(select count(*)from public.gl_impact impact
          where impact.transaction_id=source.transaction_id
            and impact.accounting_book_id=book_key
            and impact.account_id=current_control
            and impact.debit_amount>0 and impact.credit_amount=0)<>1
        or(select count(*)from public.gl_impact impact
          where impact.transaction_id=source.transaction_id
            and impact.accounting_book_id=book_key
            and impact.account_id=current_counterpart
            and impact.credit_amount>0 and impact.debit_amount=0)<>1
        or exists(
          select 1
          from(
            select
              coalesce(sum(line.debit)filter(where line.account_id=current_control),0)control_debit,
              coalesce(sum(line.credit)filter(where line.account_id=current_counterpart),0)counterpart_credit,
              coalesce(sum(line.debit_fx)filter(where line.account_id=current_control),0)control_debit_fx,
              coalesce(sum(line.credit_fx)filter(where line.account_id=current_counterpart),0)counterpart_credit_fx
            from public.journal_line line
            where line.journal_id=source.journal_id
          )line_totals
          where line_totals.control_debit<=0
            or line_totals.control_debit_fx<=0
            or abs(line_totals.control_debit-line_totals.counterpart_credit)>.000001
            or abs(line_totals.control_debit_fx-line_totals.counterpart_credit_fx)>.000001
            or abs(line_totals.control_debit-line_totals.control_debit_fx)>.000001
            or abs(line_totals.counterpart_credit-line_totals.counterpart_credit_fx)>.000001
        )
        or exists(
          select 1
          from(
            select
              coalesce(sum(impact.debit_amount)filter(where impact.account_id=current_control),0)control_debit,
              coalesce(sum(impact.credit_amount)filter(where impact.account_id=current_counterpart),0)counterpart_credit,
              coalesce(sum(impact.debit_fx)filter(where impact.account_id=current_control),0)control_debit_fx,
              coalesce(sum(impact.credit_fx)filter(where impact.account_id=current_counterpart),0)counterpart_credit_fx,
              coalesce((select sum(source_line.debit)
                from public.journal_line source_line
                where source_line.journal_id=source.journal_id
                  and source_line.account_id=current_control),0)line_control_debit,
              coalesce((select sum(source_line.credit)
                from public.journal_line source_line
                where source_line.journal_id=source.journal_id
                  and source_line.account_id=current_counterpart),0)line_counterpart_credit,
              coalesce(bool_or(
                coalesce(impact.original_currency_id,transaction_row.currency_id)
                  is distinct from source.currency_id
              ),false)wrong_currency
            from public.gl_impact impact
            join public."transaction" transaction_row using(transaction_id)
            where impact.transaction_id=source.transaction_id
              and impact.accounting_book_id=book_key
          )impact_totals
          where impact_totals.control_debit<=0
            or impact_totals.control_debit_fx<=0
            or abs(impact_totals.control_debit-impact_totals.counterpart_credit)>.000001
            or abs(impact_totals.control_debit_fx-impact_totals.counterpart_credit_fx)>.000001
            or abs(impact_totals.control_debit_fx-impact_totals.line_control_debit)>.000001
            or abs(impact_totals.counterpart_credit_fx-impact_totals.line_counterpart_credit)>.000001
            or abs(impact_totals.control_debit-
              round(impact_totals.line_control_debit*source.exchange_rate,6))>.005
            or abs(impact_totals.counterpart_credit-
              round(impact_totals.line_counterpart_credit*source.exchange_rate,6))>.005
            or impact_totals.wrong_currency
        )
      )
  )then
    raise exception 'Un pendiente anterior no conserva exactamente una línea 113003 al debe y una 413001 al haber.';
  end if;

  select count(*) into candidate_count
  from pg_temp.pending_reclass_candidate_snapshot;
  if candidate_count=0 then
    raise exception 'No hay pendientes del período anterior con saldo vivo para reclasificar.';
  end if;
  if exists(
    select 1 from pg_temp.pending_reclass_candidate_snapshot row
    where row.origin_journal_id is null or row.historical_exchange_rate is null
      or row.historical_exchange_rate<=0
      or row.balance_local<=.000001 or row.balance_foreign<=.000001
      or abs(row.balance_local-round(row.balance_foreign*row.historical_exchange_rate,6))>.005
  )then
    raise exception 'Hay pendientes cuya tasa histórica no reproduce el saldo local. Corrija el auxiliar antes de continuar.';
  end if;

  insert into public.pending_invoice_reclassification_runs(
    subsidiary_id,fiscal_year,reclassification_date,status,created_by
  )values(sid,fiscal_year_value,p_reclassification_date,'PROCESSING',uid)
  returning id into run_key;

  insert into public.number_sequences(
    scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length
  )values('Transacción',type_key,sid,'ASI_RECL_PEN-',0,8)
  on conflict(transaction_type_id,subsidiary_id)
    where scope_type='Transacción'do nothing;

  for candidate in
    select * from pg_temp.pending_reclass_candidate_snapshot
    order by origin_date,source_type,source_id
  loop
    if candidate.source_type='JOURNAL'then
      select line.department_id,line.class_id,line.location_id,line.cost_center_id,
        line.financial_creditor_id,line.related_company_id,line.service_month,
        line.service_country_id,line.customer_id,line.account_id
      into control_line
      from public.journal_line line where line.journal_line_id=candidate.control_line_id;
      select line.department_id,line.class_id,line.location_id,line.cost_center_id,
        line.financial_creditor_id,line.related_company_id,line.service_month,
        line.service_country_id,line.customer_id,line.account_id
      into counterpart_line
      from public.journal_line line where line.journal_line_id=candidate.counterpart_line_id;
    else
      select line.department_id,line.class_id,line.location_id,line.cost_center_id,
        line.financial_creditor_id,line.related_company_id,line.service_month,
        line.service_country_id,candidate.customer_id customer_id,line.account_id
      into control_line
      from public.opening_pending_invoice_lines line where line.id=candidate.control_line_id;
      select line.department_id,line.class_id,line.location_id,line.cost_center_id,
        line.financial_creditor_id,line.related_company_id,line.service_month,
        line.service_country_id,candidate.customer_id customer_id,line.account_id
      into counterpart_line
      from public.opening_pending_invoice_lines line where line.id=candidate.counterpart_line_id;
    end if;
    if control_line.account_id<>current_control
      or counterpart_line.account_id<>current_counterpart then
      raise exception 'El pendiente % ya no conserva la composición 113003 / 413001.',candidate.source_reference;
    end if;

    number_value:=public.next_transaction_number(type_key,sid);
    memo_value:='Reclasificación anual de '||candidate.source_reference
      ||' a períodos anteriores';
    insert into public."transaction"(
      tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
      exchange_rate,fiscal_period_id,total_amount,status_id
    )values(
      number_value,p_reclassification_date,type_key,sid,candidate.currency_id,
      candidate.historical_exchange_rate,period_key,
      round(candidate.balance_foreign*2,6),status_key
    )returning transaction_id into transaction_key;
    insert into public.journal(
      journal_number,journal_date,transaction_id,subsidiary_id,currency_id,
      fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,
      status,created_by
    )values(
      number_value,p_reclassification_date,transaction_key,sid,candidate.currency_id,
      period_key,candidate.historical_exchange_rate,memo_value,
      'Reclasificación Anual de Pendientes de Facturar',
      round(candidate.balance_foreign*2,6),round(candidate.balance_foreign*2,6),
      'CONTABILIZADO',uid
    )returning journal_id into journal_key;

    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,
      department_id,class_id,location_id,cost_center_id,
      financial_creditor_id,related_company_id,service_month,service_country_id,
      note,entity_type,customer_id,historical_exchange_rate,original_currency_id
    )values
    (journal_key,bridge_account,candidate.balance_foreign,0,candidate.balance_foreign,0,
      counterpart_line.department_id,counterpart_line.class_id,counterpart_line.location_id,
      counterpart_line.cost_center_id,counterpart_line.financial_creditor_id,
      counterpart_line.related_company_id,coalesce(counterpart_line.service_month,candidate.service_month),
      coalesce(counterpart_line.service_country_id,candidate.service_country_id),memo_value,'Cliente',
      candidate.customer_id,candidate.historical_exchange_rate,candidate.currency_id),
    (journal_key,current_control,0,candidate.balance_foreign,0,candidate.balance_foreign,
      control_line.department_id,control_line.class_id,control_line.location_id,
      control_line.cost_center_id,control_line.financial_creditor_id,
      control_line.related_company_id,coalesce(control_line.service_month,candidate.service_month),
      coalesce(control_line.service_country_id,candidate.service_country_id),memo_value,'Cliente',
      candidate.customer_id,candidate.historical_exchange_rate,candidate.currency_id),
    (journal_key,prior_control,candidate.balance_foreign,0,candidate.balance_foreign,0,
      control_line.department_id,control_line.class_id,control_line.location_id,
      control_line.cost_center_id,control_line.financial_creditor_id,
      control_line.related_company_id,coalesce(control_line.service_month,candidate.service_month),
      coalesce(control_line.service_country_id,candidate.service_country_id),memo_value,'Cliente',
      candidate.customer_id,candidate.historical_exchange_rate,candidate.currency_id),
    (journal_key,bridge_account,0,candidate.balance_foreign,0,candidate.balance_foreign,
      counterpart_line.department_id,counterpart_line.class_id,counterpart_line.location_id,
      counterpart_line.cost_center_id,counterpart_line.financial_creditor_id,
      counterpart_line.related_company_id,coalesce(counterpart_line.service_month,candidate.service_month),
      coalesce(counterpart_line.service_country_id,candidate.service_country_id),memo_value,'Cliente',
      candidate.customer_id,candidate.historical_exchange_rate,candidate.currency_id);

    -- Replace trigger-generated values with the exact frozen local snapshot.
    delete from public.gl_impact where transaction_id=transaction_key;
    insert into public.gl_impact(
      transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,
      debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id
    )values
    (transaction_key,bridge_account,sid,period_key,book_key,candidate.balance_local,0,
      candidate.balance_foreign,0,p_reclassification_date,candidate.currency_id),
    (transaction_key,current_control,sid,period_key,book_key,0,candidate.balance_local,
      0,candidate.balance_foreign,p_reclassification_date,candidate.currency_id),
    (transaction_key,prior_control,sid,period_key,book_key,candidate.balance_local,0,
      candidate.balance_foreign,0,p_reclassification_date,candidate.currency_id),
    (transaction_key,bridge_account,sid,period_key,book_key,0,candidate.balance_local,
      0,candidate.balance_foreign,p_reclassification_date,candidate.currency_id);

    select sum(debit_amount),sum(credit_amount),
      sum(debit_amount)filter(where account_id=bridge_account),
      sum(credit_amount)filter(where account_id=bridge_account),
      sum(debit_fx),sum(credit_fx),
      sum(debit_fx)filter(where account_id=bridge_account),
      sum(credit_fx)filter(where account_id=bridge_account)
    into local_debits,local_credits,bridge_debits,bridge_credits,
      foreign_debits,foreign_credits,bridge_foreign_debits,bridge_foreign_credits
    from public.gl_impact where transaction_id=transaction_key
      and accounting_book_id=book_key;
    if abs(local_debits-local_credits)>.000001
      or abs(bridge_debits-bridge_credits)>.000001
      or abs(local_debits-candidate.balance_local*2)>.000001
      or abs(foreign_debits-foreign_credits)>.000001
      or abs(bridge_foreign_debits-bridge_foreign_credits)>.000001
      or abs(foreign_debits-candidate.balance_foreign*2)>.000001 then
      raise exception 'La reclasificación de % no quedó balanceada.',candidate.source_reference;
    end if;

    insert into public.pending_invoice_reclassification_items(
      run_id,subsidiary_id,source_type,source_journal_id,
      source_opening_pending_id,origin_journal_id,reclassification_journal_id,
      source_reference,origin_date,customer_id,currency_id,
      historical_exchange_rate,local_amount,foreign_amount,service_month,
      service_country_id
    )values(
      run_key,sid,candidate.source_type,
      case when candidate.source_type='JOURNAL'then candidate.source_id end,
      case when candidate.source_type='OPENING'then candidate.source_id end,
      candidate.origin_journal_id,journal_key,candidate.source_reference,
      candidate.origin_date,candidate.customer_id,candidate.currency_id,
      candidate.historical_exchange_rate,candidate.balance_local,
      candidate.balance_foreign,candidate.service_month,candidate.service_country_id
    );

    perform set_config('app.pending_reclassification_internal','1',true);
    if candidate.source_type='JOURNAL'then
      update public.journal
      set pending_period_type='ANTERIOR',
        pending_origin_journal_id=coalesce(pending_origin_journal_id,journal_id)
      where journal_id=candidate.source_id;
    else
      update public.opening_pending_invoice_items
      set period_type='ANTERIOR',
        origin_journal_id=coalesce(origin_journal_id,candidate.origin_journal_id),
        updated_at=now(),updated_by=uid
      where id=candidate.source_id;
    end if;
    perform set_config('app.pending_reclassification_internal','0',true);
    local_total:=local_total+candidate.balance_local;
  end loop;

  update public.pending_invoice_reclassification_runs
  set status='POSTED',item_count=candidate_count,journal_count=candidate_count,
    total_local=local_total,posted_at=now()
  where id=run_key;
  return public.pending_invoice_reclassification_execution_result(run_key)
    ||jsonb_build_object('alreadyExecuted',false);
end
$function$;

CREATE OR REPLACE FUNCTION sales_invoice_private.ensure_sales_invoice_number_sequence(p_subsidiary_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  transaction_type_key bigint;
  canonical_max bigint:=0;
begin
  if p_subsidiary_id is null
    or not exists(
      select 1
      from public.subsidiaries subsidiary
      where subsidiary.subsidiary_id=p_subsidiary_id
    ) then
    raise exception 'La subsidiaria indicada no existe.';
  end if;

  select transaction_type.transaction_type_id
    into transaction_type_key
  from public.transaction_types transaction_type
  where transaction_type.abbreviation='FAC_VEN'
  order by transaction_type.transaction_type_id
  limit 1;

  if transaction_type_key is null then
    raise exception 'No existe el tipo de transacción FAC_VEN.';
  end if;

  -- Use the same lock as next_transaction_number.  This makes discovery of
  -- the historical maximum and the subsequent increment one atomic sequence
  -- with respect to every normal invoice creation.
  perform pg_advisory_xact_lock(
    hashtextextended('transaction-number:'||transaction_type_key::text,0)
  );

  select coalesce(max(canonical.number_value),0)
    into canonical_max
  from (
    select substring(invoice.invoice_number from '^FAC-([0-9]+)$')::bigint
      as number_value
    from public.invoice invoice
    where invoice.subsidiary_id=p_subsidiary_id
      and invoice.invoice_number~'^FAC-[0-9]+$'

    union all

    select substring(transaction_row.tran_number from '^FAC-([0-9]+)$')::bigint
    from public."transaction" transaction_row
    where transaction_row.subsidiary_id=p_subsidiary_id
      and transaction_row.tran_number~'^FAC-[0-9]+$'

    union all

    select substring(journal.journal_number from '^FAC-([0-9]+)$')::bigint
    from public.journal journal
    where journal.subsidiary_id=p_subsidiary_id
      and journal.journal_number~'^FAC-[0-9]+$'
  )canonical;

  insert into public.number_sequences(
    scope_type,transaction_type_id,subsidiary_id,prefix,suffix,
    current_number,padding_length
  )values(
    'Transacción',transaction_type_key,p_subsidiary_id,'FAC-',null,
    canonical_max,8
  )
  on conflict(transaction_type_id,subsidiary_id)
    where scope_type='Transacción'
  do update set
    current_number=greatest(
      public.number_sequences.current_number,
      case
        -- Existing configured series are preserved.  Only a FAC- series is
        -- synchronized against the imported canonical FAC- history.
        when public.number_sequences.prefix='FAC-'
          and public.number_sequences.suffix is null
          then excluded.current_number
        else public.number_sequences.current_number
      end
    );
end
$function$;

CREATE OR REPLACE FUNCTION public.next_manual_journal_number(journal_kind text, sid bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare abbreviation_value text:=case journal_kind
 when 'Asientos Pendientes de Facturar' then 'ASI_PEN'
 when 'Asiento de Nóminas' then 'ASI_NOM'
 when 'Asiento de Liquidación' then 'ASI_LIQ'
 else 'ASI_DIA' end; tt bigint; result text; last_used bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('manual-journal-number:'||abbreviation_value,0));
 select transaction_type_id into tt from transaction_types where abbreviation=abbreviation_value;
 if tt is null then raise exception 'No existe el tipo de asiento %.',abbreviation_value; end if;
 select coalesce(max(substring(n from '[0-9]+$')::bigint),0) into last_used
 from (select journal_number n from journal union all select tran_number from "transaction") numbers
 where n ~ ('^'||abbreviation_value||'-[0-9]+$');
 insert into number_sequences(scope_type,transaction_type_id,subsidiary_id,prefix,current_number,padding_length)
 values('Transacción',tt,sid,abbreviation_value||'-',last_used,8)
 on conflict(transaction_type_id,subsidiary_id) where scope_type='Transacción' do nothing;
 loop
   result:=next_transaction_number(tt,sid);
   exit when not exists(select 1 from journal where journal_number=result)
     and not exists(select 1 from "transaction" where tran_number=result);
 end loop;
 return result;
end $function$;
