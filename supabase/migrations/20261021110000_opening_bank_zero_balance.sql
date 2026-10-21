-- Allow a legitimately zero cleared opening balance while retaining strict two-currency sign control.

do $$
declare constraint_name text;
begin
 for constraint_name in
  select conname from pg_constraint
  where conrelid='public.opening_bank_items'::regclass and contype='c'
   and pg_get_constraintdef(oid)ilike'%original_amount%'
   and pg_get_constraintdef(oid)ilike'%local_equivalent%'
 loop
  execute format('alter table public.opening_bank_items drop constraint %I',constraint_name);
 end loop;
end$$;

alter table public.opening_bank_items
 add constraint opening_bank_items_amount_sign_check check(
  record_type='SALDO_CONCILIADO'and(
   original_amount=0 and local_equivalent=0
   or original_amount<>0 and local_equivalent<>0 and original_amount*local_equivalent>0
  )
  or record_type='DEPOSITO_EN_TRANSITO'and original_amount>0 and local_equivalent>0
  or record_type='CHEQUE_EN_TRANSITO'and original_amount<0 and local_equivalent<0
 );

create or replace function public.opening_bank_stage(p_run_id bigint,p_items jsonb)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
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
end$$;
revoke all on function public.opening_bank_stage(bigint,jsonb)from public,anon,authenticated;
notify pgrst,'reload schema';
