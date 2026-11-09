-- Bank transfers are stored in a local-currency journal. Resolve the proven
-- native bank leg before selecting an FX currency; never reinterpret its raw
-- local GL credit_fx/debit_fx as a foreign principal. No financial rows change.
do $patch$
declare definition text;needle text;replacement text;start_at integer;end_at integer;
begin
 if not exists(select 1 from pg_proc where oid=to_regprocedure('fx_revaluation_private.fx_exposures(date,bigint)')and md5(prosrc)='7b74399c1e4d31d4bc2efa3748eb09df')then
  raise exception 'Unexpected FX exposure calculation before bank-transfer normalization';
 end if;
 definition:=pg_get_functiondef('fx_revaluation_private.fx_exposures(date,bigint)'::regprocedure);
 needle:='  result jsonb;';replacement:=E'  result jsonb;\n  invalid_bank_transfer boolean;';
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected FX transfer declaration boundary';end if;
 definition:=replace(definition,needle,replacement);
 start_at:=strpos(definition,'  ),ledger as(');end_at:=strpos(definition,'  ),documents as(');
 if start_at<=0 or end_at<=start_at then raise exception 'Missing FX ledger boundaries';end if;
 needle:=substr(definition,start_at,end_at-start_at);
 replacement:=$normalized$
  ),raw_ledger as(
    select impact.*,tran.currency_id transaction_currency_id
    from public.gl_impact impact
    join public."transaction" tran using(transaction_id)
    join eligible account using(account_id)
    where impact.subsidiary_id=sid and tran.subsidiary_id=sid
      and impact.accounting_book_id=book and impact.posting_date<=p_date
      and not exists(
        select 1 from public.journal journal
        where journal.transaction_id=tran.transaction_id
          and journal.fx_revaluation_run_id is not null
      )
      and not exists(
        select 1
        from public.opening_balance_runs run
        join public.journal source on source.journal_id=run.journal_id
        left join public.journal reversal on reversal.reversed_from_journal_id=source.journal_id
        where run.status='REVERSED'and reversal.journal_date<=p_date
          and(source.transaction_id=tran.transaction_id or reversal.transaction_id=tran.transaction_id)
      )
  ),normalized_ledger as(
    select impact.gl_impact_id,impact.transaction_id,impact.account_id,
      impact.subsidiary_id,impact.accounting_book_id,impact.posting_date,
      impact.opening_balance_line_id,impact.debit_amount,impact.credit_amount,
      case when transfer.recognized or known_transfer.recognized then transfer.native_debit else impact.debit_fx end debit_fx,
      case when transfer.recognized or known_transfer.recognized then transfer.native_credit else impact.credit_fx end credit_fx,
      case when transfer.recognized or known_transfer.recognized then transfer.currency_id
        else coalesce(impact.original_currency_id,impact.transaction_currency_id)end effective_currency_id,
      (transfer.recognized or known_transfer.recognized)and not coalesce(transfer.valid,false) invalid_transfer,
      transfer.has_requested_currency or transfer.unknown_currency or known_transfer.has_requested_currency
        or(known_transfer.recognized and not transfer.recognized)
        or coalesce(impact.original_currency_id,impact.transaction_currency_id)=p_currency relevant_transfer
    from raw_ledger impact
    left join lateral(
      -- An identifiable bank GL line cannot fall back to raw local amounts if
      -- the transfer header/leg was lost or no longer has a unique trace.
      select impact.opening_balance_line_id is null and exists(
        select 1 from public.journal current_journal
        left join public.journal original_journal on original_journal.journal_id=current_journal.reversed_from_journal_id
        where current_journal.transaction_id=impact.transaction_id
          and current_journal.fx_revaluation_run_id is null
          and(current_journal.journal_type='Transferencia bancaria' or original_journal.journal_type='Transferencia bancaria')
      )and exists(select 1 from public.bank_account bank where bank.account_id=impact.account_id and bank.subsidiary_id=sid) recognized,
      exists(select 1 from public.bank_account bank where bank.account_id=impact.account_id and bank.subsidiary_id=sid and bank.currency_id=p_currency)has_requested_currency
    )known_transfer on true
    left join lateral(
      -- Same bank-leg proof as the published ledger's transfer_original. The
      -- aggregate retains ambiguity; it never picks a first journal or leg.
      select count(*)>0 recognized,count(*)=1 and bool_and(candidate.valid) valid,
        case when count(*)=1 then max(candidate.currency_id)end currency_id,
        case when count(*)=1 and bool_and(candidate.valid)then max(case when candidate.is_debit then candidate.native_amount else 0 end)end native_debit,
        case when count(*)=1 and bool_and(candidate.valid)then max(case when candidate.is_debit then 0 else candidate.native_amount end)end native_credit,
        coalesce(bool_or(candidate.currency_id=p_currency),false)has_requested_currency,
        coalesce(bool_or(candidate.currency_id is null),false)unknown_currency
      from(
        select bank_leg.currency_id,bank_money.is_debit,bank_money.native_amount,
          coalesce(current_journal.subsidiary_id=sid and transfer_journal.subsidiary_id=sid
          and source_bank.subsidiary_id=sid and destination_bank.subsidiary_id=sid
          and bank_transfer.subsidiary_id=sid and transfer_journal.transaction_id=bank_transfer.transaction_id
          and exists(select 1 from public."transaction" source_transaction where source_transaction.transaction_id=bank_transfer.transaction_id and source_transaction.subsidiary_id=sid)
          and bank_transfer.from_account_id<>bank_transfer.to_account_id
          and(current_journal.reversed_from_journal_id is not null or bank_transfer.transaction_id=impact.transaction_id)
          and current_journal.fx_revaluation_run_id is null
          and transfer_journal.journal_type='Transferencia bancaria'
          and transfer_currency.currency_code is not null
          and bank_leg.principal_amount>0 and bank_leg.principal_amount::text not in('NaN','Infinity','-Infinity')
          and bank_leg.base_rate>0 and bank_leg.base_rate::text not in('NaN','Infinity','-Infinity')
          and bank_leg.principal_base_amount>0 and bank_leg.principal_base_amount::text not in('NaN','Infinity','-Infinity')
          and bank_leg.fee_amount>=0 and bank_leg.fee_amount::text not in('NaN','Infinity','-Infinity')
          and(bank_leg.currency_id<>(select currency_id from public.subsidiaries where subsidiary_id=sid)or bank_leg.base_rate=1)
          and round(bank_leg.principal_amount*bank_leg.base_rate,6)=bank_leg.principal_base_amount
          and(case when bank_money.is_debit then impact.credit_amount=0 and impact.debit_amount=bank_money.local_amount
            else impact.debit_amount=0 and impact.credit_amount=bank_money.local_amount end)
          and impact.posting_date=current_journal.journal_date
          and(select count(*)=1 and bool_and(movement.amount=case when bank_leg.normal_debit then bank_money.native_amount else -bank_money.native_amount end)
            from(select bank_movement.amount from public.bank_transaction bank_movement
              where bank_movement.transaction_id=bank_transfer.transaction_id
                and bank_movement.bank_account_id=bank_leg.bank_account_id and bank_movement.tran_type='TRF_BAN'
              limit 2)movement)
          and(select count(*)=1 from(select 1 from public.gl_impact peer
            where peer.transaction_id=impact.transaction_id and peer.subsidiary_id=impact.subsidiary_id
              and peer.accounting_book_id=impact.accounting_book_id and peer.account_id=impact.account_id
              and peer.debit_amount=impact.debit_amount and peer.credit_amount=impact.credit_amount limit 2)peers),false)valid
        from public.journal current_journal
        join public.bank_transfer bank_transfer on bank_transfer.journal_id=coalesce(current_journal.reversed_from_journal_id,current_journal.journal_id)
        join public.journal transfer_journal on transfer_journal.journal_id=bank_transfer.journal_id
        left join public.bank_account source_bank on source_bank.bank_account_id=bank_transfer.from_account_id
        left join public.bank_account destination_bank on destination_bank.bank_account_id=bank_transfer.to_account_id
        cross join lateral(values
          (source_bank.bank_account_id,source_bank.account_id,source_bank.currency_id,false,
            bank_transfer.source_amount,bank_transfer.source_base_amount,bank_transfer.commission_amount,bank_transfer.source_base_rate),
          (destination_bank.bank_account_id,destination_bank.account_id,destination_bank.currency_id,true,
            bank_transfer.destination_amount,bank_transfer.destination_base_amount,0::numeric,bank_transfer.destination_base_rate)
        )bank_leg(bank_account_id,account_id,currency_id,normal_debit,principal_amount,principal_base_amount,fee_amount,base_rate)
        cross join lateral(select bank_leg.principal_amount+bank_leg.fee_amount native_amount,
          round(bank_leg.principal_base_amount+bank_leg.fee_amount*bank_leg.base_rate,6)local_amount,
          bank_leg.normal_debit<>(current_journal.journal_id<>bank_transfer.journal_id)is_debit
        )bank_money
        left join public.currencies transfer_currency on transfer_currency.currency_id=bank_leg.currency_id
        where current_journal.transaction_id=impact.transaction_id and impact.opening_balance_line_id is null
          and(current_journal.journal_type='Transferencia bancaria' or current_journal.reversed_from_journal_id is not null)
          and bank_leg.account_id=impact.account_id
          and(source_bank.account_id is distinct from destination_bank.account_id
            or(case when bank_money.is_debit then impact.debit_amount>0 and impact.credit_amount=0
              else impact.credit_amount>0 and impact.debit_amount=0 end)
            or not((impact.debit_amount>0 and impact.credit_amount=0)or(impact.credit_amount>0 and impact.debit_amount=0)))
        limit 2
      )candidate
    )transfer on true
  ),ledger as(
    select *from normalized_ledger where effective_currency_id=p_currency and not invalid_transfer
$normalized$;
 definition:=replace(definition,needle,replacement);
 needle:='),''[]'')into result';
 replacement:=$result$),'[]'),(select exists(select 1 from normalized_ledger where invalid_transfer and relevant_transfer))into result,invalid_bank_transfer$result$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected FX exposure result boundary';end if;
 definition:=replace(definition,needle,replacement);
 needle:='  if exists(';replacement:=$validation$  if invalid_bank_transfer then
    raise exception using errcode='55000',message='No se pudo comprobar la moneda y el importe de una transferencia bancaria. Revise sus fuentes antes de revaluar.';
  end if;

  if exists($validation$;
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected FX exposure validation boundary';end if;
 execute replace(definition,needle,replacement);
end $patch$;
notify pgrst,'reload schema';
