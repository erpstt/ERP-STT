-- CxC/CxP are supporting subledgers of the opening trial balance.  They must
-- replace (not add to) the matching control-account lines when the opening is
-- posted.  The original GL rows are retained here as an immutable audit
-- snapshot and are reconciled by account and original currency.

create table if not exists public.opening_ar_ap_gl_control_lines(
  id bigint generated always as identity primary key,
  run_id bigint not null references public.opening_balance_runs(id) on delete cascade,
  original_line_id bigint not null,
  source_type text not null check(source_type in('AR','AP')),
  row_number integer not null,
  account_id bigint not null references public.chart_accounts(account_id),
  currency_id bigint not null references public.currencies(currency_id),
  historical_rate numeric(24,10) not null check(historical_rate>0),
  foreign_amount numeric(24,6) not null check(foreign_amount>0),
  local_debit numeric(24,6) not null default 0,
  local_credit numeric(24,6) not null default 0,
  department_id bigint references public.departments(department_id),
  cost_center_id bigint references public.cost_centers(cost_center_id),
  class_id bigint references public.classes(class_id),
  financial_creditor_id bigint references public.financial_creditors(financial_creditor_id),
  related_company_id bigint references public.related_companies(related_company_id),
  location_id bigint references public.locations(location_id),
  opening_rate_source text,
  note text,
  raw_data jsonb not null default'{}'::jsonb,
  archived_at timestamptz not null default now(),
  unique(run_id,original_line_id),
  check((local_debit>0)<>(local_credit>0))
);

alter table public.opening_ar_ap_gl_control_lines
  add column if not exists opening_rate_source text;

create index if not exists opening_ar_ap_gl_control_reconciliation_idx
  on public.opening_ar_ap_gl_control_lines(run_id,source_type,account_id,currency_id);

alter table public.opening_ar_ap_gl_control_lines enable row level security;
drop policy if exists opening_ar_ap_gl_control_read on public.opening_ar_ap_gl_control_lines;
create policy opening_ar_ap_gl_control_read
  on public.opening_ar_ap_gl_control_lines for select to authenticated
  using(exists(
    select 1 from public.opening_balance_runs opening_run
    where opening_run.id=run_id
      and opening_run.subsidiary_id=public.active_subsidiary_id()
  ));
revoke all on table public.opening_ar_ap_gl_control_lines from public,anon,authenticated;
grant select on table public.opening_ar_ap_gl_control_lines to authenticated;

comment on table public.opening_ar_ap_gl_control_lines is
 'Snapshot de las líneas de control del Mayor sustituidas por el detalle CxC/CxP durante la apertura.';

alter table public.opening_balance_lines
  add column if not exists opening_rate_source text;
alter table public.opening_balance_lines
  drop constraint if exists opening_balance_lines_rate_source_check;
alter table public.opening_balance_lines
  add constraint opening_balance_lines_rate_source_check check(
    opening_rate_source is null or opening_rate_source in(
      'LOCAL_CURRENCY','EXPLICIT_LOCAL_AND_RATE','EXPLICIT_LOCAL',
      'EXPLICIT_RATE','GL_RESIDUAL'
    )
  );
comment on column public.opening_balance_lines.opening_rate_source is
 'Origen auditable de la tasa histórica aplicada al documento inicial CxC/CxP.';

-- Re-evaluate the control account against the current entity classification.
-- The post wrapper invokes this guard after locking the opening run and before
-- removing any aggregate GL line. Entity rows are share-locked so their
-- intercompany flag cannot change until the posting transaction finishes.
create or replace function public.opening_ar_ap_assert_account_routing(p_run_id bigint)
returns void
language plpgsql
volatile
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.opening_ar_ap_assert_account_routing(bigint)
  from public,anon,authenticated;

-- Apply an exact historical local value to every CxC/CxP document.  Explicit
-- values win.  Missing values are allocated with the residual blended rate of
-- the matching GL account/currency, so legacy templates remain usable while
-- new templates can preserve a per-document historical rate.
create or replace function public.opening_ar_ap_apply_historical_values(p_run_id bigint)
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.opening_ar_ap_apply_historical_values(bigint)
  from public,anon,authenticated;

create or replace function public.opening_ar_ap_reconciliation(p_run_id bigint)
returns jsonb
language sql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.opening_ar_ap_reconciliation(bigint)
  from public,anon,authenticated;

create or replace function public.opening_ar_ap_assert_reconciled(p_run_id bigint)
returns void
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.opening_ar_ap_assert_reconciled(bigint)
  from public,anon,authenticated;

create or replace function public.opening_balance_effective_summary(p_run_id bigint)
returns jsonb
language sql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.opening_balance_effective_summary(bigint)
  from public,anon,authenticated;

-- Preserve all existing dimension and entity validation; only enrich the
-- staged auxiliary amounts after the canonical staging routine succeeds.
do $$begin
 if to_regprocedure('public.opening_balance_stage_before_ar_ap_reconciliation(jsonb)')is null then
  alter function public.opening_balance_stage(jsonb)rename to opening_balance_stage_before_ar_ap_reconciliation;
 end if;
end$$;
revoke all on function public.opening_balance_stage_before_ar_ap_reconciliation(jsonb)
  from public,anon,authenticated;

create or replace function public.opening_balance_stage(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare result jsonb;run_key bigint;summary jsonb;
begin
 result:=public.opening_balance_stage_before_ar_ap_reconciliation(p);
 run_key:=(result->>'runId')::bigint;
 perform public.opening_ar_ap_apply_historical_values(run_key);
 summary:=public.opening_balance_effective_summary(run_key);
 return result||jsonb_build_object('rows',summary->'count','debit',summary->'debit',
  'credit',summary->'credit','difference',summary->'difference');
end
$$;
revoke all on function public.opening_balance_stage(jsonb)from public,anon,authenticated;

-- Add a professional reconciliation and report the effective posting totals.
do $$begin
 if to_regprocedure('public.opening_balance_preview_before_ar_ap_reconciliation(bigint)')is null then
  alter function public.opening_balance_preview(bigint)rename to opening_balance_preview_before_ar_ap_reconciliation;
 end if;
end$$;
revoke all on function public.opening_balance_preview_before_ar_ap_reconciliation(bigint)
  from public,anon,authenticated;

create or replace function public.opening_balance_preview(p_run_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;
revoke all on function public.opening_balance_preview(bigint)from public,anon;
grant execute on function public.opening_balance_preview(bigint)to authenticated;

do $$begin
 if to_regprocedure('public.opening_balance_validate_before_ar_ap_reconciliation(jsonb)')is null then
  alter function public.opening_balance_validate(jsonb)rename to opening_balance_validate_before_ar_ap_reconciliation;
 end if;
end$$;
revoke all on function public.opening_balance_validate_before_ar_ap_reconciliation(jsonb)
  from public,anon,authenticated;

create or replace function public.opening_balance_validate(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare result jsonb;run_key bigint;
begin
 result:=public.opening_balance_validate_before_ar_ap_reconciliation(p);
 run_key:=nullif(result->'run'->>'id','')::bigint;
 if run_key is null then raise exception 'No fue posible identificar el lote de apertura validado.';end if;
 return public.opening_balance_preview(run_key);
end
$$;
revoke all on function public.opening_balance_validate(jsonb)from public,anon;
grant execute on function public.opening_balance_validate(jsonb)to authenticated;

create or replace function public.opening_ar_ap_archive_control_lines(p_run_id bigint)
returns integer
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;
revoke all on function public.opening_ar_ap_archive_control_lines(bigint)
  from public,anon,authenticated;

-- The existing posting stack continues to create the document and its exact
-- document-level journal line.  Removing only the reconciled GL summary first
-- prevents duplication while preserving all current asset/pending/bank hooks.
do $$begin
 if to_regprocedure('public.opening_balance_post_before_ar_ap_reconciliation(bigint)')is null then
  alter function public.opening_balance_post(bigint)rename to opening_balance_post_before_ar_ap_reconciliation;
 end if;
end$$;
revoke all on function public.opening_balance_post_before_ar_ap_reconciliation(bigint)
  from public,anon,authenticated;

create or replace function public.opening_balance_post(p_run_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;
revoke all on function public.opening_balance_post(bigint)from public,anon;
grant execute on function public.opening_balance_post(bigint)to authenticated;

-- Guard the exact document-to-line trace before the established reversal
-- stack checks applications and reverses the already de-duplicated journal.
do $$begin
 if to_regprocedure('public.opening_balance_reverse_before_ar_ap_reconciliation(bigint)')is null then
  alter function public.opening_balance_reverse(bigint)rename to opening_balance_reverse_before_ar_ap_reconciliation;
 end if;
end$$;
revoke all on function public.opening_balance_reverse_before_ar_ap_reconciliation(bigint)
  from public,anon,authenticated;

create or replace function public.opening_balance_reverse(p_run_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;
revoke all on function public.opening_balance_reverse(bigint)from public,anon;
grant execute on function public.opening_balance_reverse(bigint)to authenticated;

notify pgrst,'reload schema';
