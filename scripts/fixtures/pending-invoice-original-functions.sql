CREATE OR REPLACE FUNCTION public.validate_pending_reversal_supports(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  kind text:=p_payload->>'type';
  supports jsonb:=coalesce(p_payload->'supports','[]'::jsonb);
  support jsonb;
  declared_size bigint;
  decoded_size bigint;
begin
  if jsonb_typeof(supports)<>'array' then
    raise exception 'Los archivos de respaldo no son válidos.';
  end if;

  if jsonb_array_length(supports)>0
    and kind is distinct from 'ERROR_CORRECCION' then
    raise exception 'Solo las reversiones por error / corrección permiten archivos de respaldo.';
  end if;

  for support in select value from jsonb_array_elements(supports) loop
    if support->>'support_type'='Enlace' then
      if nullif(btrim(support->>'display_name'),'') is null
        or coalesce(support->>'support_url','')
          !~* '^https?://[^[:space:]/?#]+[^[:space:]]*$' then
        raise exception 'Ingrese un enlace de respaldo válido que comience con http:// o https://';
      end if;
    elsif support->>'support_type'='Archivo' then
      begin
        declared_size:=nullif(support->>'file_size','')::bigint;
      exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'Archivo de respaldo inválido o superior a 5 MB.';
      end;

      if nullif(btrim(support->>'file_name'),'') is null
        or nullif(btrim(support->>'display_name'),'') is null
        or support->>'file_data' is null
        or coalesce(declared_size,-1) not between 0 and 5242880 then
        raise exception 'Archivo de respaldo inválido o superior a 5 MB.';
      end if;

      if length(support->>'file_data')>7100000
        or (support->>'file_data') !~ '^data:[^,]*;base64,' then
        raise exception 'El contenido del archivo de respaldo no es válido.';
      end if;

      begin
        decoded_size:=octet_length(
          decode(split_part(support->>'file_data',',',2),'base64')
        );
      exception when others then
        raise exception 'El contenido del archivo de respaldo no es Base64 válido.';
      end;
      if decoded_size<>declared_size then
        raise exception 'El tamaño del archivo de respaldo no coincide con su contenido.';
      end if;
    else
      raise exception 'Tipo de respaldo no válido.';
    end if;
  end loop;

  return supports;
end
$function$;

CREATE OR REPLACE FUNCTION public.reverse_opening_pending_invoice_before_support_integrity(p_item_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint;
  run_key bigint;
  source_fx record;
  result jsonb;
  reversal_key bigint;
  invoice_key bigint;
  requested_local numeric(24,6);
  requested_date date;
  billing_validated boolean:=false;
begin
  if not exists(
    select 1 from public.user_roles user_role
    join public.role_permissions role_permission using(role_id)
    join public.permissions permission using(permission_id)
    where user_role.user_id=public.app_user_id()
      and permission.code='accounting:journal:reverse'
  )then
    raise exception using errcode='42501',
      message='No tiene permiso para reversar asientos.';
  end if;
  select item.subsidiary_id,item.run_id into sid,run_key
  from public.opening_pending_invoice_items item
  join public.user_subsidiaries access
    on access.subsidiary_id=item.subsidiary_id
    and access.user_id=public.app_user_id()
  where item.id=p_item_id
    and item.subsidiary_id=public.active_subsidiary_id();
  if sid is null then
    raise exception using errcode='42501',
      message='El pendiente no pertenece a la subsidiaria activa o autorizada.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'pending-invoice-reclassification-subsidiary:'||sid,0));
  perform 1 from public.opening_balance_runs
  where id=run_key and subsidiary_id=sid for update;
  perform 1 from public.opening_pending_invoice_items
  where id=p_item_id and run_id=run_key and subsidiary_id=sid for update;
  select * into source_fx
  from public.pending_invoice_reversal_source_fx(null,p_item_id);

  if p_payload->>'type'='FACTURACION'then
    invoice_key:=nullif(p_payload->>'invoiceId','')::bigint;
    requested_local:=nullif(p_payload->>'amount','')::numeric;
    requested_date:=nullif(p_payload->>'reversalDate','')::date;
    perform public.pending_invoice_validate_billing_limit(
      null,p_item_id,invoice_key,requested_date,requested_local,null,null
    );
    perform set_config('app.pending_billing_limit_validated','1',true);
    billing_validated:=true;
  end if;

  begin
    result:=public.reverse_opening_pending_invoice_before_historical_fx_integrity(
      p_item_id,p_payload
    );
  exception when others then
    if billing_validated then
      perform set_config('app.pending_billing_limit_validated','0',true);
    end if;
    raise;
  end;
  if billing_validated then
    perform set_config('app.pending_billing_limit_validated','0',true);
  end if;
  reversal_key:=(result->>'journalId')::bigint;
  perform public.pending_invoice_normalize_reversal_fx(
    reversal_key,source_fx.source_historical_rate,
    source_fx.source_currency_id,source_fx.source_period_type
  );
  return result||jsonb_build_object(
    'historicalExchangeRate',source_fx.source_historical_rate,
    'originalCurrencyId',source_fx.source_currency_id
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.reverse_opening_pending_invoice(p_item_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  supports jsonb;
  result jsonb;
  reversal_key bigint;
begin
  if not exists(
    select 1
    from public.user_roles ur
    join public.role_permissions rp using(role_id)
    join public.permissions p using(permission_id)
    where ur.user_id=public.app_user_id()
      and p.code='accounting:journal:reverse'
  ) then
    raise exception using
      errcode='42501',
      message='No tiene permiso para reversar asientos.';
  end if;

  supports:=public.validate_pending_reversal_supports(p_payload);
  result:=public.reverse_opening_pending_invoice_before_support_integrity(
    p_item_id,p_payload-'supports'
  );
  reversal_key:=nullif(result->>'journalId','')::bigint;
  if reversal_key is null then
    raise exception 'La reversión no devolvió el asiento contable generado.';
  end if;

  perform public.save_pending_reversal_supports(reversal_key,supports);
  return result;
end
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_control_options_before_annual_reclassification()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$select jsonb_build_object('customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.customer_id,'name',c.company_name)order by c.company_name)from customers c where exists(select 1 from entity_subsidiaries e join user_subsidiaries u using(subsidiary_id)where e.customer_id=c.customer_id and u.user_id=app_user_id())),'[]'::jsonb))$function$;

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

CREATE OR REPLACE FUNCTION public.guard_pending_invoice_generic_reversal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
 if new.status='ANULADO'and old.status<>'ANULADO'
  and exists(select 1 from pending_invoice_reversal where reversal_journal_id=old.journal_id)then
  raise exception 'No se puede anular genéricamente una reversión controlada. Use el flujo de Pendientes de Facturar.';
 end if;
 if old.journal_number like'ASI_PEN-%'or old.journal_type='Asientos Pendientes de Facturar'then
  if new.status='ANULADO'and old.status<>'ANULADO'then
   if exists(select 1 from pending_invoice_reversal where source_journal_id=old.journal_id)then raise exception 'No se puede anular un ASI_PEN con reversiones aplicadas.';end if;
   if exists(select 1 from journal where reversed_from_journal_id=old.journal_id)then raise exception 'Use la acción Reversar Pendiente para los asientos ASI_PEN.';end if;
   new.reversal_status:='ANULADO';new.pending_balance_local:=0;new.pending_balance_foreign:=0;
  end if;
 end if;
 return new;
end$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reclassification_candidates(p_subsidiary_id bigint, p_reclassification_date date)
 RETURNS TABLE(source_type text, source_id bigint, source_reference text, origin_date date, origin_journal_id bigint, customer_id bigint, customer_name text, currency_id bigint, currency_code text, historical_exchange_rate numeric, balance_local numeric, balance_foreign numeric, service_month text, service_country_id bigint, service_country text, control_line_id bigint, counterpart_line_id bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with account_ids as(
  select
    max(account_id)filter(where account_number='113003')current_control,
    max(account_id)filter(where account_number='413001')current_counterpart
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account_number in('113003','413001')
    and assignment.subsidiary_id=p_subsidiary_id and assignment.is_active
),primary_book as(
  select book.accounting_book_id
  from public.accounting_books book
  where book.subsidiary_id=p_subsidiary_id
    and book.is_primary and book.is_active
  order by book.accounting_book_id limit 1
),ordinary_source as(
  select j.journal_id,j.journal_number,j.journal_date,j.transaction_id,
    coalesce(j.pending_origin_journal_id,j.journal_id)origin_journal_id,
    j.currency_id,j.exchange_rate,
    control.journal_line_id control_line_id,
    counterpart.journal_line_id counterpart_line_id,
    coalesce(control.customer_id,counterpart.customer_id)customer_id,
    coalesce(control.historical_exchange_rate,j.exchange_rate)historical_exchange_rate,
    control.service_month,control.service_country_id
  from public.journal j
  cross join account_ids account
  join lateral(
    select line.* from public.journal_line line
    where line.journal_id=j.journal_id and line.account_id=account.current_control
      and line.debit>0
    order by line.journal_line_id limit 1
  )control on true
  join lateral(
    select line.* from public.journal_line line
    where line.journal_id=j.journal_id and line.account_id=account.current_counterpart
      and line.credit>0
    order by line.journal_line_id limit 1
  )counterpart on true
  where j.subsidiary_id=p_subsidiary_id
    and(j.journal_number like'ASI_PEN-%'or j.journal_type='Asientos Pendientes de Facturar')
    and coalesce(j.pending_period_type,'ACTUAL')='ACTUAL'
    and j.journal_date<p_reclassification_date
    and j.status='CONTABILIZADO'
    and coalesce(j.reversal_status,'PENDIENTE')<>'ANULADO'
),ordinary_balance as(
  select source.journal_id,
    coalesce(sum(movement.local_net),0)::numeric(24,6)balance_local,
    coalesce(sum(movement.foreign_net),0)::numeric(24,6)balance_foreign
  from ordinary_source source
  cross join primary_book book
  cross join account_ids account
  cross join lateral(
    select coalesce(sum(impact.debit_amount-impact.credit_amount),0)local_net,
      coalesce(sum(impact.debit_fx-impact.credit_fx),0)foreign_net
    from public.gl_impact impact
    where impact.transaction_id=source.transaction_id
      and impact.account_id=account.current_control
      and impact.accounting_book_id=book.accounting_book_id
    union all
    select coalesce(sum(impact.debit_amount-impact.credit_amount),0)local_net,
      coalesce(sum(impact.debit_fx-impact.credit_fx),0)foreign_net
    from public.pending_invoice_reversal reversal
    join public.journal reversal_journal
      on reversal_journal.journal_id=reversal.reversal_journal_id
    join public.gl_impact impact
      on impact.transaction_id=reversal_journal.transaction_id
    where reversal.source_journal_id=source.journal_id
      and reversal.reversal_date<p_reclassification_date
      and impact.account_id=account.current_control
      and impact.accounting_book_id=book.accounting_book_id
  )movement
  group by source.journal_id
),ordinary as(
  select 'JOURNAL'::text source_type,source.journal_id source_id,
    source.journal_number source_reference,source.journal_date origin_date,
    source.origin_journal_id,source.customer_id,customer.company_name customer_name,
    source.currency_id,currency.currency_code,
    source.historical_exchange_rate,balance.balance_local,balance.balance_foreign,
    source.service_month,source.service_country_id,country.name service_country,
    source.control_line_id,source.counterpart_line_id
  from ordinary_source source
  join ordinary_balance balance using(journal_id)
  join public.currencies currency on currency.currency_id=source.currency_id
  left join public.customers customer on customer.customer_id=source.customer_id
  left join public.countries country on country.country_id=source.service_country_id
),opening as(
  select 'OPENING'::text source_type,item.id source_id,item.reference source_reference,
    item.origin_date,coalesce(item.origin_journal_id,run.journal_id)origin_journal_id,
    item.customer_id,customer.company_name customer_name,item.currency_id,
    currency.currency_code,item.historical_exchange_rate,
    (item.initial_local-coalesce(reversed.local_amount,0))::numeric(24,6)balance_local,
    (item.initial_foreign-coalesce(reversed.foreign_amount,0))::numeric(24,6)balance_foreign,
    item.service_month,item.service_country_id,country.name service_country,
    control.id control_line_id,counterpart.id counterpart_line_id
  from public.opening_pending_invoice_items item
  join public.opening_balance_runs run on run.id=item.run_id
  join public.opening_pending_invoice_lines control
    on control.item_id=item.id and control.line_role='CONTROL'
  join public.opening_pending_invoice_lines counterpart
    on counterpart.item_id=item.id and counterpart.line_role='COUNTERPART'
  join public.customers customer on customer.customer_id=item.customer_id
  join public.currencies currency on currency.currency_id=item.currency_id
  join public.countries country on country.country_id=item.service_country_id
  left join lateral(
    select coalesce(sum(reversal.reversed_local),0)local_amount,
      coalesce(sum(reversal.reversed_foreign),0)foreign_amount
    from public.pending_invoice_reversal reversal
    where reversal.source_opening_pending_id=item.id
      and reversal.reversal_date<p_reclassification_date
  )reversed on true
  where item.subsidiary_id=p_subsidiary_id and item.period_type='ACTUAL'
    and item.is_active and item.opening_reversed_at is null
    and coalesce(item.reversal_status,'PENDIENTE')<>'ANULADO'
    and run.status='POSTED'and run.opening_date<p_reclassification_date
)
select * from ordinary
where abs(balance_local)>.000001 or abs(balance_foreign)>.000001
union all
select * from opening
where abs(balance_local)>.000001 or abs(balance_foreign)>.000001
order by origin_date,source_type,source_id
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reclassification_reconciliation(p_subsidiary_id bigint, p_reclassification_date date)
 RETURNS TABLE(currency_id bigint, currency_code text, ledger_local numeric, auxiliary_local numeric, local_difference numeric, ledger_foreign numeric, auxiliary_foreign numeric, foreign_difference numeric, balanced boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with control as(
  select max(account.account_id)account_id
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number='113003'
    and assignment.subsidiary_id=p_subsidiary_id and assignment.is_active
),primary_book as(
  select book.accounting_book_id
  from public.accounting_books book
  where book.subsidiary_id=p_subsidiary_id
    and book.is_primary and book.is_active
  order by book.accounting_book_id limit 1
),ledger as(
  select coalesce(impact.original_currency_id,transaction_row.currency_id)currency_id,
    sum(impact.debit_amount-impact.credit_amount)::numeric(24,6)local_amount,
    sum(impact.debit_fx-impact.credit_fx)::numeric(24,6)foreign_amount
  from public.gl_impact impact
  join public."transaction" transaction_row using(transaction_id)
  cross join control
  cross join primary_book book
  where impact.subsidiary_id=p_subsidiary_id
    and impact.account_id=control.account_id
    and impact.accounting_book_id=book.accounting_book_id
    and impact.posting_date<p_reclassification_date
  group by coalesce(impact.original_currency_id,transaction_row.currency_id)
),auxiliary as(
  select candidate.currency_id,
    sum(candidate.balance_local)::numeric(24,6)local_amount,
    sum(candidate.balance_foreign)::numeric(24,6)foreign_amount
  from public.pending_invoice_reclassification_candidates(
    p_subsidiary_id,p_reclassification_date
  )candidate
  group by candidate.currency_id
),values_by_source as(
  select 'LEDGER'::text source,currency_id,local_amount,foreign_amount from ledger
  union all
  select 'AUXILIARY',currency_id,local_amount,foreign_amount from auxiliary
),summary as(
  select value.currency_id,
    coalesce(sum(value.local_amount)filter(where value.source='LEDGER'),0)::numeric(24,6)ledger_local,
    coalesce(sum(value.local_amount)filter(where value.source='AUXILIARY'),0)::numeric(24,6)auxiliary_local,
    coalesce(sum(value.foreign_amount)filter(where value.source='LEDGER'),0)::numeric(24,6)ledger_foreign,
    coalesce(sum(value.foreign_amount)filter(where value.source='AUXILIARY'),0)::numeric(24,6)auxiliary_foreign
  from values_by_source value group by value.currency_id
)
select summary.currency_id,coalesce(currency.currency_code,'Sin moneda')currency_code,
  summary.ledger_local,summary.auxiliary_local,
  (summary.ledger_local-summary.auxiliary_local)::numeric(24,6)local_difference,
  summary.ledger_foreign,summary.auxiliary_foreign,
  (summary.ledger_foreign-summary.auxiliary_foreign)::numeric(24,6)foreign_difference,
  abs(summary.ledger_local-summary.auxiliary_local)<=.005
    and abs(summary.ledger_foreign-summary.auxiliary_foreign)<=.005 balanced
from summary
left join public.currencies currency using(currency_id)
order by coalesce(currency.currency_code,'')
$function$;

CREATE OR REPLACE FUNCTION public.guard_pending_invoice_reversal_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if tg_op='INSERT'and current_user='postgres'
    and coalesce(current_setting('app.pending_reversal_insert',true),'')='1'then
    return new;
  end if;
  if current_user='postgres'
    and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1'then
    return case when tg_op='DELETE'then old else new end;
  end if;
  raise exception 'La trazabilidad de una reversión de pendiente es inmutable.';
end
$function$;

CREATE OR REPLACE FUNCTION public.protect_pending_reversal_metadata()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if old.pending_initial_local is distinct from new.pending_initial_local
    or old.pending_initial_foreign is distinct from new.pending_initial_foreign
    or old.pending_reversed_local is distinct from new.pending_reversed_local
    or old.pending_reversed_foreign is distinct from new.pending_reversed_foreign
    or old.pending_balance_local is distinct from new.pending_balance_local
    or old.pending_balance_foreign is distinct from new.pending_balance_foreign
    or old.reversal_status is distinct from new.reversal_status then
    if current_user<>'postgres'
      or coalesce(current_setting('app.pending_reversal_write',true),'')<>'1'
      or(to_jsonb(new)-array[
        'pending_initial_local','pending_initial_foreign',
        'pending_reversed_local','pending_reversed_foreign',
        'pending_balance_local','pending_balance_foreign','reversal_status'
      ])<>(to_jsonb(old)-array[
        'pending_initial_local','pending_initial_foreign',
        'pending_reversed_local','pending_reversed_foreign',
        'pending_balance_local','pending_balance_foreign','reversal_status'
      ]) then
      raise exception 'El saldo operativo del pendiente solo puede cambiar mediante el flujo de reversión autorizado.';
    end if;
  end if;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reversal_options_before_opening_pending(p_journal_id bigint, p_reversal_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare j journal%rowtype;customer_key bigint;reversal_month date;
begin
 select*into j from journal where journal_id=p_journal_id and subsidiary_id in(select subsidiary_id from user_subsidiaries where user_id=app_user_id());
 if j.journal_id is null or not(j.journal_number like'ASI_PEN-%'or j.journal_type='Asientos Pendientes de Facturar')then raise exception'El asiento seleccionado no es un pendiente de facturar.';end if;
 if p_reversal_date is null then raise exception'Indique la fecha de reversión para consultar las facturas.';end if;
 select customer_id into customer_key from journal_line where journal_id=j.journal_id and customer_id is not null order by journal_line_id limit 1;
 reversal_month:=date_trunc('month',p_reversal_date)::date;
 return jsonb_build_object('journal',jsonb_build_object('id',j.journal_id,'number',j.journal_number,'date',j.journal_date,'initialLocal',j.pending_initial_local,'initialForeign',j.pending_initial_foreign,'reversedLocal',j.pending_reversed_local,'reversedForeign',j.pending_reversed_foreign,'balanceLocal',j.pending_balance_local,'balanceForeign',j.pending_balance_foreign,'status',j.reversal_status,'currencyId',j.currency_id,'customerId',customer_key),
  'invoices',coalesce((select jsonb_agg(jsonb_build_object('id',i.invoice_id,'number',i.invoice_number,'date',i.invoice_date,'customerId',i.customer_id,'customer',c.company_name,'total',i.total_amount)order by i.invoice_date desc,i.invoice_id desc)from invoice i join customers c using(customer_id)where customer_key is not null and i.subsidiary_id=j.subsidiary_id and i.customer_id=customer_key and i.invoice_date>=reversal_month and i.invoice_date<reversal_month+interval'1 month'),'[]'::jsonb),
  'reversals',coalesce((select jsonb_agg(jsonb_build_object('id',r.reversal_id,'journalId',r.reversal_journal_id,'number',rev.journal_number,'date',r.reversal_date,'amount',r.reversed_local,'type',r.reversal_type,'invoice',i.invoice_number,'reason',r.error_description,'user',coalesce(u.first_name||' '||u.last_name,u.email))order by r.reversal_date,r.reversal_id)from pending_invoice_reversal r join journal rev on rev.journal_id=r.reversal_journal_id left join invoice i on i.invoice_id=r.sales_invoice_id left join users u on u.user_id=r.created_by where r.source_journal_id=j.journal_id),'[]'::jsonb));
end$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reclassification_preview(p_reclassification_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint:=public.active_subsidiary_id();
  uid bigint:=public.app_user_id();
  fiscal_year_value integer;
  run_row public.pending_invoice_reclassification_runs%rowtype;
  rows_value jsonb:='[]'::jsonb;
  by_currency jsonb:='[]'::jsonb;
  accounts_value jsonb;
  issues jsonb:='[]'::jsonb;
  item_count integer:=0;
  total_local numeric(24,6):=0;
  total_foreign numeric(24,6):=0;
  invalid_fx integer:=0;
  malformed_sources integer:=0;
  post_cutoff_reversals integer:=0;
  reconciliation_value jsonb:='[]'::jsonb;
  reconciliation_balanced boolean:=true;
  can_create boolean:=false;
  period_open boolean:=false;
  book_exists boolean:=false;
  book_count integer:=0;
  configured_accounts integer:=0;
  company_name text;
begin
  perform public.security_assert_role_access(
    'accounting:pending-invoice-reclassification','view'
  );
  if uid is null or sid is null or not exists(
    select 1 from public.user_subsidiaries access
    where access.user_id=uid and access.subsidiary_id=sid
  )then
    raise exception using errcode='42501',
      message='Seleccione una subsidiaria autorizada para consultar la reclasificación.';
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
  select subsidiary.name into company_name
  from public.subsidiaries subsidiary where subsidiary.subsidiary_id=sid;

  can_create:=public.app_is_admin()or exists(
    select 1 from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and(access.resource_key='legacy:all'
        or(access.resource_key='accounting:pending-invoice-reclassification'
          and access.can_create))
  );
  select exists(
    select 1 from public.fiscal_periods period
    where period.subsidiary_id=sid
      and p_reclassification_date between period.start_date and period.end_date
      and not period.is_closed and not coalesce(period.gl_closed,false)
      and not coalesce(period.is_inactive,false)
  )into period_open;
  select count(*)::integer into book_count
  from public.accounting_books book
  where book.subsidiary_id=sid and book.is_primary and book.is_active;
  book_exists:=book_count=1;

  with configured as(
    select account.account_number,
      jsonb_build_object('id',account.account_id,'number',account.account_number,
        'name',account.account_name)account_object
    from public.chart_accounts account
    join public.account_subsidiaries assignment using(account_id)
    where account.account_number in('113003','113004','413001','413002')
      and assignment.subsidiary_id=sid and assignment.is_active
      and account.accepts_entries and not account.is_inactive
  )
  select(select count(*)from configured),jsonb_build_object(
    'currentControl',(select account_object from configured where account_number='113003'),
    'priorControl',(select account_object from configured where account_number='113004'),
    'currentCounterpart',(select account_object from configured where account_number='413001'),
    'bridge',(select account_object from configured where account_number='413002')
  )into configured_accounts,accounts_value;

  select * into run_row
  from public.pending_invoice_reclassification_runs run
  where run.subsidiary_id=sid and run.fiscal_year=fiscal_year_value;

  if run_row.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'sourceType',item.source_type,'sourceId',coalesce(item.source_journal_id,item.source_opening_pending_id),
      'reference',item.source_reference,'originDate',item.origin_date,
      'originJournalId',item.origin_journal_id,'customerId',item.customer_id,
      'customer',customer.company_name,'currencyId',item.currency_id,
      'currency',currency.currency_code,'historicalExchangeRate',item.historical_exchange_rate,
      'balanceLocal',item.local_amount,'balanceForeign',item.foreign_amount,
      'serviceMonth',item.service_month,'serviceCountryId',item.service_country_id,
      'serviceCountry',country.name,'journalId',item.reclassification_journal_id
    )order by item.origin_date,item.source_type,item.id),'[]'::jsonb),
      count(*)::integer,coalesce(sum(item.local_amount),0),coalesce(sum(item.foreign_amount),0),
      count(*)filter(where abs(item.local_amount-round(item.foreign_amount*item.historical_exchange_rate,6))>.005)::integer
    into rows_value,item_count,total_local,total_foreign,invalid_fx
    from public.pending_invoice_reclassification_items item
    left join public.customers customer on customer.customer_id=item.customer_id
    join public.currencies currency on currency.currency_id=item.currency_id
    left join public.countries country on country.country_id=item.service_country_id
    where item.run_id=run_row.id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'currencyId',summary.currency_id,'currency',summary.currency_code,
      'count',summary.item_count,'local',summary.local_amount,
      'foreign',summary.foreign_amount
    )order by summary.currency_code),'[]'::jsonb)into by_currency
    from(
      select item.currency_id,currency.currency_code,count(*)::integer item_count,
        sum(item.local_amount)local_amount,sum(item.foreign_amount)foreign_amount
      from public.pending_invoice_reclassification_items item
      join public.currencies currency on currency.currency_id=item.currency_id
      where item.run_id=run_row.id
      group by item.currency_id,currency.currency_code
    )summary;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'sourceType',candidate.source_type,'sourceId',candidate.source_id,
      'reference',candidate.source_reference,'originDate',candidate.origin_date,
      'originJournalId',candidate.origin_journal_id,'customerId',candidate.customer_id,
      'customer',coalesce(candidate.customer_name,'Sin cliente'),
      'currencyId',candidate.currency_id,'currency',candidate.currency_code,
      'historicalExchangeRate',candidate.historical_exchange_rate,
      'balanceLocal',candidate.balance_local,'balanceForeign',candidate.balance_foreign,
      'serviceMonth',candidate.service_month,'serviceCountryId',candidate.service_country_id,
      'serviceCountry',candidate.service_country
    )order by candidate.origin_date,candidate.source_type,candidate.source_id),'[]'::jsonb),
      count(*)::integer,coalesce(sum(candidate.balance_local),0),
      coalesce(sum(candidate.balance_foreign),0),
      count(*)filter(where candidate.origin_journal_id is null
        or candidate.historical_exchange_rate is null
        or candidate.historical_exchange_rate<=0
        or candidate.balance_local<=.000001
        or candidate.balance_foreign<=.000001
        or abs(candidate.balance_local-round(candidate.balance_foreign*candidate.historical_exchange_rate,6))>.005)::integer
    into rows_value,item_count,total_local,total_foreign,invalid_fx
    from public.pending_invoice_reclassification_candidates(sid,p_reclassification_date)candidate;

    select count(*)::integer into malformed_sources
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
          join public.chart_accounts account using(account_id)
          where line.journal_id=source.journal_id
            and account.account_number='113003'and line.debit>0)<>1
        or(select count(*)from public.journal_line line
          join public.chart_accounts account using(account_id)
          where line.journal_id=source.journal_id
            and account.account_number='413001'and line.credit>0)<>1
        or(select count(*)from public.journal_line line
          where line.journal_id=source.journal_id)<>2
        or exists(select 1 from public.journal_line line
          where line.journal_id=source.journal_id
            and(line.tax_code_id is not null or coalesce(line.tax_rate,0)<>0))
        or(select count(distinct line.customer_id)from public.journal_line line
          where line.journal_id=source.journal_id and line.customer_id is not null)>1
        or source.transaction_id is null
        or(select count(*)from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=source.transaction_id
            and book.subsidiary_id=sid and book.is_primary and book.is_active)<>2
        or(select count(*)from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          join public.chart_accounts account using(account_id)
          where impact.transaction_id=source.transaction_id
            and book.subsidiary_id=sid and book.is_primary and book.is_active
            and account.account_number='113003'
            and impact.debit_amount>0 and impact.credit_amount=0)<>1
        or(select count(*)from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          join public.chart_accounts account using(account_id)
          where impact.transaction_id=source.transaction_id
            and book.subsidiary_id=sid and book.is_primary and book.is_active
            and account.account_number='413001'
            and impact.credit_amount>0 and impact.debit_amount=0)<>1
        or exists(
          select 1
          from(
            select
              coalesce(sum(line.debit)filter(where account.account_number='113003'),0)control_debit,
              coalesce(sum(line.credit)filter(where account.account_number='413001'),0)counterpart_credit,
              coalesce(sum(line.debit_fx)filter(where account.account_number='113003'),0)control_debit_fx,
              coalesce(sum(line.credit_fx)filter(where account.account_number='413001'),0)counterpart_credit_fx
            from public.journal_line line
            join public.chart_accounts account using(account_id)
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
              coalesce(sum(impact.debit_amount)filter(where account.account_number='113003'),0)control_debit,
              coalesce(sum(impact.credit_amount)filter(where account.account_number='413001'),0)counterpart_credit,
              coalesce(sum(impact.debit_fx)filter(where account.account_number='113003'),0)control_debit_fx,
              coalesce(sum(impact.credit_fx)filter(where account.account_number='413001'),0)counterpart_credit_fx,
              coalesce((
                select sum(source_line.debit)
                from public.journal_line source_line
                join public.chart_accounts source_account using(account_id)
                where source_line.journal_id=source.journal_id
                  and source_account.account_number='113003'
              ),0)line_control_debit,
              coalesce((
                select sum(source_line.credit)
                from public.journal_line source_line
                join public.chart_accounts source_account using(account_id)
                where source_line.journal_id=source.journal_id
                  and source_account.account_number='413001'
              ),0)line_counterpart_credit,
              coalesce(bool_or(
                coalesce(impact.original_currency_id,transaction_row.currency_id)
                  is distinct from source.currency_id
              ),false)wrong_currency
            from public.gl_impact impact
            join public.accounting_books book using(accounting_book_id)
            join public.chart_accounts account using(account_id)
            join public."transaction" transaction_row using(transaction_id)
            where impact.transaction_id=source.transaction_id
              and book.subsidiary_id=sid and book.is_primary and book.is_active
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
      );

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

    select coalesce(jsonb_agg(jsonb_build_object(
      'currencyId',row.currency_id,'currency',row.currency_code,
      'ledgerLocal',row.ledger_local,'auxiliaryLocal',row.auxiliary_local,
      'localDifference',row.local_difference,
      'ledgerForeign',row.ledger_foreign,'auxiliaryForeign',row.auxiliary_foreign,
      'foreignDifference',row.foreign_difference,'balanced',row.balanced
    )order by row.currency_code),'[]'::jsonb),coalesce(bool_and(row.balanced),true)
    into reconciliation_value,reconciliation_balanced
    from public.pending_invoice_reclassification_reconciliation(
      sid,p_reclassification_date
    )row;

    select coalesce(jsonb_agg(jsonb_build_object(
      'currencyId',summary.currency_id,'currency',summary.currency_code,
      'count',summary.item_count,'local',summary.local_amount,
      'foreign',summary.foreign_amount
    )order by summary.currency_code),'[]'::jsonb)into by_currency
    from(
      select candidate.currency_id,candidate.currency_code,count(*)::integer item_count,
        sum(candidate.balance_local)local_amount,sum(candidate.balance_foreign)foreign_amount
      from public.pending_invoice_reclassification_candidates(sid,p_reclassification_date)candidate
      group by candidate.currency_id,candidate.currency_code
    )summary;
  end if;

  if configured_accounts<>4 then issues:=issues||jsonb_build_array('Las cuentas 113003, 113004, 413001 y 413002 deben estar activas y asignadas a la subsidiaria.');end if;
  if not book_exists then issues:=issues||jsonb_build_array('Debe existir exactamente un libro contable principal activo para la subsidiaria.');end if;
  if not period_open then issues:=issues||jsonb_build_array('El período contable del 01 de enero debe estar abierto para Libro Mayor.');end if;
  if invalid_fx>0 then issues:=issues||jsonb_build_array('Hay pendientes cuya tasa histórica no reproduce el saldo local.');end if;
  if malformed_sources>0 then issues:=issues||jsonb_build_array('Hay pendientes que no conservan exactamente las líneas 113003 al debe y 413001 al haber.');end if;
  if post_cutoff_reversals>0 then issues:=issues||jsonb_build_array('Existen reversiones fechadas desde el 01 de enero sobre saldos a reclasificar. Deben corregirse antes de ejecutar una reclasificación retroactiva.');end if;
  if not reconciliation_balanced then issues:=issues||jsonb_build_array('El saldo del Mayor en 113003 no coincide con el auxiliar de pendientes al 01 de enero. Revise el detalle de conciliación.');end if;
  if item_count=0 and run_row.id is null then issues:=issues||jsonb_build_array('No hay pendientes del período anterior con saldo vivo para reclasificar.');end if;
  if not can_create then issues:=issues||jsonb_build_array('El rol activo puede consultar, pero no ejecutar la reclasificación.');end if;

  return jsonb_build_object(
    'subsidiary',jsonb_build_object('id',sid,'name',company_name),
    'reclassificationDate',p_reclassification_date,
    'fiscalYear',fiscal_year_value,
    'alreadyExecuted',run_row.id is not null and run_row.status='POSTED',
    'runId',run_row.id,'status',run_row.status,
    'canExecute',run_row.id is null and can_create and configured_accounts=4
      and book_exists and period_open and invalid_fx=0 and malformed_sources=0
      and post_cutoff_reversals=0 and reconciliation_balanced and item_count>0,
    'issues',issues,'accounts',accounts_value,'rows',rows_value,
    'reconciliation',reconciliation_value,
    'totals',jsonb_build_object('count',item_count,'local',total_local,
      'foreign',total_foreign,'bridgeDebit',total_local,'bridgeCredit',total_local,
      'difference',0,'byCurrency',by_currency)
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reclassification_execution_result(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
select jsonb_build_object(
  'runId',run.id,'status',run.status,
  'reclassificationDate',run.reclassification_date,'fiscalYear',run.fiscal_year,
  'itemCount',run.item_count,'journalCount',run.journal_count,
  'totalLocal',run.total_local,
  'journals',coalesce((
    select jsonb_agg(jsonb_build_object(
      'journalId',item.reclassification_journal_id,
      'number',journal.journal_number,
      'sourceType',item.source_type,
      'sourceId',coalesce(item.source_journal_id,item.source_opening_pending_id),
      'reference',item.source_reference,
      'localAmount',item.local_amount,
      'foreignAmount',item.foreign_amount,
      'rate',item.historical_exchange_rate
    )order by item.origin_date,item.source_type,item.id)
    from public.pending_invoice_reclassification_items item
    join public.journal journal
      on journal.journal_id=item.reclassification_journal_id
    where item.run_id=run.id
  ),'[]'::jsonb)
)
from public.pending_invoice_reclassification_runs run
where run.id=p_run_id
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reclassification_execute(p_reclassification_date date)
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

CREATE OR REPLACE FUNCTION public.opening_balance_reverse_before_pending_reclassification(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare run_row public.opening_balance_runs%rowtype;result jsonb;reversed_count integer:=0;
begin
 perform public.opening_balance_assert_access('delete');
 select *into run_row from public.opening_balance_runs where id=p_run_id and subsidiary_id=public.active_subsidiary_id()for update;
 if run_row.id is null or run_row.status<>'POSTED'then raise exception 'Apertura contabilizada no encontrada.';end if;
 if exists(select 1 from public.opening_bank_accounts account join public.bank_reconciliation reconciliation using(bank_account_id)
  where account.run_id=p_run_id and reconciliation.status='CERRADA'and reconciliation.reconciliation_date>=run_row.opening_date)then
  raise exception 'No se puede reversar la apertura: existe una conciliación bancaria cerrada posterior o igual a la fecha de apertura.';
 end if;
 if exists(select 1 from public.opening_bank_accounts account join public.quadratic_bank_reconciliations reconciliation using(bank_account_id)
  where account.run_id=p_run_id and reconciliation.status in('approved','closed')
   and(make_date(reconciliation.period_year,reconciliation.period_month,1)+interval'1 month'-interval'1 day')::date>=run_row.opening_date)then
  raise exception 'No se puede reversar la apertura: existe una prueba de efectivo aprobada o cerrada posterior.';
 end if;
 if exists(select 1 from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  join public.bank_reconciliation_match m on m.bank_tran_id=item.created_bank_tran_id where account.run_id=p_run_id)
  or exists(select 1 from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  join public.quadratic_reconciliation_matches m on m.bank_tran_id=item.created_bank_tran_id where account.run_id=p_run_id)then
  raise exception 'No se puede reversar la apertura: existen partidas iniciales ya conciliadas con un extracto.';
 end if;
 if exists(select 1 from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  join public.quadratic_reconciliation_items adjustment on adjustment.bank_tran_id=item.created_bank_tran_id where account.run_id=p_run_id)then
  raise exception 'No se puede reversar la apertura: existen partidas iniciales utilizadas en una prueba de efectivo.';
 end if;
 if exists(select 1 from public.opening_bank_accounts account join public.bank_transaction movement using(bank_account_id)
  where account.run_id=p_run_id and movement.tran_date>=run_row.opening_date
   and not exists(select 1 from public.opening_bank_items item join public.opening_bank_accounts source on source.id=item.opening_bank_account_id
    where item.id=movement.opening_bank_item_id and source.run_id=p_run_id))then
  raise exception 'No se puede reversar la apertura: existen movimientos bancarios posteriores.';
 end if;
 result:=public.opening_balance_reverse_before_opening_bank(p_run_id);
 select count(*)into reversed_count from public.opening_bank_items item join public.opening_bank_accounts account on account.id=item.opening_bank_account_id
  where account.run_id=p_run_id and item.created_bank_tran_id is not null;
 perform 1 from public.bank_account account where account.bank_account_id in(select bank_account_id from public.opening_bank_accounts where run_id=p_run_id)
  order by account.bank_account_id for update;
 perform set_config('app.opening_bank_internal','1',true);
 delete from public.bank_transaction movement using public.opening_bank_items item,public.opening_bank_accounts account
  where movement.opening_bank_item_id=item.id and item.opening_bank_account_id=account.id and account.run_id=p_run_id;
 update public.opening_bank_accounts set is_active=false,opening_reversed_at=now(),updated_at=now(),updated_by=public.app_user_id()where run_id=p_run_id;
 update public.bank_account account set balance=coalesce((select sum(movement.amount)from public.bank_transaction movement where movement.bank_account_id=account.bank_account_id),0)
  where account.bank_account_id in(select bank_account_id from public.opening_bank_accounts where run_id=p_run_id);
 perform set_config('app.opening_bank_internal','',true);
 return result||jsonb_build_object('bankItemsReversed',reversed_count);
end$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reversal_options_before_invoice_subtotal_limit(p_journal_id bigint, p_reversal_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
 if p_journal_id<0 then return opening_pending_invoice_reversal_options(-p_journal_id,p_reversal_date);end if;
 return pending_invoice_reversal_options_before_opening_pending(p_journal_id,p_reversal_date);
end$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reversal_options_before_period_type(p_journal_id bigint, p_reversal_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  enriched_invoices jsonb;
begin
  result:=public.pending_invoice_reversal_options_before_invoice_subtotal_limit(
    p_journal_id,p_reversal_date
  );

  select coalesce(jsonb_agg(
    candidate.item||jsonb_build_object(
      'subtotal',candidate.subtotal,
      'applied',candidate.applied,
      'available',greatest(candidate.subtotal-candidate.applied,0)
    ) order by candidate.ordinality
  ),'[]'::jsonb)
  into enriched_invoices
  from(
    select source.item,source.ordinality,
      round(coalesce(
        (select sum(line.amount) from public.sales_invoice_line line where line.invoice_id=invoice.invoice_id),
        greatest(invoice.total_amount-coalesce(
          (select sum(line.tax_amount) from public.sales_invoice_line line where line.invoice_id=invoice.invoice_id),0
        ),0)
      ),6) subtotal,
      round(coalesce((
        select sum(reversal.reversed_local)
        from public.pending_invoice_reversal reversal
        where reversal.sales_invoice_id=invoice.invoice_id
          and reversal.reversal_type='FACTURACION'
      ),0),6) applied
    from jsonb_array_elements(coalesce(result->'invoices','[]'::jsonb))
      with ordinality source(item,ordinality)
    join public.invoice invoice
      on invoice.invoice_id=(source.item->>'id')::bigint
  ) candidate;

  return jsonb_set(result,'{invoices}',coalesce(enriched_invoices,'[]'::jsonb),true);
end
$function$;

CREATE OR REPLACE FUNCTION public.opening_pending_invoice_reversal_options(p_item_id bigint, p_reversal_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare item opening_pending_invoice_items%rowtype;reversal_month date;
begin
 select i.*into item from opening_pending_invoice_items i join user_subsidiaries u using(subsidiary_id)
  where i.id=p_item_id and u.user_id=app_user_id()and i.is_active;
 if item.id is null then raise exception 'El pendiente inicial no existe o no está activo.';end if;
 if p_reversal_date is null then raise exception 'Indique la fecha de reversión para consultar las facturas.';end if;
 reversal_month:=date_trunc('month',p_reversal_date)::date;
 return jsonb_build_object(
  'journal',jsonb_build_object('id',-item.id,'openingPendingId',item.id,'sourceType','OPENING','number',item.reference,'date',item.origin_date,
   'initialLocal',item.initial_local,'initialForeign',item.initial_foreign,'reversedLocal',item.reversed_local,'reversedForeign',item.reversed_foreign,
   'balanceLocal',item.balance_local,'balanceForeign',item.balance_foreign,'status',item.reversal_status,'currencyId',item.currency_id,'customerId',item.customer_id),
  'invoices',coalesce((select jsonb_agg(jsonb_build_object('id',i.invoice_id,'number',i.invoice_number,'date',i.invoice_date,'customerId',i.customer_id,'customer',c.company_name,'total',i.total_amount)order by i.invoice_date desc,i.invoice_id desc)
   from invoice i join customers c using(customer_id)where i.subsidiary_id=item.subsidiary_id and i.customer_id=item.customer_id
    and i.invoice_date>=reversal_month and i.invoice_date<reversal_month+interval'1 month'),'[]'::jsonb),
  'reversals',coalesce((select jsonb_agg(jsonb_build_object('id',r.reversal_id,'journalId',r.reversal_journal_id,'number',j.journal_number,'date',r.reversal_date,
   'amount',r.reversed_local,'type',r.reversal_type,'invoice',i.invoice_number,'reason',r.error_description,'user',coalesce(u.first_name||' '||u.last_name,u.email))order by r.reversal_date,r.reversal_id)
   from pending_invoice_reversal r join journal j on j.journal_id=r.reversal_journal_id left join invoice i on i.invoice_id=r.sales_invoice_id
   left join users u on u.user_id=r.created_by where r.source_opening_pending_id=item.id),'[]'::jsonb)
 );
end$function$;

CREATE OR REPLACE FUNCTION public.reverse_pending_invoice_journal_before_invoice_subtotal_limit(p_journal_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
 if p_journal_id<0 then return reverse_opening_pending_invoice(-p_journal_id,p_payload);end if;
 return reverse_pending_invoice_journal_before_opening_pending(p_journal_id,p_payload);
end$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_control_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base jsonb;can_reclassify boolean;can_view_reclassification boolean;
begin
  base:=public.pending_invoice_control_options_before_annual_reclassification();
  can_reclassify:=public.app_is_admin()or exists(
    select 1 from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and(access.resource_key='legacy:all'
        or(access.resource_key='accounting:pending-invoice-reclassification'
          and access.can_create))
  );
  can_view_reclassification:=public.app_is_admin()or exists(
    select 1 from public.role_access_matrix access
    where access.role_id=public.app_active_role_id()
      and(access.resource_key='legacy:all'
        or(access.resource_key='accounting:pending-invoice-reclassification'
          and access.can_view))
  );
  return base||jsonb_build_object(
    'canReclassify',can_reclassify,
    'canViewReclassification',can_view_reclassification,
    'periodTypes',jsonb_build_array(
      jsonb_build_object('id','ACTUAL','name','Período actual'),
      jsonb_build_object('id','ANTERIOR','name','Períodos anteriores')
    )
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.run_pending_invoice_control_report_before_period_summary(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare consolidated boolean:=coalesce((p_filters->>'consolidated')::boolean,false);cutoff date:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);period_key text:=to_char(cutoff,'YYYY-MM');holding_id bigint;usd_id bigint;company record;report jsonb;item jsonb;reversal jsonb;scaled_reversals jsonb;all_rows jsonb:='[]';rate numeric;initial_total numeric:=0;reversed_total numeric:=0;balance_total numeric:=0;begin
 if not consolidated then return run_pending_invoice_control_report_before_consolidation(p_filters);end if;
 select subsidiary_id into holding_id from subsidiaries where lower(trim(name))='stt group latin american'limit 1;select currency_id into usd_id from currencies where currency_code='USD';
 if usd_id is null then raise exception 'Configure la moneda USD para generar el consolidado.';end if;
 for company in select s.subsidiary_id,s.name,s.currency_id from subsidiaries s join user_subsidiaries us using(subsidiary_id)where us.user_id=app_user_id()and s.is_active order by s.name loop
  rate:=operational_usd_closing_rate(company.subsidiary_id,cutoff);if rate is null then raise exception 'Falta la tasa de cierre hacia USD para % en %.',company.name,period_key;end if;
  report:=run_pending_invoice_control_report_before_consolidation((p_filters-'consolidated')||jsonb_build_object('subsidiaryIds',jsonb_build_array(company.subsidiary_id)));
  for item in select value from jsonb_array_elements(coalesce(report->'rows','[]')) loop
   select coalesce(jsonb_agg(r.value||jsonb_build_object('amount',round(coalesce((r.value->>'amount')::numeric,0)*rate,2))),'[]')into scaled_reversals from jsonb_array_elements(coalesce(item->'reversals','[]'))r(value);
   all_rows:=all_rows||jsonb_build_array(item||jsonb_build_object('subsidiary_id',company.subsidiary_id,'subsidiary_name',company.name,'presentation_currency','USD','conversion_rate',rate,'initial',round(coalesce((item->>'initial')::numeric,0)*rate,2),'reversed',round(coalesce((item->>'reversed')::numeric,0)*rate,2),'balance',round(coalesce((item->>'balance')::numeric,0)*rate,2),'reversals',scaled_reversals));
  end loop;
  initial_total:=initial_total+coalesce((report->'summary'->>'initial')::numeric,0)*rate;reversed_total:=reversed_total+coalesce((report->'summary'->>'reversed')::numeric,0)*rate;balance_total:=balance_total+coalesce((report->'summary'->>'balance')::numeric,0)*rate;
 end loop;
 return jsonb_build_object('rows',all_rows,'total',jsonb_array_length(all_rows),'summary',jsonb_build_object('initial',round(initial_total,2),'reversed',round(reversed_total,2),'balance',round(balance_total,2)),'consolidated',true,'currency','USD','companies',(select coalesce(jsonb_agg(jsonb_build_object('id',s.subsidiary_id,'name',s.name)order by s.name),'[]')from subsidiaries s join user_subsidiaries us using(subsidiary_id)where us.user_id=app_user_id()and s.is_active));
end$function$;

CREATE OR REPLACE FUNCTION public.run_pending_invoice_control_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare report jsonb;period_summary jsonb;
begin
  report:=public.run_pending_invoice_control_report_before_period_summary(p_filters);
  select jsonb_build_object(
    'currentBalance',coalesce(sum((row->>'balance')::numeric)
      filter(where coalesce(row->>'periodType',row->>'period_type','ACTUAL')='ACTUAL'),0),
    'previousBalance',coalesce(sum((row->>'balance')::numeric)
      filter(where coalesce(row->>'periodType',row->>'period_type','ACTUAL')='ANTERIOR'),0),
    'priorBalance',coalesce(sum((row->>'balance')::numeric)
      filter(where coalesce(row->>'periodType',row->>'period_type','ACTUAL')='ANTERIOR'),0),
    'currentCount',count(*)filter(
      where coalesce(row->>'periodType',row->>'period_type','ACTUAL')='ACTUAL'),
    'previousCount',count(*)filter(
      where coalesce(row->>'periodType',row->>'period_type','ACTUAL')='ANTERIOR')
  )into period_summary
  from jsonb_array_elements(coalesce(report->'rows','[]'::jsonb))row;
  return jsonb_set(report,'{summary}',coalesce(report->'summary','{}'::jsonb)
    ||coalesce(period_summary,'{}'::jsonb),true);
end
$function$;

CREATE OR REPLACE FUNCTION public.reverse_pending_invoice_journal(p_journal_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  supports jsonb;
  result jsonb;
  reversal_key bigint;
begin
  if not exists(
    select 1
    from public.user_roles ur
    join public.role_permissions rp using(role_id)
    join public.permissions p using(permission_id)
    where ur.user_id=public.app_user_id()
      and p.code='accounting:journal:reverse'
  ) then
    raise exception using
      errcode='42501',
      message='No tiene permiso para reversar asientos.';
  end if;

  supports:=public.validate_pending_reversal_supports(p_payload);
  result:=public.reverse_pending_invoice_journal_before_support_integrity(
    p_journal_id,p_payload-'supports'
  );
  reversal_key:=nullif(result->>'journalId','')::bigint;
  if reversal_key is null then
    raise exception 'La reversión no devolvió el asiento contable generado.';
  end if;

  perform public.save_pending_reversal_supports(reversal_key,supports);

  return result;
end
$function$;

CREATE OR REPLACE FUNCTION public.validate_pending_reversal_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if(new.source_journal_id is null)=(new.source_opening_pending_id is null)then
    raise exception 'La reversión debe tener un único origen.';
  end if;
  if new.reversal_type<>'FACTURACION'then return new;end if;
  -- The wrapper has already serialized and validated the invoice.  This
  -- narrow bypass also lets it correct the final millionth-rounding residue
  -- before the row becomes visible outside the transaction.
  if current_user='postgres'
    and coalesce(current_setting('app.pending_billing_limit_validated',true),'')='1'then
    return new;
  end if;
  perform public.pending_invoice_validate_billing_limit(
    new.source_journal_id,new.source_opening_pending_id,new.sales_invoice_id,
    new.reversal_date,new.reversed_local,new.reversed_foreign,
    case when tg_op='UPDATE'then new.reversal_id end
  );
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.reverse_pending_invoice_journal_before_opening_pending(p_journal_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  reversal_journal_id bigint;
begin
  result:=public.reverse_pending_invoice_journal_before_service_dimensions(p_journal_id,p_payload);
  reversal_journal_id:=(result->>'journalId')::bigint;

  with source_lines as (
    select service_month,service_country_id,
      row_number() over(order by journal_line_id) ordinality
    from public.journal_line
    where journal_id=p_journal_id
  ), reversal_lines as (
    select journal_line_id,
      row_number() over(order by journal_line_id) ordinality
    from public.journal_line
    where journal_id=reversal_journal_id
  ), mapped as (
    select reversal.journal_line_id,source.service_month,source.service_country_id
    from reversal_lines reversal
    join source_lines source using(ordinality)
  )
  update public.journal_line target
  set service_month=mapped.service_month,
      service_country_id=mapped.service_country_id
  from mapped
  where target.journal_line_id=mapped.journal_line_id;

  return result;
end$function$;

CREATE OR REPLACE FUNCTION public.reverse_pending_invoice_journal_before_period_type(p_journal_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  invoice_key bigint;
  amount_value numeric(24,6);
begin
  if p_journal_id<0 then
    -- Bypass the legacy regular-invoice limit: it compares a local opening
    -- amount with an invoice subtotal in transaction currency.  The hardened
    -- opening wrapper performs the same validation in one historical unit.
    return public.reverse_opening_pending_invoice(
      -p_journal_id,p_payload
    );
  end if;
  if p_payload->>'type'='FACTURACION'
    and not(current_user='postgres'
      and coalesce(current_setting('app.pending_billing_limit_validated',true),'')='1')then
    invoice_key:=nullif(p_payload->>'invoiceId','')::bigint;
    amount_value:=nullif(p_payload->>'amount','')::numeric;
    if not exists(
      select 1 from public.invoice invoice
      join public.user_subsidiaries access
        on access.subsidiary_id=invoice.subsidiary_id
       and access.user_id=public.app_user_id()
      where invoice.invoice_id=invoice_key
    )then
      raise exception 'La factura seleccionada no existe o no pertenece a una subsidiaria autorizada.';
    end if;
    perform public.pending_invoice_validate_billing_limit(
      p_journal_id,null,invoice_key,
      nullif(p_payload->>'reversalDate','')::date,amount_value,null,null
    );
    perform set_config('app.pending_billing_limit_validated','1',true);
    begin
      result:=public.reverse_pending_invoice_journal_before_invoice_subtotal_limit(
        p_journal_id,p_payload
      );
    exception when others then
      perform set_config('app.pending_billing_limit_validated','0',true);
      raise;
    end;
    perform set_config('app.pending_billing_limit_validated','0',true);
    return result;
  end if;
  return public.reverse_pending_invoice_journal_before_invoice_subtotal_limit(
    p_journal_id,p_payload
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_pending_reclassification_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare target_id bigint:=old.journal_id;
begin
  if tg_op='UPDATE'and to_jsonb(new)=to_jsonb(old)then return new;end if;
  if exists(select 1 from public.pending_invoice_reversal reversal
      where reversal.reversal_journal_id=target_id)then
    if tg_op='UPDATE'and current_user='postgres'
      and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1'
      and(old.currency_id is distinct from new.currency_id
        or old.exchange_rate is distinct from new.exchange_rate
        or old.total_debit is distinct from new.total_debit
        or old.total_credit is distinct from new.total_credit)
      and(to_jsonb(new)-array[
        'currency_id','exchange_rate','total_debit','total_credit'
      ])=(to_jsonb(old)-array[
        'currency_id','exchange_rate','total_debit','total_credit'
      ])then return new;end if;
    raise exception 'El asiento de reversión de un pendiente es inmutable.';
  end if;

  if exists(select 1 from public.pending_invoice_reclassification_items item
      where item.reclassification_journal_id=target_id
        or(item.source_type='OPENING'and item.origin_journal_id=target_id))then
    raise exception 'El asiento de apertura o reclasificación anual vinculado es inmutable.';
  end if;

  if exists(select 1 from public.pending_invoice_reversal reversal
      where reversal.source_journal_id=target_id)then
    if tg_op='UPDATE'and current_user='postgres'
      and coalesce(current_setting('app.pending_reclassification_internal',true),'')='1'
      and(old.pending_period_type is distinct from new.pending_period_type
        or old.pending_origin_journal_id is distinct from new.pending_origin_journal_id)
      and(to_jsonb(new)-array['pending_period_type','pending_origin_journal_id'])
        =(to_jsonb(old)-array['pending_period_type','pending_origin_journal_id'])then
      return new;
    end if;
    if tg_op='UPDATE'and current_user='postgres'
      and coalesce(current_setting('app.pending_reversal_write',true),'')='1'
      and(old.pending_reversed_local is distinct from new.pending_reversed_local
        or old.pending_reversed_foreign is distinct from new.pending_reversed_foreign
        or old.pending_balance_local is distinct from new.pending_balance_local
        or old.pending_balance_foreign is distinct from new.pending_balance_foreign
        or old.reversal_status is distinct from new.reversal_status)
      and(to_jsonb(new)-array[
        'pending_reversed_local','pending_reversed_foreign',
        'pending_balance_local','pending_balance_foreign','reversal_status'
      ])=(to_jsonb(old)-array[
        'pending_reversed_local','pending_reversed_foreign',
        'pending_balance_local','pending_balance_foreign','reversal_status'
      ])then return new;end if;
    raise exception 'El asiento fuente con reversiones registradas es inmutable.';
  end if;

  if exists(select 1 from public.pending_invoice_reclassification_items item
      where item.source_journal_id=target_id)then
    if tg_op='UPDATE'and current_user='postgres'
      and coalesce(current_setting('app.pending_reclassification_internal',true),'')='1'
      and(old.pending_period_type is distinct from new.pending_period_type
        or old.pending_origin_journal_id is distinct from new.pending_origin_journal_id)
      and(to_jsonb(new)-array['pending_period_type','pending_origin_journal_id'])
        =(to_jsonb(old)-array['pending_period_type','pending_origin_journal_id'])then
      return new;
    end if;
    if tg_op='UPDATE'and current_user='postgres'
      and coalesce(current_setting('app.pending_reversal_write',true),'')='1'
      and(old.pending_reversed_local is distinct from new.pending_reversed_local
        or old.pending_reversed_foreign is distinct from new.pending_reversed_foreign
        or old.pending_balance_local is distinct from new.pending_balance_local
        or old.pending_balance_foreign is distinct from new.pending_balance_foreign
        or old.reversal_status is distinct from new.reversal_status)
      and(to_jsonb(new)-array[
        'pending_reversed_local','pending_reversed_foreign',
        'pending_balance_local','pending_balance_foreign','reversal_status'
      ])=(to_jsonb(old)-array[
        'pending_reversed_local','pending_reversed_foreign',
        'pending_balance_local','pending_balance_foreign','reversal_status'
      ])then return new;end if;
    raise exception 'El asiento fuente ya fue reclasificado y sus datos contables son inmutables.';
  end if;
  return case when tg_op='DELETE'then old else new end;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_pending_reclassification_journal_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare old_id bigint:=case when tg_op='INSERT'then null else old.journal_id end;
  new_id bigint:=case when tg_op='DELETE'then null else new.journal_id end;
begin
  if exists(select 1 from public.pending_invoice_reversal reversal
      where reversal.reversal_journal_id in(old_id,new_id))then
    if tg_op='UPDATE'and current_user='postgres'
      and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1'
      and(to_jsonb(new)-array[
        'account_id','debit','credit','debit_fx','credit_fx',
        'historical_exchange_rate','original_currency_id',
        'service_month','service_country_id'
      ])=(to_jsonb(old)-array[
        'account_id','debit','credit','debit_fx','credit_fx',
        'historical_exchange_rate','original_currency_id',
        'service_month','service_country_id'
      ])then return new;end if;
    raise exception 'Las líneas de reversión de un pendiente son inmutables.';
  end if;
  if exists(select 1 from public.pending_invoice_reversal reversal
      where reversal.source_journal_id in(old_id,new_id))then
    raise exception 'Las líneas fuente de un pendiente con reversiones son inmutables.';
  end if;
  if exists(select 1 from public.pending_invoice_reclassification_items item
      where item.reclassification_journal_id in(old_id,new_id)
        or item.source_journal_id in(old_id,new_id)
        or(item.source_type='OPENING'and item.origin_journal_id in(old_id,new_id)))then
    raise exception 'Las líneas de un pendiente reclasificado son inmutables.';
  end if;
  return case when tg_op='DELETE'then old else new end;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_pending_reclassification_gl_impact()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare old_id bigint:=case when tg_op='INSERT'then null else old.transaction_id end;
  new_id bigint:=case when tg_op='DELETE'then null else new.transaction_id end;
begin
  if exists(
    select 1 from public.journal journal_row
    join public.pending_invoice_reversal reversal
      on reversal.reversal_journal_id=journal_row.journal_id
    where journal_row.transaction_id in(old_id,new_id)
  )then
    if current_user='postgres'
      and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1'then
      -- Legacy dimension-copy wrappers invoke journal_line_gl_impact_sync,
      -- which atomically rebuilds the two reversal impacts.  The hardened
      -- wrapper immediately validates the rebuilt set through the normalizer.
      if tg_op in('INSERT','DELETE')then
        return case when tg_op='DELETE'then old else new end;
      end if;
      if tg_op='UPDATE'and(to_jsonb(new)-array[
          'account_id','debit_amount','credit_amount','debit_fx','credit_fx',
          'original_currency_id'
        ])=(to_jsonb(old)-array[
          'account_id','debit_amount','credit_amount','debit_fx','credit_fx',
          'original_currency_id'
        ])then return new;end if;
    end if;
    raise exception 'El impacto de una reversión de pendiente es inmutable.';
  end if;
  if exists(
    select 1 from public.journal source
    join public.pending_invoice_reversal reversal
      on reversal.source_journal_id=source.journal_id
    where source.transaction_id in(old_id,new_id)
  )then
    raise exception 'El impacto fuente de un pendiente con reversiones es inmutable.';
  end if;
  if exists(
    select 1 from public.journal journal_row
    join public.pending_invoice_reclassification_items item
      on item.reclassification_journal_id=journal_row.journal_id
        or item.source_journal_id=journal_row.journal_id
        or(item.source_type='OPENING'and item.origin_journal_id=journal_row.journal_id)
    where journal_row.transaction_id in(old_id,new_id)
  )then
    raise exception 'El impacto contable de un pendiente reclasificado es inmutable.';
  end if;
  return case when tg_op='DELETE'then old else new end;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_pending_reclassification_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare target_id bigint:=old.transaction_id;
  sid bigint;
begin
  select journal_row.subsidiary_id into sid
  from public.journal journal_row
  where journal_row.transaction_id=target_id
    and(journal_row.journal_number like'ASI_PEN-%'
      or journal_row.journal_type='Asientos Pendientes de Facturar'
      or exists(
        select 1 from public.opening_balance_runs opening_run
        join public.opening_pending_invoice_items opening_item
          on opening_item.run_id=opening_run.id
        where opening_run.journal_id=journal_row.journal_id))
  order by journal_row.journal_id limit 1;
  if sid is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'pending-invoice-reclassification-subsidiary:'||sid,0));
  end if;
  if exists(
    select 1 from public.journal reversal_journal
    join public.pending_invoice_reversal reversal
      on reversal.reversal_journal_id=reversal_journal.journal_id
    where reversal_journal.transaction_id=target_id
  )then
    if tg_op='UPDATE'and current_user='postgres'
      and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1'
      and(to_jsonb(new)-array['currency_id','exchange_rate','total_amount'])
        =(to_jsonb(old)-array['currency_id','exchange_rate','total_amount'])then
      return new;
    end if;
    raise exception 'La transacción de reversión de un pendiente es inmutable.';
  end if;
  if exists(
    select 1 from public.journal source
    join public.pending_invoice_reversal reversal
      on reversal.source_journal_id=source.journal_id
    where source.transaction_id=target_id
  )then
    if tg_op='UPDATE'and to_jsonb(new)=to_jsonb(old)then return new;end if;
    raise exception 'La transacción fuente de un pendiente con reversiones es inmutable.';
  end if;
  if exists(
    select 1 from public.journal journal_row
    join public.pending_invoice_reclassification_items item
      on item.reclassification_journal_id=journal_row.journal_id
        or item.source_journal_id=journal_row.journal_id
        or(item.source_type='OPENING'and item.origin_journal_id=journal_row.journal_id)
    where journal_row.transaction_id=target_id
  )then
    raise exception 'La transacción de un pendiente reclasificado es inmutable.';
  end if;
  return case when tg_op='DELETE'then old else new end;
end
$function$;

CREATE OR REPLACE FUNCTION public.reverse_pending_invoice_journal_before_historical_fx_integrity(p_journal_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  period_value text;
  sid bigint;
  result jsonb;
  reversal_key bigint;
  current_control bigint;
  prior_control bigint;
  current_counterpart bigint;
  bridge_account bigint;
  reversal_transaction bigint;
  reversal_foreign numeric(24,6);
  available_foreign numeric(24,6);
  reversal_row public.pending_invoice_reversal%rowtype;
  source_after public.journal%rowtype;
  annual_date date;
begin
  if not exists(
    select 1
    from public.user_roles user_role
    join public.role_permissions role_permission using(role_id)
    join public.permissions permission using(permission_id)
    where user_role.user_id=public.app_user_id()
      and permission.code='accounting:journal:reverse'
  )then
    raise exception using errcode='42501',
      message='No tiene permiso para reversar asientos.';
  end if;
  if p_journal_id<0 then
    select period_type,subsidiary_id into period_value,sid
    from public.opening_pending_invoice_items item
    where item.id=-p_journal_id
      and item.subsidiary_id=public.active_subsidiary_id()
      and exists(
        select 1 from public.user_subsidiaries access
        where access.user_id=public.app_user_id()
          and access.subsidiary_id=item.subsidiary_id
      );
  else
    select source.subsidiary_id into sid
    from public.journal source
    where source.journal_id=p_journal_id
      and source.subsidiary_id=public.active_subsidiary_id()
      and exists(
        select 1 from public.user_subsidiaries access
        where access.user_id=public.app_user_id()
          and access.subsidiary_id=source.subsidiary_id
      );
    select annual_run.reclassification_date into annual_date
    from public.pending_invoice_reclassification_items reclassified
    join public.pending_invoice_reclassification_runs annual_run
      on annual_run.id=reclassified.run_id
    where reclassified.source_journal_id=p_journal_id
      and reclassified.subsidiary_id=sid;
    if annual_date is not null
      and nullif(p_payload->>'reversalDate','')::date<annual_date then
      raise exception 'La reversión no puede fecharse antes de la reclasificación anual del %.',annual_date;
    end if;
  end if;
  if sid is null then
    raise exception using errcode='42501',
      message='El pendiente no pertenece a la subsidiaria activa o autorizada.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'pending-invoice-reclassification-subsidiary:'||sid,0
  ));
  if p_journal_id>0 then
    select annual_run.reclassification_date into annual_date
    from public.pending_invoice_reclassification_items reclassified
    join public.pending_invoice_reclassification_runs annual_run
      on annual_run.id=reclassified.run_id
    where reclassified.source_journal_id=p_journal_id
      and reclassified.subsidiary_id=sid;
    if annual_date is not null
      and nullif(p_payload->>'reversalDate','')::date<annual_date then
      raise exception 'La reversión no puede fecharse antes de la reclasificación anual del %.',annual_date;
    end if;
  end if;
  perform set_config('app.pending_reversal_insert','1',true);
  perform set_config('app.pending_reversal_finalize','1',true);
  result:=public.reverse_pending_invoice_journal_before_period_type(p_journal_id,p_payload);
  perform set_config('app.pending_reversal_insert','0',true);
  perform set_config('app.pending_reversal_write','0',true);
  reversal_key:=(result->>'journalId')::bigint;

  -- The wrapped regular reversal locks the source row. Read the classification
  -- only after it returns so a concurrent annual move cannot leave the new
  -- reversal on the current-period accounts.
  if p_journal_id>0 then
    select * into source_after
    from public.journal where journal_id=p_journal_id;
    period_value:=coalesce(source_after.pending_period_type,'ACTUAL');
    select reversal.* into reversal_row
    from public.pending_invoice_reversal reversal
    where reversal.source_journal_id=p_journal_id
      and reversal.reversal_journal_id=reversal_key;
    if reversal_row.reversal_id is null then
      raise exception 'No fue posible identificar el importe original de la reversión.';
    end if;
    available_foreign:=greatest(source_after.pending_initial_foreign-
      (source_after.pending_reversed_foreign-reversal_row.reversed_foreign),0);
    reversal_foreign:=case
      when source_after.pending_balance_local<=.000001 then available_foreign
      else least(reversal_row.reversed_foreign,available_foreign)
    end;
    if reversal_foreign is distinct from reversal_row.reversed_foreign then
      update public.pending_invoice_reversal
      set reversed_foreign=reversal_foreign
      where reversal_id=reversal_row.reversal_id;
      perform set_config('app.pending_reversal_write','1',true);
      update public.journal
      set pending_reversed_foreign=greatest(
          pending_reversed_foreign-reversal_row.reversed_foreign+reversal_foreign,0
        ),
        pending_balance_foreign=greatest(
          pending_initial_foreign-
            (pending_reversed_foreign-reversal_row.reversed_foreign+reversal_foreign),0
        )
      where journal_id=p_journal_id;
      perform set_config('app.pending_reversal_write','0',true);
    end if;
    update public.journal_line
    set debit=case when debit>0 then reversal_foreign else 0 end,
      credit=case when credit>0 then reversal_foreign else 0 end,
      debit_fx=case when debit>0 then reversal_foreign else 0 end,
      credit_fx=case when credit>0 then reversal_foreign else 0 end,
      historical_exchange_rate=source_after.exchange_rate,
      original_currency_id=source_after.currency_id
    where journal_id=reversal_key;
    update public.journal
    set total_debit=reversal_foreign,total_credit=reversal_foreign
    where journal_id=reversal_key;
    select transaction_id into reversal_transaction
    from public.journal where journal_id=reversal_key;
    select max(account_id)filter(where account_number='113003'),
      max(account_id)filter(where account_number='113004'),
      max(account_id)filter(where account_number='413001'),
      max(account_id)filter(where account_number='413002')
    into current_control,prior_control,current_counterpart,bridge_account
    from public.chart_accounts where account_number in('113003','113004','413001','413002');
  end if;

  if p_journal_id>0 and period_value='ANTERIOR'then
    update public.journal_line
    set account_id=case account_id
      when current_control then prior_control
      when current_counterpart then bridge_account
      else account_id end
    where journal_id=reversal_key
      and account_id in(current_control,current_counterpart);
    update public.gl_impact
    set account_id=case account_id
      when current_control then prior_control
      when current_counterpart then bridge_account
      else account_id end
    where transaction_id=reversal_transaction
      and account_id in(current_control,current_counterpart);
  end if;
  if p_journal_id>0 then
    update public.gl_impact
    set debit_amount=case when debit_amount>0 then reversal_row.reversed_local else 0 end,
      credit_amount=case when credit_amount>0 then reversal_row.reversed_local else 0 end,
      debit_fx=case when debit_amount>0 then reversal_foreign else 0 end,
      credit_fx=case when credit_amount>0 then reversal_foreign else 0 end,
      original_currency_id=source_after.currency_id
    where transaction_id=reversal_transaction
      and account_id in(current_control,current_counterpart,prior_control,bridge_account);
  end if;
  perform set_config('app.pending_reversal_finalize','0',true);
  return result||jsonb_build_object('periodType',coalesce(period_value,'ACTUAL'));
end
$function$;

CREATE OR REPLACE FUNCTION public.reverse_pending_invoice_journal_before_support_integrity(p_journal_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint;
  source_before public.journal%rowtype;
  source_fx record;
  reversal_row public.pending_invoice_reversal%rowtype;
  result jsonb;
  reversal_key bigint;
  reversal_transaction_id bigint;
  requested_local numeric(24,6);
  delegated_foreign numeric(24,6);
  residual_foreign numeric(24,6);
  requires_residual_cap boolean:=false;
  invoice_key bigint;
  requested_date date;
  billing_validated boolean:=false;
begin
  if p_journal_id<0 then
    -- The established negative-id router delegates to the hardened opening
    -- function above; keeping one router preserves the public API contract.
    return public.reverse_pending_invoice_journal_before_historical_fx_integrity(
      p_journal_id,p_payload
    );
  end if;
  if not exists(
    select 1 from public.user_roles user_role
    join public.role_permissions role_permission using(role_id)
    join public.permissions permission using(permission_id)
    where user_role.user_id=public.app_user_id()
      and permission.code='accounting:journal:reverse'
  )then
    raise exception using errcode='42501',
      message='No tiene permiso para reversar asientos.';
  end if;
  select journal_row.subsidiary_id into sid
  from public.journal journal_row
  join public.user_subsidiaries access
    on access.subsidiary_id=journal_row.subsidiary_id
    and access.user_id=public.app_user_id()
  where journal_row.journal_id=p_journal_id
    and journal_row.subsidiary_id=public.active_subsidiary_id();
  if sid is null then
    raise exception using errcode='42501',
      message='El pendiente no pertenece a la subsidiaria activa o autorizada.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'pending-invoice-reclassification-subsidiary:'||sid,0));
  select * into source_before
  from public.journal where journal_id=p_journal_id for update;
  select * into source_fx
  from public.pending_invoice_reversal_source_fx(p_journal_id,null);

  requested_local:=nullif(p_payload->>'amount','')::numeric;
  if p_payload->>'type'='FACTURACION'then
    invoice_key:=nullif(p_payload->>'invoiceId','')::bigint;
    requested_date:=nullif(p_payload->>'reversalDate','')::date;
    perform public.pending_invoice_validate_billing_limit(
      p_journal_id,null,invoice_key,requested_date,requested_local,null,null
    );
    perform set_config('app.pending_billing_limit_validated','1',true);
    billing_validated:=true;
  end if;

  -- The pre-hardening delegate rounds each partial foreign amount separately.
  -- On a final reversal those prior roundings can make its calculated amount
  -- exceed the remaining foreign balance by a few millionths, causing the
  -- source constraint to reject the row before the annual wrapper can cap it.
  -- Serialize and expose a temporary constraint-safe balance; after the
  -- delegate returns, restore the source and new reversal to the exact frozen
  -- residual without relaxing any constraint.
  if requested_local is not null and source_before.pending_initial_local>0
    and requested_local>=source_before.pending_balance_local-.000001
    and requested_local<=source_before.pending_balance_local+.000001
    and source_before.pending_balance_local>.000001 then
    delegated_foreign:=round(source_before.pending_initial_foreign
      *(requested_local/source_before.pending_initial_local),6);
    residual_foreign:=source_before.pending_balance_foreign;
    requires_residual_cap:=delegated_foreign>residual_foreign+.000001;
    if requires_residual_cap then
      perform set_config('app.pending_reversal_write','1',true);
      update public.journal
      set pending_reversed_foreign=pending_initial_foreign-delegated_foreign,
        pending_balance_foreign=delegated_foreign
      where journal_id=p_journal_id;
      perform set_config('app.pending_reversal_write','0',true);
    end if;
  end if;

  begin
    result:=public.reverse_pending_invoice_journal_before_historical_fx_integrity(
      p_journal_id,p_payload
    );
  exception when others then
    if billing_validated then
      perform set_config('app.pending_billing_limit_validated','0',true);
    end if;
    raise;
  end;
  if billing_validated then
    perform set_config('app.pending_billing_limit_validated','0',true);
  end if;
  reversal_key:=(result->>'journalId')::bigint;
  if requires_residual_cap then
    select reversal.* into reversal_row
    from public.pending_invoice_reversal reversal
    where reversal.reversal_journal_id=reversal_key
      and reversal.source_journal_id=p_journal_id;
    select transaction_id into reversal_transaction_id
    from public.journal where journal_id=reversal_key;
    if reversal_row.reversal_id is null or reversal_transaction_id is null then
      raise exception 'No fue posible cerrar el residuo histórico de la reversión.';
    end if;

    perform set_config('app.pending_reversal_finalize','1',true);
    update public.pending_invoice_reversal
    set reversed_foreign=residual_foreign
    where reversal_id=reversal_row.reversal_id;
    perform set_config('app.pending_reversal_write','1',true);
    update public.journal
    set pending_reversed_foreign=source_before.pending_reversed_foreign+residual_foreign,
      pending_balance_foreign=greatest(pending_initial_foreign-
        (source_before.pending_reversed_foreign+residual_foreign),0)
    where journal_id=p_journal_id;
    perform set_config('app.pending_reversal_write','0',true);
    update public."transaction"
    set total_amount=residual_foreign,currency_id=source_fx.source_currency_id,
      exchange_rate=source_fx.source_historical_rate
    where transaction_id=reversal_transaction_id;
    update public.journal
    set total_debit=residual_foreign,total_credit=residual_foreign,
      currency_id=source_fx.source_currency_id,
      exchange_rate=source_fx.source_historical_rate
    where journal_id=reversal_key;
    update public.journal_line
    set debit=case when debit>0 then residual_foreign else 0 end,
      credit=case when credit>0 then residual_foreign else 0 end,
      debit_fx=case when debit_fx>0 then residual_foreign else 0 end,
      credit_fx=case when credit_fx>0 then residual_foreign else 0 end,
      historical_exchange_rate=source_fx.source_historical_rate,
      original_currency_id=source_fx.source_currency_id
    where journal_id=reversal_key;
    update public.gl_impact
    set debit_amount=case when debit_amount>0 then reversal_row.reversed_local else 0 end,
      credit_amount=case when credit_amount>0 then reversal_row.reversed_local else 0 end,
      debit_fx=case when debit_fx>0 then residual_foreign else 0 end,
      credit_fx=case when credit_fx>0 then residual_foreign else 0 end,
      original_currency_id=source_fx.source_currency_id
    where transaction_id=reversal_transaction_id;
    perform set_config('app.pending_reversal_finalize','0',true);
  end if;
  perform public.pending_invoice_normalize_reversal_fx(
    reversal_key,source_fx.source_historical_rate,
    source_fx.source_currency_id,source_fx.source_period_type
  );
  return result||jsonb_build_object(
    'historicalExchangeRate',source_fx.source_historical_rate,
    'originalCurrencyId',source_fx.source_currency_id
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reversal_options(p_journal_id bigint, p_reversal_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  result jsonb;
  enriched_invoices jsonb;
begin
  result:=public.pending_invoice_reversal_options_before_historical_fx_integrity(
    p_journal_id,p_reversal_date
  );
  select coalesce(jsonb_agg(source.item||jsonb_build_object(
      'subtotal',round(limit_snapshot.subtotal_invoice
        *limit_snapshot.local_per_invoice_unit,6),
      'applied',round(limit_snapshot.applied_invoice
        *limit_snapshot.local_per_invoice_unit,6),
      'available',round(limit_snapshot.available_invoice
        *limit_snapshot.local_per_invoice_unit,6),
      'subtotalOriginal',limit_snapshot.subtotal_invoice,
      'appliedOriginal',limit_snapshot.applied_invoice,
      'availableOriginal',limit_snapshot.available_invoice,
      'invoiceCurrencyId',limit_snapshot.invoice_currency_id,
      'invoiceExchangeRate',limit_snapshot.invoice_historical_rate
    )order by source.ordinality),'[]'::jsonb)
  into enriched_invoices
  from jsonb_array_elements(coalesce(result->'invoices','[]'::jsonb))
    with ordinality source(item,ordinality)
  cross join lateral public.pending_invoice_billing_limit_snapshot(
    case when p_journal_id>0 then p_journal_id end,
    case when p_journal_id<0 then-p_journal_id end,
    (source.item->>'id')::bigint,null
  )limit_snapshot;
  return jsonb_set(result,'{invoices}',enriched_invoices,true);
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_pending_control_gl_cutoff()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  old_is_control boolean:=false;
  new_is_control boolean:=false;
  old_subsidiary bigint;
  new_subsidiary bigint;
  lock_subsidiary bigint;
begin
  if tg_op<>'INSERT'then
    old_subsidiary:=old.subsidiary_id;
    select exists(
      select 1 from public.chart_accounts account
      where account.account_id=old.account_id and account.account_number='113003'
    )into old_is_control;
  end if;
  if tg_op<>'DELETE'then
    new_subsidiary:=new.subsidiary_id;
    select exists(
      select 1 from public.chart_accounts account
      where account.account_id=new.account_id and account.account_number='113003'
    )into new_is_control;
  end if;
  if not old_is_control and not new_is_control then
    return case when tg_op='DELETE'then old else new end;
  end if;

  for lock_subsidiary in
    select distinct value
    from unnest(array[
      case when old_is_control then old_subsidiary end,
      case when new_is_control then new_subsidiary end
    ])value
    where value is not null
    order by value
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'pending-invoice-reclassification-subsidiary:'||lock_subsidiary,0
    ));
  end loop;

  if old_is_control and exists(
    select 1 from public.pending_invoice_reclassification_runs annual_run
    where annual_run.subsidiary_id=old.subsidiary_id
      and annual_run.status='POSTED'
      and old.posting_date<annual_run.reclassification_date
  )then
    raise exception 'El Mayor de 113003 anterior al corte anual ya fue reclasificado y es inmutable.';
  end if;
  if new_is_control and exists(
    select 1 from public.pending_invoice_reclassification_runs annual_run
    where annual_run.subsidiary_id=new.subsidiary_id
      and annual_run.status='POSTED'
      and new.posting_date<annual_run.reclassification_date
  )then
    raise exception 'No puede contabilizar un movimiento retroactivo en 113003 después de la reclasificación anual.';
  end if;
  return case when tg_op='DELETE'then old else new end;
end
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reversal_source_fx(p_source_journal_id bigint, p_source_opening_pending_id bigint)
 RETURNS TABLE(source_subsidiary_id bigint, source_currency_id bigint, source_historical_rate numeric, source_initial_local numeric, source_initial_foreign numeric, source_balance_local numeric, source_balance_foreign numeric, source_period_type text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  source_journal public.journal%rowtype;
  opening_item public.opening_pending_invoice_items%rowtype;
  control_account bigint;
  counterpart_account bigint;
  primary_book bigint;
  primary_book_count integer;
  control_line_count integer;
  counterpart_line_count integer;
  unexpected_line_count integer;
  source_control_debit numeric(24,6);
  source_control_credit numeric(24,6);
  source_counterpart_debit numeric(24,6);
  source_counterpart_credit numeric(24,6);
  source_control_debit_fx numeric(24,6);
  source_control_credit_fx numeric(24,6);
  source_counterpart_debit_fx numeric(24,6);
  source_counterpart_credit_fx numeric(24,6);
  source_line_rate numeric;
  source_line_wrong_rate boolean;
  source_line_wrong_currency boolean;
  impact_count integer;
  impact_unexpected_count integer;
  impact_control_local numeric(24,6);
  impact_counterpart_local numeric(24,6);
  impact_control_foreign numeric(24,6);
  impact_counterpart_foreign numeric(24,6);
  impact_wrong_currency boolean;
  source_transaction_rate numeric;
  source_transaction_currency bigint;
  recorded_reversed_local numeric(24,6);
  recorded_reversed_foreign numeric(24,6);
  source_fx_tolerance numeric(24,10);
  source_cumulative_tolerance numeric(24,10);
  source_reversal_count integer;
  source_final_reversal_id bigint;
  source_closes_exactly boolean;
  invalid_reversal_count integer;
  opening_source_period_type text;
  expected_control_number text;
  expected_counterpart_number text;
begin
  if(p_source_journal_id is null)=(p_source_opening_pending_id is null)then
    raise exception 'La reversión debe tener exactamente una fuente de pendiente.';
  end if;

  if p_source_journal_id is not null then
    select journal_row.* into source_journal
    from public.journal journal_row
    where journal_row.journal_id=p_source_journal_id;
    if source_journal.journal_id is null
      or not(source_journal.journal_number like'ASI_PEN-%'
        or source_journal.journal_type='Asientos Pendientes de Facturar')then
      raise exception 'El asiento fuente no es un pendiente de facturar válido.';
    end if;
    select transaction_row.exchange_rate,transaction_row.currency_id
    into source_transaction_rate,source_transaction_currency
    from public."transaction" transaction_row
    where transaction_row.transaction_id=source_journal.transaction_id;

    expected_control_number:='113003';
    expected_counterpart_number:='413001';
    select max(account_id)filter(where account_number=expected_control_number),
      max(account_id)filter(where account_number=expected_counterpart_number)
    into control_account,counterpart_account
    from public.chart_accounts
    where account_number in(expected_control_number,expected_counterpart_number);

    select count(*)::integer,max(accounting_book_id)
    into primary_book_count,primary_book
    from public.accounting_books
    where subsidiary_id=source_journal.subsidiary_id
      and is_primary and is_active;
    if primary_book_count<>1 then
      raise exception 'Debe existir exactamente un libro principal activo para validar la tasa histórica.';
    end if;

    select
      count(*)filter(where line.account_id=control_account and line.debit>0)::integer,
      count(*)filter(where line.account_id=counterpart_account and line.credit>0)::integer,
      count(*)filter(where(line.debit<>0 or line.credit<>0)
        and not(line.account_id=control_account and line.debit>0 and line.credit=0)
        and not(line.account_id=counterpart_account and line.credit>0 and line.debit=0))::integer,
      max(line.historical_exchange_rate)filter(where line.account_id=control_account and line.debit>0),
      false,
      coalesce(bool_or(line.original_currency_id is not null
        and line.original_currency_id<>source_journal.currency_id),false),
      coalesce(sum(line.debit)filter(where line.account_id=control_account),0),
      coalesce(sum(line.credit)filter(where line.account_id=control_account),0),
      coalesce(sum(line.debit)filter(where line.account_id=counterpart_account),0),
      coalesce(sum(line.credit)filter(where line.account_id=counterpart_account),0),
      coalesce(sum(line.debit_fx)filter(where line.account_id=control_account),0),
      coalesce(sum(line.credit_fx)filter(where line.account_id=control_account),0),
      coalesce(sum(line.debit_fx)filter(where line.account_id=counterpart_account),0),
      coalesce(sum(line.credit_fx)filter(where line.account_id=counterpart_account),0)
    into control_line_count,counterpart_line_count,unexpected_line_count,
      source_line_rate,source_line_wrong_rate,source_line_wrong_currency,
      source_control_debit,source_control_credit,
      source_counterpart_debit,source_counterpart_credit,
      source_control_debit_fx,source_control_credit_fx,
      source_counterpart_debit_fx,source_counterpart_credit_fx
    from public.journal_line line
    where line.journal_id=source_journal.journal_id;

    -- Re-evaluate every line against the single control-line snapshot.
    source_line_rate:=coalesce(source_line_rate,source_journal.exchange_rate);
    select coalesce(bool_or(line.historical_exchange_rate is not null
        and abs(line.historical_exchange_rate-source_line_rate)>.0000000001),false),
      coalesce(bool_or(line.original_currency_id is not null
        and line.original_currency_id<>source_journal.currency_id),false)
    into source_line_wrong_rate,source_line_wrong_currency
    from public.journal_line line
    where line.journal_id=source_journal.journal_id;

    if control_line_count<>1 or counterpart_line_count<>1
      or unexpected_line_count<>0 then
      raise exception 'El pendiente fuente no conserva exactamente 113003 al debe y 413001 al haber.';
    end if;
    if abs(source_control_debit-source_journal.pending_initial_foreign)>.000001
      or abs(source_counterpart_credit-source_journal.pending_initial_foreign)>.000001
      or abs(source_control_debit_fx-source_journal.pending_initial_foreign)>.000001
      or abs(source_counterpart_credit_fx-source_journal.pending_initial_foreign)>.000001
      or abs(source_control_credit)>.000001
      or abs(source_counterpart_debit)>.000001
      or abs(source_control_credit_fx)>.000001
      or abs(source_counterpart_debit_fx)>.000001 then
      raise exception 'Las líneas del pendiente fuente no concilian con el importe original congelado.';
    end if;
    if source_line_rate is null or source_line_rate<=0
      or source_journal.exchange_rate is null or source_journal.exchange_rate<=0 then
      raise exception 'El pendiente fuente no tiene una tasa histórica válida.';
    end if;
    if abs(source_journal.exchange_rate-source_line_rate)>.0000000001
      or source_transaction_rate is null
      or abs(source_transaction_rate-source_line_rate)>.0000000001
      or source_transaction_currency is distinct from source_journal.currency_id
      or source_line_wrong_rate then
      raise exception 'La tasa o moneda de la transacción no coincide con el asiento fuente.';
    end if;
    if source_line_wrong_currency then
      raise exception 'La moneda original de las líneas no coincide con el asiento fuente.';
    end if;

    select count(*)::integer,
      coalesce(sum(impact.debit_amount)filter(where
        impact.accounting_book_id=primary_book and impact.account_id=control_account),0),
      coalesce(sum(impact.credit_amount)filter(where
        impact.accounting_book_id=primary_book and impact.account_id=counterpart_account),0),
      coalesce(sum(impact.debit_fx)filter(where
        impact.accounting_book_id=primary_book and impact.account_id=control_account),0),
      coalesce(sum(impact.credit_fx)filter(where
        impact.accounting_book_id=primary_book and impact.account_id=counterpart_account),0),
      coalesce(bool_or(impact.original_currency_id is not null
        and impact.original_currency_id<>source_journal.currency_id),false),
      count(*)filter(where not(
        (impact.accounting_book_id=primary_book
          and impact.account_id=control_account
          and abs(impact.debit_amount-source_journal.pending_initial_local)<=.000001
          and abs(impact.credit_amount)<=.000001
          and abs(impact.debit_fx-source_journal.pending_initial_foreign)<=.000001
          and abs(impact.credit_fx)<=.000001)
        or(impact.accounting_book_id=primary_book
          and impact.account_id=counterpart_account
          and abs(impact.debit_amount)<=.000001
          and abs(impact.credit_amount-source_journal.pending_initial_local)<=.000001
          and abs(impact.debit_fx)<=.000001
          and abs(impact.credit_fx-source_journal.pending_initial_foreign)<=.000001)
      ))::integer
    into impact_count,impact_control_local,impact_counterpart_local,
      impact_control_foreign,impact_counterpart_foreign,impact_wrong_currency,
      impact_unexpected_count
    from public.gl_impact impact
    where impact.transaction_id=source_journal.transaction_id;

    if impact_count<>2
      or abs(impact_control_local-impact_counterpart_local)>.000001
      or abs(impact_control_foreign-impact_counterpart_foreign)>.000001
      or abs(impact_control_local-source_journal.pending_initial_local)>.005
      or abs(impact_control_foreign-source_journal.pending_initial_foreign)>.000001
      or impact_wrong_currency or impact_unexpected_count<>0 then
      raise exception 'El pendiente fuente no concilia con su asiento original en moneda local y original.';
    end if;
    source_fx_tolerance:=greatest(.005,
      abs(source_line_rate)*.0000005+.000001);
    if abs(source_journal.pending_initial_local-
        round(source_journal.pending_initial_foreign*source_line_rate,6))
          >source_fx_tolerance then
      raise exception 'El importe inicial del pendiente no reproduce la tasa histórica del asiento original.';
    end if;
    select coalesce(sum(reversal.reversed_local),0),
      coalesce(sum(reversal.reversed_foreign),0),count(*)::integer,
      max(reversal.reversal_id)
    into recorded_reversed_local,recorded_reversed_foreign,source_reversal_count,
      source_final_reversal_id
    from public.pending_invoice_reversal reversal
    where reversal.source_journal_id=source_journal.journal_id;
    source_closes_exactly:=abs(source_journal.pending_balance_local)<=.000001
      and abs(source_journal.pending_balance_foreign)<=.000001
      and abs(source_journal.pending_initial_local-recorded_reversed_local)<=.000001
      and abs(source_journal.pending_initial_foreign-recorded_reversed_foreign)<=.000001;
    source_cumulative_tolerance:=.005+abs(source_line_rate)*.0000005
      *(source_reversal_count+1)+.000001;
    select count(*)::integer into invalid_reversal_count
    from public.pending_invoice_reversal reversal
    where reversal.source_journal_id=source_journal.journal_id
      and abs(reversal.reversed_local-
        round(reversal.reversed_foreign*source_line_rate,6))
          >case when source_closes_exactly
              and reversal.reversal_id=source_final_reversal_id
            then source_cumulative_tolerance else source_fx_tolerance end;
    if invalid_reversal_count<>0 then
      raise exception 'Una reversión histórica no corresponde a la tasa congelada del pendiente.';
    end if;
    if abs(source_journal.pending_reversed_local-recorded_reversed_local)>.000001
      or abs(source_journal.pending_reversed_foreign-recorded_reversed_foreign)>.000001
      or abs(source_journal.pending_initial_local-recorded_reversed_local-
        source_journal.pending_balance_local)>.000001
      or abs(source_journal.pending_initial_foreign-recorded_reversed_foreign-
        source_journal.pending_balance_foreign)>.000001 then
      raise exception 'El saldo del pendiente no concilia con sus reversiones históricas.';
    end if;

    return query select source_journal.subsidiary_id,source_journal.currency_id,
      source_line_rate,source_journal.pending_initial_local,
      source_journal.pending_initial_foreign,source_journal.pending_balance_local,
      source_journal.pending_balance_foreign,
      coalesce(source_journal.pending_period_type,'ACTUAL');
    return;
  end if;

  select item.* into opening_item
  from public.opening_pending_invoice_items item
  where item.id=p_source_opening_pending_id;
  if opening_item.id is null then
    raise exception 'El pendiente inicial no existe.';
  end if;
  if opening_item.historical_exchange_rate is null
    or opening_item.historical_exchange_rate<=0 then
    raise exception 'El pendiente inicial no tiene una tasa histórica válida.';
  end if;
  source_fx_tolerance:=greatest(.005,
    abs(opening_item.historical_exchange_rate)*.0000005+.000001);
  select coalesce(sum(reversal.reversed_local),0),
    coalesce(sum(reversal.reversed_foreign),0),count(*)::integer,
    max(reversal.reversal_id)
  into recorded_reversed_local,recorded_reversed_foreign,source_reversal_count,
    source_final_reversal_id
  from public.pending_invoice_reversal reversal
  where reversal.source_opening_pending_id=opening_item.id;
  source_closes_exactly:=abs(opening_item.balance_local)<=.000001
    and abs(opening_item.balance_foreign)<=.000001
    and abs(opening_item.initial_local-recorded_reversed_local)<=.000001
    and abs(opening_item.initial_foreign-recorded_reversed_foreign)<=.000001;
  source_cumulative_tolerance:=.005
    +abs(opening_item.historical_exchange_rate)*.0000005
      *(source_reversal_count+1)+.000001;
  select count(*)::integer into invalid_reversal_count
  from public.pending_invoice_reversal reversal
  where reversal.source_opening_pending_id=opening_item.id
    and abs(reversal.reversed_local-
      round(reversal.reversed_foreign*opening_item.historical_exchange_rate,6))
        >case when source_closes_exactly
            and reversal.reversal_id=source_final_reversal_id
          then source_cumulative_tolerance else source_fx_tolerance end;
  if abs(opening_item.initial_local-
      round(opening_item.initial_foreign*opening_item.historical_exchange_rate,6))
        >source_fx_tolerance
    or invalid_reversal_count<>0
    or abs(opening_item.reversed_local-recorded_reversed_local)>.000001
    or abs(opening_item.reversed_foreign-recorded_reversed_foreign)>.000001
    or abs(opening_item.initial_local-recorded_reversed_local-
      opening_item.balance_local)>.000001
    or abs(opening_item.initial_foreign-recorded_reversed_foreign-
      opening_item.balance_foreign)>.000001 then
    raise exception 'El pendiente inicial no reproduce su tasa histórica o no concilia con sus reversiones.';
  end if;

  select coalesce((
    select reclassified.source_period_type
    from public.pending_invoice_reclassification_items reclassified
    where reclassified.source_opening_pending_id=opening_item.id
    limit 1
  ),opening_item.period_type)
  into opening_source_period_type;
  expected_control_number:=case when opening_source_period_type='ANTERIOR'then'113004'else'113003'end;
  expected_counterpart_number:=case when opening_source_period_type='ANTERIOR'then'413002'else'413001'end;
  select count(*)filter(where line.line_role='CONTROL'
      and account.account_number=expected_control_number)::integer,
    count(*)filter(where line.line_role='COUNTERPART'
      and account.account_number=expected_counterpart_number)::integer,
    count(*)filter(where line.line_role not in('CONTROL','COUNTERPART'))::integer,
    coalesce(sum(line.local_debit)filter(where line.line_role='CONTROL'),0),
    coalesce(sum(line.local_credit)filter(where line.line_role='CONTROL'),0),
    coalesce(sum(line.local_debit)filter(where line.line_role='COUNTERPART'),0),
    coalesce(sum(line.local_credit)filter(where line.line_role='COUNTERPART'),0),
    coalesce(sum(line.foreign_debit)filter(where line.line_role='CONTROL'),0),
    coalesce(sum(line.foreign_credit)filter(where line.line_role='CONTROL'),0),
    coalesce(sum(line.foreign_debit)filter(where line.line_role='COUNTERPART'),0),
    coalesce(sum(line.foreign_credit)filter(where line.line_role='COUNTERPART'),0)
  into control_line_count,counterpart_line_count,unexpected_line_count,
    source_control_debit,source_control_credit,
    source_counterpart_debit,source_counterpart_credit,
    source_control_debit_fx,source_control_credit_fx,
    source_counterpart_debit_fx,source_counterpart_credit_fx
  from public.opening_pending_invoice_lines line
  join public.chart_accounts account on account.account_id=line.account_id
  where line.item_id=opening_item.id;
  if control_line_count<>1 or counterpart_line_count<>1
    or unexpected_line_count<>0 then
    raise exception 'El pendiente inicial no conserva la pareja contable correspondiente a su tipo de período.';
  end if;
  if abs(source_control_debit-opening_item.initial_local)>.005
    or abs(source_control_debit_fx-opening_item.initial_foreign)>.000001
    or abs(source_counterpart_credit-opening_item.initial_local)>.005
    or abs(source_counterpart_credit_fx-opening_item.initial_foreign)>.000001
    or abs(source_control_credit)>.000001
    or abs(source_counterpart_debit)>.000001
    or abs(source_control_credit_fx)>.000001
    or abs(source_counterpart_debit_fx)>.000001 then
    raise exception 'Las líneas del pendiente inicial no concilian con sus importes local y original.';
  end if;

  return query select opening_item.subsidiary_id,opening_item.currency_id,
    opening_item.historical_exchange_rate,opening_item.initial_local,
    opening_item.initial_foreign,opening_item.balance_local,
    opening_item.balance_foreign,opening_item.period_type;
end
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_normalize_reversal_fx(p_reversal_journal_id bigint, p_historical_rate numeric, p_currency_id bigint, p_period_type text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  reversal public.pending_invoice_reversal%rowtype;
  reversal_journal public.journal%rowtype;
  reversal_transaction public."transaction"%rowtype;
  validated_source record;
  control_account bigint;
  counterpart_account bigint;
  expected_control text;
  expected_counterpart text;
  book_key bigint;
  book_count integer;
  line_count integer;
  control_count integer;
  counterpart_count integer;
  unexpected_count integer;
  impact_count integer;
  impact_control_count integer;
  impact_counterpart_count integer;
  impact_unexpected_count integer;
begin
  if p_historical_rate is null or p_historical_rate<=0
    or p_currency_id is null then
    raise exception 'La fuente no tiene un snapshot histórico de moneda válido.';
  end if;
  select reversal_row.* into reversal
  from public.pending_invoice_reversal reversal_row
  where reversal_row.reversal_journal_id=p_reversal_journal_id;
  select journal_row.* into reversal_journal
  from public.journal journal_row
  where journal_row.journal_id=p_reversal_journal_id;
  if reversal.reversal_id is null or reversal_journal.journal_id is null then
    raise exception 'No fue posible identificar la reversión creada.';
  end if;
  select transaction_row.* into reversal_transaction
  from public."transaction" transaction_row
  where transaction_row.transaction_id=reversal_journal.transaction_id;
  if reversal_transaction.transaction_id is null
    or reversal_journal.currency_id is distinct from p_currency_id
    or reversal_transaction.currency_id is distinct from p_currency_id
    or reversal_journal.exchange_rate is null
    or reversal_transaction.exchange_rate is null
    or abs(reversal_journal.exchange_rate-p_historical_rate)>.0000000001
    or abs(reversal_transaction.exchange_rate-p_historical_rate)>.0000000001 then
    raise exception 'El encabezado de la reversión no conserva la moneda y tasa históricas.';
  end if;
  -- Revalidate after the delegate wrote the new reversal.  The source helper
  -- applies the strict per-row tolerance and reserves accumulated rounding
  -- only for the last row that closes both balances exactly.
  select * into validated_source
  from public.pending_invoice_reversal_source_fx(
    reversal.source_journal_id,reversal.source_opening_pending_id
  );
  if validated_source.source_historical_rate is distinct from p_historical_rate
    or validated_source.source_currency_id is distinct from p_currency_id then
    raise exception 'La reversión no reproduce el snapshot histórico de su fuente.';
  end if;
  if not(
      (abs(reversal_journal.total_debit-reversal.reversed_foreign)<=.000001
        and abs(reversal_journal.total_credit-reversal.reversed_foreign)<=.000001)
      or(abs(reversal_journal.total_debit-reversal.reversed_local)<=.000001
        and abs(reversal_journal.total_credit-reversal.reversed_local)<=.000001)
    )or not(
      abs(reversal_transaction.total_amount-reversal.reversed_foreign)<=.000001
      or abs(reversal_transaction.total_amount-reversal.reversed_local)<=.000001
    )then
    raise exception 'El encabezado de la reversión no concilia con su importe local u original.';
  end if;

  expected_control:=case when p_period_type='ANTERIOR'then'113004'else'113003'end;
  expected_counterpart:=case when p_period_type='ANTERIOR'then'413002'else'413001'end;
  select max(account_id)filter(where account_number=expected_control),
    max(account_id)filter(where account_number=expected_counterpart)
  into control_account,counterpart_account
  from public.chart_accounts
  where account_number in(expected_control,expected_counterpart);
  if control_account is null or counterpart_account is null then
    raise exception 'No está configurada la pareja contable de la reversión.';
  end if;

  select count(*)::integer,
    count(*)filter(where account_id=control_account
      and credit=reversal.reversed_foreign and debit=0
      and credit_fx=reversal.reversed_foreign and debit_fx=0
      and historical_exchange_rate=p_historical_rate
      and original_currency_id=p_currency_id)::integer,
    count(*)filter(where account_id=counterpart_account
      and debit=reversal.reversed_foreign and credit=0
      and debit_fx=reversal.reversed_foreign and credit_fx=0
      and historical_exchange_rate=p_historical_rate
      and original_currency_id=p_currency_id)::integer,
    count(*)filter(where not(
      (account_id=control_account
        and credit=reversal.reversed_foreign and debit=0
        and credit_fx=reversal.reversed_foreign and debit_fx=0
        and historical_exchange_rate=p_historical_rate
        and original_currency_id=p_currency_id)
      or(account_id=counterpart_account
        and debit=reversal.reversed_foreign and credit=0
        and debit_fx=reversal.reversed_foreign and credit_fx=0
        and historical_exchange_rate=p_historical_rate
        and original_currency_id=p_currency_id)
    ))::integer
  into line_count,control_count,counterpart_count,unexpected_count
  from public.journal_line where journal_id=p_reversal_journal_id;
  if line_count<>2 or control_count<>1 or counterpart_count<>1
    or unexpected_count<>0 then
    raise exception 'La reversión no conserva exactamente la pareja contable esperada.';
  end if;

  select count(*)::integer,max(accounting_book_id)
  into book_count,book_key
  from public.accounting_books
  where subsidiary_id=reversal_journal.subsidiary_id
    and is_primary and is_active;
  if book_count<>1 then
    raise exception 'Debe existir exactamente un libro principal activo para contabilizar la reversión.';
  end if;

  select count(*)::integer,
    count(*)filter(where accounting_book_id=book_key
      and account_id=control_account and debit_amount=0
      and credit_amount=reversal.reversed_local and debit_fx=0
      and credit_fx=reversal.reversed_foreign
      and original_currency_id=p_currency_id)::integer,
    count(*)filter(where accounting_book_id=book_key
      and account_id=counterpart_account and debit_amount=reversal.reversed_local
      and credit_amount=0 and debit_fx=reversal.reversed_foreign
      and credit_fx=0 and original_currency_id=p_currency_id)::integer,
    count(*)filter(where not(
      (accounting_book_id=book_key and account_id=control_account
        and debit_amount=0 and credit_amount=reversal.reversed_local
        and debit_fx=0 and credit_fx=reversal.reversed_foreign
        and original_currency_id=p_currency_id)
      or(accounting_book_id=book_key and account_id=counterpart_account
        and debit_amount=reversal.reversed_local and credit_amount=0
        and debit_fx=reversal.reversed_foreign and credit_fx=0
        and original_currency_id=p_currency_id)
    ))::integer
  into impact_count,impact_control_count,impact_counterpart_count,
    impact_unexpected_count
  from public.gl_impact
  where transaction_id=reversal_journal.transaction_id;
  if impact_count<>2 or impact_control_count<>1
    or impact_counterpart_count<>1 or impact_unexpected_count<>0 then
    raise exception 'La reversión contiene impactos ajenos o no conserva exactamente el libro principal esperado.';
  end if;

  perform set_config('app.pending_reversal_finalize','1',true);
  update public."transaction"
  set currency_id=p_currency_id,exchange_rate=p_historical_rate,
    total_amount=reversal.reversed_foreign
  where transaction_id=reversal_journal.transaction_id;
  update public.journal
  set currency_id=p_currency_id,exchange_rate=p_historical_rate,
    total_debit=reversal.reversed_foreign,total_credit=reversal.reversed_foreign
  where journal_id=p_reversal_journal_id;
  update public.gl_impact
  set debit_amount=case when account_id=counterpart_account
        then reversal.reversed_local else 0 end,
    credit_amount=case when account_id=control_account
        then reversal.reversed_local else 0 end,
    debit_fx=case when account_id=counterpart_account
        then reversal.reversed_foreign else 0 end,
    credit_fx=case when account_id=control_account
        then reversal.reversed_foreign else 0 end,
    original_currency_id=p_currency_id
  where transaction_id=reversal_journal.transaction_id
    and accounting_book_id=book_key
    and account_id in(control_account,counterpart_account);
  perform set_config('app.pending_reversal_finalize','0',true);
end
$function$;

CREATE OR REPLACE FUNCTION public.reverse_opening_pending_invoice_before_historical_fx_integrity(p_item_id bigint, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  item_row public.opening_pending_invoice_items%rowtype;
  run_key bigint;
  sid bigint;
  current_control bigint;
  prior_control bigint;
  current_counterpart bigint;
  bridge_account bigint;
  source_control bigint;
  source_counterpart bigint;
  temporarily_mapped boolean:=false;
  result jsonb;
  reversal_key bigint;
  reversal_row public.pending_invoice_reversal%rowtype;
  reversal_journal public.journal%rowtype;
  book_key bigint;
  annual_date date;
  requested_reversal_date date;
begin
  if not exists(
    select 1
    from public.user_roles user_role
    join public.role_permissions role_permission using(role_id)
    join public.permissions permission using(permission_id)
    where user_role.user_id=public.app_user_id()
      and permission.code='accounting:journal:reverse'
  )then
    raise exception using errcode='42501',
      message='No tiene permiso para reversar asientos.';
  end if;
  select item.run_id,item.subsidiary_id into run_key,sid
  from public.opening_pending_invoice_items item
  join public.user_subsidiaries access
    on access.subsidiary_id=item.subsidiary_id
    and access.user_id=public.app_user_id()
  where item.id=p_item_id
    and item.subsidiary_id=public.active_subsidiary_id();
  if run_key is null then raise exception 'El pendiente inicial no existe.';end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'pending-invoice-reclassification-subsidiary:'||sid,0
  ));
  perform 1 from public.opening_balance_runs run
  where run.id=run_key and run.subsidiary_id=sid order by run.id for update;
  select * into item_row
  from public.opening_pending_invoice_items item
  where item.id=p_item_id and item.run_id=run_key
    and item.subsidiary_id=sid for update;
  select annual_run.reclassification_date into annual_date
  from public.pending_invoice_reclassification_items reclassified
  join public.pending_invoice_reclassification_runs annual_run
    on annual_run.id=reclassified.run_id
  where reclassified.source_opening_pending_id=p_item_id;
  requested_reversal_date:=nullif(p_payload->>'reversalDate','')::date;
  if annual_date is not null and requested_reversal_date<annual_date then
    raise exception 'La reversión no puede fecharse antes de la reclasificación anual del %.',annual_date;
  end if;

  select max(account_id)filter(where account_number='113003'),
    max(account_id)filter(where account_number='113004'),
    max(account_id)filter(where account_number='413001'),
    max(account_id)filter(where account_number='413002')
  into current_control,prior_control,current_counterpart,bridge_account
  from public.chart_accounts where account_number in('113003','113004','413001','413002');
  select account_id into source_control
  from public.opening_pending_invoice_lines
  where item_id=p_item_id and line_role='CONTROL';
  select account_id into source_counterpart
  from public.opening_pending_invoice_lines
  where item_id=p_item_id and line_role='COUNTERPART';

  if item_row.period_type='ANTERIOR'then
    if source_control=prior_control and source_counterpart=bridge_account then
      update public.opening_pending_invoice_lines
      set account_id=case line_role when'CONTROL'then current_control else current_counterpart end
      where item_id=p_item_id;
      temporarily_mapped:=true;
    elsif source_control<>current_control or source_counterpart<>current_counterpart then
      raise exception 'El pendiente anterior no conserva la composición 113004 / 413002.';
    end if;
  end if;

  perform set_config('app.pending_reversal_insert','1',true);
  perform set_config('app.pending_reversal_finalize','1',true);
  result:=public.reverse_opening_pending_invoice_before_period_type(p_item_id,p_payload);
  perform set_config('app.pending_reversal_insert','0',true);
  reversal_key:=(result->>'journalId')::bigint;

  if temporarily_mapped then
    update public.opening_pending_invoice_lines
    set account_id=case line_role when'CONTROL'then prior_control else bridge_account end
    where item_id=p_item_id;
  end if;

  select * into reversal_row from public.pending_invoice_reversal
  where reversal_journal_id=reversal_key;
  select * into reversal_journal from public.journal
  where journal_id=reversal_key;
  if reversal_row.reversal_id is null or reversal_journal.journal_id is null then
    raise exception 'No fue posible identificar la reversión creada.';
  end if;

  -- The legacy opening routine receives a local-currency amount.  Normalize
  -- the journal presentation back to transaction currency while retaining the
  -- exact frozen local amount in the primary-book impact.
  perform set_config('app.pending_reversal_finalize','1',true);
  update public.journal_line
  set account_id=case
      when item_row.period_type='ANTERIOR'and account_id=current_control then prior_control
      when item_row.period_type='ANTERIOR'and account_id=current_counterpart then bridge_account
      else account_id end,
    debit=case when debit>0 then reversal_row.reversed_foreign else 0 end,
    credit=case when credit>0 then reversal_row.reversed_foreign else 0 end,
    debit_fx=case when debit>0 then reversal_row.reversed_foreign else 0 end,
    credit_fx=case when credit>0 then reversal_row.reversed_foreign else 0 end
  where journal_id=reversal_key;
  update public.journal
  set total_debit=reversal_row.reversed_foreign,
    total_credit=reversal_row.reversed_foreign
  where journal_id=reversal_key;

  select accounting_book_id into book_key
  from public.accounting_books
  where subsidiary_id=item_row.subsidiary_id and is_primary and is_active
  order by accounting_book_id limit 1;
  if book_key is null then raise exception 'Configure un libro contable principal activo.';end if;
  delete from public.gl_impact
  where transaction_id=reversal_journal.transaction_id;
  insert into public.gl_impact(
    transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,
    debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id
  )values
  (reversal_journal.transaction_id,
    case when item_row.period_type='ANTERIOR'then bridge_account else current_counterpart end,
    item_row.subsidiary_id,reversal_journal.fiscal_period_id,book_key,
    reversal_row.reversed_local,0,reversal_row.reversed_foreign,0,
    reversal_row.reversal_date,item_row.currency_id),
  (reversal_journal.transaction_id,
    case when item_row.period_type='ANTERIOR'then prior_control else current_control end,
    item_row.subsidiary_id,reversal_journal.fiscal_period_id,book_key,
    0,reversal_row.reversed_local,0,reversal_row.reversed_foreign,
    reversal_row.reversal_date,item_row.currency_id);
  perform set_config('app.pending_reversal_finalize','0',true);
  return result||jsonb_build_object('periodType',item_row.period_type);
end
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_reversal_options_before_historical_fx_integrity(p_journal_id bigint, p_reversal_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;period_value text;origin_key bigint;annual_date date;
begin
  if(p_journal_id<0 and not exists(
      select 1
      from public.opening_pending_invoice_items item
      join public.user_subsidiaries access
        on access.subsidiary_id=item.subsidiary_id
        and access.user_id=public.app_user_id()
      where item.id=-p_journal_id
        and item.subsidiary_id=public.active_subsidiary_id()
    ))or(p_journal_id>=0 and not exists(
      select 1
      from public.journal source
      join public.user_subsidiaries access
        on access.subsidiary_id=source.subsidiary_id
        and access.user_id=public.app_user_id()
      where source.journal_id=p_journal_id
        and source.subsidiary_id=public.active_subsidiary_id()
    ))then
    raise exception using errcode='42501',
      message='El pendiente no pertenece a la subsidiaria activa o autorizada.';
  end if;
  -- The established routine checks subsidiary access before this SECURITY
  -- DEFINER wrapper reads the annual classification metadata.
  result:=public.pending_invoice_reversal_options_before_period_type(
    p_journal_id,p_reversal_date
  );
  if p_journal_id<0 then
    select annual_run.reclassification_date into annual_date
    from public.pending_invoice_reclassification_items reclassified
    join public.pending_invoice_reclassification_runs annual_run
      on annual_run.id=reclassified.run_id
    where reclassified.source_opening_pending_id=-p_journal_id;
  else
    select annual_run.reclassification_date into annual_date
    from public.pending_invoice_reclassification_items reclassified
    join public.pending_invoice_reclassification_runs annual_run
      on annual_run.id=reclassified.run_id
    where reclassified.source_journal_id=p_journal_id;
  end if;
  if annual_date is not null and p_reversal_date<annual_date then
    raise exception 'La reversión no puede fecharse antes de la reclasificación anual del %.',annual_date;
  end if;
  if p_journal_id<0 then
    select item.period_type,coalesce(item.origin_journal_id,run.journal_id)
    into period_value,origin_key
    from public.opening_pending_invoice_items item
    join public.opening_balance_runs run on run.id=item.run_id
    where item.id=-p_journal_id;
  else
    select coalesce(pending_period_type,'ACTUAL'),
      coalesce(pending_origin_journal_id,journal_id)
    into period_value,origin_key
    from public.journal where journal_id=p_journal_id;
  end if;
  return jsonb_set(result,'{journal}',coalesce(result->'journal','{}'::jsonb)
    ||jsonb_build_object('periodType',coalesce(period_value,'ACTUAL'),
      'originJournalId',origin_key),true);
end
$function$;

CREATE OR REPLACE FUNCTION public.run_pending_invoice_control_report_before_consolidation(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sids bigint[];
  df date;
  dt date;
  customer_key bigint;
  state text;
  period_filter text;
  result jsonb;
begin
  select coalesce(array_agg(value::bigint),array[]::bigint[])into sids
  from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'));
  if cardinality(sids)=0 then sids:=array[public.active_subsidiary_id()];end if;
  if exists(select 1 from unnest(sids)x where not exists(
    select 1 from public.user_subsidiaries access
    where access.user_id=public.app_user_id()and access.subsidiary_id=x
  ))then raise exception 'No tiene acceso a la subsidiaria.';end if;
  df:=coalesce(nullif(p_filters->>'dateFrom','')::date,'1900-01-01');
  dt:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
  customer_key:=nullif(p_filters->>'pendingCustomerId','')::bigint;
  state:=nullif(p_filters->>'pendingStatus','');
  period_filter:=upper(coalesce(nullif(p_filters->>'periodType',''),
    nullif(p_filters->>'pendingPeriodType','')));
  if period_filter is not null and period_filter not in('ACTUAL','ANTERIOR')then
    raise exception 'El filtro de tipo de período no es válido.';
  end if;

  with base as(
    select 'JOURNAL'::text source_type,j.journal_id source_id,j.journal_id,
      j.journal_number,j.journal_date date,coalesce(customer.customer_id,0)customer_id,
      coalesce(customer.company_name,'Sin tercero asignado')customer,j.currency_id,
      j.pending_initial_local initial,j.pending_reversed_local reversed,
      j.pending_balance_local balance,j.reversal_status status,false opening_balance,
      coalesce(j.pending_period_type,'ACTUAL')period_type,
      coalesce(j.pending_origin_journal_id,j.journal_id)origin_journal_id,
      detail.reclassification_journal_id
    from public.journal j
    left join lateral(
      select line.customer_id,entity.company_name
      from public.journal_line line
      join public.customers entity using(customer_id)
      where line.journal_id=j.journal_id limit 1
    )customer on true
    left join public.pending_invoice_reclassification_items detail
      on detail.source_journal_id=j.journal_id
    where j.subsidiary_id=any(sids)and j.journal_date between df and dt
      and(j.journal_number like'ASI_PEN-%'or j.journal_type='Asientos Pendientes de Facturar')
      and(customer_key is null or customer.customer_id=customer_key)
      and(state is null or j.reversal_status=state)
      and(period_filter is null or coalesce(j.pending_period_type,'ACTUAL')=period_filter)
    union all
    select 'OPENING'::text,item.id,-item.id,item.reference,item.origin_date,
      item.customer_id,customer.company_name,item.currency_id,item.initial_local,
      item.reversed_local,item.balance_local,item.reversal_status,true,
      item.period_type,coalesce(item.origin_journal_id,run.journal_id),
      detail.reclassification_journal_id
    from public.opening_pending_invoice_items item
    join public.customers customer using(customer_id)
    join public.opening_balance_runs run on run.id=item.run_id
    left join public.pending_invoice_reclassification_items detail
      on detail.source_opening_pending_id=item.id
    where item.subsidiary_id=any(sids)and item.is_active
      and item.opening_reversed_at is null and run.status='POSTED'
      and item.origin_date between df and dt
      and(customer_key is null or item.customer_id=customer_key)
      and(state is null or item.reversal_status=state)
      and(period_filter is null or item.period_type=period_filter)
  ),decorated as(
    select b.*,case when b.source_type='JOURNAL'then(
      select coalesce(jsonb_agg(jsonb_build_object(
        'journalId',reversal.reversal_journal_id,'number',journal.journal_number,
        'date',reversal.reversal_date,'amount',reversal.reversed_local,
        'type',reversal.reversal_type,
        'reference',coalesce(invoice.invoice_number,reversal.error_description),
        'user',coalesce(user_row.first_name||' '||user_row.last_name,user_row.email)
      )order by reversal.reversal_date,reversal.reversal_id),'[]'::jsonb)
      from public.pending_invoice_reversal reversal
      join public.journal journal on journal.journal_id=reversal.reversal_journal_id
      left join public.invoice invoice on invoice.invoice_id=reversal.sales_invoice_id
      left join public.users user_row on user_row.user_id=reversal.created_by
      where reversal.source_journal_id=b.source_id
    )else(
      select coalesce(jsonb_agg(jsonb_build_object(
        'journalId',reversal.reversal_journal_id,'number',journal.journal_number,
        'date',reversal.reversal_date,'amount',reversal.reversed_local,
        'type',reversal.reversal_type,
        'reference',coalesce(invoice.invoice_number,reversal.error_description),
        'user',coalesce(user_row.first_name||' '||user_row.last_name,user_row.email)
      )order by reversal.reversal_date,reversal.reversal_id),'[]'::jsonb)
      from public.pending_invoice_reversal reversal
      join public.journal journal on journal.journal_id=reversal.reversal_journal_id
      left join public.invoice invoice on invoice.invoice_id=reversal.sales_invoice_id
      left join public.users user_row on user_row.user_id=reversal.created_by
      where reversal.source_opening_pending_id=b.source_id
    )end reversals
    from base b
  )
  select jsonb_build_object(
    'rows',coalesce(jsonb_agg(jsonb_build_object(
      'journal_id',b.journal_id,'source_id',b.source_id,
      'source_type',b.source_type,'opening_balance',b.opening_balance,
      'journal_number',b.journal_number,'date',b.date,
      'customer_id',b.customer_id,'customer',b.customer,'currency_id',b.currency_id,
      'initial',b.initial,'reversed',b.reversed,'balance',b.balance,'status',b.status,
      'period_type',b.period_type,'periodType',b.period_type,
      'origin_journal_id',b.origin_journal_id,'originJournalId',b.origin_journal_id,
      'reclassificationJournalId',b.reclassification_journal_id,
      'support_url',(select item.support_url
        from public.opening_pending_invoice_items item
        where b.source_type='OPENING'and item.id=b.source_id),
      'reversals',b.reversals
    )order by b.date,b.source_type,b.source_id),'[]'::jsonb),
    'total',count(*),
    'summary',jsonb_build_object(
      'initial',coalesce(sum(b.initial),0),'reversed',coalesce(sum(b.reversed),0),
      'balance',coalesce(sum(b.balance),0),
      'currentBalance',coalesce(sum(b.balance)filter(where b.period_type='ACTUAL'),0),
      'previousBalance',coalesce(sum(b.balance)filter(where b.period_type='ANTERIOR'),0),
      'priorBalance',coalesce(sum(b.balance)filter(where b.period_type='ANTERIOR'),0),
      'currentCount',count(*)filter(where b.period_type='ACTUAL'),
      'previousCount',count(*)filter(where b.period_type='ANTERIOR')
    )
  )into result from decorated b;
  return result;
end
$function$;

CREATE OR REPLACE FUNCTION public.save_pending_reversal_supports(p_journal_id bigint, p_supports jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  support jsonb;
begin
  if jsonb_array_length(p_supports)=0 then
    return;
  end if;
  if exists(
    select 1 from public.journal_support where journal_id=p_journal_id
  ) then
    raise exception
      'La reversión delegada guardó respaldos inesperados; se canceló para evitar duplicados.';
  end if;

  for support in select value from jsonb_array_elements(p_supports) loop
    if support->>'support_type'='Enlace' then
      insert into public.journal_support(
        journal_id,support_type,display_name,support_url
      ) values(
        p_journal_id,'Enlace',support->>'display_name',support->>'support_url'
      );
    else
      insert into public.journal_support(
        journal_id,support_type,display_name,file_name,mime_type,file_size,file_data
      ) values(
        p_journal_id,'Archivo',support->>'display_name',support->>'file_name',
        coalesce(nullif(support->>'mime_type',''),'application/octet-stream'),
        (support->>'file_size')::bigint,support->>'file_data'
      );
    end if;
  end loop;
end
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_billing_limit_snapshot(p_source_journal_id bigint, p_source_opening_pending_id bigint, p_invoice_id bigint, p_exclude_reversal_id bigint DEFAULT NULL::bigint)
 RETURNS TABLE(source_currency_id bigint, source_historical_rate numeric, source_initial_local numeric, source_initial_foreign numeric, source_balance_local numeric, source_balance_foreign numeric, source_customer_id bigint, source_subsidiary_id bigint, invoice_currency_id bigint, invoice_historical_rate numeric, invoice_customer_id bigint, invoice_subsidiary_id bigint, invoice_date date, subtotal_invoice numeric, applied_invoice numeric, available_invoice numeric, local_per_invoice_unit numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  source_currency bigint;
  source_rate numeric(24,10);
  initial_local numeric(24,6);
  initial_foreign numeric(24,6);
  balance_local numeric(24,6);
  balance_foreign numeric(24,6);
  source_customer bigint;
  source_subsidiary bigint;
  invoice_currency bigint;
  invoice_rate numeric(24,10);
  invoice_customer bigint;
  invoice_subsidiary bigint;
  invoice_day date;
  invoice_total numeric(24,6);
  invoice_subtotal numeric(24,6);
  invoice_applied numeric(24,6);
  invalid_applied_source boolean;
  local_factor numeric(30,15);
begin
  if(p_source_journal_id is null)=(p_source_opening_pending_id is null)then
    raise exception 'La reversión debe tener un único origen.';
  end if;
  if p_source_journal_id is not null then
    select source.currency_id,source.exchange_rate,
      source.pending_initial_local,source.pending_initial_foreign,
      source.pending_balance_local,source.pending_balance_foreign,
      source.subsidiary_id,customer.customer_id
    into source_currency,source_rate,initial_local,initial_foreign,
      balance_local,balance_foreign,source_subsidiary,source_customer
    from public.journal source
    left join lateral(
      select line.customer_id
      from public.journal_line line
      where line.journal_id=source.journal_id and line.customer_id is not null
      order by line.journal_line_id limit 1
    )customer on true
    where source.journal_id=p_source_journal_id;
  else
    select item.currency_id,item.historical_exchange_rate,
      item.initial_local,item.initial_foreign,item.balance_local,
      item.balance_foreign,item.subsidiary_id,item.customer_id
    into source_currency,source_rate,initial_local,initial_foreign,
      balance_local,balance_foreign,source_subsidiary,source_customer
    from public.opening_pending_invoice_items item
    where item.id=p_source_opening_pending_id;
  end if;
  if source_currency is null or source_rate is null or source_rate<=0
    or initial_local is null or initial_local<=0
    or initial_foreign is null or initial_foreign<=0
    or balance_local is null or balance_foreign is null
    or source_customer is null or source_subsidiary is null then
    raise exception 'El pendiente no conserva un snapshot histórico válido para vincular la factura.';
  end if;

  select coalesce(invoice.currency_id,invoice_transaction.currency_id),
    coalesce(nullif(invoice.exchange_rate,0),
      nullif(invoice_transaction.exchange_rate,0)),
    invoice.customer_id,invoice.subsidiary_id,invoice.invoice_date,
    invoice.total_amount
  into invoice_currency,invoice_rate,invoice_customer,invoice_subsidiary,
    invoice_day,invoice_total
  from public.invoice invoice
  left join public."transaction" invoice_transaction
    on invoice_transaction.transaction_id=invoice.transaction_id
  where invoice.invoice_id=p_invoice_id;
  if invoice_currency is null or invoice_rate is null or invoice_rate<=0
    or invoice_customer is null or invoice_subsidiary is null
    or invoice_day is null then
    raise exception 'La factura no conserva una moneda y tasa histórica válidas.';
  end if;
  select round(coalesce(sum(line.amount),greatest(invoice_total-coalesce(
      sum(line.tax_amount),0),0)),6)
  into invoice_subtotal
  from public.sales_invoice_line line
  where line.invoice_id=p_invoice_id;
  if invoice_subtotal is null or invoice_subtotal<0 then
    raise exception 'No fue posible determinar el subtotal histórico de la factura.';
  end if;

  select round(coalesce(sum(case
      when coalesce(regular.currency_id,opening.currency_id)=invoice_currency
        then reversal.reversed_foreign
      else reversal.reversed_local/invoice_rate end),0),6),
    coalesce(bool_or(coalesce(regular.currency_id,opening.currency_id)is null),false)
  into invoice_applied,invalid_applied_source
  from public.pending_invoice_reversal reversal
  left join public.journal regular
    on regular.journal_id=reversal.source_journal_id
  left join public.opening_pending_invoice_items opening
    on opening.id=reversal.source_opening_pending_id
  where reversal.sales_invoice_id=p_invoice_id
    and reversal.reversal_type='FACTURACION'
    and reversal.reversal_id<>coalesce(p_exclude_reversal_id,-1);
  if invalid_applied_source then
    raise exception 'Una reversión previa de la factura no conserva su moneda histórica.';
  end if;
  local_factor:=case when source_currency=invoice_currency
    then initial_local/initial_foreign else invoice_rate end;
  if local_factor is null or local_factor<=0 then
    raise exception 'No fue posible convertir el límite de la factura al saldo del pendiente.';
  end if;

  return query select source_currency,source_rate,initial_local,
    initial_foreign,balance_local,balance_foreign,source_customer,
    source_subsidiary,invoice_currency,invoice_rate,invoice_customer,
    invoice_subsidiary,invoice_day,invoice_subtotal,invoice_applied,
    greatest(invoice_subtotal-invoice_applied,0),local_factor;
end
$function$;

CREATE OR REPLACE FUNCTION public.pending_invoice_validate_billing_limit(p_source_journal_id bigint, p_source_opening_pending_id bigint, p_invoice_id bigint, p_reversal_date date, p_reversed_local numeric, p_reversed_foreign numeric DEFAULT NULL::numeric, p_exclude_reversal_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  limit_snapshot record;
  requested_invoice numeric(24,6);
begin
  if p_invoice_id is null then
    raise exception 'Seleccione una factura de venta para realizar la reversión.';
  end if;
  perform 1 from public.invoice where invoice_id=p_invoice_id for update;
  if not found then raise exception 'La factura seleccionada no existe.';end if;
  select * into limit_snapshot
  from public.pending_invoice_billing_limit_snapshot(
    p_source_journal_id,p_source_opening_pending_id,p_invoice_id,
    p_exclude_reversal_id
  );
  if limit_snapshot.source_customer_id<>limit_snapshot.invoice_customer_id
    or limit_snapshot.source_subsidiary_id<>limit_snapshot.invoice_subsidiary_id
    or p_reversal_date is null
    or date_trunc('month',limit_snapshot.invoice_date)
      <>date_trunc('month',p_reversal_date)then
    raise exception 'La factura vinculada debe pertenecer al cliente, subsidiaria y mes de la reversión.';
  end if;
  if p_reversed_local is null or p_reversed_local<=0 then
    raise exception 'Indique un monto de reversión válido.';
  end if;
  if p_exclude_reversal_id is null
    and p_reversed_local>limit_snapshot.source_balance_local+.000001 then
    raise exception 'El monto a reversar (%) supera el saldo disponible (%).',
      p_reversed_local,limit_snapshot.source_balance_local;
  end if;
  requested_invoice:=case
    when limit_snapshot.source_currency_id=limit_snapshot.invoice_currency_id
      and p_reversed_foreign is not null then p_reversed_foreign
    when limit_snapshot.source_currency_id=limit_snapshot.invoice_currency_id
      and p_exclude_reversal_id is null
      and p_reversed_local>=limit_snapshot.source_balance_local-.000001
      and p_reversed_local<=limit_snapshot.source_balance_local+.000001
      then limit_snapshot.source_balance_foreign
    when limit_snapshot.source_currency_id=limit_snapshot.invoice_currency_id
      then round(limit_snapshot.source_initial_foreign
        *(p_reversed_local/limit_snapshot.source_initial_local),6)
    else round(p_reversed_local/limit_snapshot.invoice_historical_rate,6)
  end;
  if requested_invoice>limit_snapshot.subtotal_invoice+.000001 then
    raise exception 'El monto a reversar supera el subtotal de la factura sin impuestos en su moneda histórica (%).',
      to_char(limit_snapshot.subtotal_invoice,'FM999G999G999G990D00');
  end if;
  if requested_invoice>limit_snapshot.available_invoice+.000001 then
    raise exception 'La factura no tiene suficiente subtotal disponible sin impuestos. Disponible en su moneda histórica: %.',
      to_char(limit_snapshot.available_invoice,'FM999G999G999G990D00');
  end if;
  return jsonb_build_object(
    'subtotal',round(limit_snapshot.subtotal_invoice
      *limit_snapshot.local_per_invoice_unit,6),
    'applied',round(limit_snapshot.applied_invoice
      *limit_snapshot.local_per_invoice_unit,6),
    'available',round(limit_snapshot.available_invoice
      *limit_snapshot.local_per_invoice_unit,6),
    'subtotalOriginal',limit_snapshot.subtotal_invoice,
    'appliedOriginal',limit_snapshot.applied_invoice,
    'availableOriginal',limit_snapshot.available_invoice,
    'invoiceCurrencyId',limit_snapshot.invoice_currency_id,
    'invoiceExchangeRate',limit_snapshot.invoice_historical_rate,
    'requestedOriginal',requested_invoice
  );
end
$function$;
