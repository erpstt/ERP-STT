-- Four additional, read-only ledger columns. Original amounts are the stored
-- GL amounts, including zero and NULL; they are never reconstructed by division.
-- Rates are local units per original unit, using the posted historical source.
set local lock_timeout='5s';
set local statement_timeout='30s';

do $patch$
declare
 signature text;target oid;original record;current_metadata record;definition text;
 source_hash constant text:='37ff67e5ec1edf15168eb74f2cc8912f';
 needles text[]:=array[
  $old$g.debit_amount debit,g.credit_amount credit,jx.journal_id,jx.journal_number,$old$,
  $old$jl.supplier_id,jl.employee_id,jl.cost_center_id
    from journal_line jl$old$,
  $old$) line_data on true$old$
 ];
 replacements text[]:=array[
  $new$g.debit_amount debit,g.credit_amount credit,jx.journal_id,jx.journal_number,
    original_currency.currency_code original_currency_code,
    original_conversion.rate original_exchange_rate,g.debit_fx original_debit,g.credit_fx original_credit,$new$,
  $new$jl.supplier_id,jl.employee_id,jl.cost_center_id,jl.original_currency_id,jl.historical_exchange_rate,
      case when g.opening_balance_line_id is not null then 1
        when jl.historical_exchange_rate is not null then(select count(*)from(
          select 1 from journal_line rate_candidate
          where rate_candidate.journal_id=jl.journal_id and rate_candidate.account_id=jl.account_id limit 2
        )rate_candidates)end original_line_match_count
    from journal_line jl$new$,
  $new$) line_data on true
   -- ledger-original-currency-v1: no current-rate catalog and no new posting.
   left join opening_balance_lines original_opening
     on original_opening.id=g.opening_balance_line_id and original_opening.account_id=g.account_id
     and jx.subsidiary_id=g.subsidiary_id
     and exists(select 1 from opening_balance_runs original_run
       where original_run.id=original_opening.run_id and original_run.subsidiary_id=g.subsidiary_id
         and original_run.journal_id=coalesce(jx.reversed_from_journal_id,jx.journal_id))
   left join lateral(select case when jx.fx_revaluation_run_id is not null then s.currency_id else
     coalesce(g.original_currency_id,
       case when original_opening.id is not null then line_data.original_currency_id end,
       original_opening.currency_id,t.currency_id,jx.currency_id)end currency_id
   ) original_context on true
   left join currencies original_currency on original_currency.currency_id=original_context.currency_id
   left join lateral(select
     case when line_data.historical_exchange_rate>0 and line_data.historical_exchange_rate::text not in('NaN','Infinity','-Infinity')
       and(line_data.original_currency_id is null or line_data.original_currency_id=original_context.currency_id)
       then line_data.historical_exchange_rate end line_rate,
     case when original_opening.historical_rate>0 and original_opening.historical_rate::text not in('NaN','Infinity','-Infinity')
       and original_opening.currency_id=original_context.currency_id then original_opening.historical_rate end opening_rate,
     case when t.currency_id=original_context.currency_id and t.exchange_rate>0 and t.exchange_rate::text not in('NaN','Infinity','-Infinity')
       then t.exchange_rate end transaction_rate,
     case when jx.currency_id=original_context.currency_id and jx.exchange_rate>0 and jx.exchange_rate::text not in('NaN','Infinity','-Infinity')
       then jx.exchange_rate end journal_rate,
     case when g.debit_fx>0 and g.debit_amount>0 then g.debit_amount/g.debit_fx
       when g.credit_fx>0 and g.credit_amount>0 then g.credit_amount/g.credit_fx end effective_rate
   ) original_rates on true
   left join lateral(select case
     when original_context.currency_id is null then null::numeric
     when original_context.currency_id=s.currency_id then 1::numeric
     when original_opening.id is not null then coalesce(original_rates.line_rate,original_rates.opening_rate,original_rates.effective_rate)
     when line_data.original_line_match_count=1 and original_rates.line_rate is not null
       and(g.debit_fx>0 or g.credit_fx>0)
       and round(g.debit_fx*original_rates.line_rate,6)=round(g.debit_amount,6)
       and round(g.credit_fx*original_rates.line_rate,6)=round(g.credit_amount,6)then original_rates.line_rate
     when original_rates.transaction_rate is not null and(g.debit_fx>0 or g.credit_fx>0)
       and round(g.debit_fx*original_rates.transaction_rate,6)=round(g.debit_amount,6)
       and round(g.credit_fx*original_rates.transaction_rate,6)=round(g.credit_amount,6)then original_rates.transaction_rate
     when original_rates.journal_rate is not null and(g.debit_fx>0 or g.credit_fx>0)
       and round(g.debit_fx*original_rates.journal_rate,6)=round(g.debit_amount,6)
       and round(g.credit_fx*original_rates.journal_rate,6)=round(g.credit_amount,6)then original_rates.journal_rate
     when original_rates.effective_rate>0 and original_rates.effective_rate::text not in('NaN','Infinity','-Infinity')
       then original_rates.effective_rate end rate
   ) original_conversion on true$new$
 ];
 i integer;
begin
 foreach signature in array array[
  'public.run_accounting_report_before_intercompany_loans(text,jsonb)',
  'report_delivery_private.run_accounting_report_before_intercompany_loans(text,jsonb)'
 ] loop
  target:=to_regprocedure(signature);
  if target is null then raise exception 'Missing ledger calculation: %',signature;end if;
  select p.*,l.lanname into strict original from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=target;
  if original.lanname<>'plpgsql' or not original.prosecdef or original.provolatile<>'s' or md5(original.prosrc)<>source_hash
  then raise exception 'Unexpected ledger calculation; review before migrating: %',signature;end if;
  for i in 1..array_length(needles,1)loop
   if(length(original.prosrc)-length(replace(original.prosrc,needles[i],'')))<>length(needles[i])
   then raise exception 'Unexpected ledger projection occurrence: % / %',signature,i;end if;
  end loop;
 end loop;
 foreach signature in array array[
  'public.run_accounting_report_before_intercompany_loans(text,jsonb)',
  'report_delivery_private.run_accounting_report_before_intercompany_loans(text,jsonb)'
 ] loop
  target:=to_regprocedure(signature);
  select proowner,proacl,proconfig,provolatile,prosecdef,proisstrict,proparallel into strict original from pg_proc where oid=target;
  definition:=pg_get_functiondef(target);
  for i in 1..array_length(needles,1)loop definition:=replace(definition,needles[i],replacements[i]);end loop;
  execute definition;
  select proowner,proacl,proconfig,provolatile,prosecdef,proisstrict,proparallel into strict current_metadata from pg_proc where oid=target;
  if current_metadata is distinct from original then raise exception 'Ledger metadata changed unexpectedly: %',signature;end if;
 end loop;
end
$patch$;

notify pgrst,'reload schema';
