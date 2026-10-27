begin;

-- La ruta manual conserva la validacion de fondos. El flujo de conciliacion
-- usa el mismo contabilizador con permiso interno de sobregiro porque el cargo
-- ya fue confirmado por el extracto. El parametro no se expone como RPC.
create or replace function public.post_bank_fee_internal(
  p_payload jsonb,
  p_allow_statement_overdraft boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  subsidiary_key bigint:=public.active_subsidiary_id();
  user_key bigint:=public.app_user_id();
  bank_account_row public.bank_account%rowtype;
  expense_account_key bigint;
  fee_date_value date:=nullif(p_payload->>'fee_date','')::date;
  amount_value numeric:=nullif(p_payload->>'amount','')::numeric;
  fiscal_period_key bigint;
  location_key bigint;
  exchange_rate_value numeric:=1;
  transaction_type_key bigint;
  status_key bigint;
  fee_number_value text;
  transaction_key bigint;
  journal_key bigint;
  fee_key bigint;
  memo_value text;
  subsidiary_name text;
begin
  if fee_date_value is null or coalesce(amount_value,0)<=0 then
    raise exception 'Fecha e importe son obligatorios.';
  end if;

  select *into bank_account_row
  from public.bank_account
  where bank_account_id=(p_payload->>'bank_account_id')::bigint
    and subsidiary_id=subsidiary_key
  for update;

  if bank_account_row.bank_account_id is null then
    raise exception 'Seleccione una cuenta bancaria autorizada.';
  end if;
  if not coalesce(p_allow_statement_overdraft,false)
     and bank_account_row.balance<amount_value then
    raise exception 'Saldo insuficiente. Disponible: %, requerido: %.',bank_account_row.balance,amount_value;
  end if;

  select name into subsidiary_name
  from public.subsidiaries
  where subsidiary_id=subsidiary_key;

  expense_account_key:=public.bank_fee_expense_account(subsidiary_key);
  if expense_account_key is null then
    raise exception 'Configure una cuenta contable de Comisiones bancarias o Gastos bancarios para la subsidiaria.';
  end if;

  select fiscal_period_id into fiscal_period_key
  from public.fiscal_periods
  where subsidiary_id=subsidiary_key
    and fee_date_value between start_date and end_date
    and not is_closed
  order by start_date desc
  limit 1;
  if fiscal_period_key is null then
    raise exception 'No existe periodo contable abierto para la fecha.';
  end if;

  select location.location_id into location_key
  from public.locations location
  left join public.location_subsidiaries assignment using(location_id)
  where location.subsidiary_id=subsidiary_key
     or assignment.subsidiary_id=subsidiary_key
  order by location.location_id
  limit 1;

  select transaction_type_id into transaction_type_key
  from public.transaction_types
  where abbreviation='COM_BAN';
  select status_id into status_key
  from public.status
  where code='APROBADO'and module='Transacciones'
  limit 1;

  if bank_account_row.currency_id<>(
    select currency_id from public.subsidiaries where subsidiary_id=subsidiary_key
  ) then
    select spot_rate into exchange_rate_value
    from public.exchange_rates
    where from_currency_id=bank_account_row.currency_id
      and to_currency_id=(select currency_id from public.subsidiaries where subsidiary_id=subsidiary_key)
      and effective_date<=fee_date_value
    order by effective_date desc
    limit 1;
    if exchange_rate_value is null then
      raise exception 'No existe tipo de cambio para la fecha ni una fecha anterior.';
    end if;
  end if;

  begin
    fee_number_value:=public.next_transaction_number(transaction_type_key,subsidiary_key);
  exception when others then
    fee_number_value:='COM_BAN-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');
  end;

  memo_value:=coalesce(
    nullif(btrim(p_payload->>'memo'),''),
    'Comisiones bancarias - '||subsidiary_name
  );

  insert into public."transaction"(
    tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
    exchange_rate,fiscal_period_id,total_amount,status_id
  ) values(
    fee_number_value,fee_date_value,transaction_type_key,subsidiary_key,
    bank_account_row.currency_id,exchange_rate_value,fiscal_period_key,
    amount_value,status_key
  ) returning transaction_id into transaction_key;

  insert into public.journal(
    journal_number,journal_date,transaction_id,subsidiary_id,currency_id,
    fiscal_period_id,exchange_rate,memo,journal_type,location_id,
    total_debit,total_credit,status
  ) values(
    fee_number_value,fee_date_value,transaction_key,subsidiary_key,
    bank_account_row.currency_id,fiscal_period_key,exchange_rate_value,
    memo_value,'Comisiones bancarias',location_key,amount_value,amount_value,
    'CONTABILIZADO'
  ) returning journal_id into journal_key;

  insert into public.journal_line(
    journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,note
  ) values
    (journal_key,expense_account_key,amount_value,0,amount_value*exchange_rate_value,0,location_key,memo_value),
    (journal_key,bank_account_row.account_id,0,amount_value,0,amount_value*exchange_rate_value,location_key,memo_value);

  insert into public.bank_fee(
    fee_number,fee_date,bank_account_id,expense_account_id,reference,amount,
    currency_id,exchange_rate,subsidiary_id,fiscal_period_id,location_id,
    memo,journal_id,transaction_id,created_by
  ) values(
    fee_number_value,fee_date_value,bank_account_row.bank_account_id,
    expense_account_key,nullif(btrim(p_payload->>'reference'),''),amount_value,
    bank_account_row.currency_id,exchange_rate_value,subsidiary_key,
    fiscal_period_key,location_key,memo_value,journal_key,transaction_key,user_key
  ) returning fee_id into fee_key;

  insert into public.bank_transaction(
    tran_date,value_date,bank_account_id,transaction_id,amount,tran_type,
    reference_number,description,reconciliation_status
  ) values(
    fee_date_value,fee_date_value,bank_account_row.bank_account_id,
    transaction_key,-amount_value,'COM_BAN',p_payload->>'reference',
    memo_value,'PENDIENTE_EN_TRANSITO'
  );

  update public.bank_account
  set balance=balance-amount_value
  where bank_account_id=bank_account_row.bank_account_id;

  return jsonb_build_object(
    'id',fee_key,'number',fee_number_value,'journalId',journal_key
  );
end
$$;

revoke all on function public.post_bank_fee_internal(jsonb,boolean)
  from public,anon,authenticated,service_role;

create or replace function public.save_bank_fee(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  return public.post_bank_fee_internal(p_payload,false);
end
$$;

-- Convierte cargos seleccionados del extracto en comisiones bancarias
-- contabilizadas y los concilia en la misma transaccion. Cada linea conserva
-- su propio documento/asiento para facilitar la auditoria y evitar que una
-- seleccion parcialmente invalida produzca registros incompletos.
create or replace function public.register_bank_statement_fees(
  p_bank_account_id bigint,
  p_cutoff date,
  p_statement_line_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  active_subsidiary_key bigint:=public.active_subsidiary_id();
  bank_account_row public.bank_account%rowtype;
  statement_key bigint;
  reconciliation_key bigint;
  requested_count integer;
  distinct_count integer;
  eligible_count integer;
  statement_line_row record;
  fee_result jsonb;
  fee_key bigint;
  journal_key bigint;
  bank_transaction_key bigint;
  created_count integer:=0;
  total_amount numeric(24,6):=0;
  fee_ids jsonb:='[]'::jsonb;
  fee_numbers jsonb:='[]'::jsonb;
  journal_ids jsonb:='[]'::jsonb;
  matched_line_ids jsonb:='[]'::jsonb;
begin
  if active_subsidiary_key is null then
    raise exception 'Seleccione una subsidiaria activa antes de registrar las comisiones.';
  end if;
  if p_bank_account_id is null or p_cutoff is null then
    raise exception 'La cuenta bancaria y la fecha de conciliacion son obligatorias.';
  end if;

  select account.*
    into bank_account_row
  from public.bank_account account
  where account.bank_account_id=p_bank_account_id
    and account.subsidiary_id=active_subsidiary_key
    and not coalesce(account.is_credit_card,false);

  if bank_account_row.bank_account_id is null then
    raise exception 'La cuenta bancaria no pertenece a la subsidiaria activa.';
  end if;

  select count(*),count(distinct selected.line_id)
    into requested_count,distinct_count
  from unnest(coalesce(p_statement_line_ids,'{}'::bigint[])) selected(line_id);

  if requested_count=0 then
    raise exception 'Seleccione al menos un movimiento del extracto bancario.';
  end if;
  if requested_count<>distinct_count then
    raise exception 'La seleccion contiene movimientos repetidos.';
  end if;

  select statement.statement_id
    into statement_key
  from public.bank_statement statement
  where statement.bank_account_id=p_bank_account_id
    and statement.statement_date=p_cutoff
  order by statement.statement_date desc,statement.statement_id desc
  limit 1;

  if statement_key is null then
    raise exception 'No existe un extracto bancario cargado para esta cuenta en la fecha de conciliacion.';
  end if;

  -- Bloquea el conjunto antes de validar para que dos solicitudes simultaneas
  -- no contabilicen dos veces la misma linea del extracto.
  perform 1
  from public.bank_statement_line statement_line
  where statement_line.statement_line_id=any(p_statement_line_ids)
  order by statement_line.statement_line_id
  for update;

  select count(*)
    into eligible_count
  from public.bank_statement_line statement_line
  where statement_line.statement_line_id=any(p_statement_line_ids)
    and statement_line.statement_id=statement_key
    and statement_line.bank_date<=p_cutoff
    and statement_line.amount<0
    and statement_line.reconciliation_status='PENDIENTE'
    and not exists(
      select 1
      from public.bank_reconciliation_match matched
      where matched.statement_line_id=statement_line.statement_line_id
    );

  if eligible_count<>distinct_count then
    raise exception using
      message='Uno o mas movimientos no se pueden registrar como comision bancaria.',
      detail='Seleccione solamente cargos negativos, pendientes y sin conciliar del extracto visible.';
  end if;

  if public.bank_fee_expense_account(active_subsidiary_key) is null then
    raise exception 'Configure la cuenta 631002 - Comisiones y Gastos Bancarios para la subsidiaria activa.';
  end if;

  reconciliation_key:=public.ensure_open_bank_reconciliation(p_bank_account_id,p_cutoff);

  for statement_line_row in
    select statement_line.*
    from public.bank_statement_line statement_line
    where statement_line.statement_line_id=any(p_statement_line_ids)
    order by statement_line.bank_date,statement_line.statement_line_id
  loop
    fee_result:=public.post_bank_fee_internal(jsonb_build_object(
      'bank_account_id',p_bank_account_id,
      'fee_date',statement_line_row.bank_date,
      'reference',coalesce(
        nullif(btrim(statement_line_row.reference),''),
        'EXT-'||statement_line_row.statement_line_id::text
      ),
      'amount',abs(statement_line_row.amount),
      'memo',coalesce(
        nullif(btrim(statement_line_row.description),''),
        'Comision bancaria registrada desde el extracto'
      )
    ),true);

    fee_key:=nullif(fee_result->>'id','')::bigint;
    journal_key:=nullif(fee_result->>'journalId','')::bigint;

    select bank_transaction.bank_tran_id
      into bank_transaction_key
    from public.bank_fee fee
    join public.bank_transaction bank_transaction
      on bank_transaction.transaction_id=fee.transaction_id
     and bank_transaction.bank_account_id=fee.bank_account_id
    where fee.fee_id=fee_key
    order by bank_transaction.bank_tran_id desc
    limit 1;

    if fee_key is null or bank_transaction_key is null then
      raise exception 'No fue posible vincular la comision con el movimiento del extracto.';
    end if;

    update public.bank_transaction
    set reconciliation_status='CONCILIADO',
        value_date=coalesce(statement_line_row.value_date,statement_line_row.bank_date),
        description=coalesce(
          nullif(btrim(statement_line_row.description),''),
          'Comision bancaria registrada desde el extracto'
        ),
        beneficiary=coalesce(nullif(btrim(statement_line_row.beneficiary),''),beneficiary)
    where bank_tran_id=bank_transaction_key;

    insert into public.bank_reconciliation_match(
      reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by
    ) values(
      reconciliation_key,bank_transaction_key,
      statement_line_row.statement_line_id,'MANUAL',public.app_user_id()
    );

    update public.bank_statement_line
    set reconciliation_status='CONCILIADO'
    where statement_line_id=statement_line_row.statement_line_id;

    created_count:=created_count+1;
    total_amount:=total_amount+abs(statement_line_row.amount);
    fee_ids:=fee_ids||jsonb_build_array(fee_key);
    fee_numbers:=fee_numbers||jsonb_build_array(fee_result->>'number');
    journal_ids:=journal_ids||jsonb_build_array(journal_key);
    matched_line_ids:=matched_line_ids||jsonb_build_array(statement_line_row.statement_line_id);
  end loop;

  return jsonb_build_object(
    'createdCount',created_count,
    'totalAmount',total_amount,
    'currencyId',bank_account_row.currency_id,
    'feeIds',fee_ids,
    'feeNumbers',fee_numbers,
    'journalIds',journal_ids,
    'matchedStatementLineIds',matched_line_ids,
    'reconciliationId',reconciliation_key
  );
end
$$;

comment on function public.register_bank_statement_fees(bigint,date,bigint[]) is
  'Registra en lote cargos negativos seleccionados del extracto como comisiones bancarias y los concilia sin duplicarlos.';

revoke all on function public.register_bank_statement_fees(bigint,date,bigint[])
  from public,anon;
grant execute on function public.register_bank_statement_fees(bigint,date,bigint[])
  to authenticated,service_role;

commit;

notify pgrst,'reload schema';
