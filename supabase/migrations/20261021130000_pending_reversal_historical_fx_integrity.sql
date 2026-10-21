-- Preserve the frozen currency snapshot on every reversal of an unbilled
-- revenue item.  The source journal/opening item is the only authority for
-- currency and rate; the request payload can only supply a local amount.

create or replace function public.pending_invoice_reversal_source_fx(
  p_source_journal_id bigint,
  p_source_opening_pending_id bigint
)returns table(
  source_subsidiary_id bigint,
  source_currency_id bigint,
  source_historical_rate numeric,
  source_initial_local numeric,
  source_initial_foreign numeric,
  source_balance_local numeric,
  source_balance_foreign numeric,
  source_period_type text
)
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_reversal_source_fx(bigint,bigint)
  from public,anon,authenticated;

create or replace function public.pending_invoice_normalize_reversal_fx(
  p_reversal_journal_id bigint,
  p_historical_rate numeric,
  p_currency_id bigint,
  p_period_type text
)returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_normalize_reversal_fx(bigint,numeric,bigint,text)
  from public,anon,authenticated;

-- Billing reversals are entered in local currency, while a sales invoice
-- subtotal is stored in the invoice currency.  Keep the comparison in the
-- invoice currency using only the frozen source and invoice snapshots.  In
-- particular, when both documents share a currency, compare original amounts
-- directly even when their historical rates differ.
create or replace function public.pending_invoice_billing_limit_snapshot(
  p_source_journal_id bigint,
  p_source_opening_pending_id bigint,
  p_invoice_id bigint,
  p_exclude_reversal_id bigint default null
)returns table(
  source_currency_id bigint,
  source_historical_rate numeric,
  source_initial_local numeric,
  source_initial_foreign numeric,
  source_balance_local numeric,
  source_balance_foreign numeric,
  source_customer_id bigint,
  source_subsidiary_id bigint,
  invoice_currency_id bigint,
  invoice_historical_rate numeric,
  invoice_customer_id bigint,
  invoice_subsidiary_id bigint,
  invoice_date date,
  subtotal_invoice numeric,
  applied_invoice numeric,
  available_invoice numeric,
  local_per_invoice_unit numeric
)
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_billing_limit_snapshot(bigint,bigint,bigint,bigint)
  from public,anon,authenticated;

create or replace function public.pending_invoice_validate_billing_limit(
  p_source_journal_id bigint,
  p_source_opening_pending_id bigint,
  p_invoice_id bigint,
  p_reversal_date date,
  p_reversed_local numeric,
  p_reversed_foreign numeric default null,
  p_exclude_reversal_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_validate_billing_limit(bigint,bigint,bigint,date,numeric,numeric,bigint)
  from public,anon,authenticated;

create or replace function public.validate_pending_reversal_invoice()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.validate_pending_reversal_invoice()
  from public,anon,authenticated;

-- Replace the legacy subtotal wrapper itself so every internal regular route
-- compares the invoice and reversal in one historical currency unit.
create or replace function public.reverse_pending_invoice_journal_before_period_type(
  p_journal_id bigint,
  p_payload jsonb
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.reverse_pending_invoice_journal_before_period_type(bigint,jsonb)
  from public,anon,authenticated;

-- Historical presentation metadata may need normalization even when the
-- original fiscal period is closed.  The bypass is deliberately limited to
-- an already registered pending reversal and to the exact FX/header fields.
create or replace function public.guard_transaction_accounting_period()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
declare period public.fiscal_periods%rowtype;
  row_value public."transaction"%rowtype;
begin
  if tg_op='UPDATE'and to_jsonb(new)=to_jsonb(old)then return new;end if;
  if tg_op='UPDATE'and current_user='postgres'
    and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1'
    and exists(
      select 1 from public.journal reversal_journal
      join public.pending_invoice_reversal reversal
        on reversal.reversal_journal_id=reversal_journal.journal_id
      where reversal_journal.transaction_id=old.transaction_id
    )
    and(old.currency_id is distinct from new.currency_id
      or old.exchange_rate is distinct from new.exchange_rate
      or old.total_amount is distinct from new.total_amount)
    and(to_jsonb(new)-array['currency_id','exchange_rate','total_amount'])
      =(to_jsonb(old)-array['currency_id','exchange_rate','total_amount'])then
    return new;
  end if;
  row_value:=case when tg_op='DELETE'then old else new end;
  select * into period from public.fiscal_periods
  where fiscal_period_id=row_value.fiscal_period_id;
  if period.fiscal_period_id is null then
    raise exception 'El período contable no existe.';
  end if;
  if period.is_inactive or period.is_closed then
    raise exception 'El período contable % está cerrado o inactivo.',period.period_name;
  end if;
  if row_value.supplier_id is not null and period.ap_closed then
    raise exception 'Compras (AP) está cerrado para el período %.',period.period_name;
  end if;
  if row_value.customer_id is not null and period.ar_closed then
    raise exception 'Ventas/Cuentas por cobrar (AR) está cerrado para el período %.',period.period_name;
  end if;
  if row_value.customer_id is null and row_value.supplier_id is null
    and period.gl_closed then
    raise exception 'Libro Mayor (GL) está cerrado para el período %.',period.period_name;
  end if;
  return case when tg_op='DELETE'then old else new end;
end
$$;

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
  if tg_op='UPDATE'and to_jsonb(new)=to_jsonb(old)then return new;end if;
  if tg_op='UPDATE'and current_user='postgres'
    and coalesce(current_setting('app.pending_reversal_finalize',true),'')='1'
    and exists(
      select 1 from public.pending_invoice_reversal reversal
      where reversal.reversal_journal_id=old.journal_id
    )
    and(old.currency_id is distinct from new.currency_id
      or old.exchange_rate is distinct from new.exchange_rate
      or old.total_debit is distinct from new.total_debit
      or old.total_credit is distinct from new.total_credit)
    and(to_jsonb(new)-array[
      'currency_id','exchange_rate','total_debit','total_credit'
    ])=(to_jsonb(old)-array[
      'currency_id','exchange_rate','total_debit','total_credit'
    ])then
    return new;
  end if;
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
    ])then
    return new;
  end if;
  period_id:=case when tg_op='DELETE'then old.fiscal_period_id
    else new.fiscal_period_id end;
  select(is_closed or gl_closed),is_inactive,period_name
  into closed,inactive,name from public.fiscal_periods
  where fiscal_period_id=period_id;
  if closed or inactive then
    raise exception 'Libro Mayor (GL) está cerrado para el período %.',name;
  end if;
  return case when tg_op='DELETE'then old else new end;
end
$$;

-- A pending source becomes an immutable accounting snapshot as soon as its
-- first reversal exists.  Only serialized operational balances may move.
create or replace function public.guard_pending_reclassification_journal()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
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
$$;

create or replace function public.guard_pending_reclassification_journal_line()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
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
$$;

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
$$;

create or replace function public.guard_pending_reclassification_transaction()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.guard_transaction_accounting_period(),
  public.guard_journal_accounting_period(),
  public.guard_pending_reclassification_journal(),
  public.guard_pending_reclassification_journal_line(),
  public.guard_pending_reclassification_gl_impact(),
  public.guard_pending_reclassification_transaction()
from public,anon,authenticated;

-- Regular reversals created before the local/FX snapshot migration stored the
-- request amount in reversed_local even though that request was still in the
-- original currency.  Repair only rows whose immutable journal lines and
-- primary-book impacts prove both economic legs unambiguously.
do $$
declare
  legacy record;
  current_control bigint;
  prior_control bigint;
  current_counterpart bigint;
  bridge_account bigint;
  book_key bigint;
  book_count integer;
  line_values record;
  impact_values record;
  line_period_type text;
  impact_period_type text;
  expected_period_type text;
  reclassification_date date;
  per_tolerance numeric(24,10);
begin
  select max(account_id)filter(where account_number='113003'),
    max(account_id)filter(where account_number='113004'),
    max(account_id)filter(where account_number='413001'),
    max(account_id)filter(where account_number='413002')
  into current_control,prior_control,current_counterpart,bridge_account
  from public.chart_accounts
  where account_number in('113003','113004','413001','413002');

  for legacy in
    select reversal.*,source.subsidiary_id,source.currency_id source_currency_id,
      source.exchange_rate source_rate,source_transaction.currency_id source_transaction_currency,
      source_transaction.exchange_rate source_transaction_rate,
      reversal_journal.transaction_id reversal_transaction_id,
      reversal_journal.currency_id reversal_journal_currency,
      reversal_journal.exchange_rate reversal_journal_rate,
      reversal_journal.total_debit,reversal_journal.total_credit,
      reversal_transaction.currency_id reversal_transaction_currency,
      reversal_transaction.exchange_rate reversal_transaction_rate,
      reversal_transaction.total_amount reversal_transaction_total,
      coalesce(source.pending_period_type,'ACTUAL')source_period_type
    from public.pending_invoice_reversal reversal
    join public.journal source on source.journal_id=reversal.source_journal_id
    join public."transaction" source_transaction
      on source_transaction.transaction_id=source.transaction_id
    join public.journal reversal_journal
      on reversal_journal.journal_id=reversal.reversal_journal_id
    join public."transaction" reversal_transaction
      on reversal_transaction.transaction_id=reversal_journal.transaction_id
    where reversal.source_opening_pending_id is null
      and abs(reversal.reversed_local-reversal.reversed_foreign)<=.000001
    order by reversal.reversal_id
  loop
    if legacy.source_rate is null or legacy.source_rate<=0
      or legacy.source_transaction_rate is null
      or abs(legacy.source_transaction_rate-legacy.source_rate)>.0000000001
      or legacy.source_transaction_currency is distinct from legacy.source_currency_id
      or legacy.reversal_journal_rate is null
      or legacy.reversal_transaction_rate is null
      or abs(legacy.reversal_journal_rate-legacy.source_rate)>.0000000001
      or abs(legacy.reversal_transaction_rate-legacy.source_rate)>.0000000001
      or legacy.reversal_journal_currency is distinct from legacy.source_currency_id
      or legacy.reversal_transaction_currency is distinct from legacy.source_currency_id
      or abs(legacy.total_debit-legacy.reversed_foreign)>.000001
      or abs(legacy.total_credit-legacy.reversed_foreign)>.000001
      or abs(legacy.reversal_transaction_total-legacy.reversed_foreign)>.000001 then
      continue;
    end if;

    select count(*)::integer,max(accounting_book_id)
    into book_count,book_key
    from public.accounting_books
    where subsidiary_id=legacy.subsidiary_id and is_primary and is_active;
    if book_count<>1 then continue;end if;

    select count(*)::integer line_count,
      coalesce(sum(line.debit),0)debit,coalesce(sum(line.credit),0)credit,
      coalesce(sum(line.debit_fx),0)debit_fx,
      coalesce(sum(line.credit_fx),0)credit_fx,
      coalesce(bool_or(line.historical_exchange_rate is not null
        and abs(line.historical_exchange_rate-legacy.source_rate)>.0000000001),false)wrong_rate,
      coalesce(bool_or(line.original_currency_id is not null
        and line.original_currency_id<>legacy.source_currency_id),false)wrong_currency,
      count(*)filter(where line.account_id=current_counterpart
        and line.debit=legacy.reversed_foreign and line.credit=0
        and line.debit_fx=legacy.reversed_foreign and line.credit_fx=0)::integer current_debit,
      count(*)filter(where line.account_id=current_control
        and line.debit=0 and line.credit=legacy.reversed_foreign
        and line.debit_fx=0 and line.credit_fx=legacy.reversed_foreign)::integer current_credit,
      count(*)filter(where line.account_id=bridge_account
        and line.debit=legacy.reversed_foreign and line.credit=0
        and line.debit_fx=legacy.reversed_foreign and line.credit_fx=0)::integer prior_debit,
      count(*)filter(where line.account_id=prior_control
        and line.debit=0 and line.credit=legacy.reversed_foreign
        and line.debit_fx=0 and line.credit_fx=legacy.reversed_foreign)::integer prior_credit
    into line_values
    from public.journal_line line
    where line.journal_id=legacy.reversal_journal_id;
    line_period_type:=case
      when line_values.line_count=2 and line_values.current_debit=1
        and line_values.current_credit=1 then'ACTUAL'
      when line_values.line_count=2 and line_values.prior_debit=1
        and line_values.prior_credit=1 then'ANTERIOR'
      else null end;
    if line_period_type is null or line_values.wrong_rate
      or line_values.wrong_currency
      or abs(line_values.debit-legacy.reversed_foreign)>.000001
      or abs(line_values.credit-legacy.reversed_foreign)>.000001
      or abs(line_values.debit_fx-legacy.reversed_foreign)>.000001
      or abs(line_values.credit_fx-legacy.reversed_foreign)>.000001 then
      continue;
    end if;

    select count(*)::integer impact_count,
      coalesce(sum(impact.debit_amount),0)debit,
      coalesce(sum(impact.credit_amount),0)credit,
      coalesce(sum(impact.debit_fx),0)debit_fx,
      coalesce(sum(impact.credit_fx),0)credit_fx,
      coalesce(bool_or(impact.original_currency_id is not null
        and impact.original_currency_id<>legacy.source_currency_id),false)wrong_currency,
      count(*)filter(where impact.accounting_book_id=book_key
        and impact.account_id=current_counterpart and impact.debit_amount>0
        and impact.credit_amount=0 and impact.debit_fx=legacy.reversed_foreign
        and impact.credit_fx=0)::integer current_debit,
      count(*)filter(where impact.accounting_book_id=book_key
        and impact.account_id=current_control and impact.debit_amount=0
        and impact.credit_amount>0 and impact.debit_fx=0
        and impact.credit_fx=legacy.reversed_foreign)::integer current_credit,
      count(*)filter(where impact.accounting_book_id=book_key
        and impact.account_id=bridge_account and impact.debit_amount>0
        and impact.credit_amount=0 and impact.debit_fx=legacy.reversed_foreign
        and impact.credit_fx=0)::integer prior_debit,
      count(*)filter(where impact.accounting_book_id=book_key
        and impact.account_id=prior_control and impact.debit_amount=0
        and impact.credit_amount>0 and impact.debit_fx=0
        and impact.credit_fx=legacy.reversed_foreign)::integer prior_credit
    into impact_values
    from public.gl_impact impact
    where impact.transaction_id=legacy.reversal_transaction_id;
    impact_period_type:=case
      when impact_values.impact_count=2 and impact_values.current_debit=1
        and impact_values.current_credit=1 then'ACTUAL'
      when impact_values.impact_count=2 and impact_values.prior_debit=1
        and impact_values.prior_credit=1 then'ANTERIOR'
      else null end;
    per_tolerance:=greatest(.005,abs(legacy.source_rate)*.0000005+.000001);
    if impact_period_type is null or impact_period_type<>line_period_type
      or impact_values.wrong_currency
      or abs(impact_values.debit-impact_values.credit)>.000001
      or abs(impact_values.debit_fx-legacy.reversed_foreign)>.000001
      or abs(impact_values.credit_fx-legacy.reversed_foreign)>.000001
      or abs(impact_values.debit-
        round(legacy.reversed_foreign*legacy.source_rate,6))>per_tolerance
      or abs(impact_values.debit-legacy.reversed_local)<=.000001 then
      continue;
    end if;

    select annual_run.reclassification_date into reclassification_date
    from public.pending_invoice_reclassification_items reclassified
    join public.pending_invoice_reclassification_runs annual_run
      on annual_run.id=reclassified.run_id
    where reclassified.source_journal_id=legacy.source_journal_id;
    expected_period_type:=case
      when reclassification_date is null then legacy.source_period_type
      when legacy.reversal_date<reclassification_date then'ACTUAL'
      when legacy.reversal_date>reclassification_date then'ANTERIOR'
      else null end;
    if expected_period_type is not null
      and line_period_type<>expected_period_type then
      continue;
    end if;

    perform set_config('app.pending_reversal_finalize','1',true);
    update public.pending_invoice_reversal
    set reversed_local=impact_values.debit
    where reversal_id=legacy.reversal_id
      and reversed_local=legacy.reversed_local
      and reversed_foreign=legacy.reversed_foreign;
    perform set_config('app.pending_reversal_finalize','0',true);
  end loop;
end
$$;

-- Validate every historical row before changing any metadata.  A real amount,
-- rate or currency discrepancy aborts the migration atomically.
do $$
declare
  reversal record;
  source_fx record;
  header record;
  line_values record;
  impact_values record;
  current_control bigint;
  prior_control bigint;
  current_counterpart bigint;
  bridge_account bigint;
  book_key bigint;
  book_count integer;
  reclassification_date date;
  expected_period_type text;
  line_period_type text;
  impact_period_type text;
  legacy_format boolean;
  annual_wrapper_format boolean;
  normalized_format boolean;
begin
  select max(account_id)filter(where account_number='113003'),
    max(account_id)filter(where account_number='113004'),
    max(account_id)filter(where account_number='413001'),
    max(account_id)filter(where account_number='413002')
  into current_control,prior_control,current_counterpart,bridge_account
  from public.chart_accounts
  where account_number in('113003','113004','413001','413002');
  if current_control is null or prior_control is null
    or current_counterpart is null or bridge_account is null then
    raise exception 'No están configuradas todas las cuentas de pendientes 113003, 113004, 413001 y 413002.';
  end if;

  for reversal in
    select * from public.pending_invoice_reversal order by reversal_id
  loop
    select * into source_fx
    from public.pending_invoice_reversal_source_fx(
      reversal.source_journal_id,reversal.source_opening_pending_id
    );
    select journal_row.exchange_rate journal_rate,
      journal_row.currency_id journal_currency,
      journal_row.total_debit,journal_row.total_credit,
      transaction_row.exchange_rate transaction_rate,
      transaction_row.currency_id transaction_currency,
      transaction_row.total_amount transaction_total
    into header
    from public.journal journal_row
    join public."transaction" transaction_row using(transaction_id)
    where journal_row.journal_id=reversal.reversal_journal_id;
    if header.journal_rate is null or header.transaction_rate is null
      or abs(header.journal_rate-source_fx.source_historical_rate)>.0000000001
      or abs(header.transaction_rate-source_fx.source_historical_rate)>.0000000001
      or header.journal_currency is distinct from source_fx.source_currency_id
      or header.transaction_currency is distinct from source_fx.source_currency_id then
      raise exception 'La reversión % tiene una discrepancia real de tasa, moneda o importe.',
        reversal.reversal_journal_id;
    end if;
    select count(*)::integer line_count,
      coalesce(sum(line.debit),0)debit,coalesce(sum(line.credit),0)credit,
      coalesce(sum(line.debit_fx),0)debit_fx,
      coalesce(sum(line.credit_fx),0)credit_fx,
      coalesce(bool_or(line.historical_exchange_rate is not null
        and abs(line.historical_exchange_rate-source_fx.source_historical_rate)>.0000000001),false)wrong_rate,
      coalesce(bool_or(line.original_currency_id is not null
        and line.original_currency_id<>source_fx.source_currency_id),false)wrong_currency,
      count(*)filter(where line.account_id=current_counterpart
        and line.debit>0 and line.credit=0
        and line.debit_fx>0 and line.credit_fx=0)::integer current_debit_count,
      count(*)filter(where line.account_id=current_control
        and line.debit=0 and line.credit>0
        and line.debit_fx=0 and line.credit_fx>0)::integer current_credit_count,
      count(*)filter(where not(
        (line.account_id=current_counterpart and line.debit>0 and line.credit=0
          and line.debit_fx>0 and line.credit_fx=0)
        or(line.account_id=current_control and line.debit=0 and line.credit>0
          and line.debit_fx=0 and line.credit_fx>0)))::integer current_unexpected,
      count(*)filter(where line.account_id=bridge_account
        and line.debit>0 and line.credit=0
        and line.debit_fx>0 and line.credit_fx=0)::integer prior_debit_count,
      count(*)filter(where line.account_id=prior_control
        and line.debit=0 and line.credit>0
        and line.debit_fx=0 and line.credit_fx>0)::integer prior_credit_count,
      count(*)filter(where not(
        (line.account_id=bridge_account and line.debit>0 and line.credit=0
          and line.debit_fx>0 and line.credit_fx=0)
        or(line.account_id=prior_control and line.debit=0 and line.credit>0
          and line.debit_fx=0 and line.credit_fx>0)))::integer prior_unexpected
    into line_values
    from public.journal_line line
    where line.journal_id=reversal.reversal_journal_id;
    if line_values.line_count<>2
      or abs(line_values.debit_fx-reversal.reversed_foreign)>.000001
      or abs(line_values.credit_fx-reversal.reversed_foreign)>.000001
      or line_values.wrong_rate or line_values.wrong_currency then
      raise exception 'La reversión % tiene líneas incompatibles con su snapshot histórico.',
        reversal.reversal_journal_id;
    end if;
    line_period_type:=case
      when line_values.current_debit_count=1
        and line_values.current_credit_count=1
        and line_values.current_unexpected=0 then'ACTUAL'
      when line_values.prior_debit_count=1
        and line_values.prior_credit_count=1
        and line_values.prior_unexpected=0 then'ANTERIOR'
      else null end;
    if line_period_type is null then
      raise exception 'La reversión % no conserva la pareja y dirección contable esperadas en sus líneas.',
        reversal.reversal_journal_id;
    end if;
    normalized_format:=coalesce((
      abs(header.total_debit-reversal.reversed_foreign)<=.000001
      and abs(header.total_credit-reversal.reversed_foreign)<=.000001
      and abs(header.transaction_total-reversal.reversed_foreign)<=.000001
      and abs(line_values.debit-reversal.reversed_foreign)<=.000001
      and abs(line_values.credit-reversal.reversed_foreign)<=.000001
    ),false);
    annual_wrapper_format:=coalesce((
      abs(header.total_debit-reversal.reversed_foreign)<=.000001
      and abs(header.total_credit-reversal.reversed_foreign)<=.000001
      and abs(header.transaction_total-reversal.reversed_local)<=.000001
      and abs(line_values.debit-reversal.reversed_foreign)<=.000001
      and abs(line_values.credit-reversal.reversed_foreign)<=.000001
    ),false);
    legacy_format:=coalesce((
      abs(header.total_debit-reversal.reversed_local)<=.005
      and abs(header.total_credit-reversal.reversed_local)<=.005
      and abs(header.transaction_total-reversal.reversed_local)<=.005
      and abs(line_values.debit-reversal.reversed_local)<=.005
      and abs(line_values.credit-reversal.reversed_local)<=.005
    ),false);
    if not normalized_format and not annual_wrapper_format and not legacy_format then
      raise exception 'La reversión % no corresponde a un formato histórico local/original admitido.',
        reversal.reversal_journal_id;
    end if;
    select count(*)::integer into book_count
    from public.accounting_books book
    where book.subsidiary_id=source_fx.source_subsidiary_id
      and book.is_primary and book.is_active;
    select book.accounting_book_id into book_key
    from public.accounting_books book
    where book.subsidiary_id=source_fx.source_subsidiary_id
      and book.is_primary and book.is_active;
    if book_count<>1 then
      raise exception 'La reversión % no tiene exactamente un libro principal activo.',
        reversal.reversal_journal_id;
    end if;
    select count(*)::integer impact_count,
      coalesce(sum(impact.debit_amount),0)debit,
      coalesce(sum(impact.credit_amount),0)credit,
      coalesce(sum(impact.debit_fx),0)debit_fx,
      coalesce(sum(impact.credit_fx),0)credit_fx,
      coalesce(bool_or(impact.original_currency_id is not null
        and impact.original_currency_id<>source_fx.source_currency_id),false)wrong_currency,
      count(*)filter(where impact.accounting_book_id=book_key
        and impact.account_id=current_counterpart
        and abs(impact.debit_amount-reversal.reversed_local)<=.000001
        and abs(impact.credit_amount)<=.000001
        and abs(impact.debit_fx-reversal.reversed_foreign)<=.000001
        and abs(impact.credit_fx)<=.000001)::integer current_debit_count,
      count(*)filter(where impact.accounting_book_id=book_key
        and impact.account_id=current_control
        and abs(impact.debit_amount)<=.000001
        and abs(impact.credit_amount-reversal.reversed_local)<=.000001
        and abs(impact.debit_fx)<=.000001
        and abs(impact.credit_fx-reversal.reversed_foreign)<=.000001)::integer current_credit_count,
      count(*)filter(where not(
        (impact.accounting_book_id=book_key and impact.account_id=current_counterpart
          and abs(impact.debit_amount-reversal.reversed_local)<=.000001
          and abs(impact.credit_amount)<=.000001
          and abs(impact.debit_fx-reversal.reversed_foreign)<=.000001
          and abs(impact.credit_fx)<=.000001)
        or(impact.accounting_book_id=book_key and impact.account_id=current_control
          and abs(impact.debit_amount)<=.000001
          and abs(impact.credit_amount-reversal.reversed_local)<=.000001
          and abs(impact.debit_fx)<=.000001
          and abs(impact.credit_fx-reversal.reversed_foreign)<=.000001)))::integer current_unexpected,
      count(*)filter(where impact.accounting_book_id=book_key
        and impact.account_id=bridge_account
        and abs(impact.debit_amount-reversal.reversed_local)<=.000001
        and abs(impact.credit_amount)<=.000001
        and abs(impact.debit_fx-reversal.reversed_foreign)<=.000001
        and abs(impact.credit_fx)<=.000001)::integer prior_debit_count,
      count(*)filter(where impact.accounting_book_id=book_key
        and impact.account_id=prior_control
        and abs(impact.debit_amount)<=.000001
        and abs(impact.credit_amount-reversal.reversed_local)<=.000001
        and abs(impact.debit_fx)<=.000001
        and abs(impact.credit_fx-reversal.reversed_foreign)<=.000001)::integer prior_credit_count,
      count(*)filter(where not(
        (impact.accounting_book_id=book_key and impact.account_id=bridge_account
          and abs(impact.debit_amount-reversal.reversed_local)<=.000001
          and abs(impact.credit_amount)<=.000001
          and abs(impact.debit_fx-reversal.reversed_foreign)<=.000001
          and abs(impact.credit_fx)<=.000001)
        or(impact.accounting_book_id=book_key and impact.account_id=prior_control
          and abs(impact.debit_amount)<=.000001
          and abs(impact.credit_amount-reversal.reversed_local)<=.000001
          and abs(impact.debit_fx)<=.000001
          and abs(impact.credit_fx-reversal.reversed_foreign)<=.000001)))::integer prior_unexpected
    into impact_values
    from public.gl_impact impact
    where impact.transaction_id=(select transaction_id from public.journal
      where journal_id=reversal.reversal_journal_id);
    impact_period_type:=case
      when impact_values.current_debit_count=1
        and impact_values.current_credit_count=1
        and impact_values.current_unexpected=0 then'ACTUAL'
      when impact_values.prior_debit_count=1
        and impact_values.prior_credit_count=1
        and impact_values.prior_unexpected=0 then'ANTERIOR'
      else null end;
    if impact_values.impact_count<>2
      or abs(impact_values.debit-reversal.reversed_local)>.005
      or abs(impact_values.credit-reversal.reversed_local)>.005
      or abs(impact_values.debit_fx-reversal.reversed_foreign)>.000001
      or abs(impact_values.credit_fx-reversal.reversed_foreign)>.000001
      or impact_values.wrong_currency or impact_period_type is null then
      raise exception 'La reversión % no concilia con el Mayor en moneda local y original.',
        reversal.reversal_journal_id;
    end if;
    if line_period_type<>impact_period_type then
      raise exception 'La reversión % usa parejas contables distintas entre líneas y Mayor.',
        reversal.reversal_journal_id;
    end if;

    select annual_run.reclassification_date into reclassification_date
    from public.pending_invoice_reclassification_items reclassified
    join public.pending_invoice_reclassification_runs annual_run
      on annual_run.id=reclassified.run_id
    where(reversal.source_journal_id is not null
        and reclassified.source_journal_id=reversal.source_journal_id)
      or(reversal.source_opening_pending_id is not null
        and reclassified.source_opening_pending_id=reversal.source_opening_pending_id);
    expected_period_type:=case
      when reclassification_date is null then source_fx.source_period_type
      when reversal.reversal_date<reclassification_date then'ACTUAL'
      when reversal.reversal_date>reclassification_date then'ANTERIOR'
      else null end;
    -- On the exact annual date either pair is valid: the account pair records
    -- whether the reversal was posted before or after that serialized run.
    if expected_period_type is not null
      and line_period_type<>expected_period_type then
      raise exception 'La reversión % no usa la pareja contable vigente en su fecha.',
        reversal.reversal_journal_id;
    end if;
  end loop;
end
$$;

-- Normalize legacy presentation fields to original currency without touching
-- the already reconciled primary-book local/FX amounts.  Suppress the legacy
-- rebuild trigger while header and line presentation is repaired.
alter table public.journal_line disable trigger journal_line_gl_impact_sync;
select set_config('app.pending_reversal_finalize','1',true);
with expected as(
  select reversal.reversal_journal_id,reversal.reversed_foreign,
    source_fx.source_historical_rate,source_fx.source_currency_id
  from public.pending_invoice_reversal reversal
  cross join lateral public.pending_invoice_reversal_source_fx(
    reversal.source_journal_id,reversal.source_opening_pending_id
  )source_fx
)
update public.journal_line line
set debit=case when line.debit>0 then expected.reversed_foreign else 0 end,
  credit=case when line.credit>0 then expected.reversed_foreign else 0 end,
  debit_fx=case when line.debit>0 then expected.reversed_foreign else 0 end,
  credit_fx=case when line.credit>0 then expected.reversed_foreign else 0 end,
  historical_exchange_rate=coalesce(line.historical_exchange_rate,
      expected.source_historical_rate),
  original_currency_id=coalesce(line.original_currency_id,
      expected.source_currency_id)
from expected
where line.journal_id=expected.reversal_journal_id
  and(line.debit is distinct from case when line.debit>0 then expected.reversed_foreign else 0 end
    or line.credit is distinct from case when line.credit>0 then expected.reversed_foreign else 0 end
    or line.debit_fx is distinct from case when line.debit>0 then expected.reversed_foreign else 0 end
    or line.credit_fx is distinct from case when line.credit>0 then expected.reversed_foreign else 0 end
    or line.historical_exchange_rate is null or line.original_currency_id is null);

with expected as(
  select reversal.reversal_journal_id,reversal.reversed_foreign,
    source_fx.source_historical_rate,source_fx.source_currency_id
  from public.pending_invoice_reversal reversal
  cross join lateral public.pending_invoice_reversal_source_fx(
    reversal.source_journal_id,reversal.source_opening_pending_id
  )source_fx
)
update public.journal journal_row
set currency_id=expected.source_currency_id,
  exchange_rate=expected.source_historical_rate,
  total_debit=expected.reversed_foreign,
  total_credit=expected.reversed_foreign
from expected
where journal_row.journal_id=expected.reversal_journal_id;

with expected as(
  select reversal_journal.transaction_id,reversal.reversed_foreign,
    source_fx.source_historical_rate,source_fx.source_currency_id
  from public.pending_invoice_reversal reversal
  join public.journal reversal_journal
    on reversal_journal.journal_id=reversal.reversal_journal_id
  cross join lateral public.pending_invoice_reversal_source_fx(
    reversal.source_journal_id,reversal.source_opening_pending_id
  )source_fx
)
update public."transaction" transaction_row
set currency_id=expected.source_currency_id,
  exchange_rate=expected.source_historical_rate,
  total_amount=expected.reversed_foreign
from expected
where transaction_row.transaction_id=expected.transaction_id;

-- The annual cutoff guard is disabled only while filling a missing currency
-- identifier.  The AccessExclusive lock prevents concurrent GL writes and the
-- strict trigger is enabled again before this migration can commit.
alter table public.gl_impact disable trigger guard_pending_control_gl_cutoff_trigger;
with expected as(
  select reversal_journal.transaction_id,source_fx.source_currency_id
  from public.pending_invoice_reversal reversal
  join public.journal reversal_journal
    on reversal_journal.journal_id=reversal.reversal_journal_id
  cross join lateral public.pending_invoice_reversal_source_fx(
    reversal.source_journal_id,reversal.source_opening_pending_id
  )source_fx
)
update public.gl_impact impact
set original_currency_id=expected.source_currency_id
from expected
where impact.transaction_id=expected.transaction_id
  and impact.original_currency_id is null;
alter table public.gl_impact enable trigger guard_pending_control_gl_cutoff_trigger;
select set_config('app.pending_reversal_finalize','0',true);
alter table public.journal_line enable trigger journal_line_gl_impact_sync;

do $$
begin
  if to_regprocedure(
    'public.reverse_opening_pending_invoice_before_historical_fx_integrity(bigint,jsonb)'
  )is null then
    alter function public.reverse_opening_pending_invoice(bigint,jsonb)
      rename to reverse_opening_pending_invoice_before_historical_fx_integrity;
  end if;
end
$$;

revoke all on function
  public.reverse_opening_pending_invoice_before_historical_fx_integrity(bigint,jsonb)
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
$$;

revoke all on function public.reverse_opening_pending_invoice(bigint,jsonb)
  from public,anon;
grant execute on function public.reverse_opening_pending_invoice(bigint,jsonb)
  to authenticated;

do $$
begin
  if to_regprocedure(
    'public.reverse_pending_invoice_journal_before_historical_fx_integrity(bigint,jsonb)'
  )is null then
    alter function public.reverse_pending_invoice_journal(bigint,jsonb)
      rename to reverse_pending_invoice_journal_before_historical_fx_integrity;
  end if;
end
$$;

revoke all on function
  public.reverse_pending_invoice_journal_before_historical_fx_integrity(bigint,jsonb)
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
$$;

revoke all on function public.reverse_pending_invoice_journal(bigint,jsonb)
  from public,anon;
grant execute on function public.reverse_pending_invoice_journal(bigint,jsonb)
  to authenticated;

do $$
begin
  if to_regprocedure(
    'public.pending_invoice_reversal_options_before_historical_fx_integrity(bigint,date)'
  )is null then
    alter function public.pending_invoice_reversal_options(bigint,date)
      rename to pending_invoice_reversal_options_before_historical_fx_integrity;
  end if;
end
$$;

revoke all on function
  public.pending_invoice_reversal_options_before_historical_fx_integrity(bigint,date)
from public,anon,authenticated;

-- The modal amount is entered in local currency.  Convert the invoice's
-- original-currency ceiling back through the frozen source relationship so
-- subtotal/applied/available are directly comparable with that input.
create or replace function public.pending_invoice_reversal_options(
  p_journal_id bigint,
  p_reversal_date date
)returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
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
$$;

revoke all on function public.pending_invoice_reversal_options(bigint,date)
  from public,anon;
grant execute on function public.pending_invoice_reversal_options(bigint,date)
  to authenticated;

revoke all on function public.guard_pending_control_gl_cutoff(),
  public.pending_invoice_reversal_source_fx(bigint,bigint),
  public.pending_invoice_normalize_reversal_fx(bigint,numeric,bigint,text),
  public.pending_invoice_billing_limit_snapshot(bigint,bigint,bigint,bigint),
  public.pending_invoice_validate_billing_limit(bigint,bigint,bigint,date,numeric,numeric,bigint),
  public.reverse_opening_pending_invoice_before_historical_fx_integrity(bigint,jsonb),
  public.reverse_pending_invoice_journal_before_historical_fx_integrity(bigint,jsonb),
  public.pending_invoice_reversal_options_before_historical_fx_integrity(bigint,date)
from public,anon,authenticated;

notify pgrst,'reload schema';
