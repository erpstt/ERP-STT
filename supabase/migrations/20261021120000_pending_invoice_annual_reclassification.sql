-- Annual reclassification of unbilled revenue.
--
-- Current-period items live in 113003 / 413001.  At January 1 every open
-- item is moved, at its frozen historical rate, through the zero-net bridge
-- 413002 into 113004.  Operational balances are not consumed by this move;
-- subsequent billing reversals use 413002 / 113004.

insert into public.transaction_types(abbreviation,name,module_category,description)
values(
  'ASI_RECL_PEN',
  'Reclasificación anual de pendientes de facturar',
  'Contabilidad',
  'Traslado de pendientes vivos del período actual a períodos anteriores, conservando la tasa histórica.'
)
on conflict(abbreviation) do update set
  name=excluded.name,
  module_category=excluded.module_category,
  description=excluded.description;

alter table public.journal
  add column if not exists pending_period_type text,
  add column if not exists pending_origin_journal_id bigint references public.journal(journal_id) on delete restrict;

alter table public.opening_pending_invoice_items
  add column if not exists period_type text not null default 'ACTUAL',
  add column if not exists origin_journal_id bigint references public.journal(journal_id) on delete restrict;

update public.opening_pending_invoice_items item
set origin_journal_id=coalesce(item.origin_journal_id,run.journal_id)
from public.opening_balance_runs run
where run.id=item.run_id and run.journal_id is not null;

alter table public.journal
  drop constraint if exists journal_pending_period_type_allowed;
alter table public.journal
  add constraint journal_pending_period_type_allowed
  check(pending_period_type is null or pending_period_type in('ACTUAL','ANTERIOR'));

alter table public.opening_pending_invoice_items
  drop constraint if exists opening_pending_period_type_allowed;
alter table public.opening_pending_invoice_items
  add constraint opening_pending_period_type_allowed
  check(period_type in('ACTUAL','ANTERIOR'));

create index if not exists journal_pending_period_idx
  on public.journal(subsidiary_id,pending_period_type,reversal_status,journal_date)
  where pending_period_type is not null;
create index if not exists opening_pending_period_idx
  on public.opening_pending_invoice_items(subsidiary_id,period_type,reversal_status,origin_date)
  where is_active;

-- Keep the accounting invariant used by every posting routine and serialize
-- primary-book changes with the annual reclassification.  Existing bad data
-- is reported by preview/execute; new writes cannot introduce a second active
-- primary book while a run is being calculated.
create or replace function public.enforce_one_active_primary_accounting_book()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  previous_subsidiary bigint;
  lock_subsidiary bigint;
begin
  previous_subsidiary:=case when tg_op='UPDATE'then old.subsidiary_id else null end;
  for lock_subsidiary in
    select distinct value
    from unnest(array[previous_subsidiary,new.subsidiary_id])value
    where value is not null
    order by value
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'pending-invoice-reclassification-subsidiary:'||lock_subsidiary,0
    ));
  end loop;
  if new.is_primary and new.is_active and exists(
    select 1 from public.accounting_books other_book
    where other_book.subsidiary_id=new.subsidiary_id
      and other_book.is_primary and other_book.is_active
      and other_book.accounting_book_id<>coalesce(new.accounting_book_id,-1)
  )then
    raise exception 'La subsidiaria solo puede tener un libro contable principal activo.';
  end if;
  return new;
end
$$;

drop trigger if exists enforce_one_active_primary_accounting_book_trigger
  on public.accounting_books;
create trigger enforce_one_active_primary_accounting_book_trigger
before insert or update of subsidiary_id,is_primary,is_active
on public.accounting_books for each row
execute function public.enforce_one_active_primary_accounting_book();

revoke all on function public.enforce_one_active_primary_accounting_book()
  from public,anon,authenticated;

-- Journal updates normally synchronize their transaction and are rejected in
-- a closed period.  The annual move only updates protected operational
-- metadata on the source journal; it must not rewrite its historical posting.
create or replace function public.sync_journal_transaction()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  tt bigint;
  st bigint;
  tid bigint;
  type_abbreviation text;
begin
  if tg_op='UPDATE'
    and current_user='postgres'
    and coalesce(current_setting('app.pending_reclassification_internal',true),'')='1'
    and(old.pending_period_type is distinct from new.pending_period_type
      or old.pending_origin_journal_id is distinct from new.pending_origin_journal_id)
    and(to_jsonb(new)-array['pending_period_type','pending_origin_journal_id'])
      =(to_jsonb(old)-array['pending_period_type','pending_origin_journal_id']) then
    return new;
  end if;

  -- A controlled pending reversal only updates the operational balance of
  -- its source.  Do not rewrite the historical transaction behind it.
  if tg_op='UPDATE'
    and coalesce(current_setting('app.pending_reversal_write',true),'')='1'
    and(old.pending_initial_local is distinct from new.pending_initial_local
      or old.pending_initial_foreign is distinct from new.pending_initial_foreign
      or old.pending_reversed_local is distinct from new.pending_reversed_local
      or old.pending_reversed_foreign is distinct from new.pending_reversed_foreign
      or old.pending_balance_local is distinct from new.pending_balance_local
      or old.pending_balance_foreign is distinct from new.pending_balance_foreign
      or old.reversal_status is distinct from new.reversal_status)
    and(to_jsonb(new)-array[
      'pending_initial_local','pending_initial_foreign',
      'pending_reversed_local','pending_reversed_foreign',
      'pending_balance_local','pending_balance_foreign','reversal_status'
    ])=(to_jsonb(old)-array[
      'pending_initial_local','pending_initial_foreign',
      'pending_reversed_local','pending_reversed_foreign',
      'pending_balance_local','pending_balance_foreign','reversal_status'
    ]) then
    return new;
  end if;

  type_abbreviation:=case new.journal_type
    when 'Asientos Pendientes de Facturar' then 'ASI_PEN'
    when 'Asiento de Nóminas' then 'ASI_NOM'
    when 'Asiento de Liquidación' then 'ASI_LIQ'
    when 'Reclasificación Anual de Pendientes de Facturar' then 'ASI_RECL_PEN'
    else 'ASI_DIA'
  end;

  select transaction_type_id into tt
  from public.transaction_types
  where abbreviation=type_abbreviation
  limit 1;

  select status_id into st
  from public.status
  where code='APROBADO' and module='Transacciones'
  limit 1;

  if tt is null then raise exception 'No existe el tipo de transacción %.',type_abbreviation;end if;
  if st is null then select status_id into st from public.status order by status_id limit 1;end if;

  if new.transaction_id is null then
    insert into public."transaction"(
      tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
      exchange_rate,fiscal_period_id,total_amount,status_id
    )values(
      new.journal_number,new.journal_date,tt,new.subsidiary_id,new.currency_id,
      new.exchange_rate,new.fiscal_period_id,
      greatest(coalesce(new.total_debit,0),coalesce(new.total_credit,0)),st
    )
    on conflict(tran_number)do update set
      tran_date=excluded.tran_date,
      transaction_type_id=excluded.transaction_type_id,
      subsidiary_id=excluded.subsidiary_id,
      currency_id=excluded.currency_id,
      exchange_rate=excluded.exchange_rate,
      fiscal_period_id=excluded.fiscal_period_id,
      total_amount=excluded.total_amount,
      status_id=excluded.status_id
    returning transaction_id into tid;
    new.transaction_id:=tid;
  else
    update public."transaction" set
      tran_date=new.journal_date,
      subsidiary_id=new.subsidiary_id,
      currency_id=new.currency_id,
      exchange_rate=new.exchange_rate,
      fiscal_period_id=new.fiscal_period_id,
      total_amount=greatest(coalesce(new.total_debit,0),coalesce(new.total_credit,0)),
      status_id=st
    where transaction_id=new.transaction_id;
  end if;
  return new;
end
$$;



-- Exact balances at the January 1 cut-off.  Regular ASI_PEN amounts are read
-- from the primary-book GL impact of 113003 and reduced only by reversals dated
-- before the cut-off.  Opening items use the same as-of rule over their audited
-- local/original snapshots.  A separate guard rejects later reversals so a
-- backdated annual move can never silently rewrite the historical position.
create or replace function public.pending_invoice_reclassification_candidates(
  p_subsidiary_id bigint,
  p_reclassification_date date
)returns table(
  source_type text,
  source_id bigint,
  source_reference text,
  origin_date date,
  origin_journal_id bigint,
  customer_id bigint,
  customer_name text,
  currency_id bigint,
  currency_code text,
  historical_exchange_rate numeric,
  balance_local numeric,
  balance_foreign numeric,
  service_month text,
  service_country_id bigint,
  service_country text,
  control_line_id bigint,
  counterpart_line_id bigint
)
language sql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_reclassification_candidates(bigint,date)
  from public,anon,authenticated;

-- Reconcile the auxiliary selected for the annual move against the complete
-- primary-book balance of 113003 at the cut-off.  This catches manual entries,
-- orphaned impacts, stale status flags and any opening detail missing from the
-- auxiliary before an entry is posted.
create or replace function public.pending_invoice_reclassification_reconciliation(
  p_subsidiary_id bigint,
  p_reclassification_date date
)returns table(
  currency_id bigint,
  currency_code text,
  ledger_local numeric,
  auxiliary_local numeric,
  local_difference numeric,
  ledger_foreign numeric,
  auxiliary_foreign numeric,
  foreign_difference numeric,
  balanced boolean
)
language sql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_reclassification_reconciliation(bigint,date)
  from public,anon,authenticated;

create or replace function public.guard_journal_accounting_period()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
declare
  closed boolean;
  inactive boolean;
  name text;
  period_id bigint;
begin
  if tg_op='UPDATE'
    and current_user='postgres'
    and coalesce(current_setting('app.pending_reclassification_internal',true),'')='1'
    and(old.pending_period_type is distinct from new.pending_period_type
      or old.pending_origin_journal_id is distinct from new.pending_origin_journal_id)
    and(to_jsonb(new)-array['pending_period_type','pending_origin_journal_id'])
      =(to_jsonb(old)-array['pending_period_type','pending_origin_journal_id']) then
    return new;
  end if;
  if tg_op='UPDATE'
    and current_user='postgres'
    and coalesce(current_setting('app.pending_reversal_write',true),'')='1'
    and(old.pending_initial_local is distinct from new.pending_initial_local
      or old.pending_initial_foreign is distinct from new.pending_initial_foreign
      or old.pending_reversed_local is distinct from new.pending_reversed_local
      or old.pending_reversed_foreign is distinct from new.pending_reversed_foreign
      or old.pending_balance_local is distinct from new.pending_balance_local
      or old.pending_balance_foreign is distinct from new.pending_balance_foreign
      or old.reversal_status is distinct from new.reversal_status)
    and(to_jsonb(new)-array[
      'pending_initial_local','pending_initial_foreign',
      'pending_reversed_local','pending_reversed_foreign',
      'pending_balance_local','pending_balance_foreign','reversal_status'
    ])=(to_jsonb(old)-array[
      'pending_initial_local','pending_initial_foreign',
      'pending_reversed_local','pending_reversed_foreign',
      'pending_balance_local','pending_balance_foreign','reversal_status'
    ]) then
    return new;
  end if;
  period_id:=case when tg_op='DELETE' then old.fiscal_period_id else new.fiscal_period_id end;
  select(is_closed or gl_closed),is_inactive,period_name
    into closed,inactive,name
  from public.fiscal_periods where fiscal_period_id=period_id;
  if closed or inactive then raise exception 'Libro Mayor (GL) está cerrado para el período %.',name;end if;
  return case when tg_op='DELETE' then old else new end;
end
$$;

create or replace function public.protect_pending_period_metadata()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
begin
  if tg_op='UPDATE'
    and(old.pending_period_type is distinct from new.pending_period_type
      or old.pending_origin_journal_id is distinct from new.pending_origin_journal_id)
    then
    if current_user<>'postgres'
      or coalesce(current_setting('app.pending_reclassification_internal',true),'')<>'1'
      or(to_jsonb(new)-array['pending_period_type','pending_origin_journal_id'])
        <>(to_jsonb(old)-array['pending_period_type','pending_origin_journal_id']) then
    raise exception 'El tipo de período del pendiente solo puede cambiar mediante la reclasificación anual.';
    end if;
  end if;
  if new.journal_number like 'ASI_PEN-%'
     or new.journal_type='Asientos Pendientes de Facturar' then
    if tg_op='INSERT'then
      -- Regular ASI_PEN records are always born in the current period.  The
      -- only authorized path to ANTERIOR is the annual reclassification.
      new.pending_period_type:='ACTUAL';
      new.pending_origin_journal_id:=new.journal_id;
    else
      new.pending_period_type:=coalesce(new.pending_period_type,'ACTUAL');
      new.pending_origin_journal_id:=coalesce(new.pending_origin_journal_id,new.journal_id);
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists protect_pending_period_metadata_trigger on public.journal;
create trigger protect_pending_period_metadata_trigger
before insert or update of journal_type,pending_period_type,pending_origin_journal_id
on public.journal for each row execute function public.protect_pending_period_metadata();

-- These balances may only be maintained by the trusted refresh/reversal
-- routines.  Client roles can set custom GUC values, so both the technical
-- owner and the narrow field list are verified here.
create or replace function public.protect_pending_reversal_metadata()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
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
$$;

drop trigger if exists protect_pending_reversal_metadata_trigger on public.journal;
create trigger protect_pending_reversal_metadata_trigger
before update of pending_initial_local,pending_initial_foreign,
  pending_reversed_local,pending_reversed_foreign,
  pending_balance_local,pending_balance_foreign,reversal_status
on public.journal for each row
execute function public.protect_pending_reversal_metadata();

-- Line maintenance legitimately refreshes the operational snapshot.  Mark
-- that exact internal UPDATE so the protection above can distinguish it from
-- direct table writes.
create or replace function public.refresh_pending_invoice_amounts()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  target bigint:=coalesce(new.journal_id,old.journal_id);
  local_amount numeric(24,6):=0;
  foreign_amount numeric(24,6):=0;
  control_account bigint;
begin
  select max(account_id)into control_account
  from public.chart_accounts where account_number='113003';
  select
    coalesce((
      select sum(impact.debit_amount)
      from public.gl_impact impact
      join public.accounting_books book
        on book.accounting_book_id=impact.accounting_book_id
        and book.subsidiary_id=journal_row.subsidiary_id
        and book.is_primary and book.is_active
      where impact.transaction_id=journal_row.transaction_id
        and impact.account_id=control_account
    ),(
      select sum(line.debit*journal_row.exchange_rate)
      from public.journal_line line where line.journal_id=target
        and line.account_id=control_account
    ),0),
    coalesce((
      select sum(impact.debit_fx)
      from public.gl_impact impact
      join public.accounting_books book
        on book.accounting_book_id=impact.accounting_book_id
        and book.subsidiary_id=journal_row.subsidiary_id
        and book.is_primary and book.is_active
      where impact.transaction_id=journal_row.transaction_id
        and impact.account_id=control_account
    ),(
      select sum(line.debit)
      from public.journal_line line where line.journal_id=target
        and line.account_id=control_account
    ),0)
  into local_amount,foreign_amount
  from public.journal journal_row where journal_row.journal_id=target;

  perform set_config('app.pending_reversal_write','1',true);
  update public.journal journal_row
  set pending_initial_local=local_amount,
    pending_initial_foreign=foreign_amount,
    pending_balance_local=local_amount,
    pending_balance_foreign=foreign_amount,
    reversal_status=case when journal_row.status='ANULADO'then'ANULADO'else'PENDIENTE'end
  where journal_row.journal_id=target
    and(journal_row.journal_number like'ASI_PEN-%'
      or journal_row.journal_type='Asientos Pendientes de Facturar')
    and journal_row.pending_reversed_local=0
    and journal_row.reversal_status in('N/A','PENDIENTE');
  perform set_config('app.pending_reversal_write','0',true);
  return coalesce(new,old);
end
$$;

-- Run the historical backfill only after synchronization and period guards
-- recognize this exact metadata-only operation. Accounting facts remain
-- immutable even when the source fiscal period is closed.
select set_config('app.pending_reclassification_internal','1',true);
update public.journal
set pending_period_type=coalesce(pending_period_type,'ACTUAL'),
    pending_origin_journal_id=coalesce(pending_origin_journal_id,journal_id)
where(journal_number like 'ASI_PEN-%'
   or journal_type='Asientos Pendientes de Facturar')
  and(pending_period_type is null or pending_origin_journal_id is null);
select set_config('app.pending_reclassification_internal','0',true);

create or replace function public.protect_opening_pending_period_metadata()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
begin
  if tg_op='UPDATE'
    and(old.period_type is distinct from new.period_type
      or old.origin_journal_id is distinct from new.origin_journal_id)
    then
    if current_user<>'postgres'
      or coalesce(current_setting('app.pending_reclassification_internal',true),'')<>'1'
      or(to_jsonb(new)-array['period_type','origin_journal_id','updated_at','updated_by'])
        <>(to_jsonb(old)-array['period_type','origin_journal_id','updated_at','updated_by']) then
    raise exception 'El tipo de período del pendiente inicial solo puede cambiar mediante el flujo contable autorizado.';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists protect_opening_pending_period_metadata_trigger
  on public.opening_pending_invoice_items;
create trigger protect_opening_pending_period_metadata_trigger
before update of period_type,origin_journal_id
on public.opening_pending_invoice_items for each row
execute function public.protect_opening_pending_period_metadata();

create or replace function public.sync_opening_pending_origin_journal()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if new.journal_id is not null and(new.journal_id is distinct from old.journal_id or new.status='POSTED')then
    perform set_config('app.pending_reclassification_internal','1',true);
    update public.opening_pending_invoice_items
    set origin_journal_id=new.journal_id,updated_at=now(),updated_by=coalesce(public.app_user_id(),updated_by)
    where run_id=new.id and origin_journal_id is distinct from new.journal_id;
    perform set_config('app.pending_reclassification_internal','0',true);
  end if;
  return new;
end
$$;

drop trigger if exists sync_opening_pending_origin_journal_trigger
  on public.opening_balance_runs;
create trigger sync_opening_pending_origin_journal_trigger
after update of journal_id,status on public.opening_balance_runs
for each row execute function public.sync_opening_pending_origin_journal();

-- Identity values do not exist in a BEFORE INSERT trigger. Complete the
-- self-origin pointer immediately after a regular ASI_PEN is inserted.
create or replace function public.sync_pending_origin_after_insert()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if(new.journal_number like 'ASI_PEN-%'
      or new.journal_type='Asientos Pendientes de Facturar')
    and new.pending_origin_journal_id is null then
    perform set_config('app.pending_reclassification_internal','1',true);
    update public.journal
    set pending_origin_journal_id=new.journal_id
    where journal_id=new.journal_id and pending_origin_journal_id is null;
    perform set_config('app.pending_reclassification_internal','0',true);
  end if;
  return new;
end
$$;

drop trigger if exists sync_pending_origin_after_insert_trigger on public.journal;
create trigger sync_pending_origin_after_insert_trigger
after insert on public.journal for each row
execute function public.sync_pending_origin_after_insert();

create table if not exists public.pending_invoice_reclassification_runs(
  id bigint generated always as identity primary key,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete restrict,
  fiscal_year integer not null check(fiscal_year between 1900 and 9999),
  reclassification_date date not null,
  status text not null default 'PROCESSING' check(status in('PROCESSING','POSTED')),
  item_count integer not null default 0 check(item_count>=0),
  journal_count integer not null default 0 check(journal_count>=0),
  total_local numeric(24,6) not null default 0,
  created_by bigint not null default public.app_user_id() references public.users(user_id),
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  unique(subsidiary_id,fiscal_year),
  check(extract(month from reclassification_date)=1 and extract(day from reclassification_date)=1),
  check(extract(year from reclassification_date)::integer=fiscal_year)
);

create table if not exists public.pending_invoice_reclassification_items(
  id bigint generated always as identity primary key,
  run_id bigint not null references public.pending_invoice_reclassification_runs(id) on delete restrict,
  subsidiary_id bigint not null references public.subsidiaries(subsidiary_id) on delete restrict,
  source_type text not null check(source_type in('JOURNAL','OPENING')),
  source_journal_id bigint references public.journal(journal_id) on delete restrict,
  source_opening_pending_id bigint references public.opening_pending_invoice_items(id) on delete restrict,
  origin_journal_id bigint not null references public.journal(journal_id) on delete restrict,
  reclassification_journal_id bigint not null unique references public.journal(journal_id) on delete restrict,
  source_reference text not null,
  origin_date date not null,
  customer_id bigint references public.customers(customer_id) on delete restrict,
  currency_id bigint not null references public.currencies(currency_id) on delete restrict,
  historical_exchange_rate numeric(24,10) not null check(historical_exchange_rate>0),
  local_amount numeric(24,6) not null check(local_amount>0),
  foreign_amount numeric(24,6) not null check(foreign_amount>0),
  service_month text,
  service_country_id bigint references public.countries(country_id) on delete restrict,
  source_period_type text not null default 'ACTUAL' check(source_period_type='ACTUAL'),
  target_period_type text not null default 'ANTERIOR' check(target_period_type='ANTERIOR'),
  created_at timestamptz not null default now(),
  check((source_journal_id is not null)<>(source_opening_pending_id is not null)),
  unique(run_id,source_type,source_journal_id,source_opening_pending_id)
);

create unique index if not exists pending_reclass_source_journal_unique
  on public.pending_invoice_reclassification_items(source_journal_id)
  where source_journal_id is not null;
create unique index if not exists pending_reclass_source_opening_unique
  on public.pending_invoice_reclassification_items(source_opening_pending_id)
  where source_opening_pending_id is not null;
create index if not exists pending_reclass_run_idx
  on public.pending_invoice_reclassification_items(run_id,id);
create index if not exists pending_reclass_subsidiary_idx
  on public.pending_invoice_reclassification_items(subsidiary_id,origin_date);

-- Serialize the annual run with creation or redating of source records.  Once
-- a year is posted, a new ACTUAL source before that January 1 would otherwise
-- be omitted forever by the one-run-per-year invariant.
create or replace function public.prevent_retroactive_pending_after_annual_run()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  old_pending boolean:=false;
  new_pending boolean:=false;
  lock_subsidiary bigint;
begin
  if tg_op<>'INSERT'then
    old_pending:=old.journal_number like'ASI_PEN-%'
      or old.journal_type='Asientos Pendientes de Facturar';
  end if;
  if tg_op<>'DELETE'then
    new_pending:=new.journal_number like'ASI_PEN-%'
      or new.journal_type='Asientos Pendientes de Facturar';
  end if;
  for lock_subsidiary in
    select distinct value
    from unnest(array[
      case when old_pending then old.subsidiary_id end,
      case when new_pending then new.subsidiary_id end
    ])value
    where value is not null
    order by value
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'pending-invoice-reclassification-subsidiary:'||lock_subsidiary,0
    ));
  end loop;
  if new_pending and coalesce(new.pending_period_type,'ACTUAL')='ACTUAL'then
    if exists(
      select 1 from public.pending_invoice_reclassification_runs run
      where run.subsidiary_id=new.subsidiary_id and run.status='POSTED'
        and new.journal_date<run.reclassification_date
    )then
      raise exception 'No puede crear ni redatar un pendiente antes de una reclasificación anual ya contabilizada.';
    end if;
  end if;
  return case when tg_op='DELETE'then old else new end;
end
$$;

drop trigger if exists prevent_retroactive_pending_after_annual_run_trigger
  on public.journal;
create trigger prevent_retroactive_pending_after_annual_run_trigger
before insert or update or delete
on public.journal for each row
execute function public.prevent_retroactive_pending_after_annual_run();

create or replace function public.prevent_retroactive_opening_pending_after_annual_run()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if coalesce(new.period_type,'ACTUAL')='ACTUAL'
    and coalesce(new.is_active,false)then
    perform pg_advisory_xact_lock(hashtextextended(
      'pending-invoice-reclassification-subsidiary:'||new.subsidiary_id,0
    ));
    if exists(
      select 1 from public.pending_invoice_reclassification_runs run
      where run.subsidiary_id=new.subsidiary_id and run.status='POSTED'
        and new.origin_date<run.reclassification_date
    )then
      raise exception 'No puede cargar un pendiente ACTUAL anterior a una reclasificación anual ya contabilizada.';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists prevent_retroactive_opening_pending_after_annual_run_trigger
  on public.opening_pending_invoice_items;
create trigger prevent_retroactive_opening_pending_after_annual_run_trigger
before insert or update of origin_date,subsidiary_id,period_type,is_active
on public.opening_pending_invoice_items for each row
execute function public.prevent_retroactive_opening_pending_after_annual_run();

-- Once the annual run links a source and its reclassification journal, both
-- accounting snapshots are immutable. The source may subsequently change
-- only its protected operational balance through a controlled reversal.
create or replace function public.guard_pending_reclassification_journal()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
declare target_id bigint:=old.journal_id;
begin
  if exists(
    select 1 from public.pending_invoice_reversal reversal
    where reversal.reversal_journal_id=target_id
  )and not(current_user='postgres'
    and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1')then
    raise exception 'El asiento de reversión de un pendiente es inmutable.';
  end if;
  if exists(
    select 1 from public.pending_invoice_reclassification_items item
    where item.reclassification_journal_id=target_id
      or(item.source_type='OPENING'and item.origin_journal_id=target_id)
  )then
    raise exception 'El asiento de apertura o reclasificación anual vinculado es inmutable.';
  end if;

  if exists(
    select 1 from public.pending_invoice_reclassification_items item
    where item.source_journal_id=target_id
  )then
    if tg_op='UPDATE'and current_user='postgres'
      and coalesce(current_setting('app.pending_reclassification_internal',true),'')='1'
      and(old.pending_period_type is distinct from new.pending_period_type
        or old.pending_origin_journal_id is distinct from new.pending_origin_journal_id)
      and(to_jsonb(new)-array['pending_period_type','pending_origin_journal_id'])
        =(to_jsonb(old)-array['pending_period_type','pending_origin_journal_id']) then
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
      ]) then
      return new;
    end if;
    raise exception 'El asiento fuente ya fue reclasificado y sus datos contables son inmutables.';
  end if;
  return case when tg_op='DELETE'then old else new end;
end
$$;

drop trigger if exists guard_pending_reclassification_journal_trigger on public.journal;
create trigger guard_pending_reclassification_journal_trigger
before update or delete on public.journal for each row
execute function public.guard_pending_reclassification_journal();

create or replace function public.guard_pending_reclassification_journal_line()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
declare old_id bigint:=case when tg_op='INSERT'then null else old.journal_id end;
  new_id bigint:=case when tg_op='DELETE'then null else new.journal_id end;
begin
  if exists(
    select 1 from public.pending_invoice_reversal reversal
    where reversal.reversal_journal_id in(old_id,new_id)
  )and not(current_user='postgres'
    and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1')then
    raise exception 'Las líneas de reversión de un pendiente son inmutables.';
  end if;
  if exists(
    select 1 from public.pending_invoice_reclassification_items item
    where item.reclassification_journal_id in(old_id,new_id)
      or item.source_journal_id in(old_id,new_id)
      or(item.source_type='OPENING'and item.origin_journal_id in(old_id,new_id))
  )then
    raise exception 'Las líneas de un pendiente reclasificado son inmutables.';
  end if;
  return case when tg_op='DELETE'then old else new end;
end
$$;

drop trigger if exists guard_pending_reclassification_journal_line_trigger
  on public.journal_line;
create trigger guard_pending_reclassification_journal_line_trigger
before insert or update or delete on public.journal_line for each row
execute function public.guard_pending_reclassification_journal_line();

-- Seal the 113003 cut-off itself, regardless of which document type produced
-- the GL impact.  This closes the race where a general journal could post a
-- backdated manual movement while the annual auxiliary was being reconciled.
create or replace function public.guard_pending_control_gl_cutoff()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

drop trigger if exists guard_pending_control_gl_cutoff_trigger
  on public.gl_impact;
create trigger guard_pending_control_gl_cutoff_trigger
before insert or update or delete on public.gl_impact for each row
execute function public.guard_pending_control_gl_cutoff();

create or replace function public.guard_pending_reclassification_gl_impact()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
declare old_id bigint:=case when tg_op='INSERT'then null else old.transaction_id end;
  new_id bigint:=case when tg_op='DELETE'then null else new.transaction_id end;
begin
  if exists(
    select 1 from public.journal journal_row
    join public.pending_invoice_reversal reversal
      on reversal.reversal_journal_id=journal_row.journal_id
    where journal_row.transaction_id in(old_id,new_id)
  )and not(current_user='postgres'
    and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1')then
    raise exception 'El impacto de una reversión de pendiente es inmutable.';
  end if;
  if exists(
    select 1
    from public.journal journal_row
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
$$;

drop trigger if exists guard_pending_reclassification_gl_impact_trigger
  on public.gl_impact;
create trigger guard_pending_reclassification_gl_impact_trigger
before insert or update or delete on public.gl_impact for each row
execute function public.guard_pending_reclassification_gl_impact();

create or replace function public.guard_pending_reclassification_transaction()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
declare
  target_id bigint:=old.transaction_id;
  sid bigint;
begin
  select journal_row.subsidiary_id into sid
  from public.journal journal_row
  where journal_row.transaction_id=target_id
    and(
      journal_row.journal_number like'ASI_PEN-%'
      or journal_row.journal_type='Asientos Pendientes de Facturar'
      or exists(
        select 1
        from public.opening_balance_runs opening_run
        join public.opening_pending_invoice_items opening_item
          on opening_item.run_id=opening_run.id
        where opening_run.journal_id=journal_row.journal_id
      )
    )
  order by journal_row.journal_id limit 1;
  if sid is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'pending-invoice-reclassification-subsidiary:'||sid,0
    ));
  end if;
  if exists(
    select 1 from public.journal journal_row
    join public.pending_invoice_reversal reversal
      on reversal.reversal_journal_id=journal_row.journal_id
    where journal_row.transaction_id=target_id
  )and not(current_user='postgres'
    and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1')then
    raise exception 'La transacción de reversión de un pendiente es inmutable.';
  end if;
  if exists(
    select 1
    from public.journal journal_row
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
$$;

drop trigger if exists guard_pending_reclassification_transaction_trigger
  on public."transaction";
create trigger guard_pending_reclassification_transaction_trigger
before update or delete on public."transaction" for each row
execute function public.guard_pending_reclassification_transaction();

revoke all on function public.guard_pending_reclassification_transaction()
  from public,anon,authenticated;

create or replace function public.guard_pending_invoice_reversal_row()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
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
$$;

drop trigger if exists guard_pending_invoice_reversal_row_trigger
  on public.pending_invoice_reversal;
create trigger guard_pending_invoice_reversal_row_trigger
before insert or update or delete on public.pending_invoice_reversal for each row
execute function public.guard_pending_invoice_reversal_row();

-- Reversals and GL impacts are accounting facts written by audited RPCs and
-- posting triggers.  Direct table DML would bypass subsidiary, permission and
-- source-balance validation, so keep those writes private.
revoke insert,update,delete on public.pending_invoice_reversal
  from anon,authenticated;
revoke insert,update,delete on public.gl_impact
  from anon,authenticated;
revoke all on function public.sync_journal_gl_impacts(bigint)
  from public,anon,authenticated;

alter table public.pending_invoice_reversal enable row level security;
drop policy if exists pending_invoice_reversal_authorized_select
  on public.pending_invoice_reversal;
create policy pending_invoice_reversal_authorized_select
on public.pending_invoice_reversal for select to authenticated
using(
  exists(
    select 1 from public.journal source
    join public.user_subsidiaries access
      on access.subsidiary_id=source.subsidiary_id
    where source.journal_id=pending_invoice_reversal.source_journal_id
      and access.user_id=public.app_user_id()
  )
  or exists(
    select 1 from public.opening_pending_invoice_items source
    join public.user_subsidiaries access
      on access.subsidiary_id=source.subsidiary_id
    where source.id=pending_invoice_reversal.source_opening_pending_id
      and access.user_id=public.app_user_id()
  )
);
grant select on public.pending_invoice_reversal to authenticated;

-- Normalize legacy regular ASI_PEN snapshots.  Journal lines are stored in
-- transaction currency; the primary-book GL is the source of truth for local
-- amounts and its FX columns preserve the historical original amount.
select set_config('app.pending_reversal_write','1',true);
with control as(
  select max(account_id)account_id
  from public.chart_accounts where account_number='113003'
),source_snapshot as(
  select journal_row.journal_id,
    coalesce(sum(impact.debit_amount),0)::numeric(24,6)initial_local,
    coalesce(sum(impact.debit_fx),0)::numeric(24,6)initial_foreign
  from public.journal journal_row
  join public.accounting_books book
    on book.subsidiary_id=journal_row.subsidiary_id
    and book.is_primary and book.is_active
  left join public.gl_impact impact
    on impact.transaction_id=journal_row.transaction_id
    and impact.accounting_book_id=book.accounting_book_id
    and impact.account_id=(select account_id from control)
  where journal_row.journal_number like'ASI_PEN-%'
    or journal_row.journal_type='Asientos Pendientes de Facturar'
  group by journal_row.journal_id
),reversed_snapshot as(
  select source.journal_id,
    coalesce(sum(impact.credit_amount),0)::numeric(24,6)reversed_local,
    coalesce(sum(impact.credit_fx),0)::numeric(24,6)reversed_foreign
  from source_snapshot source
  join public.journal source_journal on source_journal.journal_id=source.journal_id
  join public.accounting_books book
    on book.subsidiary_id=source_journal.subsidiary_id
    and book.is_primary and book.is_active
  left join public.pending_invoice_reversal reversal
    on reversal.source_journal_id=source.journal_id
  left join public.journal reversal_journal
    on reversal_journal.journal_id=reversal.reversal_journal_id
  left join public.gl_impact impact
    on impact.transaction_id=reversal_journal.transaction_id
    and impact.accounting_book_id=book.accounting_book_id
    and impact.account_id=(select account_id from control)
  group by source.journal_id
),desired as(
  select source.journal_id,source.initial_local,source.initial_foreign,
    reversed.reversed_local,reversed.reversed_foreign,
    greatest(source.initial_local-reversed.reversed_local,0)::numeric(24,6)balance_local,
    greatest(source.initial_foreign-reversed.reversed_foreign,0)::numeric(24,6)balance_foreign
  from source_snapshot source join reversed_snapshot reversed using(journal_id)
)
update public.journal journal_row
set pending_initial_local=desired.initial_local,
  pending_initial_foreign=desired.initial_foreign,
  pending_reversed_local=desired.reversed_local,
  pending_reversed_foreign=desired.reversed_foreign,
  pending_balance_local=desired.balance_local,
  pending_balance_foreign=desired.balance_foreign,
  reversal_status=case
    when journal_row.status='ANULADO'then'ANULADO'
    when desired.balance_local<=.000001 and desired.balance_foreign<=.000001
      then'REVERSADO_TOTAL'
    when desired.reversed_local>.000001 or desired.reversed_foreign>.000001
      then'REVERSADO_PARCIAL'
    else'PENDIENTE'end
from desired
where journal_row.journal_id=desired.journal_id
  and not exists(
    select 1 from public.pending_invoice_reclassification_items item
    where item.source_journal_id=journal_row.journal_id
  )
  and not exists(
    select 1 from public.pending_invoice_reclassification_runs annual_run
    where annual_run.subsidiary_id=journal_row.subsidiary_id
      and annual_run.status='POSTED'
      and journal_row.journal_date<annual_run.reclassification_date
  )
  and row(
    journal_row.pending_initial_local,journal_row.pending_initial_foreign,
    journal_row.pending_reversed_local,journal_row.pending_reversed_foreign,
    journal_row.pending_balance_local,journal_row.pending_balance_foreign,
    journal_row.reversal_status
  )is distinct from row(
    desired.initial_local,desired.initial_foreign,
    desired.reversed_local,desired.reversed_foreign,
    desired.balance_local,desired.balance_foreign,
    case
      when journal_row.status='ANULADO'then'ANULADO'
      when desired.balance_local<=.000001 and desired.balance_foreign<=.000001
        then'REVERSADO_TOTAL'
      when desired.reversed_local>.000001 or desired.reversed_foreign>.000001
        then'REVERSADO_PARCIAL'
      else'PENDIENTE'end
  );
select set_config('app.pending_reversal_write','0',true);

revoke all on function public.guard_pending_reclassification_journal(),
  public.guard_pending_reclassification_journal_line(),
  public.guard_pending_control_gl_cutoff(),
  public.guard_pending_reclassification_gl_impact(),
  public.guard_pending_reclassification_transaction(),
  public.guard_pending_invoice_reversal_row(),
  public.protect_pending_reversal_metadata(),
  public.prevent_retroactive_pending_after_annual_run(),
  public.prevent_retroactive_opening_pending_after_annual_run()
from public,anon,authenticated;

alter table public.pending_invoice_reclassification_runs enable row level security;
alter table public.pending_invoice_reclassification_items enable row level security;

drop policy if exists pending_reclass_runs_select
  on public.pending_invoice_reclassification_runs;
create policy pending_reclass_runs_select
on public.pending_invoice_reclassification_runs for select to authenticated
using(exists(
  select 1 from public.user_subsidiaries access
  where access.user_id=public.app_user_id()
    and access.subsidiary_id=pending_invoice_reclassification_runs.subsidiary_id
));

drop policy if exists pending_reclass_items_select
  on public.pending_invoice_reclassification_items;
create policy pending_reclass_items_select
on public.pending_invoice_reclassification_items for select to authenticated
using(exists(
  select 1 from public.user_subsidiaries access
  where access.user_id=public.app_user_id()
    and access.subsidiary_id=pending_invoice_reclassification_items.subsidiary_id
));

revoke all on table public.pending_invoice_reclassification_runs,
  public.pending_invoice_reclassification_items from public,anon,authenticated;

-- The legacy stage function already performs the complete entity, dimension,
-- attachment and FX validation.  Normalize prior-period lines only while it
-- runs, then restore their actual accounting pair in the operational snapshot.
do $$
begin
  if to_regprocedure('public.opening_pending_invoice_stage_before_period_type(bigint,jsonb)') is null then
    alter function public.opening_pending_invoice_stage(bigint,jsonb)
      rename to opening_pending_invoice_stage_before_period_type;
  end if;
end
$$;

revoke all on function public.opening_pending_invoice_stage_before_period_type(bigint,jsonb)
  from public,anon,authenticated;

create or replace function public.opening_pending_invoice_stage(
  p_run_id bigint,
  p_items jsonb
)returns integer
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.opening_pending_invoice_stage(bigint,jsonb)
  from public,anon,authenticated;

-- Reconcile the opening lot against the classification it had when posted.
-- A later annual move changes the item's current class to ANTERIOR, but does
-- not rewrite the historical opening journal; source_period_type preserves
-- that audit basis so a valid opening never appears artificially unbalanced.
create or replace function public.opening_pending_invoice_reconciliation(p_run_id bigint)
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
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
$$;

do $$
begin
  if to_regprocedure('public.opening_balance_options_before_pending_period_type()') is null then
    alter function public.opening_balance_options()
      rename to opening_balance_options_before_pending_period_type;
  end if;
end
$$;
revoke all on function public.opening_balance_options_before_pending_period_type()
  from public,anon,authenticated;

create or replace function public.opening_balance_options()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.opening_balance_options()from public,anon;
grant execute on function public.opening_balance_options()to authenticated;

do $$
begin
  if to_regprocedure('public.opening_balance_preview_before_pending_period_type(bigint)') is null then
    alter function public.opening_balance_preview(bigint)
      rename to opening_balance_preview_before_pending_period_type;
  end if;
end
$$;
revoke all on function public.opening_balance_preview_before_pending_period_type(bigint)
  from public,anon,authenticated;

create or replace function public.opening_balance_preview(p_run_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.opening_balance_preview(bigint)from public,anon;
grant execute on function public.opening_balance_preview(bigint)to authenticated;

create or replace function public.pending_invoice_reclassification_preview(
  p_reclassification_date date
)returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_reclassification_preview(date)
  from public,anon;
grant execute on function public.pending_invoice_reclassification_preview(date)
  to authenticated;

create or replace function public.pending_invoice_reclassification_execution_result(
  p_run_id bigint
)returns jsonb
language sql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_reclassification_execution_result(bigint)
  from public,anon,authenticated;

create or replace function public.pending_invoice_reclassification_execute(
  p_reclassification_date date
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_reclassification_execute(date)
  from public,anon;
grant execute on function public.pending_invoice_reclassification_execute(date)
  to authenticated;

-- A posted opening lot cannot be reversed after one of its pending items has
-- been carried into 113004.  Reversing the original opening journal in that
-- state would orphan the immutable annual reclassification.
do $$
begin
  if to_regprocedure('public.opening_balance_reverse_before_pending_reclassification(bigint)')is null then
    alter function public.opening_balance_reverse(bigint)
      rename to opening_balance_reverse_before_pending_reclassification;
  end if;
end
$$;

revoke all on function public.opening_balance_reverse_before_pending_reclassification(bigint)
  from public,anon,authenticated;

create or replace function public.opening_balance_reverse(p_run_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.opening_balance_reverse(bigint)from public,anon;
grant execute on function public.opening_balance_reverse(bigint)to authenticated;

-- Direct opening reversals retain the exact auxiliary local/original amounts.
-- The legacy implementation creates Dr 413001 / Cr 113003; for an ANTERIOR
-- source this wrapper maps the result to Dr 413002 / Cr 113004 and rebuilds
-- the primary-book impacts without applying the historical rate twice.
do $$
begin
  if to_regprocedure('public.reverse_opening_pending_invoice_before_period_type(bigint,jsonb)')is null then
    alter function public.reverse_opening_pending_invoice(bigint,jsonb)
      rename to reverse_opening_pending_invoice_before_period_type;
  end if;
end
$$;

revoke all on function public.reverse_opening_pending_invoice_before_period_type(bigint,jsonb)
  from public,anon,authenticated;

create or replace function public.reverse_opening_pending_invoice(
  p_item_id bigint,
  p_payload jsonb
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.reverse_opening_pending_invoice(bigint,jsonb)
  from public,anon;
grant execute on function public.reverse_opening_pending_invoice(bigint,jsonb)
  to authenticated;

do $$
begin
  if to_regprocedure('public.reverse_pending_invoice_journal_before_period_type(bigint,jsonb)')is null then
    alter function public.reverse_pending_invoice_journal(bigint,jsonb)
      rename to reverse_pending_invoice_journal_before_period_type;
  end if;
end
$$;

revoke all on function public.reverse_pending_invoice_journal_before_period_type(bigint,jsonb)
  from public,anon,authenticated;

create or replace function public.reverse_pending_invoice_journal(
  p_journal_id bigint,
  p_payload jsonb
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.reverse_pending_invoice_journal(bigint,jsonb)
  from public,anon;
grant execute on function public.reverse_pending_invoice_journal(bigint,jsonb)
  to authenticated;

do $$
begin
  if to_regprocedure('public.pending_invoice_reversal_options_before_period_type(bigint,date)')is null then
    alter function public.pending_invoice_reversal_options(bigint,date)
      rename to pending_invoice_reversal_options_before_period_type;
  end if;
end
$$;

revoke all on function public.pending_invoice_reversal_options_before_period_type(bigint,date)
  from public,anon,authenticated;

create or replace function public.pending_invoice_reversal_options(
  p_journal_id bigint,
  p_reversal_date date
)returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_reversal_options(bigint,date)
  from public,anon;
grant execute on function public.pending_invoice_reversal_options(bigint,date)
  to authenticated;

do $$
begin
  if to_regprocedure('public.pending_invoice_control_options_before_annual_reclassification()')is null then
    alter function public.pending_invoice_control_options()
      rename to pending_invoice_control_options_before_annual_reclassification;
  end if;
end
$$;

revoke all on function public.pending_invoice_control_options_before_annual_reclassification()
  from public,anon,authenticated;

create or replace function public.pending_invoice_control_options()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_control_options()from public,anon;
grant execute on function public.pending_invoice_control_options()to authenticated;

create or replace function public.run_pending_invoice_control_report_before_consolidation(
  p_filters jsonb default'{}'
)returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

do $$
begin
  if to_regprocedure('public.run_pending_invoice_control_report_before_period_summary(jsonb)')is null then
    alter function public.run_pending_invoice_control_report(jsonb)
      rename to run_pending_invoice_control_report_before_period_summary;
  end if;
end
$$;

revoke all on function public.run_pending_invoice_control_report_before_period_summary(jsonb)
  from public,anon,authenticated;

create or replace function public.run_pending_invoice_control_report(
  p_filters jsonb default'{}'
)returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.run_pending_invoice_control_report(jsonb)
  from public,anon;
grant execute on function public.run_pending_invoice_control_report(jsonb)
  to authenticated;

notify pgrst,'reload schema';
