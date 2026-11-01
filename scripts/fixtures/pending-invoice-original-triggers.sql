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
CREATE TRIGGER guard_pending_reclassification_transaction_trigger BEFORE DELETE OR UPDATE ON public.transaction FOR EACH ROW EXECUTE FUNCTION guard_pending_reclassification_transaction();

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
CREATE TRIGGER guard_pending_control_gl_cutoff_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.gl_impact FOR EACH ROW EXECUTE FUNCTION guard_pending_control_gl_cutoff();

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
CREATE TRIGGER guard_pending_reclassification_gl_impact_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.gl_impact FOR EACH ROW EXECUTE FUNCTION guard_pending_reclassification_gl_impact();

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
CREATE TRIGGER guard_pending_invoice_generic_reversal_trigger BEFORE UPDATE ON public.journal FOR EACH ROW EXECUTE FUNCTION guard_pending_invoice_generic_reversal();

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
CREATE TRIGGER guard_pending_reclassification_journal_trigger BEFORE DELETE OR UPDATE ON public.journal FOR EACH ROW EXECUTE FUNCTION guard_pending_reclassification_journal();

CREATE OR REPLACE FUNCTION public.prevent_retroactive_pending_after_annual_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
CREATE TRIGGER prevent_retroactive_pending_after_annual_run_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.journal FOR EACH ROW EXECUTE FUNCTION prevent_retroactive_pending_after_annual_run();

CREATE OR REPLACE FUNCTION public.protect_pending_period_metadata()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
CREATE TRIGGER protect_pending_period_metadata_trigger BEFORE INSERT OR UPDATE OF journal_type, pending_period_type, pending_origin_journal_id ON public.journal FOR EACH ROW EXECUTE FUNCTION protect_pending_period_metadata();

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
CREATE TRIGGER protect_pending_reversal_metadata_trigger BEFORE UPDATE OF pending_initial_local, pending_initial_foreign, pending_reversed_local, pending_reversed_foreign, pending_balance_local, pending_balance_foreign, reversal_status ON public.journal FOR EACH ROW EXECUTE FUNCTION protect_pending_reversal_metadata();

CREATE OR REPLACE FUNCTION public.sync_pending_origin_after_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
CREATE TRIGGER sync_pending_origin_after_insert_trigger AFTER INSERT ON public.journal FOR EACH ROW EXECUTE FUNCTION sync_pending_origin_after_insert();

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
CREATE TRIGGER guard_pending_reclassification_journal_line_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.journal_line FOR EACH ROW EXECUTE FUNCTION guard_pending_reclassification_journal_line();

CREATE OR REPLACE FUNCTION public.refresh_pending_invoice_amounts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
CREATE TRIGGER refresh_pending_invoice_amounts_trigger AFTER INSERT OR DELETE OR UPDATE ON public.journal_line FOR EACH ROW EXECUTE FUNCTION refresh_pending_invoice_amounts();

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
CREATE TRIGGER guard_pending_invoice_reversal_row_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.pending_invoice_reversal FOR EACH ROW EXECUTE FUNCTION guard_pending_invoice_reversal_row();

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
CREATE TRIGGER validate_pending_reversal_invoice_trigger BEFORE INSERT OR UPDATE OF source_journal_id, source_opening_pending_id, reversal_date, reversal_type, sales_invoice_id, reversed_local ON public.pending_invoice_reversal FOR EACH ROW EXECUTE FUNCTION validate_pending_reversal_invoice();
