-- Keep the receivable account chosen when a sales invoice is issued.  The
-- snapshot makes subsequent notes and collections clear the same ledger
-- account even if the customer master is changed later.
alter table public.invoice
  add column if not exists receivable_account_id bigint;

do $$
begin
  if not exists(
    select 1
    from pg_constraint
    where conrelid='public.invoice'::regclass
      and conname='invoice_receivable_account_id_fkey'
  )then
    alter table public.invoice
      add constraint invoice_receivable_account_id_fkey
      foreign key(receivable_account_id)
      references public.chart_accounts(account_id);
  end if;
end
$$;

create index if not exists invoice_receivable_account_idx
  on public.invoice(receivable_account_id);

comment on column public.invoice.receivable_account_id is
  'Historical receivable account: 113001 for regular customers and 113002 for intercompany customers.';

create or replace function public.resolve_customer_receivable_account(
  p_subsidiary_id bigint,
  p_customer_id bigint
)returns bigint
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  intercompany boolean;
  required_number text;
  account_key bigint;
begin
  if p_subsidiary_id is null then
    raise exception 'No se pudo determinar la subsidiaria para asignar la cuenta por cobrar.';
  end if;

  select coalesce(customer.is_intercompany,false)
    into intercompany
  from public.customers customer
  where customer.customer_id=p_customer_id;

  if not found then
    raise exception 'No se encontró el cliente para asignar la cuenta por cobrar.';
  end if;

  required_number:=case when intercompany then '113002' else '113001' end;

  select account.account_id
    into account_key
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number=required_number
    and assignment.subsidiary_id=p_subsidiary_id
    and assignment.is_active
    and account.accepts_entries
    and not account.is_inactive
    and account.category='Activo'
    and account.nature='Deudora'
    and account.financial_statement='Balance General'
  order by account.account_id
  limit 1;

  if account_key is null then
    raise exception 'La cuenta % no está activa y vinculada a la subsidiaria.',required_number;
  end if;

  return account_key;
end
$$;

revoke all on function public.resolve_customer_receivable_account(bigint,bigint)
  from public,anon,authenticated;

-- Preserve the account that was really posted for historical documents.  An
-- opening invoice is tied to its exact opening line; normal invoices use their
-- explicit receivable journal line.  Only documents without accounting detail
-- fall back to the current customer classification.
with historical as (
  select invoice.invoice_id,
    coalesce(
      (
        select line.account_id
        from public.journal_line line
        where invoice.opening_balance_line_id is not null
          and line.opening_balance_line_id=invoice.opening_balance_line_id
          and line.customer_id=invoice.customer_id
        order by line.journal_line_id
        limit 1
      ),
      (
        select line.account_id
        from public.journal_line line
        where line.journal_id=invoice.journal_id
          and line.customer_id=invoice.customer_id
          and lower(coalesce(line.note,'')) like 'cuenta por cobrar%'
        order by line.journal_line_id
        limit 1
      ),
      (
        select line.account_id
        from public.journal_line line
        join public.chart_accounts account using(account_id)
        where line.journal_id=invoice.journal_id
          and line.customer_id=invoice.customer_id
          and line.entity_type='Cliente'
          and account.category='Activo'
          and account.account_name~*'(cuenta.*por cobrar|cliente.*por cobrar)'
        order by
          case when account.account_number in('113001','113002') then 0 else 1 end,
          abs(coalesce(line.debit,0)-coalesce(line.credit,0)) desc,
          line.journal_line_id
        limit 1
      ),
      public.resolve_customer_receivable_account(
        invoice.subsidiary_id,invoice.customer_id
      )
    ) account_id
  from public.invoice invoice
  where invoice.receivable_account_id is null
)
update public.invoice invoice
set receivable_account_id=historical.account_id
from historical
where invoice.invoice_id=historical.invoice_id;

do $$
begin
  if to_regprocedure('public.save_sales_invoice_before_intercompany_receivable(jsonb,bigint)') is null then
    alter function public.save_sales_invoice(jsonb,bigint)
      rename to save_sales_invoice_before_intercompany_receivable;
  end if;
  if to_regprocedure('public.save_sales_note_before_intercompany_receivable(text,jsonb,bigint)') is null then
    alter function public.save_sales_note(text,jsonb,bigint)
      rename to save_sales_note_before_intercompany_receivable;
  end if;
  if to_regprocedure('public.save_customer_payment_before_intercompany_receivable(jsonb,bigint)') is null then
    alter function public.save_customer_payment(jsonb,bigint)
      rename to save_customer_payment_before_intercompany_receivable;
  end if;
  if to_regprocedure('public.save_customer_payment_with_advances_before_intercompany_receivable(jsonb,bigint)') is null then
    alter function public.save_customer_payment_with_advances(jsonb,bigint)
      rename to save_customer_payment_with_advances_before_intercompany_receivable;
  end if;
end
$$;

revoke all on function public.save_sales_invoice_before_intercompany_receivable(jsonb,bigint),
  public.save_sales_note_before_intercompany_receivable(text,jsonb,bigint),
  public.save_customer_payment_before_intercompany_receivable(jsonb,bigint),
  public.save_customer_payment_with_advances_before_intercompany_receivable(jsonb,bigint)
from public,anon,authenticated;

create or replace function public.save_sales_invoice(
  payload jsonb,
  target_invoice_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  invoice_key bigint;
  journal_key bigint;
  transaction_key bigint;
  customer_key bigint;
  subsidiary_key bigint;
  prior_customer_key bigint;
  requested_customer_key bigint:=nullif(payload->>'customer_id','')::bigint;
  prior_account_key bigint;
  account_key bigint;
  affected integer;
begin
  if target_invoice_id is not null then
    select invoice.customer_id,invoice.receivable_account_id
      into prior_customer_key,prior_account_key
    from public.invoice invoice
    where invoice.invoice_id=target_invoice_id
      and invoice.subsidiary_id=public.active_subsidiary_id();

    if prior_customer_key is distinct from requested_customer_key
      and(
        exists(
          select 1 from public.customer_payment_application application
          where application.invoice_id=target_invoice_id
        )
        or exists(
          select 1 from public.credit_note note
          where note.invoice_id=target_invoice_id
        )
        or exists(
          select 1 from public.debit_note note
          where note.invoice_id=target_invoice_id
        )
      )
    then
      raise exception 'No se puede cambiar el cliente porque la factura tiene cobros o notas aplicadas.';
    end if;
  end if;

  result:=public.save_sales_invoice_before_intercompany_receivable(
    payload,target_invoice_id
  );
  invoice_key:=nullif(result->>'invoiceId','')::bigint;

  select invoice.journal_id,invoice.transaction_id,invoice.customer_id,
    invoice.subsidiary_id
    into journal_key,transaction_key,customer_key,subsidiary_key
  from public.invoice invoice
  where invoice.invoice_id=invoice_key
    and invoice.subsidiary_id=public.active_subsidiary_id();

  if not found then
    raise exception 'La factura guardada no pertenece a la subsidiaria activa.';
  end if;

  if prior_account_key is not null and prior_customer_key=customer_key then
    account_key:=prior_account_key;
  else
    account_key:=public.resolve_customer_receivable_account(
      subsidiary_key,customer_key
    );
  end if;

  update public.invoice
  set receivable_account_id=account_key
  where invoice_id=invoice_key;

  -- The legacy editor did not mirror a changed customer to the transaction
  -- header.  Keep the document, journal dimensions and account snapshot aligned.
  update public."transaction"
  set customer_id=customer_key
  where transaction_id=transaction_key;

  update public.journal_line line
  set account_id=account_key
  where line.journal_id=journal_key
    and line.customer_id=customer_key
    and line.entity_type='Cliente'
    and lower(coalesce(line.note,'')) like 'cuenta por cobrar%';
  get diagnostics affected=row_count;

  if affected<>1 then
    raise exception 'No fue posible identificar una única línea de cuenta por cobrar en la factura.';
  end if;

  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object('receivableAccountId',account_key);
end
$$;

create or replace function public.save_sales_note(
  p_kind text,
  p_payload jsonb,
  p_target_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  normalized_kind text:=upper(p_kind);
  note_key bigint;
  invoice_key bigint;
  journal_key bigint;
  customer_key bigint;
  subsidiary_key bigint;
  account_key bigint;
  affected integer;
begin
  if normalized_kind not in('CREDIT','DEBIT') then
    raise exception 'Tipo de nota no válido.';
  end if;

  result:=public.save_sales_note_before_intercompany_receivable(
    p_kind,p_payload,p_target_id
  );
  note_key:=nullif(result->>'noteId','')::bigint;

  if normalized_kind='CREDIT' then
    select note.invoice_id,note.journal_id,note.customer_id,invoice.subsidiary_id,
      invoice.receivable_account_id
      into invoice_key,journal_key,customer_key,subsidiary_key,account_key
    from public.credit_note note
    join public.invoice invoice using(invoice_id)
    where note.cn_id=note_key
      and invoice.subsidiary_id=public.active_subsidiary_id();
  else
    select note.invoice_id,note.journal_id,note.customer_id,invoice.subsidiary_id,
      invoice.receivable_account_id
      into invoice_key,journal_key,customer_key,subsidiary_key,account_key
    from public.debit_note note
    join public.invoice invoice using(invoice_id)
    where note.dn_id=note_key
      and invoice.subsidiary_id=public.active_subsidiary_id();
  end if;

  if not found then
    raise exception 'La nota guardada no pertenece a la subsidiaria activa.';
  end if;

  if account_key is null then
    account_key:=public.resolve_customer_receivable_account(
      subsidiary_key,customer_key
    );
    update public.invoice
    set receivable_account_id=account_key
    where invoice_id=invoice_key;
  end if;

  update public.journal_line line
  set account_id=account_key
  where line.journal_id=journal_key
    and line.customer_id=customer_key
    and line.entity_type='Cliente'
    and lower(coalesce(line.note,'')) like 'cuenta por cobrar%';
  get diagnostics affected=row_count;

  if affected<>1 then
    raise exception 'No fue posible identificar una única línea de cuenta por cobrar en la nota.';
  end if;

  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object('receivableAccountId',account_key);
end
$$;

create or replace function public.apply_customer_payment_receivable_accounts(
  p_payment_id bigint,
  p_expected_total numeric
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  payment_row public.customer_payment%rowtype;
  applied_total numeric;
  replaced integer;
  inserted integer;
  account_keys jsonb;
begin
  select payment.* into payment_row
  from public.customer_payment payment
  join public."transaction" transaction using(transaction_id)
  where payment.payment_id=p_payment_id
    and transaction.subsidiary_id=public.active_subsidiary_id();

  if payment_row.payment_id is null then
    raise exception 'El cobro guardado no pertenece a la subsidiaria activa.';
  end if;

  -- Defensive support for invoices inserted by imports or integrations that do
  -- not yet populate the snapshot themselves.
  update public.invoice invoice
  set receivable_account_id=public.resolve_customer_receivable_account(
    invoice.subsidiary_id,invoice.customer_id
  )
  where invoice.receivable_account_id is null
    and exists(
      select 1
      from public.customer_payment_application application
      where application.payment_id=p_payment_id
        and application.invoice_id=invoice.invoice_id
    );

  select coalesce(sum(application.amount),0)
    into applied_total
  from public.customer_payment_application application
  where application.payment_id=p_payment_id;

  if abs(applied_total-p_expected_total)>.000001 then
    raise exception 'Las aplicaciones del cobro no coinciden con el total contabilizado.';
  end if;

  delete from public.journal_line line
  using public.chart_accounts account
  where line.journal_id=payment_row.journal_id
    and line.account_id=account.account_id
    and line.customer_id=payment_row.customer_id
    and line.entity_type='Cliente'
    and coalesce(line.debit,0)=0
    and coalesce(line.credit,0)>0
    and(
      account.account_number in('113001','113002')
      or line.account_id in(
        select invoice.receivable_account_id
        from public.customer_payment_application application
        join public.invoice invoice using(invoice_id)
        where application.payment_id=p_payment_id
      )
    );
  get diagnostics replaced=row_count;

  if replaced<1 then
    raise exception 'No fue posible identificar las líneas de cuenta por cobrar en el cobro.';
  end if;

  insert into public.journal_line(
    journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,
    note,entity_type,customer_id
  )
  select payment_row.journal_id,invoice.receivable_account_id,
    0,sum(application.amount),0,sum(application.amount)*payment_row.exchange_rate,
    payment_row.location_id,coalesce(payment_row.memo,'Cobro de cliente'),
    'Cliente',payment_row.customer_id
  from public.customer_payment_application application
  join public.invoice invoice using(invoice_id)
  where application.payment_id=p_payment_id
  group by invoice.receivable_account_id;
  get diagnostics inserted=row_count;

  if inserted<1 then
    raise exception 'El cobro no contiene aplicaciones con una cuenta por cobrar válida.';
  end if;

  perform public.sync_journal_gl_impacts(payment_row.journal_id);

  select coalesce(jsonb_agg(accounts.account_id order by accounts.account_id),'[]'::jsonb)
    into account_keys
  from(
    select distinct invoice.receivable_account_id account_id
    from public.customer_payment_application application
    join public.invoice invoice using(invoice_id)
    where application.payment_id=p_payment_id
  )accounts;

  return account_keys;
end
$$;

revoke all on function public.apply_customer_payment_receivable_accounts(bigint,numeric)
from public,anon,authenticated;

create or replace function public.save_customer_payment(
  p_payload jsonb,
  p_payment_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  payment_key bigint;
  account_keys jsonb;
begin
  result:=public.save_customer_payment_before_intercompany_receivable(
    p_payload,p_payment_id
  );
  payment_key:=nullif(result->>'id','')::bigint;
  account_keys:=public.apply_customer_payment_receivable_accounts(
    payment_key,coalesce(nullif(result->>'total','')::numeric,0)
  );
  return result||jsonb_build_object('receivableAccountIds',account_keys);
end
$$;

-- The application saves through the advance-aware entry point.  Wrap it as
-- well so the account normalization is guaranteed regardless of whether its
-- previously compiled inner call resolves the renamed or the new base RPC.
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
  payment_key bigint;
  expected_total numeric;
  account_keys jsonb;
begin
  result:=public.save_customer_payment_with_advances_before_intercompany_receivable(
    p_payload,p_payment_id
  );
  payment_key:=nullif(result->>'id','')::bigint;
  expected_total:=coalesce(
    nullif(result->>'grossTotal','')::numeric,
    nullif(result->>'total','')::numeric,
    0
  );
  account_keys:=public.apply_customer_payment_receivable_accounts(
    payment_key,expected_total
  );
  return result||jsonb_build_object('receivableAccountIds',account_keys);
end
$$;

revoke all on function public.save_sales_invoice(jsonb,bigint),
  public.save_sales_note(text,jsonb,bigint),
  public.save_customer_payment(jsonb,bigint),
  public.save_customer_payment_with_advances(jsonb,bigint)
from public,anon;

grant execute on function public.save_sales_invoice(jsonb,bigint),
  public.save_sales_note(text,jsonb,bigint),
  public.save_customer_payment(jsonb,bigint),
  public.save_customer_payment_with_advances(jsonb,bigint)
to authenticated;

notify pgrst,'reload schema';
