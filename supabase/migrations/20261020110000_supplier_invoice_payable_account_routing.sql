-- Preserve the payable account selected when a supplier invoice is posted.
-- Subsequent supplier notes and payments clear this snapshot, even if the
-- supplier classification or the invoice type changes later.
alter table public.supplier_invoice
  add column if not exists payable_account_id bigint;

do $$
begin
  if not exists(
    select 1
    from pg_constraint
    where conrelid='public.supplier_invoice'::regclass
      and conname='supplier_invoice_payable_account_id_fkey'
  )then
    alter table public.supplier_invoice
      add constraint supplier_invoice_payable_account_id_fkey
      foreign key(payable_account_id)
      references public.chart_accounts(account_id);
  end if;
end
$$;

create index if not exists supplier_invoice_payable_account_idx
  on public.supplier_invoice(payable_account_id);

comment on column public.supplier_invoice.payable_account_id is
  'Historical payable account selected from invoice type and supplier classification.';

-- amount_paid stores the actual bank/cash disbursement. A payment settled
-- entirely with supplier advances is valid and therefore has amount_paid=0.
-- Replace only the known historical check; leave every other table constraint
-- untouched.
do $$
declare
  constraint_definition text;
begin
  select pg_get_constraintdef(constraint_record.oid)
    into constraint_definition
  from pg_constraint constraint_record
  where constraint_record.conrelid='public.supplier_payment'::regclass
    and constraint_record.conname='supplier_payment_amount_paid_check'
    and constraint_record.contype='c';

  if constraint_definition is not null
    and position('amount_paid >= ' in constraint_definition)=0
  then
    alter table public.supplier_payment
      drop constraint supplier_payment_amount_paid_check;
    constraint_definition:=null;
  end if;

  if constraint_definition is null then
    alter table public.supplier_payment
      add constraint supplier_payment_amount_paid_check
      check(amount_paid>=0);
  end if;
end
$$;

create or replace function public.resolve_supplier_payable_account(
  p_subsidiary_id bigint,
  p_supplier_id bigint,
  p_invoice_type text
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
    raise exception 'No se pudo determinar la subsidiaria para asignar la cuenta por pagar.';
  end if;

  select coalesce(supplier.is_intercompany,false)
    into intercompany
  from public.suppliers supplier
  where supplier.supplier_id=p_supplier_id;

  if not found then
    raise exception 'No se encontró el proveedor para asignar la cuenta por pagar.';
  end if;

  required_number:=case
    when p_invoice_type='Factura Expense' then '211003'
    when p_invoice_type='Factura Caja Chica' then '211004'
    when intercompany then '211002'
    else '211001'
  end;

  select account.account_id
    into account_key
  from public.chart_accounts account
  join public.account_subsidiaries assignment using(account_id)
  where account.account_number=required_number
    and assignment.subsidiary_id=p_subsidiary_id
    and assignment.is_active
    and account.accepts_entries
    and not account.is_inactive
    and account.category='Pasivo'
    and account.nature='Acreedora'
    and account.financial_statement='Balance General'
  order by account.account_id
  limit 1;

  if account_key is null then
    raise exception 'La cuenta % no está activa y vinculada a la subsidiaria.',required_number;
  end if;

  return account_key;
end
$$;

revoke all on function public.resolve_supplier_payable_account(bigint,bigint,text)
  from public,anon,authenticated;

-- Historical invoices keep the account that was actually posted. Opening
-- invoices are tied to their exact opening line. Only records without usable
-- accounting detail fall back to the current routing rule.
with historical as (
  select invoice.invoice_id,
    coalesce(
      (
        select line.account_id
        from public.journal_line line
        where invoice.opening_balance_line_id is not null
          and line.opening_balance_line_id=invoice.opening_balance_line_id
          and line.supplier_id=invoice.supplier_id
        order by line.journal_line_id
        limit 1
      ),
      (
        select line.account_id
        from public.journal_line line
        where line.journal_id=invoice.journal_id
          and line.supplier_id=invoice.supplier_id
          and line.entity_type='Proveedor'
          and lower(coalesce(line.note,'')) like 'cuenta por pagar%'
        order by line.journal_line_id
        limit 1
      ),
      (
        select line.account_id
        from public.journal_line line
        join public.chart_accounts account using(account_id)
        where line.journal_id=invoice.journal_id
          and line.supplier_id=invoice.supplier_id
          and line.entity_type='Proveedor'
          and account.category='Pasivo'
          and account.account_name~*'(cuenta.*por pagar|proveedor.*por pagar)'
        order by
          case when account.account_number in('211001','211002','211003','211004') then 0 else 1 end,
          abs(coalesce(line.credit,0)-coalesce(line.debit,0)) desc,
          line.journal_line_id
        limit 1
      ),
      public.resolve_supplier_payable_account(
        invoice.subsidiary_id,invoice.supplier_id,invoice.invoice_type
      )
    ) account_id
  from public.supplier_invoice invoice
  where invoice.payable_account_id is null
)
update public.supplier_invoice invoice
set payable_account_id=historical.account_id
from historical
where invoice.invoice_id=historical.invoice_id;

-- Resolve a missing snapshot defensively for documents created by imports or
-- older integrations. Prefer the exact historical posting before applying the
-- current master-data rule.
create or replace function public.ensure_supplier_invoice_payable_account(
  p_invoice_id bigint
)returns bigint
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  invoice_row public.supplier_invoice%rowtype;
  account_key bigint;
begin
  select invoice.* into invoice_row
  from public.supplier_invoice invoice
  where invoice.invoice_id=p_invoice_id;

  if invoice_row.invoice_id is null then
    raise exception 'No se encontró la factura de proveedor relacionada.';
  end if;

  -- Established snapshots are immutable in the document flows and need no
  -- write lock. For legacy/imported rows without one, serialize the recovery
  -- and re-read after acquiring the lock so concurrent notes or payments all
  -- use the same account selected by the first caller.
  if invoice_row.payable_account_id is null then
    select invoice.* into invoice_row
    from public.supplier_invoice invoice
    where invoice.invoice_id=p_invoice_id
    for update;

    if invoice_row.invoice_id is null then
      raise exception 'No se encontró la factura de proveedor relacionada.';
    end if;
  end if;

  account_key:=invoice_row.payable_account_id;

  if account_key is null and invoice_row.opening_balance_line_id is not null then
    select line.account_id into account_key
    from public.journal_line line
    where line.opening_balance_line_id=invoice_row.opening_balance_line_id
      and line.supplier_id=invoice_row.supplier_id
    order by line.journal_line_id
    limit 1;
  end if;

  if account_key is null then
    select line.account_id into account_key
    from public.journal_line line
    where line.journal_id=invoice_row.journal_id
      and line.supplier_id=invoice_row.supplier_id
      and line.entity_type='Proveedor'
      and lower(coalesce(line.note,'')) like 'cuenta por pagar%'
    order by line.journal_line_id
    limit 1;
  end if;

  if account_key is null then
    select line.account_id into account_key
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=invoice_row.journal_id
      and line.supplier_id=invoice_row.supplier_id
      and line.entity_type='Proveedor'
      and account.category='Pasivo'
      and account.account_name~*'(cuenta.*por pagar|proveedor.*por pagar)'
    order by
      case when account.account_number in('211001','211002','211003','211004') then 0 else 1 end,
      abs(coalesce(line.credit,0)-coalesce(line.debit,0)) desc,
      line.journal_line_id
    limit 1;
  end if;

  if account_key is null then
    account_key:=public.resolve_supplier_payable_account(
      invoice_row.subsidiary_id,invoice_row.supplier_id,invoice_row.invoice_type
    );
  end if;

  if not exists(
    select 1
    from public.chart_accounts account
    join public.account_subsidiaries assignment using(account_id)
    where account.account_id=account_key
      and assignment.subsidiary_id=invoice_row.subsidiary_id
      and assignment.is_active
      and account.accepts_entries
      and not account.is_inactive
      and account.category='Pasivo'
      and account.nature='Acreedora'
      and account.financial_statement='Balance General'
  )then
    raise exception 'La cuenta por pagar histórica no está disponible para contabilizar en la subsidiaria.';
  end if;

  update public.supplier_invoice
  set payable_account_id=account_key
  where invoice_id=invoice_row.invoice_id
    and payable_account_id is null;

  return account_key;
end
$$;

revoke all on function public.ensure_supplier_invoice_payable_account(bigint)
  from public,anon,authenticated;

-- The advance-aware payment flow calculates its final cash amount only after
-- inserting supplier_advance_application. The original protection trigger
-- rejected that internal normalization as if it were a manual edit. Keep the
-- document immutable, but permit the one derived amount_paid update when no
-- other column changes and the value exactly reconciles applications,
-- advances and payment-time withholdings.
create or replace function public.protect_applied_supplier_advance()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  expected_cash numeric;
begin
  if exists(
    select 1
    from public.supplier_advance_application application
    where application.payment_id=old.payment_id
  )then
    if tg_op='UPDATE' then
      select greatest(
        coalesce((
          select sum(application.amount)
          from public.supplier_payment_application application
          where application.payment_id=old.payment_id
        ),0)
        -coalesce((
          select sum(application.amount)
          from public.supplier_advance_application application
          where application.payment_id=old.payment_id
        ),0)
        -coalesce((
          select sum(withholding.withholding_amount)
          from public.supplier_payment_withholding withholding
          where withholding.payment_id=old.payment_id
        ),0),
        0
      ) into expected_cash;

      if (to_jsonb(new)-'amount_paid')
           is not distinct from (to_jsonb(old)-'amount_paid')
        and abs(coalesce(new.amount_paid,0)-expected_cash)<=.000001
      then
        return new;
      end if;
    end if;

    raise exception 'El pago aplicó anticipos y no puede modificarse ni eliminarse directamente.';
  end if;

  return case when tg_op='DELETE' then old else new end;
end
$$;

revoke all on function public.protect_applied_supplier_advance()
  from public,anon,authenticated;

do $$
begin
  -- This is the operational entry point called by budget_run, including the
  -- approved-over-budget flow. Wrapping only save_supplier_invoice would leave
  -- that route unprotected.
  if to_regprocedure('public.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint)') is null then
    alter function public.save_supplier_invoice_without_budget(jsonb,bigint)
      rename to save_supplier_invoice_without_budget_before_payable_routing;
  end if;
  if to_regprocedure('public.save_supplier_note_before_payable_routing(text,jsonb,bigint)') is null then
    alter function public.save_supplier_note(text,jsonb,bigint)
      rename to save_supplier_note_before_payable_routing;
  end if;
  if to_regprocedure('public.save_supplier_payment_before_payable_routing(jsonb,bigint)') is null then
    alter function public.save_supplier_payment(jsonb,bigint)
      rename to save_supplier_payment_before_payable_routing;
  end if;
  if to_regprocedure('public.save_supplier_payment_with_advances_before_payable_routing(jsonb,bigint)') is null then
    alter function public.save_supplier_payment_with_advances(jsonb,bigint)
      rename to save_supplier_payment_with_advances_before_payable_routing;
  end if;
end
$$;

revoke all on function
  public.save_supplier_invoice_without_budget_before_payable_routing(jsonb,bigint),
  public.save_supplier_note_before_payable_routing(text,jsonb,bigint),
  public.save_supplier_payment_before_payable_routing(jsonb,bigint),
  public.save_supplier_payment_with_advances_before_payable_routing(jsonb,bigint)
from public,anon,authenticated;

-- These older implementation layers are invoked only through SECURITY DEFINER
-- entry points. Renames preserve ACLs, so revoke them explicitly to prevent an
-- authenticated RPC caller from bypassing withholding, advance or routing
-- controls.
revoke all on function
  public.save_supplier_invoice_without_withholding(jsonb,bigint),
  public.save_supplier_payment_without_withholding(jsonb,bigint),
  public.save_supplier_payment_with_advances_base(jsonb,bigint)
from public,anon,authenticated;

create or replace function public.save_supplier_invoice_without_budget(
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
  supplier_key bigint;
  subsidiary_key bigint;
  invoice_type_value text;
  prior_supplier_key bigint;
  prior_invoice_type text;
  requested_supplier_key bigint:=nullif(payload->>'supplier_id','')::bigint;
  requested_invoice_type text:=payload->>'invoice_type';
  prior_account_key bigint;
  prior_invoice_found boolean:=false;
  account_key bigint;
  affected integer;
begin
  if target_invoice_id is not null then
    select invoice.supplier_id,invoice.invoice_type,invoice.payable_account_id
      into prior_supplier_key,prior_invoice_type,prior_account_key
    from public.supplier_invoice invoice
    where invoice.invoice_id=target_invoice_id
      and invoice.subsidiary_id=public.active_subsidiary_id();
    prior_invoice_found:=found;

    if prior_invoice_found
      and(
        prior_supplier_key is distinct from requested_supplier_key
        or prior_invoice_type is distinct from requested_invoice_type
      )
      and(
        exists(
          select 1 from public.supplier_payment_application application
          where application.invoice_id=target_invoice_id
        )
        or exists(
          select 1 from public.supplier_credit_note note
          where note.invoice_id=target_invoice_id
        )
        or exists(
          select 1 from public.supplier_debit_note note
          where note.invoice_id=target_invoice_id
        )
      )
    then
      raise exception 'No se puede cambiar el proveedor ni el tipo de factura porque existen pagos o notas relacionados.';
    end if;

    -- Recover a missing historical snapshot before the legacy editor deletes
    -- and rebuilds journal lines. The helper also verifies that an existing
    -- snapshot remains an active posting account for this subsidiary.
    if prior_invoice_found
      and prior_supplier_key=requested_supplier_key
      and prior_invoice_type=requested_invoice_type
    then
      prior_account_key:=public.ensure_supplier_invoice_payable_account(
        target_invoice_id
      );
    end if;
  end if;

  result:=public.save_supplier_invoice_without_budget_before_payable_routing(
    payload,target_invoice_id
  );

  -- Defensive for future wrappers that may return a pending result without
  -- creating a document. The current inner routine always returns invoiceId.
  invoice_key:=nullif(result->>'invoiceId','')::bigint;
  if invoice_key is null then
    return result;
  end if;

  select invoice.journal_id,invoice.transaction_id,invoice.supplier_id,
    invoice.subsidiary_id,invoice.invoice_type
    into journal_key,transaction_key,supplier_key,subsidiary_key,
      invoice_type_value
  from public.supplier_invoice invoice
  where invoice.invoice_id=invoice_key
    and invoice.subsidiary_id=public.active_subsidiary_id();

  if not found then
    raise exception 'La factura guardada no pertenece a la subsidiaria activa.';
  end if;

  if prior_account_key is not null
    and prior_supplier_key=supplier_key
    and prior_invoice_type=invoice_type_value
  then
    account_key:=prior_account_key;
  else
    account_key:=public.resolve_supplier_payable_account(
      subsidiary_key,supplier_key,invoice_type_value
    );
  end if;

  update public.supplier_invoice
  set payable_account_id=account_key
  where invoice_id=invoice_key;

  update public."transaction"
  set supplier_id=supplier_key
  where transaction_id=transaction_key;

  update public.journal_line line
  set account_id=account_key
  where line.journal_id=journal_key
    and line.supplier_id=supplier_key
    and line.entity_type='Proveedor'
    and lower(coalesce(line.note,'')) like 'cuenta por pagar%';
  get diagnostics affected=row_count;

  if affected<>1 then
    raise exception 'No fue posible identificar una única línea de cuenta por pagar en la factura.';
  end if;

  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object('payableAccountId',account_key);
end
$$;

revoke all on function public.save_supplier_invoice_without_budget(jsonb,bigint)
  from public,anon,authenticated;

create or replace function public.save_supplier_note(
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
  supplier_key bigint;
  subsidiary_key bigint;
  account_key bigint;
  affected integer;
begin
  if normalized_kind not in('CREDIT','DEBIT') then
    raise exception 'Tipo de nota no válido.';
  end if;

  result:=public.save_supplier_note_before_payable_routing(
    p_kind,p_payload,p_target_id
  );
  note_key:=nullif(result->>'noteId','')::bigint;

  if normalized_kind='CREDIT' then
    select note.invoice_id,note.journal_id,note.supplier_id,invoice.subsidiary_id
      into invoice_key,journal_key,supplier_key,subsidiary_key
    from public.supplier_credit_note note
    join public.supplier_invoice invoice using(invoice_id)
    where note.cn_id=note_key
      and invoice.subsidiary_id=public.active_subsidiary_id();
  else
    select note.invoice_id,note.journal_id,note.supplier_id,invoice.subsidiary_id
      into invoice_key,journal_key,supplier_key,subsidiary_key
    from public.supplier_debit_note note
    join public.supplier_invoice invoice using(invoice_id)
    where note.dn_id=note_key
      and invoice.subsidiary_id=public.active_subsidiary_id();
  end if;

  if not found then
    raise exception 'La nota guardada no pertenece a la subsidiaria activa.';
  end if;

  account_key:=public.ensure_supplier_invoice_payable_account(invoice_key);

  update public.journal_line line
  set account_id=account_key
  where line.journal_id=journal_key
    and line.supplier_id=supplier_key
    and line.entity_type='Proveedor'
    and lower(trim(coalesce(line.note,'')))='cuenta por pagar';
  get diagnostics affected=row_count;

  if affected<>1 then
    raise exception 'No fue posible identificar una única línea de cuenta por pagar en la nota.';
  end if;

  perform public.sync_journal_gl_impacts(journal_key);

  return result||jsonb_build_object('payableAccountId',account_key);
end
$$;

create or replace function public.apply_supplier_payment_payable_accounts(
  p_payment_id bigint,
  p_expected_total numeric
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  payment_row public.supplier_payment%rowtype;
  invoice_key bigint;
  applied_total numeric;
  replaced integer;
  inserted integer;
  account_keys jsonb;
begin
  select payment.* into payment_row
  from public.supplier_payment payment
  join public."transaction" transaction using(transaction_id)
  where payment.payment_id=p_payment_id
    and transaction.subsidiary_id=public.active_subsidiary_id();

  if payment_row.payment_id is null then
    raise exception 'El pago guardado no pertenece a la subsidiaria activa.';
  end if;

  for invoice_key in
    select distinct application.invoice_id
    from public.supplier_payment_application application
    where application.payment_id=p_payment_id
    order by application.invoice_id
  loop
    perform public.ensure_supplier_invoice_payable_account(invoice_key);
  end loop;

  select coalesce(sum(application.amount),0)
    into applied_total
  from public.supplier_payment_application application
  where application.payment_id=p_payment_id;

  if abs(applied_total-p_expected_total)>.000001 then
    raise exception 'Las aplicaciones del pago no coinciden con el total contabilizado.';
  end if;

  delete from public.journal_line line
  using public.chart_accounts account
  where line.journal_id=payment_row.journal_id
    and line.account_id=account.account_id
    and line.supplier_id=payment_row.supplier_id
    and line.entity_type='Proveedor'
    and coalesce(line.debit,0)>0
    and coalesce(line.credit,0)=0
    and(
      account.account_number in('211001','211002','211003','211004')
      or line.account_id in(
        select invoice.payable_account_id
        from public.supplier_payment_application application
        join public.supplier_invoice invoice using(invoice_id)
        where application.payment_id=p_payment_id
      )
    );
  get diagnostics replaced=row_count;

  if replaced<1 then
    raise exception 'No fue posible identificar las líneas de cuenta por pagar en el pago.';
  end if;

  insert into public.journal_line(
    journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,
    note,entity_type,supplier_id
  )
  select payment_row.journal_id,invoice.payable_account_id,
    sum(application.amount),0,
    sum(application.amount)*payment_row.exchange_rate,0,
    payment_row.location_id,coalesce(payment_row.memo,'Pago a proveedor'),
    'Proveedor',payment_row.supplier_id
  from public.supplier_payment_application application
  join public.supplier_invoice invoice using(invoice_id)
  where application.payment_id=p_payment_id
  group by invoice.payable_account_id;
  get diagnostics inserted=row_count;

  if inserted<1 then
    raise exception 'El pago no contiene aplicaciones con una cuenta por pagar válida.';
  end if;

  perform public.sync_journal_gl_impacts(payment_row.journal_id);

  select coalesce(
    jsonb_agg(accounts.account_id order by accounts.account_id),'[]'::jsonb
  ) into account_keys
  from(
    select distinct invoice.payable_account_id account_id
    from public.supplier_payment_application application
    join public.supplier_invoice invoice using(invoice_id)
    where application.payment_id=p_payment_id
  )accounts;

  return account_keys;
end
$$;

revoke all on function public.apply_supplier_payment_payable_accounts(bigint,numeric)
  from public,anon,authenticated;

create or replace function public.save_supplier_payment(
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
  result:=public.save_supplier_payment_before_payable_routing(
    p_payload,p_payment_id
  );
  payment_key:=nullif(result->>'id','')::bigint;
  account_keys:=public.apply_supplier_payment_payable_accounts(
    payment_key,coalesce(nullif(result->>'total','')::numeric,0)
  );
  return result||jsonb_build_object('payableAccountIds',account_keys);
end
$$;

create or replace function public.save_supplier_payment_with_advances(
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
  advance_total numeric;
  withholding_total numeric;
  account_keys jsonb;
begin
  result:=public.save_supplier_payment_with_advances_before_payable_routing(
    p_payload,p_payment_id
  );
  payment_key:=nullif(result->>'id','')::bigint;
  expected_total:=coalesce(
    nullif(result->>'grossTotal','')::numeric,
    nullif(result->>'total','')::numeric,
    0
  );
  advance_total:=coalesce(nullif(result->>'advanceTotal','')::numeric,0);
  withholding_total:=coalesce(nullif(result->>'withholdingTotal','')::numeric,0);

  if advance_total+withholding_total>expected_total+.000001 then
    raise exception 'La suma de anticipos y retenciones (%) no puede superar el total aplicado a facturas (%).',
      round(advance_total+withholding_total,2),round(expected_total,2);
  end if;

  account_keys:=public.apply_supplier_payment_payable_accounts(
    payment_key,expected_total
  );
  return result||jsonb_build_object('payableAccountIds',account_keys);
end
$$;

revoke all on function public.save_supplier_note(text,jsonb,bigint),
  public.save_supplier_payment(jsonb,bigint),
  public.save_supplier_payment_with_advances(jsonb,bigint)
from public,anon;

grant execute on function public.save_supplier_note(text,jsonb,bigint),
  public.save_supplier_payment(jsonb,bigint),
  public.save_supplier_payment_with_advances(jsonb,bigint)
to authenticated;

notify pgrst,'reload schema';
