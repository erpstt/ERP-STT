CREATE OR REPLACE FUNCTION public.opening_bank_stage(p_run_id bigint, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
 run_row public.opening_balance_runs%rowtype;item jsonb;account_row record;header_key bigint;
 source_row_value integer;record_type_value text;transaction_date_value date;value_date_value date;
 original_value numeric(24,6);local_value numeric(24,6);matches integer;created_count integer:=0;
 bank_code_value text;account_number_value text;currency_value text;reference_value text;
begin
 if jsonb_typeof(coalesce(p_items,'[]'::jsonb))<>'array'then raise exception 'El Auxiliar de Bancos debe ser una lista válida.';end if;
 select *into run_row from public.opening_balance_runs
  where id=p_run_id and subsidiary_id=public.active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'Lote de apertura no disponible para el Auxiliar de Bancos.';end if;
 if run_row.status not in('VALIDATED','POSTED')then raise exception 'El lote debe estar validado o contabilizado para cargar el Auxiliar de Bancos.';end if;

 -- A new validation replaces only staged data. Active items are immutable and
 -- can coexist with a later file containing other bank accounts.
 delete from public.opening_bank_accounts where run_id=p_run_id and not is_active;

 for item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb))loop
  begin
   source_row_value:=coalesce(nullif(item->>'sourceRow','')::integer,created_count+2);
   record_type_value:=upper(btrim(coalesce(item->>'recordType','')));
   bank_code_value:=btrim(coalesce(item->>'bankCode',''));
   account_number_value:=btrim(coalesce(item->>'accountNumber',''));
   currency_value:=upper(btrim(coalesce(item->>'currency','')));
   transaction_date_value:=coalesce(nullif(item->>'transactionDate','')::date,run_row.opening_date);
   value_date_value:=nullif(item->>'valueDate','')::date;
   original_value:=(item->>'originalAmount')::numeric;
   local_value:=(item->>'localEquivalent')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
   raise exception 'Auxiliar de Bancos fila %: revise fechas e importes.',coalesce(item->>'sourceRow','?');
  end;
   if original_value is null or local_value is null then
    raise exception 'Auxiliar de Bancos fila %: complete el importe original y su equivalente local.',source_row_value;
   end if;
  if source_row_value<=1 then raise exception 'Auxiliar de Bancos: la fila de origen debe ser mayor que 1.';end if;
  if bank_code_value=''or account_number_value=''or currency_value=''then
   raise exception 'Auxiliar de Bancos fila %: complete banco, cuenta bancaria y moneda.',source_row_value;
  end if;
  if record_type_value not in('SALDO_CONCILIADO','DEPOSITO_EN_TRANSITO','CHEQUE_EN_TRANSITO')then
   raise exception 'Auxiliar de Bancos fila %: tipo de registro no válido.',source_row_value;
  end if;
  if transaction_date_value>run_row.opening_date or value_date_value>run_row.opening_date then
   raise exception 'Auxiliar de Bancos fila %: las fechas no pueden ser posteriores a la fecha de apertura.',source_row_value;
  end if;
   if record_type_value='SALDO_CONCILIADO'then
    if(original_value=0)<>(local_value=0)or(original_value<>0 and original_value*local_value<=0)then
     raise exception 'Auxiliar de Bancos fila %: el saldo original y su equivalente local deben ser ambos cero o conservar el mismo signo.',source_row_value;
    end if;
   elsif record_type_value='DEPOSITO_EN_TRANSITO'and(original_value<=0 or local_value<=0)then
    raise exception 'Auxiliar de Bancos fila %: el depósito en tránsito debe recibirse con signo positivo.',source_row_value;
   elsif record_type_value='CHEQUE_EN_TRANSITO'and(original_value>=0 or local_value>=0)then
    raise exception 'Auxiliar de Bancos fila %: el cheque en tránsito debe recibirse con signo negativo.',source_row_value;
   end if;
  reference_value:=nullif(btrim(item->>'reference'),'');
  if record_type_value<>'SALDO_CONCILIADO'and reference_value is null then
   raise exception 'Auxiliar de Bancos fila %: indique la referencia de la partida en tránsito.',source_row_value;
  end if;

  select count(*)into matches from public.bank_account account join public.banks bank using(bank_id)
   where account.subsidiary_id=run_row.subsidiary_id and not coalesce(account.is_credit_card,false)
    and lower(bank.bank_code)=lower(bank_code_value)and btrim(account.account_number)=account_number_value;
  if matches<>1 then
   raise exception 'Auxiliar de Bancos fila %: banco % y cuenta % no existen, no pertenecen a la subsidiaria o son ambiguos.',source_row_value,bank_code_value,account_number_value;
  end if;
  select account.bank_account_id,account.bank_id,account.currency_id,account.account_id ledger_account_id,
   bank.bank_code,bank.bank_name,currency.currency_code,account.account_number
   into account_row
  from public.bank_account account join public.banks bank using(bank_id)join public.currencies currency using(currency_id)
  where account.subsidiary_id=run_row.subsidiary_id and not coalesce(account.is_credit_card,false)
   and lower(bank.bank_code)=lower(bank_code_value)and btrim(account.account_number)=account_number_value;
  if account_row.currency_code<>currency_value then
   raise exception 'Auxiliar de Bancos fila %: la moneda % no coincide con la moneda % de la cuenta bancaria.',source_row_value,currency_value,account_row.currency_code;
  end if;
   if exists(
    select 1 from public.bank_reconciliation reconciliation
    where reconciliation.bank_account_id=account_row.bank_account_id
     and reconciliation.status='CERRADA'and reconciliation.reconciliation_date>=run_row.opening_date
   )then
    raise exception 'Auxiliar de Bancos fila %: la cuenta bancaria tiene una conciliación cerrada posterior a la apertura.',source_row_value;
   end if;
   if exists(
    select 1 from public.quadratic_bank_reconciliations reconciliation
    where reconciliation.bank_account_id=account_row.bank_account_id
     and reconciliation.status in('approved','closed')
     and(make_date(reconciliation.period_year,reconciliation.period_month,1)+interval'1 month'-interval'1 day')::date>=run_row.opening_date
   )then
    raise exception 'Auxiliar de Bancos fila %: la cuenta bancaria tiene una prueba de efectivo aprobada o cerrada posterior a la apertura.',source_row_value;
   end if;
  if not exists(select 1 from public.account_subsidiaries scope join public.chart_accounts chart using(account_id)
   where scope.subsidiary_id=run_row.subsidiary_id and scope.account_id=account_row.ledger_account_id
    and scope.is_active and chart.accepts_entries and not chart.is_inactive)then
   raise exception 'Auxiliar de Bancos fila %: la cuenta contable vinculada al banco no está habilitada para la subsidiaria.',source_row_value;
  end if;
  -- A zero-net bank account may legitimately have no GL row: for example, a
  -- zero cleared balance plus equal deposits and checks in transit. The final
  -- reconciliation validates the complete auxiliary against the ledger and
  -- rejects any non-zero auxiliary total that lacks its corresponding GL sum.

  select id into header_key from public.opening_bank_accounts
   where run_id=run_row.id and bank_account_id=account_row.bank_account_id;
  if header_key is not null and exists(select 1 from public.opening_bank_accounts where id=header_key and is_active)then
   raise exception 'La cuenta bancaria % ya tiene un auxiliar inicial activo.',account_row.account_number;
  end if;
  if header_key is null then
   insert into public.opening_bank_accounts(run_id,subsidiary_id,bank_account_id,bank_id,currency_id,ledger_account_id,created_by,updated_by)
   values(run_row.id,run_row.subsidiary_id,account_row.bank_account_id,account_row.bank_id,account_row.currency_id,account_row.ledger_account_id,public.app_user_id(),public.app_user_id())
   returning id into header_key;
   insert into public.opening_bank_gl_links(opening_bank_account_id,opening_balance_line_id)
   select header_key,line.id from public.opening_balance_lines line
   where line.run_id=run_row.id and line.source_type='GL'and line.account_id=account_row.ledger_account_id and line.currency_id=account_row.currency_id;
  end if;
  insert into public.opening_bank_items(opening_bank_account_id,source_row,record_type,transaction_date,value_date,reference,beneficiary,description,original_amount,local_equivalent,raw_data)
  values(header_key,source_row_value,record_type_value,transaction_date_value,value_date_value,reference_value,nullif(btrim(item->>'beneficiary'),''),nullif(btrim(item->>'description'),''),original_value,local_value,item);
  created_count:=created_count+1;
 end loop;

 if exists(select 1 from public.opening_bank_accounts account where account.run_id=run_row.id and not account.is_active
  and(select count(*)from public.opening_bank_items item where item.opening_bank_account_id=account.id and item.record_type='SALDO_CONCILIADO')<>1)then
  raise exception 'Cada cuenta del Auxiliar de Bancos debe incluir exactamente un registro SALDO_CONCILIADO.';
 end if;
 perform public.opening_bank_assert_reconciled(run_row.id);
 return created_count;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_options_before_opening_bank()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base jsonb;sid bigint:=active_subsidiary_id();
begin
 base:=opening_balance_options_before_opening_pending();
 return base||jsonb_build_object(
  'pendingAccounts',jsonb_build_object(
   'control',(select jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)from chart_accounts a join account_subsidiaries s using(account_id)where a.account_number='113003'and s.subsidiary_id=sid and s.is_active limit 1),
   'counterpart',(select jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)from chart_accounts a join account_subsidiaries s using(account_id)where a.account_number='413001'and s.subsidiary_id=sid and s.is_active limit 1)
  ),
  'countries',coalesce((select jsonb_agg(jsonb_build_object('id',country_id,'name',name,'iso2',country_code_iso2,'iso3',country_code_iso3)order by name)from countries),'[]'::jsonb)
 );
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_post_before_opening_pending(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare run_row opening_balance_runs%rowtype;line opening_balance_lines%rowtype;period_key bigint;base_currency bigint;book_key bigint;journal_key bigint;journal_transaction_key bigint;journal_number_value text;difference_value numeric;customer_key bigint;supplier_key bigint;sid bigint;assets_created integer:=0;reconciliation jsonb;
begin
 sid:=opening_balance_assert_access('create');
 perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
 select * into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=sid for update;
 if run_row.id is null then raise exception 'Lote no disponible.';end if;
 if(select count(*)from accounting_books where subsidiary_id=run_row.subsidiary_id and is_primary and is_active)<>1 then raise exception 'Configure un único libro contable principal activo antes de contabilizar la apertura.';end if;
 reconciliation:=opening_fixed_asset_reconciliation(run_row.id);
 if exists(select 1 from jsonb_array_elements(reconciliation)x where abs((x->>'difference')::numeric)>.005)then raise exception 'El auxiliar de activos fijos no coincide con el Libro Mayor. Corrija la conciliación antes de continuar.';end if;
 if run_row.status='POSTED'then
  if not exists(select 1 from opening_fixed_asset_lines where run_id=run_row.id and created_asset_id is null)then raise exception 'No hay fichas de activos pendientes de cargar.';end if;
  select fiscal_period_id into period_key from journal where journal_id=run_row.journal_id;
  perform set_config('app.opening_balance_internal','1',true);assets_created:=opening_fixed_asset_create(run_row.id,period_key);perform set_config('app.opening_balance_internal','',true);
  return jsonb_build_object('runId',run_row.id,'journalId',run_row.journal_id,'journalNumber',(select journal_number from journal where journal_id=run_row.journal_id),'assetsOnly',true,'assetsCreated',assets_created);
 end if;
 if run_row.status<>'VALIDATED'then raise exception 'Valide nuevamente el lote antes de contabilizar.';end if;
 if exists(
  select 1
  from opening_balance_lines l
  left join departments d on d.department_id=l.department_id
  left join cost_centers cc on cc.cost_center_id=l.cost_center_id
  left join customers center_owner on center_owner.customer_id=cc.customer_id
  left join classes cl on cl.class_id=l.class_id
  left join financial_creditors fc on fc.financial_creditor_id=l.financial_creditor_id
  left join related_companies rc on rc.related_company_id=l.related_company_id
  left join locations lo on lo.location_id=l.location_id
  where l.run_id=run_row.id and(
   l.department_id is not null and(d.department_id is null or d.is_inactive or not(d.subsidiary_id=run_row.subsidiary_id or exists(select 1 from department_subsidiaries x where x.department_id=d.department_id and x.subsidiary_id=run_row.subsidiary_id)))
   or l.cost_center_id is not null and(cc.cost_center_id is null or cc.is_inactive or cc.subsidiary_id<>run_row.subsidiary_id)
   or l.class_id is not null and(cl.class_id is null or cl.is_inactive or not(cl.subsidiary_id=run_row.subsidiary_id or exists(select 1 from class_subsidiaries x where x.class_id=cl.class_id and x.subsidiary_id=run_row.subsidiary_id)))
   or l.financial_creditor_id is not null and(fc.financial_creditor_id is null or fc.is_inactive or not(fc.subsidiary_id=run_row.subsidiary_id or exists(select 1 from financial_creditor_subsidiaries x where x.financial_creditor_id=fc.financial_creditor_id and x.subsidiary_id=run_row.subsidiary_id)))
   or l.related_company_id is not null and(rc.related_company_id is null or rc.is_inactive or not(rc.subsidiary_id=run_row.subsidiary_id or exists(select 1 from related_company_subsidiaries x where x.related_company_id=rc.related_company_id and x.subsidiary_id=run_row.subsidiary_id)))
   or l.location_id is not null and(lo.location_id is null or not(lo.subsidiary_id=run_row.subsidiary_id or exists(select 1 from location_subsidiaries x where x.location_id=lo.location_id and x.subsidiary_id=run_row.subsidiary_id)))
   or l.cost_center_id is null and l.class_id is not null
   or l.cost_center_id is not null and l.class_id is distinct from cc.class_id
   or l.cost_center_id is not null and cc.cost_center_type='CLIENTE'and l.department_id is distinct from center_owner.department_id
   or l.source_type='AR'and exists(
    select 1 from customers customer
    where customer.tax_id=l.raw_data->>'entityTaxId'
     and(customer.primary_subsidiary_id=run_row.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.customer_id=customer.customer_id and e.subsidiary_id=run_row.subsidiary_id))
     and(
      exists(select 1 from departments customer_department left join department_subsidiaries ds using(department_id)
       where customer_department.department_id=customer.department_id and not customer_department.is_inactive
        and(customer_department.subsidiary_id=run_row.subsidiary_id or ds.subsidiary_id=run_row.subsidiary_id))
       and l.department_id is distinct from customer.department_id
      or cc.customer_id is not null and cc.customer_id is distinct from customer.customer_id
     )
   )
  )
 )then raise exception 'Las dimensiones cambiaron desde la validación. Valide nuevamente el lote antes de contabilizar.';end if;
 if exists(
  select 1 from fx_revaluation_runs x
  where x.subsidiary_id=run_row.subsidiary_id and x.status='CONTABILIZADO'and x.closing_date>=run_row.opening_date
   and exists(select 1 from opening_balance_lines l where l.run_id=run_row.id and l.currency_id=x.currency_id)
 )then
  raise exception 'No se puede contabilizar la apertura: existen revaluaciones de moneda contabilizadas desde la fecha de apertura. Anule primero esas revaluaciones.';
 end if;
 select coalesce(sum(local_debit-local_credit),0)into difference_value from opening_balance_lines where run_id=run_row.id;
 if abs(difference_value)>.005 then raise exception 'La apertura no cuadra. Diferencia: %.',difference_value;end if;
 select fiscal_period_id into period_key from fiscal_periods where subsidiary_id=run_row.subsidiary_id and run_row.opening_date between start_date and end_date and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)limit 1;
 if period_key is null then raise exception 'No existe un período contable abierto para la fecha de apertura.';end if;
 select currency_id into base_currency from subsidiaries where subsidiary_id=run_row.subsidiary_id;
 select accounting_book_id into book_key from accounting_books where subsidiary_id=run_row.subsidiary_id and is_primary and is_active;
 journal_number_value:='ASI-APERTURA-'||run_row.subsidiary_id||'-'||to_char(run_row.opening_date,'YYYYMMDD');
 if exists(select 1 from journal where journal_number=journal_number_value)then journal_number_value:=journal_number_value||'-'||run_row.id;end if;
 perform set_config('app.asset_proposal_internal','1',true);perform set_config('app.opening_balance_internal','1',true);
 insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by,is_opening_balance,asset_proposal_internal)
 select journal_number_value,run_row.opening_date,run_row.subsidiary_id,base_currency,period_key,1,'Carga de saldos iniciales','APERTURA',coalesce(sum(local_debit),0),coalesce(sum(local_credit),0),'CONTABILIZADO',app_user_id(),true,true from opening_balance_lines where run_id=run_row.id returning journal_id,transaction_id into journal_key,journal_transaction_key;
 for line in select * from opening_balance_lines where run_id=run_row.id order by id loop
  customer_key:=null;supplier_key:=null;
  if line.source_type='AR'then
   select customer_id into customer_key from customers c where c.tax_id=line.raw_data->>'entityTaxId'and(c.primary_subsidiary_id=run_row.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=run_row.subsidiary_id))limit 1;
   if customer_key is null then raise exception 'Fila % CxC: cliente no encontrado.',line.row_number;end if;
   if line.document_number is null or line.issue_date is null or line.due_date is null then raise exception 'Fila % CxC: complete documento, emisión y vencimiento.',line.row_number;end if;
   if exists(select 1 from invoice where invoice_number=line.document_number and customer_id=customer_key)then raise exception 'La factura CxC % ya existe.',line.document_number;end if;
    insert into invoice(invoice_number,customer_id,subsidiary_id,due_date,total_amount,invoice_date,fiscal_period_id,currency_id,exchange_rate,memo,journal_id,location_id,opening_run_id,opening_balance_line_id,is_opening_balance)
    values(line.document_number,customer_key,run_row.subsidiary_id,line.due_date,line.foreign_amount,line.issue_date,period_key,line.currency_id,line.historical_rate,coalesce(line.note,'Saldo inicial CxC'),journal_key,line.location_id,run_row.id,line.id,true);
  elsif line.source_type='AP'then
   select supplier_id into supplier_key from suppliers s where s.tax_id=line.raw_data->>'entityTaxId'and(s.primary_subsidiary_id=run_row.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=run_row.subsidiary_id))limit 1;
   if supplier_key is null then raise exception 'Fila % CxP: proveedor no encontrado.',line.row_number;end if;
   if line.document_number is null or line.issue_date is null or line.due_date is null then raise exception 'Fila % CxP: complete documento, emisión y vencimiento.',line.row_number;end if;
   if exists(select 1 from supplier_invoice where invoice_number=line.document_number and supplier_id=supplier_key)then raise exception 'La factura CxP % ya existe.',line.document_number;end if;
    insert into supplier_invoice(invoice_number,supplier_id,subsidiary_id,due_date,total_amount,invoice_date,fiscal_period_id,currency_id,exchange_rate,memo,journal_id,location_id,opening_run_id,opening_balance_line_id,is_opening_balance)
    values(line.document_number,supplier_key,run_row.subsidiary_id,line.due_date,line.foreign_amount,line.issue_date,period_key,line.currency_id,line.historical_rate,coalesce(line.note,'Saldo inicial CxP'),journal_key,line.location_id,run_row.id,line.id,true);
  end if;
  insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,cost_center_id,financial_creditor_id,related_company_id,note,entity_type,customer_id,supplier_id,historical_exchange_rate,original_currency_id,opening_balance_line_id)
  values(journal_key,line.account_id,line.local_debit,line.local_credit,case when line.local_debit>0 then line.foreign_amount else 0 end,case when line.local_credit>0 then line.foreign_amount else 0 end,line.department_id,line.class_id,line.location_id,line.cost_center_id,line.financial_creditor_id,line.related_company_id,coalesce(line.note,'Saldo inicial'),case line.source_type when'AR'then'Cliente'when'AP'then'Proveedor'end,customer_key,supplier_key,line.historical_rate,line.currency_id,line.id);
 end loop;
 assets_created:=opening_fixed_asset_create(run_row.id,period_key);
 delete from gl_impact where transaction_id=journal_transaction_key;
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id)
 select j.transaction_id,l.account_id,j.subsidiary_id,j.fiscal_period_id,book_key,l.debit,l.credit,l.debit_fx,l.credit_fx,j.journal_date,l.original_currency_id,l.opening_balance_line_id
 from journal j join journal_line l using(journal_id)where j.journal_id=journal_key;
 if not exists(select 1 from journal j join gl_impact g on g.transaction_id=j.transaction_id join accounting_books b using(accounting_book_id)where j.journal_id=journal_key and b.is_primary and b.is_active)then raise exception 'No fue posible registrar el asiento de apertura en el libro principal activo.';end if;
 update opening_balance_runs set status='POSTED',journal_id=journal_key,posted_at=now()where id=run_row.id;
 perform set_config('app.asset_proposal_internal','',true);perform set_config('app.opening_balance_internal','',true);
 return jsonb_build_object('runId',run_row.id,'journalId',journal_key,'journalNumber',journal_number_value,'assetsOnly',false,'assetsCreated',assets_created);
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_preview_before_opening_bank(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base jsonb;reconciliation jsonb;
begin
 base:=opening_balance_preview_before_opening_pending(p_run_id);
 if base is null then return null;end if;
 reconciliation:=opening_pending_invoice_reconciliation(p_run_id);
 return base||jsonb_build_object(
  'pendingItems',coalesce((select jsonb_agg(jsonb_build_object(
   'id',i.id,'pendingId',i.id,'reference',i.reference,'originDate',i.origin_date,'customerId',i.customer_id,'customer',c.company_name,
   'customerName',c.company_name,'entityTaxId',c.tax_id,'customerIdentification',c.tax_id,
   'currencyId',i.currency_id,'currency',cu.currency_code,'exchangeRate',i.historical_exchange_rate,'rate',i.historical_exchange_rate,'serviceMonth',i.service_month,
   'serviceCountryId',i.service_country_id,'serviceCountry',country.name,'initialLocal',i.initial_local,'initialForeign',i.initial_foreign,
   'initial',i.initial_local,'reversedLocal',i.reversed_local,'reversedForeign',i.reversed_foreign,'reversed',i.reversed_local,
   'balanceLocal',i.balance_local,'balanceForeign',i.balance_foreign,'balance',i.balance_local,
   'status',i.reversal_status,'active',i.is_active,'created',i.is_active,'supportUrl',i.support_url,'note',i.note,'errors','[]'::jsonb,
   'lines',coalesce((select jsonb_agg(jsonb_build_object(
    'id',l.id,'row',l.row_number,'role',l.line_role,'account',a.account_number,'accountName',a.account_name,
    'debit',l.local_debit,'credit',l.local_credit,'debitFx',l.foreign_debit,'creditFx',l.foreign_credit,
    'department',d.name,'costCenter',case when cc.cost_center_id is null then null else cc.code||' · '||cc.name end,
    'className',cl.name,'location',lo.name,'financialCreditor',fc.name,'relatedCompany',rc.name,'note',l.note
   )order by l.row_number)from opening_pending_invoice_lines l join chart_accounts a on a.account_id=l.account_id
    left join departments d on d.department_id=l.department_id left join cost_centers cc on cc.cost_center_id=l.cost_center_id left join classes cl on cl.class_id=l.class_id
    left join locations lo on lo.location_id=l.location_id left join financial_creditors fc on fc.financial_creditor_id=l.financial_creditor_id
    left join related_companies rc on rc.related_company_id=l.related_company_id where l.item_id=i.id),'[]'::jsonb),
   'supports',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'type',s.support_type,'name',s.display_name,'url',s.support_url,'fileName',s.file_name,'mimeType',s.mime_type,'fileSize',s.file_size)order by s.id)from opening_pending_invoice_supports s where s.item_id=i.id),'[]'::jsonb)
  )order by i.origin_date,i.id)from opening_pending_invoice_items i join customers c on c.customer_id=i.customer_id join currencies cu on cu.currency_id=i.currency_id
   join countries country on country.country_id=i.service_country_id where i.run_id=p_run_id),'[]'::jsonb),
  'pendingReconciliation',reconciliation,
  'pendingSummary',(select jsonb_build_object(
   'count',count(*),'initial',coalesce(sum(initial_local),0),'reversed',coalesce(sum(reversed_local),0),'balance',coalesce(sum(balance_local),0),
   'pending',count(*)filter(where reversal_status='PENDIENTE'),'pendingCount',count(*)filter(where reversal_status='PENDIENTE'),'partial',count(*)filter(where reversal_status='REVERSADO_PARCIAL'),
   'total',count(*)filter(where reversal_status='REVERSADO_TOTAL'),'active',count(*)filter(where is_active),
   'balanced',coalesce((select bool_and(abs((x->>'difference')::numeric)<=.005 and abs((x->>'foreignDifference')::numeric)<=.005)from jsonb_array_elements(reconciliation)x),true)
  )from opening_pending_invoice_items where run_id=p_run_id)
 );
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_validate_before_opening_bank(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare output jsonb;rid bigint;sid bigint;existing opening_balance_runs%rowtype;pending_payload jsonb:=coalesce(p->'pending',p->'pendingItems');has_pending boolean:=false;
begin
 sid:=opening_balance_assert_access('create');
 if coalesce(p->>'expectedSubsidiaryId','')<>sid::text then raise exception 'La empresa activa cambió desde que abrió la carga. Recargue la pantalla y seleccione nuevamente los archivos.';end if;
 if((p ? 'pending')or(p ? 'pendingItems'))and jsonb_typeof(coalesce(pending_payload,'[]'::jsonb))<>'array'then raise exception 'El auxiliar de pendientes debe ser una lista válida.';end if;
 has_pending:=jsonb_typeof(coalesce(pending_payload,'[]'::jsonb))='array'and jsonb_array_length(coalesce(pending_payload,'[]'::jsonb))>0;
 select * into existing from opening_balance_runs where subsidiary_id=sid and status<>'REVERSED'order by id desc limit 1;
 if existing.status='POSTED'and has_pending and jsonb_array_length(coalesce(pending_payload,'[]'::jsonb))>0
  and jsonb_array_length(coalesce(p->'rows','[]'::jsonb))=0 and jsonb_array_length(coalesce(p->'assets','[]'::jsonb))=0 then
  rid:=existing.id;
 elsif existing.status='POSTED'and has_pending and jsonb_array_length(coalesce(pending_payload,'[]'::jsonb))>0 then
  output:=opening_balance_validate_before_opening_pending(p-'pending'-'pendingItems');
  rid:=(output->'run'->>'id')::bigint;
 else
  output:=opening_balance_validate_before_opening_pending(p-'pending'-'pendingItems');
  rid:=(output->'run'->>'id')::bigint;
 end if;
 if has_pending then perform opening_pending_invoice_stage(rid,coalesce(pending_payload,'[]'::jsonb));end if;
 return opening_balance_preview(rid);
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_post_before_opening_bank(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare run_row opening_balance_runs%rowtype;result jsonb;reconciliation jsonb;has_pending boolean;has_assets boolean;activated_count integer:=0;
begin
 perform opening_balance_assert_access('create');
 select * into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'Lote no disponible.';end if;
 has_pending:=exists(select 1 from opening_pending_invoice_items where run_id=p_run_id and not is_active);
 reconciliation:=opening_pending_invoice_reconciliation(p_run_id);
 if exists(select 1 from jsonb_array_elements(reconciliation)x
  where abs(coalesce((x->>'difference')::numeric,0))>.005 or abs(coalesce((x->>'foreignDifference')::numeric,0))>.005)then
  raise exception 'El auxiliar de pendientes de facturar no coincide con la cuenta 113003 del Libro Mayor. Corrija la conciliación antes de continuar.';
 end if;
 if run_row.status='POSTED'then
  has_assets:=exists(select 1 from opening_fixed_asset_lines where run_id=p_run_id and created_asset_id is null);
  if has_assets then result:=opening_balance_post_before_opening_pending(p_run_id);
  elsif not has_pending then raise exception 'No hay auxiliares pendientes de activar.';
  else result:=jsonb_build_object('runId',run_row.id,'journalId',run_row.journal_id,'journalNumber',(select journal_number from journal where journal_id=run_row.journal_id),'pendingOnly',true);end if;
 else
  result:=opening_balance_post_before_opening_pending(p_run_id);
 end if;
 update opening_pending_invoice_items set is_active=true,activated_at=coalesce(activated_at,now()),updated_at=now(),updated_by=app_user_id()
  where run_id=p_run_id and not is_active;
 get diagnostics activated_count=row_count;
 return result||jsonb_build_object('pendingActivated',activated_count);
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_reverse_before_opening_bank(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;run_row opening_balance_runs%rowtype;sid bigint;
begin
 sid:=opening_balance_assert_access('delete');
 select *into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=sid for update;
 if run_row.id is null or run_row.status<>'POSTED'then raise exception 'Apertura contabilizada no encontrada.';end if;
 if exists(select 1 from pending_invoice_reversal r join opening_pending_invoice_items i on i.id=r.source_opening_pending_id where i.run_id=p_run_id)then
  raise exception 'No se puede reversar la apertura: existen reversiones posteriores aplicadas al auxiliar de pendientes de facturar.';
 end if;
 result:=opening_balance_reverse_before_opening_pending(p_run_id);
 update opening_pending_invoice_items set is_active=false,opening_reversed_at=now(),reversal_status='ANULADO',updated_at=now(),updated_by=app_user_id()
  where run_id=p_run_id;
 return result;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_bank_reconciliation(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with run as(
 select r.* from public.opening_balance_runs r
 where r.id=p_run_id and r.subsidiary_id=public.active_subsidiary_id()
),ledger as(
 select l.account_id,l.currency_id,
  sum(case when l.local_debit>0 then l.foreign_amount else-l.foreign_amount end)original_amount,
  sum(l.local_debit-l.local_credit)local_amount
 from run r join public.opening_balance_lines l on l.run_id=r.id
 where l.source_type='GL'and exists(
  select 1 from public.bank_account bank
  where bank.subsidiary_id=r.subsidiary_id and bank.account_id=l.account_id
 )
 group by l.account_id,l.currency_id
),auxiliary_accounts as(
 select account.ledger_account_id account_id,account.currency_id,
  string_agg(distinct bank.bank_code,', 'order by bank.bank_code)bank_code,
  string_agg(distinct bank.bank_name,', 'order by bank.bank_name)bank_name,
  string_agg(distinct bank_account.account_number,', 'order by bank_account.account_number)account_number,
  sum(item.signed_original_amount)original_amount,
  sum(item.signed_local_equivalent)local_amount
 from run r join public.opening_bank_accounts account on account.run_id=r.id
 join public.opening_bank_items item on item.opening_bank_account_id=account.id
 join public.bank_account bank_account on bank_account.bank_account_id=account.bank_account_id
 join public.banks bank on bank.bank_id=account.bank_id
 where account.opening_reversed_at is null
 group by account.ledger_account_id,account.currency_id
),keys as(
 select account_id,currency_id from ledger
 union select account_id,currency_id from auxiliary_accounts
),rows as(
 select key.account_id,key.currency_id,
  coalesce(auxiliary.bank_code,catalog.bank_code)bank_code,
  coalesce(auxiliary.bank_name,catalog.bank_name)bank_name,
  coalesce(auxiliary.account_number,catalog.account_number)account_number,
  chart.account_number ledger_account_number,chart.account_name ledger_account_name,currency.currency_code currency,
  coalesce(ledger.original_amount,0)ledger_original,
  coalesce(auxiliary.original_amount,0)auxiliary_original,
  coalesce(ledger.original_amount,0)-coalesce(auxiliary.original_amount,0)original_difference,
  coalesce(ledger.local_amount,0)ledger_local,
  coalesce(auxiliary.local_amount,0)auxiliary_local,
  coalesce(ledger.local_amount,0)-coalesce(auxiliary.local_amount,0)local_difference
 from keys key join public.chart_accounts chart on chart.account_id=key.account_id
 join public.currencies currency on currency.currency_id=key.currency_id
 left join ledger on ledger.account_id=key.account_id and ledger.currency_id=key.currency_id
 left join auxiliary_accounts auxiliary on auxiliary.account_id=key.account_id and auxiliary.currency_id=key.currency_id
 left join lateral(
  select string_agg(distinct bank.bank_code,', 'order by bank.bank_code)bank_code,
   string_agg(distinct bank.bank_name,', 'order by bank.bank_name)bank_name,
   string_agg(distinct account.account_number,', 'order by account.account_number)account_number
  from run r join public.bank_account account on account.subsidiary_id=r.subsidiary_id
  join public.banks bank using(bank_id)
  where account.account_id=key.account_id and account.currency_id=key.currency_id
 )catalog on true
)
select coalesce(jsonb_agg(jsonb_build_object(
 'bankCode',bank_code,'bankName',bank_name,'accountNumber',account_number,
 'ledgerAccountId',account_id,'ledgerAccountNumber',ledger_account_number,'ledgerAccountName',ledger_account_name,
 'currencyId',currency_id,'currency',currency,
 'ledger',ledger_original,'auxiliary',auxiliary_original,'difference',original_difference,
 'ledgerLocal',ledger_local,'auxiliaryLocal',auxiliary_local,'localDifference',local_difference,
 'balanced',abs(original_difference)<.005 and abs(local_difference)<.005
)order by ledger_account_number,currency),'[]'::jsonb)from rows
$function$;


CREATE OR REPLACE FUNCTION public.opening_bank_assert_reconciled(p_run_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
 reconciliation jsonb;
 discrepancy_text text;
begin
 reconciliation:=public.opening_bank_reconciliation(p_run_id);

 if exists(
  select 1
  from jsonb_array_elements(reconciliation)item
  where abs(coalesce((item->>'difference')::numeric,0))>=.005
     or abs(coalesce((item->>'localDifference')::numeric,0))>=.005
 )then
  -- Validation must return the reconciliation rows so the user can identify
  -- and correct the account.  Posting and activation never set this flag.
  if coalesce(current_setting('app.opening_bank_validation_preview',true),'')='1'then
   return;
  end if;

  select string_agg(
   format(
    'Cuenta contable %s · %s · Banco %s · Cuenta bancaria %s: Mayor %s (local %s); Auxiliar %s (local %s); Diferencia %s (local %s).',
    coalesce(nullif(item->>'ledgerAccountNumber',''),'Sin cuenta'),
    coalesce(nullif(item->>'currency',''),'Sin moneda'),
    coalesce(nullif(concat_ws(' · ',nullif(item->>'bankCode',''),nullif(item->>'bankName','')),''),'Sin banco'),
    coalesce(nullif(item->>'accountNumber',''),'Sin cuenta bancaria'),
    coalesce(item->>'ledger','0'),coalesce(item->>'ledgerLocal','0'),
    coalesce(item->>'auxiliary','0'),coalesce(item->>'auxiliaryLocal','0'),
    coalesce(item->>'difference','0'),coalesce(item->>'localDifference','0')
   ),
   ' 'order by item->>'ledgerAccountNumber',item->>'currency'
  )into discrepancy_text
  from jsonb_array_elements(reconciliation)item
  where abs(coalesce((item->>'difference')::numeric,0))>=.005
     or abs(coalesce((item->>'localDifference')::numeric,0))>=.005;

  raise exception using
   message='El Auxiliar de Bancos no coincide con el Libro Mayor. '
    ||coalesce(discrepancy_text,'No fue posible identificar la cuenta con diferencia.'),
   detail=reconciliation::text,
   hint='Revise en el Libro Mayor y en el Auxiliar de Bancos los importes de la cuenta y moneda indicadas.';
 end if;
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_bank_activate(p_run_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare run_row public.opening_balance_runs%rowtype;item_row record;transaction_key bigint;line_key bigint;bank_transaction_key bigint;created_count integer:=0;
begin
 select *into run_row from public.opening_balance_runs where id=p_run_id and subsidiary_id=public.active_subsidiary_id()for update;
 if run_row.id is null or run_row.status<>'POSTED'or run_row.journal_id is null then raise exception 'La apertura debe estar contabilizada antes de activar el Auxiliar de Bancos.';end if;
 select transaction_id into transaction_key from public.journal where journal_id=run_row.journal_id;
 if transaction_key is null then raise exception 'El asiento de apertura no tiene una transacción contable asociada.';end if;
 if exists(select 1 from public.opening_bank_accounts staged join public.bank_account current using(bank_account_id)
  where staged.run_id=run_row.id and staged.opening_reversed_at is null and(
   current.subsidiary_id<>staged.subsidiary_id or current.bank_id<>staged.bank_id
   or current.currency_id<>staged.currency_id or current.account_id<>staged.ledger_account_id
   or coalesce(current.is_credit_card,false)
   or not exists(select 1 from public.account_subsidiaries scope join public.chart_accounts chart using(account_id)
    where scope.subsidiary_id=staged.subsidiary_id and scope.account_id=staged.ledger_account_id
     and scope.is_active and chart.accepts_entries and not chart.is_inactive)
  ))then
  raise exception 'La configuración de una cuenta bancaria cambió desde la validación. Valide nuevamente el Auxiliar de Bancos.';
 end if;
 perform public.opening_bank_assert_reconciled(run_row.id);
 if exists(
  select 1 from public.opening_bank_accounts account join public.bank_reconciliation reconciliation using(bank_account_id)
  where account.run_id=run_row.id and account.opening_reversed_at is null
   and reconciliation.status='CERRADA'and reconciliation.reconciliation_date>=run_row.opening_date
 )then
  raise exception 'No se puede activar el Auxiliar de Bancos: existe una conciliación bancaria cerrada posterior a la apertura.';
 end if;
 if exists(
  select 1 from public.opening_bank_accounts account join public.quadratic_bank_reconciliations reconciliation using(bank_account_id)
  where account.run_id=run_row.id and account.opening_reversed_at is null and reconciliation.status in('approved','closed')
   and(make_date(reconciliation.period_year,reconciliation.period_month,1)+interval'1 month'-interval'1 day')::date>=run_row.opening_date
 )then
  raise exception 'No se puede activar el Auxiliar de Bancos: existe una prueba de efectivo aprobada o cerrada posterior a la apertura.';
 end if;
 perform 1 from public.bank_account account where account.bank_account_id in(
  select bank_account_id from public.opening_bank_accounts where run_id=run_row.id and opening_reversed_at is null
 )order by account.bank_account_id for update;
 perform set_config('app.opening_bank_internal','1',true);
 for item_row in
  select item.*,account.bank_account_id,account.id header_id,
   coalesce((select min(link.opening_balance_line_id)from public.opening_bank_gl_links link where link.opening_bank_account_id=account.id),null)opening_line_id,
   journal.journal_number
  from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  join public.journal journal on journal.journal_id=run_row.journal_id
  where account.run_id=run_row.id and account.opening_reversed_at is null and item.created_bank_tran_id is null
  order by account.bank_account_id,case when item.record_type='SALDO_CONCILIADO'then 0 else 1 end,item.source_row
 loop
  bank_transaction_key:=null;
  insert into public.bank_transaction(
   tran_date,value_date,bank_account_id,transaction_id,amount,tran_type,reference_number,beneficiary,description,reconciliation_status,
   opening_bank_item_id,opening_balance_line_id,is_opening_balance
  )values(
   item_row.transaction_date,item_row.value_date,item_row.bank_account_id,transaction_key,item_row.signed_original_amount,
   case item_row.record_type when'SALDO_CONCILIADO'then'SALDO_INICIAL'else item_row.record_type end,
   coalesce(item_row.reference,item_row.journal_number),item_row.beneficiary,
   coalesce(item_row.description,case item_row.record_type when'SALDO_CONCILIADO'then'Saldo bancario inicial conciliado'when'DEPOSITO_EN_TRANSITO'then'Depósito en tránsito al inicio'else'Cheque en tránsito al inicio'end),
   case when item_row.record_type='SALDO_CONCILIADO'then'CONCILIADO'else'PENDIENTE_EN_TRANSITO'end,
   item_row.id,item_row.opening_line_id,true
  )on conflict do nothing returning bank_tran_id into bank_transaction_key;
  if bank_transaction_key is null then select bank_tran_id into bank_transaction_key from public.bank_transaction where opening_bank_item_id=item_row.id;end if;
  if bank_transaction_key is null then raise exception 'No fue posible crear el movimiento inicial de la fila %.',item_row.source_row;end if;
  update public.opening_bank_items set created_bank_tran_id=bank_transaction_key,updated_at=now()where id=item_row.id;
  created_count:=created_count+1;
 end loop;
 update public.opening_bank_accounts account set is_active=true,activated_at=coalesce(activated_at,now()),updated_at=now(),updated_by=public.app_user_id()
 where account.run_id=run_row.id and account.opening_reversed_at is null
  and not exists(select 1 from public.opening_bank_items item where item.opening_bank_account_id=account.id and item.created_bank_tran_id is null);
 update public.bank_account account set balance=coalesce((select sum(movement.amount)from public.bank_transaction movement where movement.bank_account_id=account.bank_account_id),0)
 where account.bank_account_id in(select bank_account_id from public.opening_bank_accounts where run_id=run_row.id and opening_reversed_at is null);
 perform set_config('app.opening_bank_internal','',true);
 return created_count;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_pending_invoice_stage(p_run_id bigint, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  item jsonb;
  line jsonb;
  normalized_items jsonb:='[]'::jsonb;
  normalized_lines jsonb;
  period_value text;
  account_value text;
  actual_control bigint;
  actual_counterpart bigint;
  prior_control bigint;
  prior_counterpart bigint;
  run_subsidiary bigint;
  staged integer;
begin
  if p_items is null then return 0;end if;
  if jsonb_typeof(p_items)<>'array' then
    raise exception 'El auxiliar de pendientes debe ser una lista válida.';
  end if;

  select run.subsidiary_id into run_subsidiary
  from public.opening_balance_runs run
  where run.id=p_run_id and run.subsidiary_id=public.active_subsidiary_id();
  if run_subsidiary is null then
    raise exception 'La apertura no pertenece a la subsidiaria activa.';
  end if;

  select account.account_id into actual_control
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number='113003'and assignment.subsidiary_id=run_subsidiary
    and assignment.is_active and account.accepts_entries and not account.is_inactive;
  select account.account_id into actual_counterpart
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number='413001'and assignment.subsidiary_id=run_subsidiary
    and assignment.is_active and account.accepts_entries and not account.is_inactive;
  select account.account_id into prior_control
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number='113004'and assignment.subsidiary_id=run_subsidiary
    and assignment.is_active and account.accepts_entries and not account.is_inactive;
  select account.account_id into prior_counterpart
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number='413002'and assignment.subsidiary_id=run_subsidiary
    and assignment.is_active and account.accepts_entries and not account.is_inactive;
  if actual_control is null or actual_counterpart is null
    or prior_control is null or prior_counterpart is null then
    raise exception 'Configure las cuentas 113003, 113004, 413001 y 413002 antes de cargar el auxiliar.';
  end if;

  for item in select value from jsonb_array_elements(p_items)loop
    period_value:=upper(coalesce(nullif(btrim(item->>'periodType'),''),nullif(btrim(item->>'period_type'),'')));
    if period_value is null then
      raise exception 'Pendiente %: indique tipo_periodo ACTUAL o ANTERIOR.',coalesce(item->>'reference','sin referencia');
    end if;
    if period_value not in('ACTUAL','ANTERIOR')then
      raise exception 'Pendiente %: tipo_periodo debe ser ACTUAL o ANTERIOR.',coalesce(item->>'reference','sin referencia');
    end if;
    if jsonb_typeof(coalesce(item->'lines','[]'::jsonb))<>'array'then
      raise exception 'Pendiente %: las líneas no son válidas.',coalesce(item->>'reference','sin referencia');
    end if;

    normalized_lines:='[]'::jsonb;
    for line in select value from jsonb_array_elements(item->'lines')loop
      account_value:=replace(coalesce(line->>'account',''),' ','');
      if period_value='ACTUAL'and account_value not in('113003','413001')then
        raise exception 'Pendiente %: ACTUAL solo admite 113003 al debe y 413001 al haber.',coalesce(item->>'reference','sin referencia');
      elsif period_value='ANTERIOR'and account_value not in('113004','413002')then
        raise exception 'Pendiente %: ANTERIOR solo admite 113004 al debe y 413002 al haber.',coalesce(item->>'reference','sin referencia');
      end if;

      if period_value='ANTERIOR'then
        line:=line||jsonb_build_object(
          'originalPeriodAccount',account_value,
          'account',case account_value when'113004'then'113003'else'413001'end,
          'isControlLine',account_value='113004'
        );
      else
        line:=line||jsonb_build_object('isControlLine',account_value='113003');
      end if;
      normalized_lines:=normalized_lines||jsonb_build_array(line);
    end loop;
    normalized_items:=normalized_items||jsonb_build_array(
      item||jsonb_build_object('periodType',period_value,'period_type',period_value,'lines',normalized_lines)
    );
  end loop;

  staged:=public.opening_pending_invoice_stage_before_period_type(p_run_id,normalized_items);

  perform set_config('app.pending_reclassification_internal','1',true);
  update public.opening_pending_invoice_items pending
  set period_type=upper(coalesce(nullif(pending.raw_data->>'periodType',''),nullif(pending.raw_data->>'period_type',''),'ACTUAL')),
      origin_journal_id=coalesce(pending.origin_journal_id,run.journal_id),
      updated_at=now(),updated_by=public.app_user_id()
  from public.opening_balance_runs run
  where pending.run_id=p_run_id and run.id=pending.run_id;

  perform set_config('app.pending_reclassification_internal','0',true);

  update public.opening_pending_invoice_lines pending_line
  set account_id=case pending_line.line_role when'CONTROL'then prior_control else prior_counterpart end,
      raw_data=(pending_line.raw_data-'originalPeriodAccount')||jsonb_build_object(
        'account',case pending_line.line_role when'CONTROL'then'113004'else'413002'end,
        'isControlLine',pending_line.line_role='CONTROL'
      )
  from public.opening_pending_invoice_items pending
  where pending.id=pending_line.item_id
    and pending.run_id=p_run_id
    and pending.period_type='ANTERIOR';

  return staged;
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_pending_invoice_reconciliation(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with run as(
  select r.* from public.opening_balance_runs r
  where r.id=p_run_id and r.subsidiary_id=public.active_subsidiary_id()
),controls as(
  select x.period_type,a.account_id,a.account_number,a.account_name
  from(values('ACTUAL'::text,'113003'::text),('ANTERIOR','113004'))x(period_type,account_number)
  join public.chart_accounts a on a.account_number=x.account_number
),ledger_values as(
  select c.period_type,l.currency_id,l.local_debit-l.local_credit local_amount,
    case when l.local_debit>0 then l.foreign_amount else-l.foreign_amount end foreign_amount
  from run r
  join public.opening_balance_lines l on l.run_id=r.id
  join controls c on c.account_id=l.account_id
  where r.status<>'POSTED'
  union all
  select c.period_type,coalesce(g.original_currency_id,j.currency_id),
    g.debit_amount-g.credit_amount,g.debit_fx-g.credit_fx
  from run r
  join public.journal j on j.journal_id=r.journal_id
  join public.gl_impact g on g.transaction_id=j.transaction_id
  join public.accounting_books b using(accounting_book_id)
  join controls c on c.account_id=g.account_id
  where r.status='POSTED'and b.is_primary and b.is_active
),ledger as(
  select period_type,currency_id,sum(local_amount)local_amount,sum(foreign_amount)foreign_amount
  from ledger_values group by period_type,currency_id
),auxiliary as(
  select coalesce(reclassified.source_period_type,i.period_type)period_type,
    i.currency_id,sum(i.initial_local)local_amount,sum(i.initial_foreign)foreign_amount,
    sum(i.initial_local)filter(where i.is_active)existing_local,
    sum(i.initial_foreign)filter(where i.is_active)existing_foreign,
    sum(i.initial_local)filter(where not i.is_active)staged_local,
    sum(i.initial_foreign)filter(where not i.is_active)staged_foreign
  from public.opening_pending_invoice_items i
  left join public.pending_invoice_reclassification_items reclassified
    on reclassified.source_opening_pending_id=i.id
  where i.run_id=p_run_id
  group by coalesce(reclassified.source_period_type,i.period_type),i.currency_id
),keys as(
  select period_type,currency_id from ledger
  union select period_type,currency_id from auxiliary
)
select coalesce(jsonb_agg(jsonb_build_object(
  'periodType',k.period_type,
  'accountId',c.account_id,'accountNumber',c.account_number,'accountName',c.account_name,
  'currencyId',k.currency_id,'currency',cu.currency_code,
  'ledger',coalesce(l.local_amount,0),'existing',coalesce(a.existing_local,0),
  'staged',coalesce(a.staged_local,0),'auxiliary',coalesce(a.local_amount,0),
  'difference',coalesce(l.local_amount,0)-coalesce(a.local_amount,0),
  'ledgerForeign',coalesce(l.foreign_amount,0),'auxiliaryForeign',coalesce(a.foreign_amount,0),
  'foreignDifference',coalesce(l.foreign_amount,0)-coalesce(a.foreign_amount,0),
  'balanced',abs(coalesce(l.local_amount,0)-coalesce(a.local_amount,0))<=.005
    and abs(coalesce(l.foreign_amount,0)-coalesce(a.foreign_amount,0))<=.005
)order by k.period_type,cu.currency_code),'[]'::jsonb)
from keys k
join controls c on c.period_type=k.period_type
join public.currencies cu on cu.currency_id=k.currency_id
left join ledger l on l.period_type=k.period_type and l.currency_id=k.currency_id
left join auxiliary a on a.period_type=k.period_type and a.currency_id=k.currency_id
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_options_before_pending_period_type()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base jsonb;sid bigint:=public.active_subsidiary_id();
begin
 base:=public.opening_balance_options_before_opening_bank();
 return base||jsonb_build_object(
  'banks',coalesce((select jsonb_agg(jsonb_build_object('id',bank.bank_id,'code',bank.bank_code,'name',bank.bank_name)order by bank.bank_name)
   from(select distinct b.bank_id,b.bank_code,b.bank_name from public.bank_account account join public.banks b using(bank_id)
    where account.subsidiary_id=sid and not coalesce(account.is_credit_card,false))bank),'[]'::jsonb),
  'bankAccounts',coalesce((select jsonb_agg(jsonb_build_object(
   'id',account.bank_account_id,'bankId',account.bank_id,'bankCode',bank.bank_code,'bankName',bank.bank_name,
   'accountNumber',account.account_number,'currencyId',account.currency_id,'currency',currency.currency_code,
   'ledgerAccountId',account.account_id,'ledgerAccountNumber',chart.account_number,'ledgerAccountName',chart.account_name
  )order by bank.bank_name,account.account_number)from public.bank_account account join public.banks bank using(bank_id)
   join public.currencies currency using(currency_id)join public.chart_accounts chart using(account_id)
   where account.subsidiary_id=sid and not coalesce(account.is_credit_card,false)),'[]'::jsonb),
  'bankRecordTypes',jsonb_build_array(
   jsonb_build_object('code','SALDO_CONCILIADO','name','Saldo conciliado inicial'),
   jsonb_build_object('code','DEPOSITO_EN_TRANSITO','name','Depósito en tránsito'),
   jsonb_build_object('code','CHEQUE_EN_TRANSITO','name','Cheque en tránsito')
  )
 );
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base jsonb;sid bigint:=public.active_subsidiary_id();
begin
  base:=public.opening_balance_options_before_pending_period_type();
  return base||jsonb_build_object('pendingAccounts',jsonb_build_object(
    'currentControl',(select jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)
      from public.chart_accounts a join public.account_subsidiaries s using(account_id)
      where a.account_number='113003'and s.subsidiary_id=sid and s.is_active limit 1),
    'currentCounterpart',(select jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)
      from public.chart_accounts a join public.account_subsidiaries s using(account_id)
      where a.account_number='413001'and s.subsidiary_id=sid and s.is_active limit 1),
    'priorControl',(select jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)
      from public.chart_accounts a join public.account_subsidiaries s using(account_id)
      where a.account_number='113004'and s.subsidiary_id=sid and s.is_active limit 1),
    'priorCounterpart',(select jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name)
      from public.chart_accounts a join public.account_subsidiaries s using(account_id)
      where a.account_number='413002'and s.subsidiary_id=sid and s.is_active limit 1)
  ));
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_preview_before_pending_period_type(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base jsonb;reconciliation jsonb;
begin
 base:=public.opening_balance_preview_before_opening_bank(p_run_id);
 if base is null then return null;end if;
 reconciliation:=public.opening_bank_reconciliation(p_run_id);
 return base||jsonb_build_object(
  'bankItems',coalesce((select jsonb_agg(jsonb_build_object(
   'id',item.id,'row',item.source_row,'sourceRow',item.source_row,
   'bankAccountId',account.bank_account_id,'bankCode',bank.bank_code,'bankName',bank.bank_name,'accountNumber',bank_account.account_number,
   'recordType',item.record_type,'transactionDate',item.transaction_date,'valueDate',item.value_date,'reference',item.reference,
   'beneficiary',item.beneficiary,'description',item.description,'currency',currency.currency_code,
   'originalAmount',item.original_amount,'signedOriginalAmount',item.signed_original_amount,
   'localEquivalent',item.local_equivalent,'signedLocalEquivalent',item.signed_local_equivalent,
   'created',item.created_bank_tran_id is not null,'bankTransactionId',item.created_bank_tran_id,'active',account.is_active,'errors','[]'::jsonb
  )order by bank.bank_name,bank_account.account_number,item.source_row)
  from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  join public.bank_account bank_account on bank_account.bank_account_id=account.bank_account_id
  join public.banks bank on bank.bank_id=account.bank_id join public.currencies currency on currency.currency_id=account.currency_id
  where account.run_id=p_run_id),'[]'::jsonb),
  'bankReconciliation',reconciliation,
  'bankSummary',(select jsonb_build_object(
   'count',count(item.id),'accounts',count(distinct account.id),
   'openingBalance',coalesce(sum(item.original_amount)filter(where item.record_type='SALDO_CONCILIADO'),0),
   'openingLocal',coalesce(sum(item.local_equivalent)filter(where item.record_type='SALDO_CONCILIADO'),0),
   'originalAmount',coalesce(sum(item.signed_original_amount),0),'localEquivalent',coalesce(sum(item.signed_local_equivalent),0),
   'transitCount',count(item.id)filter(where item.record_type<>'SALDO_CONCILIADO'),
   'transitDeposits',coalesce(sum(item.original_amount)filter(where item.record_type='DEPOSITO_EN_TRANSITO'),0),
   'transitChecks',coalesce(sum(abs(item.original_amount))filter(where item.record_type='CHEQUE_EN_TRANSITO'),0),
   'transitDepositsLocal',coalesce(sum(item.local_equivalent)filter(where item.record_type='DEPOSITO_EN_TRANSITO'),0),
   'transitChecksLocal',coalesce(sum(abs(item.local_equivalent))filter(where item.record_type='CHEQUE_EN_TRANSITO'),0),
   'pending',count(item.id)filter(where item.created_bank_tran_id is null),
   'active',count(item.id)filter(where account.is_active),
   'balanced',coalesce((select bool_and(abs((row->>'difference')::numeric)<.005 and abs((row->>'localDifference')::numeric)<.005)
    from jsonb_array_elements(reconciliation)row),true)
  )from public.opening_bank_accounts account left join public.opening_bank_items item on item.opening_bank_account_id=account.id
   where account.run_id=p_run_id)
 );
end$function$;

CREATE OR REPLACE FUNCTION public.opening_pending_country_id(p_value text)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare value_text text:=nullif(btrim(p_value),'');result_id bigint;matches integer;
begin
 if value_text is null then return null;end if;
 if value_text~*'^ID:[0-9]+$'then
  select count(*),min(country_id)into matches,result_id from countries
   where country_id=substring(value_text from 4)::bigint;
 elsif value_text~'^[0-9]+$'then
  select count(*),min(country_id)into matches,result_id from countries where country_id=value_text::bigint;
 else
  select count(*),min(country_id)into matches,result_id from countries
   where lower(name)=lower(value_text)or upper(coalesce(country_code_iso2,''))=upper(value_text)
    or upper(coalesce(country_code_iso3,''))=upper(value_text);
 end if;
 if matches<>1 then raise exception 'País de servicio "%" no existe o es ambiguo. Use ISO, nombre exacto o ID:identificador.',value_text;end if;
 return result_id;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_options_before_opening_pending()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=opening_balance_assert_access('view');result jsonb;
begin
 select jsonb_build_object(
  'canCreate',app_is_admin()or exists(select 1 from role_access_matrix m where m.role_id=app_active_role_id()and(m.resource_key='legacy:all'or(m.resource_key='accounting:opening-balances'and m.can_create))),
  'canReverse',app_is_admin()or exists(select 1 from role_access_matrix m where m.role_id=app_active_role_id()and(m.resource_key='legacy:all'or(m.resource_key='accounting:opening-balances'and m.can_delete))),
  'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id,'currency',cu.currency_code),
  'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',a.category)order by a.account_number)from chart_accounts a join account_subsidiaries x using(account_id)where x.subsidiary_id=s.subsidiary_id and x.is_active and a.account_number='319999'and a.accepts_entries and not a.is_inactive),'[]'),
  'assetCategories',coalesce((select jsonb_agg(jsonb_build_object('code',category_code,'name',category_name,'life',useful_life_months,'method',depreciation_method)order by category_code)from asset_category where subsidiary_id=s.subsidiary_id and is_active),'[]'),
  'run',(select to_jsonb(r)from opening_balance_runs r where r.subsidiary_id=s.subsidiary_id and r.status<>'REVERSED'order by r.id desc limit 1)
 )into result from subsidiaries s join currencies cu using(currency_id)where s.subsidiary_id=sid;
 return result;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_pending_invoice_stage_before_period_type(p_run_id bigint, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
 run_row opening_balance_runs%rowtype;item jsonb;line jsonb;support jsonb;
 item_key bigint;customer_key bigint;currency_key bigint;local_currency bigint;country_key bigint;
 control_account bigint;counterpart_account bigint;account_key bigint;
 department_key bigint;cost_key bigint;class_key bigint;location_key bigint;creditor_key bigint;related_key bigint;
 center_customer bigint;center_department bigint;center_class bigint;
 reference_value text;origin_value date;service_month_value text;row_value integer;line_count integer;
 local_debit_value numeric;local_credit_value numeric;foreign_debit_value numeric;foreign_credit_value numeric;
 control_local numeric;counterpart_local numeric;control_foreign numeric;counterpart_foreign numeric;rate_value numeric;
 count_items integer:=0;role_value text;link_value text;supports jsonb;
begin
 if p_items is null then return 0;end if;
 if jsonb_typeof(p_items)<>'array'then raise exception 'El auxiliar de pendientes debe ser una lista válida.';end if;
 select * into run_row from opening_balance_runs
  where id=p_run_id and subsidiary_id=active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'La apertura no pertenece a la subsidiaria activa.';end if;
 if exists(select 1 from opening_pending_invoice_items where run_id=p_run_id and(is_active or reversed_local>0))then
  raise exception 'El auxiliar de pendientes de facturar ya fue activado para esta apertura.';
 end if;
 delete from opening_pending_invoice_items where run_id=p_run_id;
 if jsonb_array_length(p_items)=0 then return 0;end if;

 select currency_id into local_currency from subsidiaries where subsidiary_id=run_row.subsidiary_id;
 select a.account_id into control_account from chart_accounts a join account_subsidiaries s using(account_id)
  where a.account_number='113003'and s.subsidiary_id=run_row.subsidiary_id and s.is_active
   and a.accepts_entries and not a.is_inactive limit 1;
 select a.account_id into counterpart_account from chart_accounts a join account_subsidiaries s using(account_id)
  where a.account_number='413001'and s.subsidiary_id=run_row.subsidiary_id and s.is_active
   and a.accepts_entries and not a.is_inactive limit 1;
 if control_account is null then raise exception 'La cuenta 113003 · Facturación Pendiente de Emitir no está habilitada para la subsidiaria.';end if;
 if counterpart_account is null then raise exception 'La cuenta 413001 · Servicios Pendientes de Facturar no está habilitada para la subsidiaria.';end if;

 for item in select value from jsonb_array_elements(p_items)loop
  count_items:=count_items+1;
  reference_value:=nullif(btrim(item->>'reference'),'');
  if reference_value is null then raise exception 'Pendientes registro %: indique una referencia única.',count_items;end if;
  if length(reference_value)>100 then raise exception 'Pendiente %: la referencia no puede exceder 100 caracteres.',left(reference_value,100);end if;
  begin origin_value:=nullif(item->>'originDate','')::date;
  exception when invalid_text_representation then raise exception 'Pendiente %: fecha de origen inválida.',reference_value;end;
  if origin_value is null or origin_value>run_row.opening_date then
   raise exception 'Pendiente %: la fecha de origen debe ser igual o anterior a la apertura.',reference_value;
  end if;
  service_month_value:=nullif(btrim(item->>'serviceMonth'),'');
  if service_month_value is null or service_month_value!~'^[0-9]{4}-(0[1-9]|1[0-2])$'then
   raise exception 'Pendiente %: el mes de servicio debe tener formato AAAA-MM.',reference_value;
  end if;
  if service_month_value>to_char(run_row.opening_date,'YYYY-MM')then
   raise exception 'Pendiente %: el mes de servicio no puede ser posterior al mes de apertura.',reference_value;
  end if;
  country_key:=opening_pending_country_id(coalesce(item->>'serviceCountry',item->>'serviceCountryId'));
  if country_key is null then raise exception 'Pendiente %: indique el país de servicio.',reference_value;end if;
  select c.customer_id into customer_key from customers c
   where c.tax_id=item->>'entityTaxId'and(c.primary_subsidiary_id=run_row.subsidiary_id
    or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=run_row.subsidiary_id))limit 1;
  if customer_key is null then raise exception 'Pendiente %: cliente con identificación % no encontrado.',reference_value,coalesce(item->>'entityTaxId','');end if;
  select c.currency_id into currency_key from currencies c where upper(c.currency_code)=upper(item->>'currency')
   and(c.currency_id=local_currency or exists(select 1 from subsidiary_currencies sc where sc.subsidiary_id=run_row.subsidiary_id and sc.currency_id=c.currency_id))limit 1;
  if currency_key is null then raise exception 'Pendiente %: la moneda % no está habilitada.',reference_value,coalesce(item->>'currency','');end if;
  if jsonb_typeof(coalesce(item->'lines','[]'::jsonb))<>'array'or jsonb_array_length(coalesce(item->'lines','[]'::jsonb))<>2 then
   raise exception 'Pendiente %: incluya exactamente dos líneas, 113003 al debe y 413001 al haber.',reference_value;
  end if;

  control_local:=0;counterpart_local:=0;control_foreign:=0;counterpart_foreign:=0;line_count:=0;
  -- First pass validates the exact accounting composition and determines the
  -- historical rate before inserting the header.
  for line in select value from jsonb_array_elements(item->'lines')loop
   line_count:=line_count+1;
   select a.account_id into account_key from chart_accounts a join account_subsidiaries s using(account_id)
    where a.account_number=line->>'account'and s.subsidiary_id=run_row.subsidiary_id and s.is_active
     and a.accepts_entries and not a.is_inactive limit 1;
   if account_key is null then raise exception 'Pendiente % línea %: cuenta % no habilitada.',reference_value,line_count,coalesce(line->>'account','');end if;
   begin
    local_debit_value:=coalesce(nullif(line->>'debit','')::numeric,0);
    local_credit_value:=coalesce(nullif(line->>'credit','')::numeric,0);
    foreign_debit_value:=coalesce(nullif(line->>'debitFx','')::numeric,case when currency_key=local_currency then local_debit_value else 0 end);
    foreign_credit_value:=coalesce(nullif(line->>'creditFx','')::numeric,case when currency_key=local_currency then local_credit_value else 0 end);
   exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Pendiente % línea %: revise los importes.',reference_value,line_count;
   end;
   if least(local_debit_value,local_credit_value,foreign_debit_value,foreign_credit_value)<0
    or(local_debit_value>0)=(local_credit_value>0)
    or(foreign_debit_value>0)=(foreign_credit_value>0)
    or(local_debit_value>0)<>(foreign_debit_value>0)then
    raise exception 'Pendiente % línea %: indique un único lado y conserve el mismo lado en moneda local y original.',reference_value,line_count;
   end if;
   if account_key=control_account and local_debit_value>0 then
    control_local:=control_local+local_debit_value;control_foreign:=control_foreign+foreign_debit_value;
   elsif account_key=counterpart_account and local_credit_value>0 then
    counterpart_local:=counterpart_local+local_credit_value;counterpart_foreign:=counterpart_foreign+foreign_credit_value;
   else
    raise exception 'Pendiente %: la composición original debe ser 113003 al debe y 413001 al haber.',reference_value;
   end if;
  end loop;
  if control_local<=0 or abs(control_local-counterpart_local)>.005 or abs(control_foreign-counterpart_foreign)>.005 then
   raise exception 'Pendiente %: el asiento original no cuadra en moneda local u original.',reference_value;
  end if;
  if currency_key=local_currency then
   if abs(control_local-control_foreign)>.000001 then raise exception 'Pendiente %: los importes local y original deben coincidir en moneda funcional.',reference_value;end if;
   rate_value:=1;
  else
   rate_value:=coalesce(nullif(item->>'exchangeRate','')::numeric,control_local/nullif(control_foreign,0));
   if rate_value is null or rate_value<=0 or abs(control_local-round(control_foreign*rate_value,6))>.005 then
    raise exception 'Pendiente %: el tipo de cambio histórico no reproduce el importe local.',reference_value;
   end if;
  end if;

  link_value:=coalesce(nullif(btrim(item->>'supportUrl'),''),nullif(btrim(item->>'supportLink'),''));
  if link_value is not null and link_value!~*'^https?://[^[:space:]/?#]+[^[:space:]]*$'then
   raise exception 'Pendiente %: el enlace de respaldo no es válido.',reference_value;
  end if;
  insert into opening_pending_invoice_items(
   run_id,subsidiary_id,reference,origin_date,customer_id,currency_id,historical_exchange_rate,
   service_month,service_country_id,initial_local,initial_foreign,balance_local,balance_foreign,support_url,note,raw_data,created_by,updated_by
  )values(
   run_row.id,run_row.subsidiary_id,reference_value,origin_value,customer_key,currency_key,rate_value,
   service_month_value,country_key,control_local,control_foreign,control_local,control_foreign,link_value,nullif(btrim(item->>'note'),''),item-'supports',app_user_id(),app_user_id()
  )returning id into item_key;

  line_count:=0;
  for line in select value from jsonb_array_elements(item->'lines')loop
   line_count:=line_count+1;row_value:=coalesce(nullif(line->>'sourceRow','')::integer,line_count);
   select account_id into account_key from chart_accounts where account_number=line->>'account'limit 1;
   local_debit_value:=coalesce(nullif(line->>'debit','')::numeric,0);local_credit_value:=coalesce(nullif(line->>'credit','')::numeric,0);
   foreign_debit_value:=coalesce(nullif(line->>'debitFx','')::numeric,case when currency_key=local_currency then local_debit_value else 0 end);
   foreign_credit_value:=coalesce(nullif(line->>'creditFx','')::numeric,case when currency_key=local_currency then local_credit_value else 0 end);
   role_value:=case when account_key=control_account then'CONTROL'else'COUNTERPART'end;
   if(line ? 'isControlLine')and coalesce((line->>'isControlLine')::boolean,false)<>(role_value='CONTROL')then
    raise exception 'Pendiente % línea %: el indicador de cuenta control no coincide con la cuenta.',reference_value,row_value;
   end if;
   department_key:=opening_balance_dimension_id('department',line->>'department',run_row.subsidiary_id);
   cost_key:=opening_balance_dimension_id('costCenter',line->>'costCenter',run_row.subsidiary_id);
   class_key:=opening_balance_dimension_id('class',line->>'className',run_row.subsidiary_id);
   creditor_key:=opening_balance_dimension_id('financialCreditor',line->>'financialCreditor',run_row.subsidiary_id);
   related_key:=opening_balance_dimension_id('relatedCompany',line->>'relatedCompany',run_row.subsidiary_id);
   location_key:=opening_balance_dimension_id('location',line->>'location',run_row.subsidiary_id);

   if role_value='COUNTERPART'and cost_key is null then
    raise exception 'Pendiente % línea %: el centro de costos es obligatorio para la cuenta 413001.',reference_value,row_value;
   end if;
   if cost_key is not null then
    select cc.customer_id,cu.department_id,cc.class_id into center_customer,center_department,center_class
     from cost_centers cc left join customers cu on cu.customer_id=cc.customer_id where cc.cost_center_id=cost_key;
    if center_customer is not null and center_customer<>customer_key then raise exception 'Pendiente % línea %: el centro de costos pertenece a otro cliente.',reference_value,row_value;end if;
    if center_department is not null then
     if department_key is null then department_key:=center_department;
     elsif department_key<>center_department then raise exception 'Pendiente % línea %: el centro de costos no corresponde al departamento.',reference_value,row_value;end if;
    end if;
    if center_class is not null then
     if class_key is not null and class_key<>center_class then raise exception 'Pendiente % línea %: la clase no corresponde al centro de costos.',reference_value,row_value;end if;
     class_key:=center_class;
    elsif class_key is not null then raise exception 'Pendiente % línea %: el centro de costos no tiene la clase indicada.',reference_value,row_value;
    end if;
   elsif class_key is not null then raise exception 'Pendiente % línea %: indique centro de costos para asignar una clase.',reference_value,row_value;
   end if;
   insert into opening_pending_invoice_lines(
    item_id,row_number,line_role,account_id,local_debit,local_credit,foreign_debit,foreign_credit,
    department_id,cost_center_id,class_id,location_id,financial_creditor_id,related_company_id,
    service_month,service_country_id,note,raw_data
   )values(
    item_key,row_value,role_value,account_key,local_debit_value,local_credit_value,foreign_debit_value,foreign_credit_value,
    department_key,cost_key,class_key,location_key,creditor_key,related_key,service_month_value,country_key,
    coalesce(nullif(btrim(line->>'note'),''),nullif(btrim(item->>'note'),'')),line
   );
  end loop;

  if link_value is not null then
   insert into opening_pending_invoice_supports(item_id,support_type,display_name,support_url)
    values(item_key,'Enlace','Respaldo de '||reference_value,link_value);
  end if;
  supports:=coalesce(item->'supports','[]'::jsonb);
  if jsonb_typeof(supports)<>'array'then raise exception 'Pendiente %: los respaldos no son válidos.',reference_value;end if;
  for support in select value from jsonb_array_elements(supports)loop
   if coalesce(support->>'supportType',support->>'support_type')='Enlace'then
    if nullif(btrim(coalesce(support->>'displayName',support->>'display_name')),'')is null
     or coalesce(support->>'supportUrl',support->>'support_url','')!~*'^https?://[^[:space:]/?#]+[^[:space:]]*$'then
     raise exception 'Pendiente %: enlace de respaldo inválido.',reference_value;
    end if;
    insert into opening_pending_invoice_supports(item_id,support_type,display_name,support_url)
     values(item_key,'Enlace',coalesce(support->>'displayName',support->>'display_name'),coalesce(support->>'supportUrl',support->>'support_url'));
   elsif coalesce(support->>'supportType',support->>'support_type')='Archivo'then
    if nullif(btrim(coalesce(support->>'fileName',support->>'file_name')),'')is null
     or nullif(btrim(coalesce(support->>'displayName',support->>'display_name')),'')is null
     or coalesce(support->>'fileData',support->>'file_data')is null
     or coalesce(coalesce(support->>'fileSize',support->>'file_size')::bigint,-1)not between 0 and 5242880 then
     raise exception 'Pendiente %: archivo de respaldo inválido o superior a 5 MB.',reference_value;
    end if;
    if length(coalesce(support->>'fileData',support->>'file_data'))>7100000
     or coalesce(support->>'fileData',support->>'file_data')!~'^data:[^,]*;base64,'then raise exception 'Pendiente %: contenido de respaldo inválido.',reference_value;end if;
    if octet_length(decode(split_part(coalesce(support->>'fileData',support->>'file_data'),',',2),'base64'))
      <>coalesce(support->>'fileSize',support->>'file_size')::bigint then
     raise exception 'Pendiente %: el tamaño del respaldo no coincide con su contenido.',reference_value;
    end if;
    insert into opening_pending_invoice_supports(item_id,support_type,display_name,file_name,mime_type,file_size,file_data)
     values(item_key,'Archivo',coalesce(support->>'displayName',support->>'display_name'),coalesce(support->>'fileName',support->>'file_name'),
      coalesce(support->>'mimeType',support->>'mime_type','application/octet-stream'),coalesce(support->>'fileSize',support->>'file_size')::bigint,
      coalesce(support->>'fileData',support->>'file_data'));
   else raise exception 'Pendiente %: tipo de respaldo no válido.',reference_value;
   end if;
  end loop;
 end loop;
 return count_items;
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

CREATE OR REPLACE FUNCTION public.opening_balance_rate(p_currency bigint, p_date date)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$declare base bigint:= (select currency_id from subsidiaries where subsidiary_id=active_subsidiary_id());r numeric;begin if p_currency=base then return 1;end if;select spot_rate into r from exchange_rates where from_currency_id=p_currency and to_currency_id=base and effective_date<=p_date order by effective_date desc limit 1;if r is null then raise exception'No existe tipo de cambio para la moneda seleccionada a la fecha de apertura.';end if;return r;end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_reverse_before_opening_pending(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare run_row opening_balance_runs%rowtype;reversal_key bigint;reversal_number text;reversal_period_key bigint;sid bigint;
begin
 sid:=opening_balance_assert_access('delete');
 perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
 select * into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=sid and status='POSTED'for update;
 if run_row.id is null then raise exception 'Apertura contabilizada no encontrada.';end if;
 if exists(select 1 from customer_payment_application a join invoice i using(invoice_id)where i.opening_run_id=run_row.id)or exists(select 1 from supplier_payment_application a join supplier_invoice i using(invoice_id)where i.opening_run_id=run_row.id)then raise exception 'No se puede reversar: existen cobros o pagos aplicados a documentos iniciales.';end if;
 if exists(
  select 1 from fx_revaluation_runs x
  where x.subsidiary_id=run_row.subsidiary_id and x.status='CONTABILIZADO'and x.closing_date>=run_row.opening_date
   and exists(select 1 from opening_balance_lines l where l.run_id=run_row.id and l.currency_id=x.currency_id)
 )then
  raise exception 'No se puede reversar: existen revaluaciones de moneda contabilizadas desde la fecha de apertura. Anule primero esas revaluaciones.';
 end if;
 if exists(select 1 from asset_depreciation where opening_run_id=run_row.id and not is_opening_balance)or exists(select 1 from asset_depreciation d join asset a using(asset_id)where a.opening_run_id=run_row.id and not d.is_opening_balance)or exists(select 1 from asset_transfer t join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_disposal d join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_maintenance m join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_revaluation v join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_impairment i join asset a using(asset_id)where a.opening_run_id=run_row.id)then raise exception 'No se puede reversar: un activo inicial tiene depreciaciones u operaciones posteriores.';end if;
 if exists(select 1 from jsonb_array_elements(opening_fixed_asset_reconciliation(run_row.id))x where abs(coalesce((x->>'existing')::numeric,0))>.005)then raise exception 'No se puede reversar: el saldo PPE de apertura está conciliado con fichas de activos preexistentes. Revise y relacione esas fichas antes de reversar.';end if;
 select fiscal_period_id into reversal_period_key from fiscal_periods where subsidiary_id=run_row.subsidiary_id and run_row.opening_date between start_date and end_date and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)limit 1;
 if reversal_period_key is null then raise exception 'No se puede reversar la apertura porque su período contable original está cerrado. Reabra ese período antes de continuar.';end if;
 reversal_number:='REV-'||(select journal_number from journal where journal_id=run_row.journal_id);
 perform set_config('app.asset_proposal_internal','1',true);perform set_config('app.opening_balance_internal','1',true);
 insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by,reversed_from_journal_id,asset_proposal_internal)
 select reversal_number,run_row.opening_date,subsidiary_id,currency_id,reversal_period_key,1,'Reversión de apertura','Reversión',total_credit,total_debit,'CONTABILIZADO',app_user_id(),journal_id,true from journal where journal_id=run_row.journal_id returning journal_id into reversal_key;
 insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,cost_center_id,financial_creditor_id,related_company_id,note,entity_type,customer_id,supplier_id,historical_exchange_rate,original_currency_id,opening_balance_line_id)
 select reversal_key,account_id,credit,debit,credit_fx,debit_fx,department_id,class_id,location_id,cost_center_id,financial_creditor_id,related_company_id,'Reversión de apertura',entity_type,customer_id,supplier_id,historical_exchange_rate,original_currency_id,opening_balance_line_id from journal_line where journal_id=run_row.journal_id;
 delete from gl_impact where transaction_id=(select transaction_id from journal where journal_id=reversal_key);
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id)
 select reversal.transaction_id,original.account_id,original.subsidiary_id,reversal_period_key,original.accounting_book_id,original.credit_amount,original.debit_amount,original.credit_fx,original.debit_fx,run_row.opening_date,original.original_currency_id,original.opening_balance_line_id
 from journal source join gl_impact original on original.transaction_id=source.transaction_id cross join journal reversal
 where source.journal_id=run_row.journal_id and reversal.journal_id=reversal_key;
 if not exists(select 1 from journal j join gl_impact g on g.transaction_id=j.transaction_id where j.journal_id=reversal_key)then raise exception 'No fue posible registrar los impactos de la reversión en el libro original.';end if;
 delete from invoice where opening_run_id=run_row.id;delete from supplier_invoice where opening_run_id=run_row.id;
 update asset set opening_reversed_at=run_row.opening_date::timestamp,status='INACTIVO'where opening_run_id=run_row.id and is_opening_balance;
 update opening_balance_runs set status='REVERSED',reversed_at=now()where id=run_row.id;
 perform set_config('app.asset_proposal_internal','',true);perform set_config('app.opening_balance_internal','',true);
 return jsonb_build_object('reversalJournalId',reversal_key,'number',reversal_number);
end$function$;

CREATE OR REPLACE FUNCTION public.opening_date_hard_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare row_data jsonb:=to_jsonb(new);movement_date date;sid bigint;
begin
 if coalesce(current_setting('app.opening_balance_internal',true),'')='1'then return new;end if;
 movement_date:=case tg_table_name when'transaction'then nullif(row_data->>'tran_date','')::date when'invoice'then nullif(row_data->>'invoice_date','')::date when'supplier_invoice'then nullif(row_data->>'invoice_date','')::date when'purchase_document'then nullif(row_data->>'document_date','')::date when'sales_document'then nullif(row_data->>'document_date','')::date end;
 sid:=nullif(row_data->>'subsidiary_id','')::bigint;
 if movement_date is not null and sid is not null and exists(select 1 from opening_balance_runs where subsidiary_id=sid and status='POSTED'and movement_date<=opening_date)then raise exception 'La fecha % está bloqueada por la apertura contable. Registre el movimiento después de la fecha de apertura.',movement_date;end if;
 return new;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_validate_before_opening_pending(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare output jsonb;rid bigint;line record;existing opening_balance_runs%rowtype;asset_count integer;sid bigint;entity_customer bigint;entity_department bigint;center_customer bigint;
begin
 sid:=opening_balance_assert_access('create');
 if coalesce(p->>'expectedSubsidiaryId','')<>sid::text then raise exception 'La empresa activa cambió desde que abrió la carga. Recargue la pantalla y seleccione nuevamente los archivos.';end if;
 select * into existing from opening_balance_runs where subsidiary_id=sid and status<>'REVERSED'order by id desc limit 1;
 if existing.status='POSTED'then
  if jsonb_array_length(coalesce(p->'rows','[]'::jsonb))>0 then raise exception 'La apertura ya está contabilizada. Solo puede agregar el auxiliar de activos fijos pendiente.';end if;
  if jsonb_array_length(coalesce(p->'assets','[]'::jsonb))=0 then raise exception 'Seleccione la plantilla del auxiliar de activos fijos.';end if;
  rid:=existing.id;asset_count:=opening_fixed_asset_stage(rid,p->'assets');
 else
  output:=opening_balance_stage(p);rid:=(output->>'runId')::bigint;
  for line in select l.*,a.category from opening_balance_lines l join chart_accounts a using(account_id)where l.run_id=rid loop
   if(select load_type from opening_balance_runs where id=rid)='FISCAL_YEAR'and lower(trim(coalesce(line.category,'')))in('ingreso','ingresos','gasto','gastos','costo','costos')then raise exception 'Fila %: las cuentas de resultados solo se permiten en apertura a mitad de período.',line.row_number;end if;
   perform opening_balance_assert_result_dimensions(line.account_id,line.category,line.department_id,line.cost_center_id,line.row_number);
   if line.source_type='AR'then
    entity_customer:=null;entity_department:=null;center_customer:=null;
    select c.customer_id,case when exists(
     select 1 from departments d left join department_subsidiaries ds using(department_id)
     where d.department_id=c.department_id and not d.is_inactive and(d.subsidiary_id=sid or ds.subsidiary_id=sid)
    )then c.department_id end into entity_customer,entity_department from customers c
    where c.tax_id=line.raw_data->>'entityTaxId'and(c.primary_subsidiary_id=sid or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=sid))limit 1;
    if entity_customer is null then raise exception 'CxC fila %: cliente % no encontrado.',line.row_number,line.raw_data->>'entityTaxId';end if;
    if entity_department is not null then
     if line.department_id is null then update opening_balance_lines set department_id=entity_department where id=line.id;
     elsif line.department_id is distinct from entity_department then raise exception 'CxC fila %: el departamento no corresponde al cliente.',line.row_number;
     end if;
    end if;
    if line.cost_center_id is not null then
     select customer_id into center_customer from cost_centers where cost_center_id=line.cost_center_id;
     if center_customer is not null and center_customer is distinct from entity_customer then raise exception 'CxC fila %: el centro de costos no corresponde al cliente.',line.row_number;end if;
    end if;
   end if;
   if line.source_type='AP'and not exists(select 1 from suppliers s where s.tax_id=line.raw_data->>'entityTaxId'and(s.primary_subsidiary_id=sid or exists(select 1 from entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=sid)))then raise exception 'CxP fila %: proveedor % no encontrado.',line.row_number,line.raw_data->>'entityTaxId';end if;
  end loop;
  asset_count:=opening_fixed_asset_stage(rid,coalesce(p->'assets','[]'::jsonb));
  update opening_balance_runs set status='VALIDATED'where id=rid;
 end if;
 if exists(select 1 from opening_balance_lines l join chart_accounts a using(account_id)where l.run_id=rid and(account_belongs_to_group(l.account_id,'deterioro|revaluaci.n')or a.account_name~*'deterioro|revaluaci.n'))then
  raise exception 'La plantilla actual del auxiliar no admite saldos iniciales de revaluación o deterioro. Separe esos ajustes antes de continuar.';
 end if;
 if(exists(select 1 from opening_fixed_asset_lines where run_id=rid)or exists(select 1 from opening_balance_lines l where l.run_id=rid and(fixed_asset_ppe_account(l.account_id)or account_belongs_to_group(l.account_id,'depreciaci.n acumulada'))))and exists(
  select 1 from opening_balance_runs r join asset a on a.subsidiary_id=r.subsidiary_id left join asset_revaluation v on v.asset_id=a.asset_id and v.revaluation_date<=r.opening_date left join asset_impairment i on i.asset_id=a.asset_id and i.assessment_date<=r.opening_date where r.id=rid and(v.revaluation_id is not null or i.impairment_id is not null)
 )then raise exception 'Existen activos con revaluaciones o deterioros anteriores a la apertura. Esta carga debe revisarse antes de conciliar el auxiliar.';end if;
 return opening_balance_preview(rid);
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_is_financial_income(p_account_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select public.account_belongs_to_group(
  p_account_id,
  '(^|[^[:alnum:]])ingresos?[[:space:]]+financieros?([^[:alnum:]]|$)'
 )
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_assert_result_dimensions(p_account_id bigint, p_category text, p_department_id bigint, p_cost_center_id bigint, p_row integer)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
 if p_cost_center_id is null and(
  lower(trim(coalesce(p_category,'')))in('costo','costos')
  or(
   lower(trim(coalesce(p_category,'')))in('ingreso','ingresos')
   and not public.opening_balance_is_financial_income(p_account_id)
  )
 )then
  raise exception 'Libro Mayor fila %: el centro de costos es obligatorio para cuentas de ingreso operativo o costo.',p_row;
 end if;
 if lower(trim(coalesce(p_category,'')))in('gasto','gastos')and p_department_id is null then
  raise exception 'Libro Mayor fila %: el departamento es obligatorio para cuentas de gasto.',p_row;
 end if;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_stage_before_ar_ap_reconciliation(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
 rid bigint;item jsonb;row_number_value integer;account_key bigint;currency_key bigint;
 local_currency bigint;local_debit_value numeric;local_credit_value numeric;
 original_debit_value numeric;original_credit_value numeric;rate numeric;
 department_key bigint;cost_center_key bigint;class_key bigint;creditor_key bigint;related_key bigint;location_key bigint;
 cost_center_type_value text;cost_center_department bigint;cost_center_class bigint;
 sid bigint:=active_subsidiary_id();source_kind text;
begin
 if sid is null then raise exception 'Seleccione una subsidiaria activa.';end if;
 if nullif(p->>'openingDate','')is null then raise exception 'Indique la fecha de apertura.';end if;
 if(p->>'openingDate')::date>current_date then raise exception 'La fecha de apertura no puede ser futura.';end if;
 if p->>'loadType'not in('FISCAL_YEAR','MID_YEAR')then raise exception 'Seleccione un tipo de carga válido.';end if;
 if exists(select 1 from opening_balance_runs where subsidiary_id=sid and status='POSTED')then raise exception 'Ya existe una apertura contabilizada para esta subsidiaria.';end if;
 select currency_id into local_currency from subsidiaries where subsidiary_id=sid;
 delete from opening_balance_runs where subsidiary_id=sid and status in('DRAFT','VALIDATED');
 insert into opening_balance_runs(subsidiary_id,opening_date,load_type,transition_account_id,created_by)
 values(sid,(p->>'openingDate')::date,p->>'loadType',(p->>'transitionAccountId')::bigint,app_user_id())returning id into rid;

 for item in select value from jsonb_array_elements(coalesce(p->'rows','[]'::jsonb))loop
  source_kind:=item->>'sourceType';
  row_number_value:=coalesce(nullif(item->>'sourceRow','')::integer,1+(select count(*)from opening_balance_lines where run_id=rid and source_type=source_kind));
  if source_kind not in('GL','AR','AP')then raise exception 'Fila %: tipo de origen inválido.',row_number_value;end if;
  select a.account_id into account_key from chart_accounts a join account_subsidiaries s using(account_id)
   where a.account_number=item->>'account'and s.subsidiary_id=sid and s.is_active and a.accepts_entries and not a.is_inactive limit 1;
  select c.currency_id into currency_key from currencies c where upper(c.currency_code)=upper(item->>'currency')
   and(c.currency_id=local_currency or exists(select 1 from subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=c.currency_id))limit 1;
  if account_key is null then raise exception '% fila %: la cuenta % no está habilitada para la subsidiaria.',source_kind,row_number_value,coalesce(item->>'account','');end if;
  if currency_key is null then raise exception '% fila %: la moneda % no está habilitada para la subsidiaria.',source_kind,row_number_value,coalesce(item->>'currency','');end if;

  begin
   if source_kind='GL'then
    local_debit_value:=coalesce(nullif(item->>'debit','')::numeric,0);
    local_credit_value:=coalesce(nullif(item->>'credit','')::numeric,0);
    original_debit_value:=coalesce(nullif(item->>'debitFx','')::numeric,case when currency_key=local_currency then local_debit_value else 0 end);
    original_credit_value:=coalesce(nullif(item->>'creditFx','')::numeric,case when currency_key=local_currency then local_credit_value else 0 end);
    if local_debit_value<0 or local_credit_value<0 or original_debit_value<0 or original_credit_value<0 then raise exception 'los importes no pueden ser negativos';end if;
    if(local_debit_value>0)=(local_credit_value>0)then raise exception 'indique únicamente débito o crédito en moneda local';end if;
    if(original_debit_value>0)=(original_credit_value>0)then raise exception 'indique únicamente débito o crédito en moneda original';end if;
    if(local_debit_value>0)<>(original_debit_value>0)then raise exception 'el débito/crédito local y original deben estar en el mismo lado';end if;
    if currency_key=local_currency and abs(greatest(original_debit_value,original_credit_value)-greatest(local_debit_value,local_credit_value))>.000001 then raise exception 'para la moneda local, el importe original debe coincidir con el importe local';end if;
    rate:=greatest(local_debit_value,local_credit_value)/nullif(greatest(original_debit_value,original_credit_value),0);
   else
    -- CxC/CxP retain their existing template contract: debit/credit is the
    -- pending amount in the document currency and is converted at opening.
    original_debit_value:=coalesce(nullif(item->>'debit','')::numeric,0);
    original_credit_value:=coalesce(nullif(item->>'credit','')::numeric,0);
    if original_debit_value<0 or original_credit_value<0 then raise exception 'los importes no pueden ser negativos';end if;
    if(original_debit_value>0)=(original_credit_value>0)then raise exception 'indique únicamente débito o crédito';end if;
    rate:=opening_balance_rate(currency_key,(p->>'openingDate')::date);
    local_debit_value:=original_debit_value*rate;
    local_credit_value:=original_credit_value*rate;
   end if;
  exception when invalid_text_representation or numeric_value_out_of_range or division_by_zero then
   raise exception '% fila %: revise los importes locales y originales.',source_kind,row_number_value;
  end;
  if rate is null or rate<=0 then raise exception '% fila %: la equivalencia local/original debe producir una tasa histórica positiva.',source_kind,row_number_value;end if;

  department_key:=opening_balance_dimension_id('department',item->>'department',sid);
  cost_center_key:=opening_balance_dimension_id('costCenter',item->>'costCenter',sid);
  class_key:=opening_balance_dimension_id('class',item->>'className',sid);
  creditor_key:=opening_balance_dimension_id('financialCreditor',item->>'financialCreditor',sid);
  related_key:=opening_balance_dimension_id('relatedCompany',item->>'relatedCompany',sid);
  location_key:=opening_balance_dimension_id('location',item->>'location',sid);

  -- Keep the analytical hierarchy coherent. Client cost centers inherit their
  -- customer's department; a cost center with a configured class also owns
  -- that class. Internal centers may be combined with an explicit department.
  if cost_center_key is not null then
   select cc.cost_center_type,cu.department_id,cc.class_id
    into cost_center_type_value,cost_center_department,cost_center_class
   from cost_centers cc left join customers cu using(customer_id)
   where cc.cost_center_id=cost_center_key;
   if cost_center_type_value='CLIENTE'then
    if department_key is null then department_key:=cost_center_department;end if;
    if department_key is null or department_key is distinct from cost_center_department then
     raise exception '% fila %: el centro de costos no corresponde al departamento.',source_kind,row_number_value;
    end if;
   end if;
   if cost_center_class is not null then
    if class_key is not null and class_key is distinct from cost_center_class then
     raise exception '% fila %: la clase no corresponde al centro de costos.',source_kind,row_number_value;
    end if;
    class_key:=cost_center_class;
   elsif class_key is not null then
    raise exception '% fila %: el centro de costos seleccionado no tiene asignada la clase indicada.',source_kind,row_number_value;
   end if;
  elsif class_key is not null then
   raise exception '% fila %: indique un centro de costos para asignar la clase.',source_kind,row_number_value;
  end if;

  insert into opening_balance_lines(
   run_id,source_type,row_number,account_id,document_number,issue_date,due_date,currency_id,historical_rate,foreign_amount,
   local_debit,local_credit,department_id,cost_center_id,class_id,financial_creditor_id,related_company_id,location_id,project_code,note,raw_data
  )values(
   rid,source_kind,row_number_value,account_key,nullif(item->>'documentNumber',''),nullif(item->>'issueDate','')::date,nullif(item->>'dueDate','')::date,
   currency_key,rate,greatest(original_debit_value,original_credit_value),local_debit_value,local_credit_value,
   department_key,cost_center_key,class_key,creditor_key,related_key,location_key,null,nullif(item->>'note',''),item-'project'
  );
 end loop;
 return(select jsonb_build_object('runId',rid,'rows',count(*),'debit',coalesce(sum(local_debit),0),'credit',coalesce(sum(local_credit),0),'difference',coalesce(sum(local_debit-local_credit),0))from opening_balance_lines where run_id=rid);
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_dimension_id(p_kind text, p_value text, p_subsidiary_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  value_text text:=nullif(btrim(p_value),'');
  explicit_id bigint;
  matches integer:=0;
  result_id bigint;
  label text;
begin
  if value_text is null then return null;end if;
  if value_text~*'^ID:[0-9]+$'then explicit_id:=substring(value_text from 4)::bigint;end if;

  case p_kind
   when 'department' then
    label:='Departamento';
    select count(distinct d.department_id),min(d.department_id)into matches,result_id
    from departments d
    where(d.subsidiary_id=p_subsidiary_id or exists(select 1 from department_subsidiaries x where x.department_id=d.department_id and x.subsidiary_id=p_subsidiary_id))
      and not d.is_inactive
      and(case when explicit_id is not null then d.department_id=explicit_id else lower(d.name)=lower(value_text)end);
   when 'costCenter' then
    label:='Centro de costos';
    select count(*),min(c.cost_center_id)into matches,result_id
    from cost_centers c
    where c.subsidiary_id=p_subsidiary_id and not c.is_inactive
      and(case when explicit_id is not null then c.cost_center_id=explicit_id else lower(c.code)=lower(value_text)or lower(c.name)=lower(value_text)end);
   when 'class' then
    label:='Clase';
    select count(distinct c.class_id),min(c.class_id)into matches,result_id
    from classes c
    where(c.subsidiary_id=p_subsidiary_id or exists(select 1 from class_subsidiaries x where x.class_id=c.class_id and x.subsidiary_id=p_subsidiary_id))
      and not c.is_inactive
      and(case when explicit_id is not null then c.class_id=explicit_id else lower(c.name)=lower(value_text)end);
   when 'financialCreditor' then
    label:='Acreedor financiero';
    select count(distinct c.financial_creditor_id),min(c.financial_creditor_id)into matches,result_id
    from financial_creditors c
    where(c.subsidiary_id=p_subsidiary_id or exists(select 1 from financial_creditor_subsidiaries x where x.financial_creditor_id=c.financial_creditor_id and x.subsidiary_id=p_subsidiary_id))
      and not c.is_inactive
      and(case when explicit_id is not null then c.financial_creditor_id=explicit_id else lower(c.code)=lower(value_text)or lower(c.name)=lower(value_text)or lower(c.identification)=lower(value_text)end);
   when 'relatedCompany' then
    label:='Compañía relacionada';
    select count(distinct c.related_company_id),min(c.related_company_id)into matches,result_id
    from related_companies c
    where(c.subsidiary_id=p_subsidiary_id or exists(select 1 from related_company_subsidiaries x where x.related_company_id=c.related_company_id and x.subsidiary_id=p_subsidiary_id))
      and not c.is_inactive
      and(case when explicit_id is not null then c.related_company_id=explicit_id else lower(c.code)=lower(value_text)or lower(c.name)=lower(value_text)or lower(c.identification)=lower(value_text)end);
   when 'location' then
    label:='Ubicación / sucursal';
    select count(distinct l.location_id),min(l.location_id)into matches,result_id
    from locations l
    where(l.subsidiary_id=p_subsidiary_id or exists(select 1 from location_subsidiaries x where x.location_id=l.location_id and x.subsidiary_id=p_subsidiary_id))
      and(case when explicit_id is not null then l.location_id=explicit_id else lower(l.name)=lower(value_text)end);
   else raise exception 'Dimensión de apertura no permitida: %.',p_kind;
  end case;

  if matches<>1 then
   raise exception '% "%" no existe, está inactivo, no pertenece a la subsidiaria o es ambiguo. Use código, nombre exacto o ID:identificador.',label,value_text;
  end if;
  return result_id;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_preview_before_opening_pending(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;
begin
 perform opening_balance_assert_access('view');
 select jsonb_build_object(
  'run',to_jsonb(r),
  'rows',coalesce((select jsonb_agg(jsonb_build_object(
   'id',l.id,'sourceType',l.source_type,'row',l.row_number,'account',a.account_number||' · '||a.account_name,'document',l.document_number,
   'currency',c.currency_code,'rate',l.historical_rate,'foreignAmount',l.foreign_amount,
   'debitFx',case when l.local_debit>0 then l.foreign_amount else 0 end,'creditFx',case when l.local_credit>0 then l.foreign_amount else 0 end,
   'debit',l.local_debit,'credit',l.local_credit,'department',d.name,'costCenter',case when cc.cost_center_id is null then null else cc.code||' · '||cc.name end,
   'className',cl.name,'financialCreditor',fc.name,'relatedCompany',rc.name,'location',lo.name,'note',l.note
  )order by l.source_type,l.row_number)
  from opening_balance_lines l join chart_accounts a on a.account_id=l.account_id join currencies c on c.currency_id=l.currency_id
  left join departments d on d.department_id=l.department_id left join cost_centers cc on cc.cost_center_id=l.cost_center_id
  left join classes cl on cl.class_id=l.class_id left join financial_creditors fc on fc.financial_creditor_id=l.financial_creditor_id
  left join related_companies rc on rc.related_company_id=l.related_company_id left join locations lo on lo.location_id=l.location_id
  where l.run_id=r.id),'[]'::jsonb),
  'summary',(select jsonb_build_object('debit',coalesce(sum(local_debit),0),'credit',coalesce(sum(local_credit),0),'difference',coalesce(sum(local_debit-local_credit),0),'count',count(*))from opening_balance_lines where run_id=r.id),
  'assets',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'row',f.row_number,'number',f.asset_number,'name',f.asset_name,'serial',f.serial_number,'categoryCode',c.category_code,'category',c.category_name,'location',l.name,'purchaseDate',f.purchase_date,'serviceDate',f.in_service_date,'cost',f.purchase_cost,'accumulated',f.accumulated_depreciation,'bookValue',f.book_value_control,'depreciatedMonths',f.depreciated_months,'department',d.name,'costCenter',cc.code||' · '||cc.name,'className',cl.name,'status',f.status,'created',f.created_asset_id is not null)order by f.row_number)from opening_fixed_asset_lines f join asset_category c on c.category_id=f.category_id join locations l on l.location_id=f.location_id left join departments d on d.department_id=f.department_id left join cost_centers cc on cc.cost_center_id=f.cost_center_id left join classes cl on cl.class_id=f.class_id where f.run_id=r.id),'[]'::jsonb),
  'assetReconciliation',opening_fixed_asset_reconciliation(r.id),
  'assetSummary',(select jsonb_build_object('count',count(*),'cost',coalesce(sum(purchase_cost),0),'accumulated',coalesce(sum(accumulated_depreciation),0),'bookValue',coalesce(sum(book_value_control),0),'pending',count(*)filter(where created_asset_id is null),'created',count(*)filter(where created_asset_id is not null),'balanced',coalesce((select bool_and(abs((x->>'difference')::numeric)<=.005)from jsonb_array_elements(opening_fixed_asset_reconciliation(r.id))x),true))from opening_fixed_asset_lines where run_id=r.id)
 )into result from opening_balance_runs r where r.id=p_run_id and r.subsidiary_id=active_subsidiary_id();
 return result;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_ar_ap_apply_historical_values(p_run_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  run_row public.opening_balance_runs%rowtype;
  local_currency_key bigint;
  line_row public.opening_balance_lines%rowtype;
  group_row record;
  missing_row record;
  local_text text;
  rate_text text;
  explicit_local numeric;
  explicit_rate numeric;
  ledger_local numeric;
  explicit_total numeric;
  missing_original numeric;
  inferred_rate numeric;
  allocated numeric;
  allocated_total numeric;
  missing_count integer;
  sequence_value integer;
  account_number_value text;
  entity_key bigint;
  expected_account_key bigint;
  invoice_type_value text;
begin
  select * into run_row from public.opening_balance_runs where id=p_run_id;
  if run_row.id is null then raise exception 'Lote de apertura no encontrado.';end if;
  select currency_id into local_currency_key from public.subsidiaries
  where subsidiary_id=run_row.subsidiary_id;

  for line_row in
    select * from public.opening_balance_lines
    where run_id=p_run_id and source_type in('AR','AP') order by id
  loop
    select account_number into account_number_value from public.chart_accounts
    where account_id=line_row.account_id;
    if line_row.source_type='AR'and account_number_value not in('113001','113002')then
      raise exception 'CxC fila %: use una cuenta de control permitida (113001 o 113002).',line_row.row_number;
    end if;
    if line_row.source_type='AP'and account_number_value not in('211001','211002','211003','211004')then
      raise exception 'CxP fila %: use una cuenta de control permitida (211001, 211002, 211003 o 211004).',line_row.row_number;
    end if;
    if line_row.source_type='AR'then
      select customer.customer_id into entity_key from public.customers customer
      where customer.tax_id=line_row.raw_data->>'entityTaxId'and(
       customer.primary_subsidiary_id=run_row.subsidiary_id or exists(
        select 1 from public.entity_subsidiaries scope where scope.customer_id=customer.customer_id
         and scope.subsidiary_id=run_row.subsidiary_id
       )
      )limit 1;
      if entity_key is null then
       raise exception 'CxC fila %: cliente % no encontrado.',line_row.row_number,line_row.raw_data->>'entityTaxId';
      end if;
      expected_account_key:=public.resolve_customer_receivable_account(run_row.subsidiary_id,entity_key);
      if line_row.account_id is distinct from expected_account_key then
       raise exception 'CxC fila %: la cuenta no corresponde a la clasificación normal/intercompany del cliente.',line_row.row_number;
      end if;
    else
      select supplier.supplier_id into entity_key from public.suppliers supplier
      where supplier.tax_id=line_row.raw_data->>'entityTaxId'and(
       supplier.primary_subsidiary_id=run_row.subsidiary_id or exists(
        select 1 from public.entity_subsidiaries scope where scope.supplier_id=supplier.supplier_id
         and scope.subsidiary_id=run_row.subsidiary_id
       )
      )limit 1;
      if entity_key is null then
       raise exception 'CxP fila %: proveedor % no encontrado.',line_row.row_number,line_row.raw_data->>'entityTaxId';
      end if;
      invoice_type_value:=case account_number_value when'211003'then'Factura Expense'
       when'211004'then'Factura Caja Chica'else'Factura estándar'end;
      expected_account_key:=public.resolve_supplier_payable_account(
       run_row.subsidiary_id,entity_key,invoice_type_value
      );
      if line_row.account_id is distinct from expected_account_key then
       raise exception 'CxP fila %: la cuenta no corresponde al tipo de factura o a la clasificación normal/intercompany del proveedor.',line_row.row_number;
      end if;
    end if;
    if line_row.foreign_amount<=0 then
      raise exception '% fila %: el saldo debe ser mayor que cero.',
        case line_row.source_type when'AR'then'CxC'else'CxP'end,line_row.row_number;
    end if;
    if line_row.source_type='AR'and(line_row.local_debit<=0 or line_row.local_credit<>0)then
      raise exception 'CxC fila %: el saldo debe registrarse al débito.',line_row.row_number;
    end if;
    if line_row.source_type='AP'and(line_row.local_credit<=0 or line_row.local_debit<>0)then
      raise exception 'CxP fila %: el saldo debe registrarse al crédito.',line_row.row_number;
    end if;

    local_text:=nullif(btrim(coalesce(
      line_row.raw_data->>'localEquivalent',
      line_row.raw_data->>'equivalente_moneda_local',
      line_row.raw_data->>'local_equivalent',''
    )), '');
    rate_text:=nullif(btrim(coalesce(
      line_row.raw_data->>'historicalRate',
      line_row.raw_data->>'tipo_cambio_historico',
      line_row.raw_data->>'historical_rate',''
    )), '');
    begin
      explicit_local:=local_text::numeric;
      explicit_rate:=rate_text::numeric;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception '% fila %: equivalente_moneda_local y tipo_cambio_historico deben ser numéricos.',
        case line_row.source_type when'AR'then'CxC'else'CxP'end,line_row.row_number;
    end;
    if explicit_local is not null and explicit_local<=0 then
      raise exception '% fila %: equivalente_moneda_local debe ser mayor que cero.',
        case line_row.source_type when'AR'then'CxC'else'CxP'end,line_row.row_number;
    end if;
    if explicit_rate is not null and explicit_rate<=0 then
      raise exception '% fila %: tipo_cambio_historico debe ser mayor que cero.',
        case line_row.source_type when'AR'then'CxC'else'CxP'end,line_row.row_number;
    end if;

    if line_row.currency_id=local_currency_key then
      if explicit_local is not null and abs(explicit_local-line_row.foreign_amount)>.005 then
        raise exception '% fila %: en moneda local el equivalente debe coincidir con el saldo.',
          case line_row.source_type when'AR'then'CxC'else'CxP'end,line_row.row_number;
      end if;
      if explicit_rate is not null and abs(explicit_rate-1)>.0000000001 then
        raise exception '% fila %: en moneda local el tipo de cambio histórico debe ser 1.',
          case line_row.source_type when'AR'then'CxC'else'CxP'end,line_row.row_number;
      end if;
      update public.opening_balance_lines set historical_rate=1,opening_rate_source='LOCAL_CURRENCY',
        local_debit=case when source_type='AR'then foreign_amount else 0 end,
        local_credit=case when source_type='AP'then foreign_amount else 0 end,
        raw_data=raw_data||jsonb_build_object('historicalRateSource','LOCAL_CURRENCY',
         'historicalRateApplied',1,'localEquivalentApplied',foreign_amount)
      where id=line_row.id;
    elsif explicit_local is not null or explicit_rate is not null then
      if explicit_local is null then explicit_local:=round(line_row.foreign_amount*explicit_rate,6);end if;
      if explicit_rate is null then explicit_rate:=explicit_local/line_row.foreign_amount;end if;
      if abs(round(line_row.foreign_amount*explicit_rate,2)-round(explicit_local,2))>.005 then
        raise exception '% fila %: el saldo, el equivalente local y la tasa histórica no coinciden.',
          case line_row.source_type when'AR'then'CxC'else'CxP'end,line_row.row_number;
      end if;
      update public.opening_balance_lines set historical_rate=explicit_local/foreign_amount,
        opening_rate_source=case when local_text is not null and rate_text is not null then'EXPLICIT_LOCAL_AND_RATE'
          when local_text is not null then'EXPLICIT_LOCAL'else'EXPLICIT_RATE'end,
        local_debit=case when source_type='AR'then round(explicit_local,6)else 0 end,
        local_credit=case when source_type='AP'then round(explicit_local,6)else 0 end,
        raw_data=raw_data||jsonb_build_object(
         'historicalRateSource',case when local_text is not null and rate_text is not null then'EXPLICIT_LOCAL_AND_RATE'
          when local_text is not null then'EXPLICIT_LOCAL'else'EXPLICIT_RATE'end,
         'historicalRateApplied',explicit_local/foreign_amount,'localEquivalentApplied',round(explicit_local,6))
      where id=line_row.id;
    end if;
  end loop;

  if exists(
   select 1 from public.opening_balance_lines auxiliary
   where auxiliary.run_id=p_run_id and auxiliary.source_type in('AR','AP')and not exists(
    select 1 from public.opening_balance_lines ledger
    where ledger.run_id=auxiliary.run_id and ledger.source_type='GL'
     and ledger.account_id=auxiliary.account_id and ledger.currency_id=auxiliary.currency_id
   )
  )then
   select auxiliary.* into line_row from public.opening_balance_lines auxiliary
   where auxiliary.run_id=p_run_id and auxiliary.source_type in('AR','AP')and not exists(
    select 1 from public.opening_balance_lines ledger
    where ledger.run_id=auxiliary.run_id and ledger.source_type='GL'
     and ledger.account_id=auxiliary.account_id and ledger.currency_id=auxiliary.currency_id
   )order by auxiliary.source_type,auxiliary.row_number limit 1;
   raise exception '% fila %: no existe una línea del Libro Mayor para la misma cuenta y moneda.',
    case line_row.source_type when'AR'then'CxC'else'CxP'end,line_row.row_number;
  end if;

  -- Allocate only rows that supplied neither historical field.  The last row
  -- receives the rounding residual, making the group equal to the GL cents.
  for group_row in
    select source_type,account_id,currency_id
    from public.opening_balance_lines
    where run_id=p_run_id and source_type in('AR','AP')and currency_id<>local_currency_key
    group by source_type,account_id,currency_id
  loop
    select count(*),coalesce(sum(line.foreign_amount),0)
      into missing_count,missing_original
    from public.opening_balance_lines line
    where line.run_id=p_run_id and line.source_type=group_row.source_type
      and line.account_id=group_row.account_id and line.currency_id=group_row.currency_id
      and nullif(btrim(coalesce(line.raw_data->>'localEquivalent',line.raw_data->>'equivalente_moneda_local',line.raw_data->>'local_equivalent','')),'')is null
      and nullif(btrim(coalesce(line.raw_data->>'historicalRate',line.raw_data->>'tipo_cambio_historico',line.raw_data->>'historical_rate','')),'')is null;
    if missing_count=0 then continue;end if;

    select coalesce(sum(case group_row.source_type when'AR'then line.local_debit-line.local_credit
      else line.local_credit-line.local_debit end),0)
      into explicit_total
    from public.opening_balance_lines line
    where line.run_id=p_run_id and line.source_type=group_row.source_type
      and line.account_id=group_row.account_id and line.currency_id=group_row.currency_id
      and not(
       nullif(btrim(coalesce(line.raw_data->>'localEquivalent',line.raw_data->>'equivalente_moneda_local',line.raw_data->>'local_equivalent','')),'')is null
       and nullif(btrim(coalesce(line.raw_data->>'historicalRate',line.raw_data->>'tipo_cambio_historico',line.raw_data->>'historical_rate','')),'')is null
      );

    select sum(case group_row.source_type when'AR'then line.local_debit-line.local_credit
      else line.local_credit-line.local_debit end)
      into ledger_local
    from public.opening_balance_lines line
    where line.run_id=p_run_id and line.source_type='GL'
      and line.account_id=group_row.account_id and line.currency_id=group_row.currency_id;

    if ledger_local-explicit_total<=0 then
      raise exception '%: los equivalentes locales informados superan el saldo del Mayor para la cuenta % y moneda %.',
        case group_row.source_type when'AR'then'CxC'else'CxP'end,
        (select account_number from public.chart_accounts where account_id=group_row.account_id),
        (select currency_code from public.currencies where currency_id=group_row.currency_id);
    end if;
    inferred_rate:=(ledger_local-explicit_total)/missing_original;
    if inferred_rate is null or inferred_rate<=0 then
      raise exception 'No fue posible determinar una tasa histórica positiva para el auxiliar.';
    end if;

    allocated_total:=0;sequence_value:=0;
    for missing_row in
      select line.id,line.foreign_amount,line.source_type,
        row_number()over(order by line.id)sequence,
        count(*)over()total_rows
      from public.opening_balance_lines line
      where line.run_id=p_run_id and line.source_type=group_row.source_type
        and line.account_id=group_row.account_id and line.currency_id=group_row.currency_id
        and nullif(btrim(coalesce(line.raw_data->>'localEquivalent',line.raw_data->>'equivalente_moneda_local',line.raw_data->>'local_equivalent','')),'')is null
        and nullif(btrim(coalesce(line.raw_data->>'historicalRate',line.raw_data->>'tipo_cambio_historico',line.raw_data->>'historical_rate','')),'')is null
      order by line.id
    loop
      sequence_value:=sequence_value+1;
      if ledger_local is not null and missing_row.sequence=missing_row.total_rows then
        allocated:=round(ledger_local-explicit_total-allocated_total,6);
      else
        allocated:=round(missing_row.foreign_amount*inferred_rate,6);
      end if;
      if allocated<=0 then raise exception 'La distribución histórica produjo un importe no positivo.';end if;
      update public.opening_balance_lines set historical_rate=allocated/foreign_amount,
        opening_rate_source='GL_RESIDUAL',
        local_debit=case when source_type='AR'then allocated else 0 end,
        local_credit=case when source_type='AP'then allocated else 0 end,
        raw_data=raw_data||jsonb_build_object('historicalRateSource','GL_RESIDUAL',
         'historicalRateApplied',allocated/foreign_amount,'localEquivalentApplied',allocated)
      where id=missing_row.id;
      allocated_total:=allocated_total+allocated;
    end loop;
  end loop;
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_ar_ap_reconciliation(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with auxiliary as(
 select line.source_type,line.account_id,line.currency_id,
  sum(case line.source_type when'AR'then line.local_debit-line.local_credit else line.local_credit-line.local_debit end)auxiliary_local,
  sum(line.foreign_amount)auxiliary_original,count(*)document_count
 from public.opening_balance_lines line
 where line.run_id=p_run_id and line.source_type in('AR','AP')
 group by line.source_type,line.account_id,line.currency_id
),live_ledger as(
 select line.account_id,line.currency_id,
  sum(line.local_debit-line.local_credit)signed_local,
  sum(case when line.local_debit>0 then line.foreign_amount else-line.foreign_amount end)signed_original
 from public.opening_balance_lines line
 where line.run_id=p_run_id and line.source_type='GL'
 group by line.account_id,line.currency_id
),standard_keys as(
 select case when account.account_number in('113001','113002')then'AR'else'AP'end source_type,
  ledger.account_id,ledger.currency_id
 from live_ledger ledger join public.chart_accounts account using(account_id)
 where account.account_number in('113001','113002','211001','211002','211003','211004')
 union
 select snapshot.source_type,snapshot.account_id,snapshot.currency_id
 from public.opening_ar_ap_gl_control_lines snapshot where snapshot.run_id=p_run_id
),keys as(
 select source_type,account_id,currency_id from auxiliary
 union select source_type,account_id,currency_id from standard_keys
),ledger as(
 select key.source_type,key.account_id,key.currency_id,
  coalesce(sum(case key.source_type when'AR'then line.local_debit-line.local_credit else line.local_credit-line.local_debit end),0)ledger_local,
  coalesce(sum(case key.source_type
    when'AR'then case when line.local_debit>0 then line.foreign_amount else-line.foreign_amount end
    else case when line.local_credit>0 then line.foreign_amount else-line.foreign_amount end
   end)filter(where line.id is not null),0)ledger_original
 from keys key left join public.opening_balance_lines line
  on line.run_id=p_run_id and line.source_type='GL'and line.account_id=key.account_id and line.currency_id=key.currency_id
 group by key.source_type,key.account_id,key.currency_id
 union all
 select snapshot.source_type,snapshot.account_id,snapshot.currency_id,
  sum(case snapshot.source_type when'AR'then snapshot.local_debit-snapshot.local_credit else snapshot.local_credit-snapshot.local_debit end),
  sum(case snapshot.source_type
    when'AR'then case when snapshot.local_debit>0 then snapshot.foreign_amount else-snapshot.foreign_amount end
    else case when snapshot.local_credit>0 then snapshot.foreign_amount else-snapshot.foreign_amount end
   end)
 from public.opening_ar_ap_gl_control_lines snapshot where snapshot.run_id=p_run_id
 group by snapshot.source_type,snapshot.account_id,snapshot.currency_id
),ledger_grouped as(
 select source_type,account_id,currency_id,sum(ledger_local)ledger_local,sum(ledger_original)ledger_original
 from ledger group by source_type,account_id,currency_id
),rows as(
 select key.source_type,key.account_id,key.currency_id,account.account_number,account.account_name,currency.currency_code,
  coalesce(ledger.ledger_local,0)ledger_local,coalesce(auxiliary.auxiliary_local,0)auxiliary_local,
  coalesce(ledger.ledger_original,0)ledger_original,coalesce(auxiliary.auxiliary_original,0)auxiliary_original,
  coalesce(auxiliary.document_count,0)document_count
 from keys key
 join public.chart_accounts account on account.account_id=key.account_id
 join public.currencies currency on currency.currency_id=key.currency_id
 left join ledger_grouped ledger on ledger.source_type=key.source_type
  and ledger.account_id=key.account_id and ledger.currency_id=key.currency_id
 left join auxiliary on auxiliary.source_type=key.source_type
  and auxiliary.account_id=key.account_id and auxiliary.currency_id=key.currency_id
)
select coalesce(jsonb_agg(jsonb_build_object(
 'sourceType',source_type,'accountId',account_id,'accountNumber',account_number,'accountName',account_name,
 'currencyId',currency_id,'currency',currency_code,'documentCount',document_count,
 'ledgerLocal',round(ledger_local,6),'auxiliaryLocal',round(auxiliary_local,6),
 'localDifference',round(ledger_local-auxiliary_local,6),
 'ledgerOriginal',round(ledger_original,6),'auxiliaryOriginal',round(auxiliary_original,6),
 'originalDifference',round(ledger_original-auxiliary_original,6),
 'balanced',abs(ledger_local-auxiliary_local)<=.005 and abs(ledger_original-auxiliary_original)<=.005
 )order by source_type,account_number,currency_code),'[]'::jsonb)
from rows
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_effective_summary(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with effective as(
 select line.local_debit,line.local_credit
 from public.opening_balance_lines line
 where line.run_id=p_run_id and(
  line.source_type<>'GL'or not exists(
   select 1 from public.opening_balance_lines auxiliary
   where auxiliary.run_id=line.run_id and auxiliary.source_type in('AR','AP')
    and auxiliary.account_id=line.account_id and auxiliary.currency_id=line.currency_id
  )
 )
)
select jsonb_build_object('debit',coalesce(sum(local_debit),0),'credit',coalesce(sum(local_credit),0),
 'difference',coalesce(sum(local_debit-local_credit),0),'count',count(*))from effective
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_stage(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;run_key bigint;summary jsonb;
begin
 result:=public.opening_balance_stage_before_ar_ap_reconciliation(p);
 run_key:=(result->>'runId')::bigint;
 perform public.opening_ar_ap_apply_historical_values(run_key);
 summary:=public.opening_balance_effective_summary(run_key);
 return result||jsonb_build_object('rows',summary->'count','debit',summary->'debit',
  'credit',summary->'credit','difference',summary->'difference');
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_preview(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base jsonb;reconciliation jsonb;summary jsonb;filtered_rows jsonb;
begin
 base:=public.opening_balance_preview_before_ar_ap_reconciliation(p_run_id);
 if base is null then return null;end if;
 reconciliation:=public.opening_ar_ap_reconciliation(p_run_id);
 summary:=public.opening_balance_effective_summary(p_run_id);
 select coalesce(jsonb_agg(
   case when item->>'sourceType'in('AR','AP')then item||jsonb_build_object(
    'rateSource',(select line.opening_rate_source from public.opening_balance_lines line
     where line.id=nullif(item->>'id','')::bigint),
    'rateSourceLabel',(select case line.opening_rate_source
      when'LOCAL_CURRENCY'then'Moneda local'
      when'EXPLICIT_LOCAL_AND_RATE'then'Tasa informada'
      when'EXPLICIT_LOCAL'then'Tasa informada'
      when'EXPLICIT_RATE'then'Tasa informada'
      when'GL_RESIDUAL'then'Inferida del Mayor'
      else'Sin identificar'end
     from public.opening_balance_lines line where line.id=nullif(item->>'id','')::bigint)
   )else item end order by ordinality
 ),'[]'::jsonb)into filtered_rows
 from jsonb_array_elements(coalesce(base->'rows','[]'::jsonb))with ordinality source(item,ordinality)
 where not(
  item->>'sourceType'='GL'and exists(
   select 1 from public.opening_balance_lines ledger
   where ledger.id=nullif(item->>'id','')::bigint and exists(
    select 1 from public.opening_balance_lines auxiliary
    where auxiliary.run_id=ledger.run_id and auxiliary.source_type in('AR','AP')
     and auxiliary.account_id=ledger.account_id and auxiliary.currency_id=ledger.currency_id
   )
  )
 );
 return jsonb_set(jsonb_set(base,'{rows}',filtered_rows,true),'{summary}',summary,true)
  ||jsonb_build_object(
   'arApReconciliation',reconciliation,
   'arReconciliation',coalesce((select jsonb_agg(value)from jsonb_array_elements(reconciliation)value where value->>'sourceType'='AR'),'[]'::jsonb),
   'apReconciliation',coalesce((select jsonb_agg(value)from jsonb_array_elements(reconciliation)value where value->>'sourceType'='AP'),'[]'::jsonb),
   'arApSummary',jsonb_build_object(
    'documents',(select count(*)from public.opening_balance_lines where run_id=p_run_id and source_type in('AR','AP')),
    'balanced',coalesce((select bool_and((value->>'balanced')::boolean)from jsonb_array_elements(reconciliation)value),true),
    'arDocuments',(select count(*)from public.opening_balance_lines where run_id=p_run_id and source_type='AR'),
    'apDocuments',(select count(*)from public.opening_balance_lines where run_id=p_run_id and source_type='AP')
   )
  );
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_ar_ap_archive_control_lines(p_run_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare archived integer:=0;
begin
 perform public.opening_ar_ap_assert_reconciled(p_run_id);
 insert into public.opening_ar_ap_gl_control_lines(
  run_id,original_line_id,source_type,row_number,account_id,currency_id,historical_rate,foreign_amount,
  local_debit,local_credit,department_id,cost_center_id,class_id,financial_creditor_id,related_company_id,
  location_id,opening_rate_source,note,raw_data
 )
 select ledger.run_id,ledger.id,min(auxiliary.source_type),ledger.row_number,ledger.account_id,ledger.currency_id,
  ledger.historical_rate,ledger.foreign_amount,ledger.local_debit,ledger.local_credit,ledger.department_id,
  ledger.cost_center_id,ledger.class_id,ledger.financial_creditor_id,ledger.related_company_id,ledger.location_id,
  ledger.opening_rate_source,ledger.note,ledger.raw_data
 from public.opening_balance_lines ledger join public.opening_balance_lines auxiliary
  on auxiliary.run_id=ledger.run_id and auxiliary.source_type in('AR','AP')
   and auxiliary.account_id=ledger.account_id and auxiliary.currency_id=ledger.currency_id
 where ledger.run_id=p_run_id and ledger.source_type='GL'
 group by ledger.id
 on conflict(run_id,original_line_id)do nothing;
 get diagnostics archived=row_count;
 delete from public.opening_balance_lines ledger
 where ledger.run_id=p_run_id and ledger.source_type='GL'and exists(
  select 1 from public.opening_ar_ap_gl_control_lines snapshot
  where snapshot.run_id=ledger.run_id and snapshot.original_line_id=ledger.id
 );
 return archived;
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_post_before_ar_ap_reconciliation(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare run_row public.opening_balance_runs%rowtype;result jsonb;has_bank boolean;has_other boolean;created_count integer:=0;
begin
 perform public.opening_balance_assert_access('create');
 select *into run_row from public.opening_balance_runs where id=p_run_id and subsidiary_id=public.active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'Lote no disponible.';end if;
 has_bank:=exists(select 1 from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  where account.run_id=p_run_id and account.opening_reversed_at is null and item.created_bank_tran_id is null);
 has_other:=exists(select 1 from public.opening_fixed_asset_lines where run_id=p_run_id and created_asset_id is null)
  or exists(select 1 from public.opening_pending_invoice_items where run_id=p_run_id and not is_active);
 if exists(select 1 from public.opening_bank_accounts where run_id=p_run_id and opening_reversed_at is null)
  or run_row.status<>'POSTED'then perform public.opening_bank_assert_reconciled(p_run_id);end if;
 if run_row.status='POSTED'and not has_other then
  result:=jsonb_build_object('runId',run_row.id,'journalId',run_row.journal_id,
   'journalNumber',(select journal_number from public.journal where journal_id=run_row.journal_id),
   'bankOnly',has_bank or exists(select 1 from public.opening_bank_accounts where run_id=p_run_id));
 else
  result:=public.opening_balance_post_before_opening_bank(p_run_id);
 end if;
 if exists(select 1 from public.opening_bank_accounts account join public.opening_bank_items item on item.opening_bank_account_id=account.id
  where account.run_id=p_run_id and account.opening_reversed_at is null and item.created_bank_tran_id is null)then
  created_count:=public.opening_bank_activate(p_run_id);
 end if;
 return result||jsonb_build_object('bankItemsCreated',created_count,'bankOnly',coalesce((result->>'bankOnly')::boolean,false));
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_post(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare run_row public.opening_balance_runs%rowtype;result jsonb;archived integer:=0;
begin
 perform public.opening_balance_assert_access('create');
 select *into run_row from public.opening_balance_runs
 where id=p_run_id and subsidiary_id=public.active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'Lote no disponible.';end if;
 if run_row.status='VALIDATED'then
  perform public.opening_ar_ap_assert_account_routing(p_run_id);
  perform public.opening_ar_ap_assert_reconciled(p_run_id);
  archived:=public.opening_ar_ap_archive_control_lines(p_run_id);
 end if;
 result:=public.opening_balance_post_before_ar_ap_reconciliation(p_run_id);

 update public.invoice invoice set receivable_account_id=line.account_id
 from public.opening_balance_lines line
 where invoice.opening_run_id=p_run_id and invoice.opening_balance_line_id=line.id
  and line.source_type='AR'and invoice.receivable_account_id is distinct from line.account_id;
 update public.supplier_invoice invoice set payable_account_id=line.account_id,
  invoice_type=case account.account_number when'211003'then'Factura Expense'
    when'211004'then'Factura Caja Chica'else'Factura estándar'end
 from public.opening_balance_lines line join public.chart_accounts account using(account_id)
 where invoice.opening_run_id=p_run_id and invoice.opening_balance_line_id=line.id
  and line.source_type='AP'and(
   invoice.payable_account_id is distinct from line.account_id
   or invoice.invoice_type is distinct from case account.account_number when'211003'then'Factura Expense'
      when'211004'then'Factura Caja Chica'else'Factura estándar'end
  );

 return result||jsonb_build_object('arApControlLinesReplaced',archived,
  'arApReconciliation',public.opening_ar_ap_reconciliation(p_run_id));
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_ar_ap_assert_account_routing(p_run_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  run_row public.opening_balance_runs%rowtype;
  line_row record;
  entity_key bigint;
  expected_account_key bigint;
  expected_account_number text;
  invoice_type_value text;
begin
  select * into run_row from public.opening_balance_runs where id=p_run_id;
  if run_row.id is null then raise exception 'Lote de apertura no encontrado.';end if;

  for line_row in
    select line.*,account.account_number
    from public.opening_balance_lines line
    join public.chart_accounts account using(account_id)
    where line.run_id=p_run_id and line.source_type in('AR','AP')
    order by line.source_type,line.row_number,line.id
  loop
    entity_key:=null;expected_account_key:=null;expected_account_number:=null;
    if line_row.source_type='AR'then
      if line_row.account_number not in('113001','113002')then
        raise exception 'CxC fila %: use una cuenta de control permitida (113001 o 113002).',line_row.row_number;
      end if;
      select customer.customer_id,
        case when coalesce(customer.is_intercompany,false)then'113002'else'113001'end
        into entity_key,expected_account_number
      from public.customers customer
      where customer.tax_id=line_row.raw_data->>'entityTaxId'and(
        customer.primary_subsidiary_id=run_row.subsidiary_id or exists(
          select 1 from public.entity_subsidiaries scope
          where scope.customer_id=customer.customer_id
            and scope.subsidiary_id=run_row.subsidiary_id
        )
      )
      order by customer.customer_id limit 1 for share;
      if entity_key is null then
        raise exception 'CxC fila %: cliente % no encontrado.',line_row.row_number,line_row.raw_data->>'entityTaxId';
      end if;
      expected_account_key:=public.resolve_customer_receivable_account(run_row.subsidiary_id,entity_key);
      if line_row.account_id is distinct from expected_account_key then
        raise exception 'CxC fila %: la cuenta % ya no corresponde a la clasificación actual del cliente. Use la cuenta % y vuelva a validar.',
          line_row.row_number,line_row.account_number,expected_account_number;
      end if;
    else
      if line_row.account_number not in('211001','211002','211003','211004')then
        raise exception 'CxP fila %: use una cuenta de control permitida (211001, 211002, 211003 o 211004).',line_row.row_number;
      end if;
      select supplier.supplier_id,
        case
          when line_row.account_number in('211003','211004')then line_row.account_number
          when coalesce(supplier.is_intercompany,false)then'211002'
          else'211001'
        end
        into entity_key,expected_account_number
      from public.suppliers supplier
      where supplier.tax_id=line_row.raw_data->>'entityTaxId'and(
        supplier.primary_subsidiary_id=run_row.subsidiary_id or exists(
          select 1 from public.entity_subsidiaries scope
          where scope.supplier_id=supplier.supplier_id
            and scope.subsidiary_id=run_row.subsidiary_id
        )
      )
      order by supplier.supplier_id limit 1 for share;
      if entity_key is null then
        raise exception 'CxP fila %: proveedor % no encontrado.',line_row.row_number,line_row.raw_data->>'entityTaxId';
      end if;
      invoice_type_value:=case line_row.account_number
        when'211003'then'Factura Expense'
        when'211004'then'Factura Caja Chica'
        else'Factura estándar'end;
      expected_account_key:=public.resolve_supplier_payable_account(
        run_row.subsidiary_id,entity_key,invoice_type_value
      );
      if line_row.account_id is distinct from expected_account_key then
        raise exception 'CxP fila %: la cuenta % ya no corresponde al tipo de factura o a la clasificación actual del proveedor. Use la cuenta % y vuelva a validar.',
          line_row.row_number,line_row.account_number,expected_account_number;
      end if;
    end if;
  end loop;
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_ar_ap_assert_reconciled(p_run_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare issue jsonb;
begin
 if exists(
  select 1 from public.opening_balance_lines
  where run_id=p_run_id and source_type in('AR','AP')
  group by account_id,currency_id having count(distinct source_type)>1
 )then raise exception 'Una misma cuenta y moneda no puede utilizarse simultáneamente como auxiliar CxC y CxP.';end if;
 select value into issue from jsonb_array_elements(public.opening_ar_ap_reconciliation(p_run_id))
 where not coalesce((value->>'balanced')::boolean,false)limit 1;
 if issue is not null then
  raise exception 'El auxiliar % no coincide con el Mayor para la cuenta % y moneda %. Diferencia local: %, diferencia original: %.',
   case issue->>'sourceType'when'AR'then'CxC'else'CxP'end,issue->>'accountNumber',issue->>'currency',
   issue->>'localDifference',issue->>'originalDifference';
 end if;
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_preview_before_ar_ap_reconciliation(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  base jsonb;
  items jsonb;
  reconciliation jsonb;
  balanced boolean;
  current_local numeric(24,6);
  previous_local numeric(24,6);
begin
  base:=public.opening_balance_preview_before_pending_period_type(p_run_id);
  if base is null then return null;end if;
  select coalesce(jsonb_agg(source.item||jsonb_build_object(
    'periodType',pending.period_type,'period_type',pending.period_type,
    'originJournalId',pending.origin_journal_id
  )order by source.ordinality),'[]'::jsonb)
  into items
  from jsonb_array_elements(coalesce(base->'pendingItems','[]'::jsonb))
    with ordinality source(item,ordinality)
  join public.opening_pending_invoice_items pending
    on pending.id=(source.item->>'id')::bigint;

  reconciliation:=public.opening_pending_invoice_reconciliation(p_run_id);
  select coalesce(bool_and(coalesce((entry->>'balanced')::boolean,false)),true)
    into balanced from jsonb_array_elements(reconciliation)entry;
  select
    coalesce(sum(pending.balance_local)filter(where pending.period_type='ACTUAL'),0),
    coalesce(sum(pending.balance_local)filter(where pending.period_type='ANTERIOR'),0)
  into current_local,previous_local
  from public.opening_pending_invoice_items pending
  where pending.run_id=p_run_id;
  return jsonb_set(
    jsonb_set(
      jsonb_set(base,'{pendingItems}',coalesce(items,'[]'::jsonb),true),
      '{pendingReconciliation}',reconciliation,true
    ),
    '{pendingSummary}',coalesce(base->'pendingSummary','{}'::jsonb)||jsonb_build_object(
      'balanced',balanced,
      'currentLocal',current_local,
      'previousLocal',previous_local
    ),true
  );
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_validate_before_ar_ap_reconciliation(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare output jsonb;rid bigint;sid bigint;existing public.opening_balance_runs%rowtype;
 bank_payload jsonb:=coalesce(p->'banks',p->'bankItems');has_banks boolean:=false;has_other boolean:=false;
begin
 sid:=public.opening_balance_assert_access('create');
 if coalesce(p->>'expectedSubsidiaryId','')<>sid::text then
  raise exception 'La empresa activa cambió desde que abrió la carga. Recargue la pantalla y seleccione nuevamente los archivos.';
 end if;
 if((p ? 'banks')or(p ? 'bankItems'))and jsonb_typeof(coalesce(bank_payload,'[]'::jsonb))<>'array'then
  raise exception 'El Auxiliar de Bancos debe ser una lista válida.';
 end if;
 has_banks:=jsonb_typeof(coalesce(bank_payload,'[]'::jsonb))='array'and jsonb_array_length(coalesce(bank_payload,'[]'::jsonb))>0;
 has_other:=jsonb_array_length(coalesce(p->'rows','[]'::jsonb))>0
  or jsonb_array_length(coalesce(p->'assets','[]'::jsonb))>0
  or jsonb_array_length(coalesce(p->'pending',p->'pendingItems','[]'::jsonb))>0;
 select *into existing from public.opening_balance_runs where subsidiary_id=sid and status<>'REVERSED'order by id desc limit 1;
 if existing.status='POSTED'and has_banks and not has_other then
  rid:=existing.id;
 else
  output:=public.opening_balance_validate_before_opening_bank((p-'banks')-'bankItems');
  rid:=(output->'run'->>'id')::bigint;
 end if;
 if rid is null then raise exception 'No fue posible identificar el lote de apertura validado.';end if;
 if has_banks then perform public.opening_bank_stage(rid,bank_payload);end if;
 if has_banks or exists(select 1 from public.opening_bank_accounts where run_id=rid)
  or coalesce(existing.status,'')<>'POSTED'then perform public.opening_bank_assert_reconciled(rid);end if;
 return public.opening_balance_preview(rid);
end$function$;

CREATE OR REPLACE FUNCTION public.opening_balance_reverse_before_ar_ap_reconciliation(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  sid bigint;
begin
  perform public.opening_balance_assert_access('delete');
  select opening_run.subsidiary_id into sid
  from public.opening_balance_runs opening_run
  where opening_run.id=p_run_id
    and opening_run.subsidiary_id=public.active_subsidiary_id();
  if sid is null then
    raise exception 'La apertura no pertenece a la subsidiaria activa.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'pending-invoice-reclassification-subsidiary:'||sid,0
  ));
  perform 1 from public.opening_balance_runs opening_run
  where opening_run.id=p_run_id and opening_run.subsidiary_id=sid
  for update;
  if not found then
    raise exception 'La apertura cambió mientras se validaba la reversión.';
  end if;
  perform 1 from public.opening_pending_invoice_items opening_item
  where opening_item.run_id=p_run_id
  order by opening_item.id for update;
  if exists(
    select 1
    from public.opening_balance_runs opening_run
    join public.opening_pending_invoice_items opening_item
      on opening_item.run_id=opening_run.id
    join public.pending_invoice_reclassification_items reclassified
      on reclassified.source_opening_pending_id=opening_item.id
    where opening_run.id=p_run_id
      and opening_run.subsidiary_id=public.active_subsidiary_id()
  )then
    raise exception 'No se puede reversar la apertura: contiene pendientes ya reclasificados a períodos anteriores.';
  end if;
  return public.opening_balance_reverse_before_pending_reclassification(p_run_id);
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_reverse(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;ar_count integer;ap_count integer;
begin
 perform public.opening_balance_assert_access('delete');
 select count(*)into ar_count from public.opening_balance_lines line
 where line.run_id=p_run_id and line.source_type='AR'and not exists(
  select 1 from public.invoice invoice where invoice.opening_run_id=p_run_id
   and invoice.opening_balance_line_id=line.id and invoice.receivable_account_id=line.account_id
 );
 select count(*)into ap_count from public.opening_balance_lines line
 where line.run_id=p_run_id and line.source_type='AP'and not exists(
  select 1 from public.supplier_invoice invoice where invoice.opening_run_id=p_run_id
   and invoice.opening_balance_line_id=line.id and invoice.payable_account_id=line.account_id
 );
 if ar_count+ap_count>0 then
  raise exception 'No se puede reversar: la trazabilidad entre el auxiliar CxC/CxP y sus documentos fue modificada.';
 end if;
 result:=public.opening_balance_reverse_before_ar_ap_reconciliation(p_run_id);
 return result||jsonb_build_object('arApDocumentsReversed',
  (select count(*)from public.opening_balance_lines where run_id=p_run_id and source_type in('AR','AP')));
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_validate_before_bank_preview_details(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;run_key bigint;
begin
 result:=public.opening_balance_validate_before_ar_ap_reconciliation(p);
 run_key:=nullif(result->'run'->>'id','')::bigint;
 if run_key is null then raise exception 'No fue posible identificar el lote de apertura validado.';end if;
 return public.opening_balance_preview(run_key);
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_validate(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;
begin
 perform set_config('app.opening_bank_validation_preview','1',true);
 result:=public.opening_balance_validate_before_bank_preview_details(p);
 perform set_config('app.opening_bank_validation_preview','',true);
 return result;
exception when others then
 perform set_config('app.opening_bank_validation_preview','',true);
 raise;
end
$function$;


CREATE OR REPLACE FUNCTION public.opening_fixed_asset_stage(p_run_id bigint, p_assets jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
 run_row opening_balance_runs%rowtype;item jsonb;source_row integer;category_row asset_category%rowtype;
 location_key bigint;department_key bigint;cost_key bigint;class_key bigint;local_currency bigint;local_code text;cost_type text;cost_department bigint;
 cost_value numeric;accumulated_value numeric;book_value numeric;months_value integer;purchase_value date;service_value date;status_value text;number_value text;count_rows integer:=0;
begin
 select * into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'La apertura no pertenece a la subsidiaria activa.';end if;
 if exists(select 1 from opening_fixed_asset_lines where run_id=p_run_id and created_asset_id is not null)then raise exception 'El auxiliar de activos fijos ya fue cargado para esta apertura.';end if;
 delete from opening_fixed_asset_lines where run_id=p_run_id;
 select s.currency_id,c.currency_code into local_currency,local_code from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=run_row.subsidiary_id;
 for item in select value from jsonb_array_elements(coalesce(p_assets,'[]'::jsonb))loop
  source_row:=coalesce(nullif(item->>'sourceRow','')::integer,count_rows+2);count_rows:=count_rows+1;
  begin
   cost_value:=nullif(item->>'cost','')::numeric;
   accumulated_value:=coalesce(nullif(item->>'accumulatedDepreciation','')::numeric,0);
   months_value:=coalesce(nullif(item->>'depreciatedMonths','')::integer,0);
   purchase_value:=nullif(item->>'purchaseDate','')::date;
   service_value:=nullif(item->>'serviceDate','')::date;
  exception when others then raise exception 'Activos Fijos fila %: revise fechas, importes y meses depreciados.',source_row;end;
  number_value:=coalesce(nullif(upper(trim(item->>'assetNumber')),''),'AUTO');
  status_value:=upper(coalesce(nullif(trim(item->>'status'),''),'ACTIVO'));
  if nullif(trim(item->>'name'),'')is null then raise exception 'Activos Fijos fila %: el nombre es obligatorio.',source_row;end if;
  select * into category_row from asset_category where subsidiary_id=run_row.subsidiary_id and upper(category_code)=upper(trim(item->>'categoryCode'))and is_active limit 1;
  if category_row.category_id is null then raise exception 'Activos Fijos fila %: la categoría % no existe o está inactiva.',source_row,coalesce(item->>'categoryCode','');end if;
  if category_row.depreciation_method<>'No Depreciable'and(category_row.depreciation_expense_account_id is null or not exists(select 1 from chart_accounts a join account_subsidiaries x using(account_id)where a.account_id=category_row.depreciation_expense_account_id and x.subsidiary_id=run_row.subsidiary_id and x.is_active and a.accepts_entries and not a.is_inactive))then raise exception 'Activos Fijos fila %: la categoría % no tiene una cuenta de gasto de depreciación activa.',source_row,category_row.category_code;end if;
  select l.location_id into location_key from locations l left join location_subsidiaries ls using(location_id)where(l.subsidiary_id=run_row.subsidiary_id or ls.subsidiary_id=run_row.subsidiary_id)and(lower(l.name)=lower(trim(item->>'location'))or l.location_id::text=trim(item->>'location'))order by(l.subsidiary_id=run_row.subsidiary_id)desc limit 1;
  if location_key is null then raise exception 'Activos Fijos fila %: la ubicación % no pertenece a la subsidiaria.',source_row,coalesce(item->>'location','');end if;
  department_key:=null;
  if nullif(trim(item->>'department'),'')is not null then
   select d.department_id into department_key from departments d left join department_subsidiaries ds using(department_id)where(d.subsidiary_id=run_row.subsidiary_id or ds.subsidiary_id=run_row.subsidiary_id)and not d.is_inactive and lower(d.name)=lower(trim(item->>'department'))and(nullif(trim(item->>'departmentType'),'')is null or lower(d.type)=lower(trim(item->>'departmentType')))limit 1;
   if department_key is null then raise exception 'Activos Fijos fila %: el departamento % no está disponible.',source_row,item->>'department';end if;
  end if;
  cost_key:=null;
  if nullif(trim(item->>'costCenter'),'')is not null then
   select cc.cost_center_id,cc.cost_center_type,cu.department_id into cost_key,cost_type,cost_department from cost_centers cc left join customers cu using(customer_id)where cc.subsidiary_id=run_row.subsidiary_id and not cc.is_inactive and(lower(cc.code)=lower(trim(item->>'costCenter'))or lower(cc.name)=lower(trim(item->>'costCenter')))limit 1;
   if cost_key is null then raise exception 'Activos Fijos fila %: el centro de costos % no está disponible.',source_row,item->>'costCenter';end if;
   if cost_type='CLIENTE'and department_key is null then department_key:=cost_department;end if;
   if cost_type='CLIENTE'and(department_key is null or department_key is distinct from cost_department)then raise exception 'Activos Fijos fila %: el centro de costos no corresponde al departamento.',source_row;end if;
  end if;
  class_key:=null;
  if nullif(trim(item->>'className'),'')is not null then
   select c.class_id into class_key from classes c left join class_subsidiaries cs using(class_id)where(c.subsidiary_id=run_row.subsidiary_id or cs.subsidiary_id=run_row.subsidiary_id)and not c.is_inactive and lower(c.name)=lower(trim(item->>'className'))limit 1;
   if class_key is null then raise exception 'Activos Fijos fila %: la clase % no está disponible.',source_row,item->>'className';end if;
  elsif cost_key is not null then select class_id into class_key from cost_centers where cost_center_id=cost_key;end if;
  if upper(coalesce(item->>'currency',''))<>upper(local_code)then raise exception 'Activos Fijos fila %: la moneda debe ser la moneda funcional %.',source_row,local_code;end if;
  if cost_value is null or cost_value<=0 then raise exception 'Activos Fijos fila %: el costo histórico debe ser mayor que cero.',source_row;end if;
  if accumulated_value<0 or accumulated_value>cost_value then raise exception 'Activos Fijos fila %: la depreciación acumulada debe estar entre cero y el costo histórico.',source_row;end if;
  if purchase_value is null or service_value is null or purchase_value>service_value or service_value>run_row.opening_date then raise exception 'Activos Fijos fila %: las fechas deben cumplir compra ≤ servicio ≤ apertura.',source_row;end if;
  if status_value not in('ACTIVO','INACTIVO')then raise exception 'Activos Fijos fila %: el estado debe ser ACTIVO o INACTIVO.',source_row;end if;
  if category_row.depreciation_method='No Depreciable'and(accumulated_value<>0 or months_value<>0)then raise exception 'Activos Fijos fila %: una categoría no depreciable debe tener depreciación y meses en cero.',source_row;end if;
  if category_row.depreciation_method<>'No Depreciable'and(months_value<0 or months_value>category_row.useful_life_months)then raise exception 'Activos Fijos fila %: los meses depreciados deben estar entre 0 y %.',source_row,category_row.useful_life_months;end if;
  if category_row.depreciation_method<>'No Depreciable'and months_value>(extract(year from age(run_row.opening_date,service_value))::integer*12+extract(month from age(run_row.opening_date,service_value))::integer+1)then raise exception 'Activos Fijos fila %: los meses depreciados superan los meses transcurridos desde la fecha de servicio.',source_row;end if;
  if accumulated_value>round(cost_value*(1-category_row.residual_value_percentage/100),6)+.005 then raise exception 'Activos Fijos fila %: la depreciación supera la base depreciable de la categoría.',source_row;end if;
  if accumulated_value>0 and months_value=0 then raise exception 'Activos Fijos fila %: indique los meses consumidos para la depreciación acumulada.',source_row;end if;
  if category_row.depreciation_method<>'No Depreciable'and months_value=category_row.useful_life_months and accumulated_value<round(cost_value*(1-category_row.residual_value_percentage/100),6)-.005 then raise exception 'Activos Fijos fila %: agotó la vida útil, pero conserva depreciación pendiente.',source_row;end if;
  book_value:=cost_value-accumulated_value;
  if nullif(item->>'bookValue','')is not null and abs((item->>'bookValue')::numeric-book_value)>.005 then raise exception 'Activos Fijos fila %: el valor en libros debe ser costo menos depreciación acumulada (%).',source_row,book_value;end if;
  if number_value<>'AUTO'and exists(select 1 from asset where subsidiary_id=run_row.subsidiary_id and opening_reversed_at is null and upper(asset_number)=number_value)then raise exception 'Activos Fijos fila %: el código % ya existe. No lo incluya nuevamente; la conciliación reconoce automáticamente las fichas existentes a la fecha de apertura.',source_row,number_value;end if;
  if number_value<>'AUTO'and exists(select 1 from opening_fixed_asset_lines where run_id=p_run_id and upper(asset_number)=number_value)then raise exception 'Activos Fijos fila %: el código % está repetido dentro del archivo.',source_row,number_value;end if;
  if nullif(trim(item->>'serial'),'')is not null and(exists(select 1 from asset where subsidiary_id=run_row.subsidiary_id and opening_reversed_at is null and lower(serial_number)=lower(trim(item->>'serial')))or exists(select 1 from opening_fixed_asset_lines where run_id=p_run_id and lower(serial_number)=lower(trim(item->>'serial'))))then raise exception 'Activos Fijos fila %: el número de serie % está duplicado.',source_row,item->>'serial';end if;
  insert into opening_fixed_asset_lines(run_id,row_number,asset_number,asset_name,description,serial_number,category_id,category_asset_account_id,category_depreciation_account_id,category_expense_account_id,category_useful_life_months,category_depreciation_method,category_residual_value_percentage,location_id,currency_id,purchase_date,in_service_date,purchase_cost,accumulated_depreciation,book_value_control,depreciated_months,department_id,cost_center_id,class_id,status,note,raw_data)
  values(p_run_id,source_row,number_value,trim(item->>'name'),nullif(trim(item->>'description'),''),nullif(trim(item->>'serial'),''),category_row.category_id,category_row.asset_account_id,category_row.depreciation_account_id,category_row.depreciation_expense_account_id,category_row.useful_life_months,category_row.depreciation_method,category_row.residual_value_percentage,location_key,local_currency,purchase_value,service_value,cost_value,accumulated_value,book_value,months_value,department_key,cost_key,class_key,status_value,nullif(trim(item->>'note'),''),item);
 end loop;
 return count_rows;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_fixed_asset_create(p_run_id bigint, p_period_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare staged opening_fixed_asset_lines%rowtype;asset_key bigint;created_number text;created_count integer:=0;reconciliation jsonb;
begin
 if exists(select 1 from opening_fixed_asset_lines f join opening_balance_runs r on r.id=f.run_id join asset_category c using(category_id)where f.run_id=p_run_id and(not c.is_active or c.asset_account_id is distinct from f.category_asset_account_id or c.depreciation_account_id is distinct from f.category_depreciation_account_id or c.depreciation_expense_account_id is distinct from f.category_expense_account_id or c.useful_life_months is distinct from f.category_useful_life_months or c.depreciation_method is distinct from f.category_depreciation_method or c.residual_value_percentage is distinct from f.category_residual_value_percentage or not exists(select 1 from chart_accounts a join account_subsidiaries x using(account_id)where a.account_id=c.asset_account_id and x.subsidiary_id=r.subsidiary_id and x.is_active and a.accepts_entries and not a.is_inactive)or not exists(select 1 from chart_accounts a join account_subsidiaries x using(account_id)where a.account_id=c.depreciation_account_id and x.subsidiary_id=r.subsidiary_id and x.is_active and a.accepts_entries and not a.is_inactive)or(c.depreciation_method<>'No Depreciable'and(c.depreciation_expense_account_id is null or not exists(select 1 from chart_accounts a join account_subsidiaries x using(account_id)where a.account_id=c.depreciation_expense_account_id and x.subsidiary_id=r.subsidiary_id and x.is_active and a.accepts_entries and not a.is_inactive)))))then
  raise exception 'Una categoría de activos cambió después de la validación. Valide nuevamente el archivo antes de contabilizar.';
 end if;
 reconciliation:=opening_fixed_asset_reconciliation(p_run_id);
 if exists(select 1 from jsonb_array_elements(reconciliation)x where abs((x->>'difference')::numeric)>.005)then raise exception 'El auxiliar de activos fijos no coincide con el Libro Mayor. Corrija las cuentas marcadas con diferencia.';end if;
 for staged in select * from opening_fixed_asset_lines where run_id=p_run_id and created_asset_id is null order by row_number for update loop
  insert into asset(asset_number,asset_name,description,serial_number,category_id,subsidiary_id,location_id,currency_id,purchase_date,in_service_date,purchase_cost,exchange_rate,department_id,cost_center_id,class_id,status,opening_run_id,is_opening_balance)
  select staged.asset_number,staged.asset_name,staged.description,staged.serial_number,staged.category_id,r.subsidiary_id,staged.location_id,staged.currency_id,staged.purchase_date,staged.in_service_date,staged.purchase_cost,1,staged.department_id,staged.cost_center_id,staged.class_id,staged.status,p_run_id,true from opening_balance_runs r where r.id=p_run_id returning asset_id,asset_number into asset_key,created_number;
  if staged.accumulated_depreciation>0 or staged.depreciated_months>0 then
   insert into asset_depreciation(depreciation_date,asset_id,fiscal_period_id,gl_impact_id,depreciation_amount,accumulated_depreciation,opening_run_id,is_opening_balance,depreciated_months)
   select r.opening_date,asset_key,p_period_id,null,staged.accumulated_depreciation,staged.accumulated_depreciation,p_run_id,true,staged.depreciated_months from opening_balance_runs r where r.id=p_run_id;
  end if;
  update opening_fixed_asset_lines set created_asset_id=asset_key,asset_number=created_number where id=staged.id;
  created_count:=created_count+1;
 end loop;
 return created_count;
end$function$;

CREATE OR REPLACE FUNCTION public.opening_fixed_asset_reconciliation(p_run_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with run as(
 select id,subsidiary_id,opening_date,status,journal_id from opening_balance_runs where id=p_run_id and subsidiary_id=active_subsidiary_id()
),staged as(
 select 'Costo histórico'::text type,c.asset_account_id account_id,sum(f.purchase_cost)staged
 from opening_fixed_asset_lines f join asset_category c using(category_id)where f.run_id=p_run_id group by c.asset_account_id
 union all
 select 'Depreciación acumulada',c.depreciation_account_id,sum(f.accumulated_depreciation)
 from opening_fixed_asset_lines f join asset_category c using(category_id)where f.run_id=p_run_id group by c.depreciation_account_id
),existing as(
 select 'Costo histórico'::text type,c.asset_account_id account_id,sum(a.purchase_cost*a.exchange_rate)existing
 from run r join asset a on a.subsidiary_id=r.subsidiary_id and a.opening_run_id is distinct from r.id
 join asset_category c using(category_id)
 where a.purchase_date<=r.opening_date and a.opening_reversed_at is null
  and not exists(select 1 from asset_disposal d where d.asset_id=a.asset_id and d.disposal_date<=r.opening_date)
 group by c.asset_account_id
 union all
 select 'Depreciación acumulada',c.depreciation_account_id,sum(d.depreciation_amount*a.exchange_rate)
 from run r join asset a on a.subsidiary_id=r.subsidiary_id and a.opening_run_id is distinct from r.id
 join asset_category c using(category_id)join asset_depreciation d using(asset_id)
 where a.purchase_date<=r.opening_date and a.opening_reversed_at is null and d.depreciation_date<=r.opening_date
  and not exists(select 1 from asset_disposal z where z.asset_id=a.asset_id and z.disposal_date<=r.opening_date)
 group by c.depreciation_account_id
),ledger_values as(
 select l.account_id,l.local_debit debit,l.local_credit credit
 from run r join opening_balance_lines l on l.run_id=r.id where r.status<>'POSTED'
 union all
 select g.account_id,g.debit_amount,g.credit_amount
 from run r join journal j on j.journal_id=r.journal_id join gl_impact g on g.transaction_id=j.transaction_id join accounting_books b using(accounting_book_id)where r.status='POSTED'and b.is_primary and b.is_active
),ledger_accounts as(
 select distinct
  case when exists(select 1 from asset_category c where c.subsidiary_id=r.subsidiary_id and c.depreciation_account_id=l.account_id)
    or account_belongs_to_group(l.account_id,'depreciaci.n acumulada')or a.account_name~*'depreciaci.n acumulada'
   then 'Depreciación acumulada'else 'Costo histórico'end type,l.account_id
 from run r cross join ledger_values l join chart_accounts a using(account_id)
 where fixed_asset_ppe_account(l.account_id)
  or exists(select 1 from asset_category c where c.subsidiary_id=r.subsidiary_id and(c.asset_account_id=l.account_id or c.depreciation_account_id=l.account_id))
  or account_belongs_to_group(l.account_id,'depreciaci.n acumulada')or a.account_name~*'depreciaci.n acumulada'
),keys as(
 select type,account_id from staged union select type,account_id from existing union select type,account_id from ledger_accounts
),amounts as(
 select k.type,k.account_id,coalesce(e.existing,0)existing,coalesce(s.staged,0)staged,
  case when k.type='Costo histórico'then coalesce(sum(l.debit-l.credit),0)else coalesce(sum(l.credit-l.debit),0)end ledger
 from keys k left join existing e using(type,account_id)left join staged s using(type,account_id)
 left join ledger_values l on l.account_id=k.account_id
 group by k.type,k.account_id,e.existing,s.staged
)
select coalesce(jsonb_agg(jsonb_build_object(
 'type',x.type,'accountId',x.account_id,'accountNumber',c.account_number,'accountName',c.account_name,
 'ledger',x.ledger,'existing',x.existing,'staged',x.staged,'auxiliary',x.existing+x.staged,
 'difference',x.ledger-x.existing-x.staged
)order by x.type,c.account_number),'[]'::jsonb)from amounts x join chart_accounts c using(account_id)
$function$;


CREATE OR REPLACE FUNCTION public.opening_balance_assert_access(p_action text)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sid bigint:=active_subsidiary_id();uid bigint:=app_user_id();
begin
 perform security_assert_role_access('accounting:opening-balances',p_action);
 if sid is null or uid is null or not exists(select 1 from user_subsidiaries where user_id=uid and subsidiary_id=sid)then
  raise exception using errcode='42501',message='Seleccione una subsidiaria autorizada para administrar la apertura.';
 end if;
 return sid;
end$function$;
