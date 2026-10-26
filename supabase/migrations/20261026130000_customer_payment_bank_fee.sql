create table if not exists public.customer_payment_bank_fee(
  payment_id bigint primary key references public.customer_payment(payment_id) on delete cascade,
  expense_account_id bigint not null references public.chart_accounts(account_id),
  amount numeric(24,6) not null check(amount>0),
  created_by bigint references public.users(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_payment_bank_fee_expense_idx
  on public.customer_payment_bank_fee(expense_account_id);

alter table public.customer_payment_bank_fee enable row level security;
drop policy if exists customer_payment_bank_fee_select on public.customer_payment_bank_fee;
create policy customer_payment_bank_fee_select
on public.customer_payment_bank_fee for select to authenticated
using(
  exists(
    select 1
    from public.customer_payment payment
    join public."transaction" transaction using(transaction_id)
    where payment.payment_id=customer_payment_bank_fee.payment_id
      and transaction.subsidiary_id=public.active_subsidiary_id()
  )
);

revoke all on public.customer_payment_bank_fee from public,anon,authenticated;
grant select on public.customer_payment_bank_fee to authenticated;

-- Preserve the account convention already used by the standalone bank-fee
-- module, while also supporting accounts that are globally available because
-- they do not have explicit subsidiary assignments.
create or replace function public.bank_fee_expense_account(p_sid bigint)
returns bigint
language sql
stable
set search_path=public
as $$
  select account.account_id
  from public.chart_accounts account
  where account.accepts_entries
    and not account.is_inactive
    and(
      lower(account.account_name) like '%comisi%bancar%'
      or lower(account.account_name) like '%gasto%bancar%'
    )
    and(
      exists(
        select 1 from public.account_subsidiaries assignment
        where assignment.account_id=account.account_id
          and assignment.subsidiary_id=p_sid
          and assignment.is_active
      )
      or not exists(
        select 1 from public.account_subsidiaries assignment
        where assignment.account_id=account.account_id
      )
    )
  order by
    case when lower(account.account_name) like '%comisi%' then 0 else 1 end,
    account.account_number
  limit 1
$$;

do $$
begin
  if to_regprocedure('public.save_customer_payment_with_advances_before_bank_fee(jsonb,bigint)') is null then
    alter function public.save_customer_payment_with_advances(jsonb,bigint)
      rename to save_customer_payment_with_advances_before_bank_fee;
  end if;
  if to_regprocedure('public.delete_customer_payment_before_bank_fee(bigint)') is null then
    alter function public.delete_customer_payment(bigint)
      rename to delete_customer_payment_before_bank_fee;
  end if;
end
$$;

create or replace function public.save_customer_payment_with_advances(
  p_payload jsonb,
  p_payment_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  payment_row public.customer_payment%rowtype;
  bank_row public.bank_account%rowtype;
  old_fee numeric:=0;
  old_bank_account_id bigint;
  fee numeric:=coalesce(nullif(trim(p_payload->>'bank_fee_amount'),'')::numeric,0);
  available_cash numeric;
  net_cash numeric;
  expense_account_id bigint;
  expense_number text;
  expense_name text;
  bank_line_id bigint;
  bank_line_debit numeric;
  affected integer;
  note_text text;
begin
  if fee<0 then
    raise exception 'La comisión bancaria no puede ser negativa.';
  end if;

  if p_payment_id is not null then
    select coalesce(payment_fee.amount,0),payment.bank_account_id
      into old_fee,old_bank_account_id
    from public.customer_payment payment
    join public."transaction" transaction using(transaction_id)
    left join public.customer_payment_bank_fee payment_fee using(payment_id)
    where payment.payment_id=p_payment_id
      and transaction.subsidiary_id=public.active_subsidiary_id()
    for update of payment;

    -- The legacy save routine reverses amount_received, whose historical
    -- meaning excludes the embedded fee. Restore the prior fee first so an
    -- edit removes exactly the previous net bank movement.
    if coalesce(old_fee,0)>0 then
      update public.bank_account
      set balance=balance+old_fee
      where bank_account_id=old_bank_account_id;
    end if;
  end if;

  result:=public.save_customer_payment_with_advances_before_bank_fee(
    p_payload,p_payment_id
  );

  select payment.* into payment_row
  from public.customer_payment payment
  join public."transaction" transaction using(transaction_id)
  where payment.payment_id=nullif(result->>'id','')::bigint
    and transaction.subsidiary_id=public.active_subsidiary_id()
  for update of payment;

  if payment_row.payment_id is null then
    raise exception 'No fue posible identificar el cobro registrado.';
  end if;

  select * into bank_row
  from public.bank_account
  where bank_account_id=payment_row.bank_account_id
    and subsidiary_id=public.active_subsidiary_id()
  for update;

  if bank_row.bank_account_id is null then
    raise exception 'La cuenta bancaria del cobro no pertenece a la subsidiaria activa.';
  end if;

  available_cash:=coalesce(
    nullif(result->>'cashTotal','')::numeric,
    nullif(result->>'total','')::numeric,
    0
  );

  if fee>available_cash+.000001 then
    raise exception 'La comisión bancaria (%) no puede superar el ingreso bancario disponible (%).',
      round(fee,2),round(greatest(available_cash,0),2);
  end if;

  net_cash:=greatest(available_cash-fee,0);

  if fee>0 then
    expense_account_id:=public.bank_fee_expense_account(public.active_subsidiary_id());
    if expense_account_id is null then
      raise exception 'Configure una cuenta contable activa de Comisiones bancarias o Gastos bancarios para la subsidiaria.';
    end if;

    select account_number,account_name into expense_number,expense_name
    from public.chart_accounts
    where account_id=expense_account_id;

    select line.journal_line_id,line.debit
      into bank_line_id,bank_line_debit
    from public.journal_line line
    where line.journal_id=payment_row.journal_id
      and line.account_id=bank_row.account_id
      and coalesce(line.debit,0)>0
    order by line.journal_line_id
    limit 1
    for update;

    if bank_line_id is null or bank_line_debit+0.000001<fee then
      raise exception 'El débito bancario disponible no permite registrar la comisión indicada.';
    end if;

    if abs(bank_line_debit-fee)<.000001 then
      delete from public.journal_line where journal_line_id=bank_line_id;
    else
      update public.journal_line
      set debit=debit-fee,
          debit_fx=greatest(coalesce(debit_fx,0)-fee*payment_row.exchange_rate,0)
      where journal_line_id=bank_line_id;
    end if;

    note_text:='Comisión bancaria descontada del cobro '||payment_row.payment_number;
    insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,
      note,entity_type,customer_id
    )values(
      payment_row.journal_id,expense_account_id,fee,0,
      fee*payment_row.exchange_rate,0,payment_row.location_id,
      note_text,'Cliente',payment_row.customer_id
    );

    update public.bank_account
    set balance=balance-fee
    where bank_account_id=bank_row.bank_account_id;

    update public.bank_transaction
    set amount=amount-fee,
        description=coalesce(nullif(payment_row.memo,''),payment_row.payment_number)
          ||' · Comisión bancaria '||to_char(fee,'FM999999999999990.00')
    where transaction_id=payment_row.transaction_id
      and bank_account_id=bank_row.bank_account_id;
    get diagnostics affected=row_count;

    if available_cash>.000001 and affected<>1 then
      raise exception 'No fue posible actualizar el movimiento bancario neto del cobro.';
    end if;

    delete from public.bank_transaction
    where transaction_id=payment_row.transaction_id
      and bank_account_id=bank_row.bank_account_id
      and abs(amount)<.000001;

    insert into public.customer_payment_bank_fee(
      payment_id,expense_account_id,amount,created_by,updated_at
    )values(
      payment_row.payment_id,expense_account_id,fee,public.app_user_id(),now()
    )
    on conflict(payment_id)do update set
      expense_account_id=excluded.expense_account_id,
      amount=excluded.amount,
      updated_at=now();
  else
    delete from public.customer_payment_bank_fee
    where payment_id=payment_row.payment_id;
  end if;

  perform public.sync_journal_gl_impacts(payment_row.journal_id);

  return result||jsonb_build_object(
    'bankFeeTotal',fee,
    'bankFeeAccountId',expense_account_id,
    'bankFeeAccountNumber',expense_number,
    'bankFeeAccountName',expense_name,
    'cashTotal',net_cash
  );
end
$$;

create or replace function public.delete_customer_payment(p_payment_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  fee numeric:=0;
  bank_account_key bigint;
begin
  select coalesce(payment_fee.amount,0),payment.bank_account_id
    into fee,bank_account_key
  from public.customer_payment payment
  join public."transaction" transaction using(transaction_id)
  left join public.customer_payment_bank_fee payment_fee using(payment_id)
  where payment.payment_id=p_payment_id
    and transaction.subsidiary_id=public.active_subsidiary_id()
  for update of payment;

  if coalesce(fee,0)>0 then
    update public.bank_account set balance=balance+fee
    where bank_account_id=bank_account_key;
  end if;

  result:=public.delete_customer_payment_before_bank_fee(p_payment_id);
  return result||jsonb_build_object('bankFeeTotal',coalesce(fee,0));
end
$$;

create or replace function public.customer_payment_bank_fee_summary()
returns jsonb
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'paymentId',fee.payment_id,
    'amount',fee.amount,
    'expenseAccountId',fee.expense_account_id,
    'expenseAccountNumber',account.account_number,
    'expenseAccountName',account.account_name
  )order by fee.payment_id),'[]'::jsonb)
  from public.customer_payment_bank_fee fee
  join public.customer_payment payment using(payment_id)
  join public."transaction" transaction using(transaction_id)
  join public.chart_accounts account on account.account_id=fee.expense_account_id
  where transaction.subsidiary_id=public.active_subsidiary_id()
$$;

create or replace function public.customer_payment_bank_fee_detail(p_payment_id bigint)
returns jsonb
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select coalesce((
    select jsonb_build_object(
      'paymentId',fee.payment_id,
      'amount',fee.amount,
      'expenseAccountId',fee.expense_account_id,
      'expenseAccountNumber',account.account_number,
      'expenseAccountName',account.account_name
    )
    from public.customer_payment_bank_fee fee
    join public.customer_payment payment using(payment_id)
    join public."transaction" transaction using(transaction_id)
    join public.chart_accounts account on account.account_id=fee.expense_account_id
    where fee.payment_id=p_payment_id
      and transaction.subsidiary_id=public.active_subsidiary_id()
  ),'{}'::jsonb)
$$;

revoke all on function
  public.save_customer_payment_with_advances_before_bank_fee(jsonb,bigint),
  public.delete_customer_payment_before_bank_fee(bigint)
from public,anon,authenticated;

revoke all on function
  public.save_customer_payment_with_advances(jsonb,bigint),
  public.delete_customer_payment(bigint),
  public.customer_payment_bank_fee_summary(),
  public.customer_payment_bank_fee_detail(bigint)
from public,anon;

grant execute on function
  public.save_customer_payment_with_advances(jsonb,bigint),
  public.delete_customer_payment(bigint),
  public.customer_payment_bank_fee_summary(),
  public.customer_payment_bank_fee_detail(bigint)
to authenticated;

notify pgrst,'reload schema';
