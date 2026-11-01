CREATE OR REPLACE FUNCTION public.sync_journal_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
CREATE TRIGGER journal_transaction_sync BEFORE INSERT OR UPDATE ON public.journal FOR EACH ROW EXECUTE FUNCTION sync_journal_transaction();
