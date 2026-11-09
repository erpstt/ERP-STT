-- Published function definitions only; no business rows, session data or credentials.
-- The current ledger includes historical bank-transfer original-currency logic.
-- Source MD5: 49cc0831bffdd2eb2d24728faaa6b816
CREATE OR REPLACE FUNCTION public.run_accounting_report(p_report text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$begin perform report_template_private.enter('reports:accounting-reports','view');

begin
  if p_report='intercompany-commercial'then
    return public.run_intercompany_commercial_report(p_filters);
  end if;
  return public.run_accounting_report_before_intercompany_commercial(
    p_report,p_filters
  );
end
;
end$function$
;

-- Source MD5: fa9aa5c18c8993d4bb497b76d3ab4ebd
CREATE OR REPLACE FUNCTION public.run_accounting_report_before_intercompany_commercial(p_report text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if p_report='intercompany-loans'then
    return public.run_intercompany_loan_report(p_filters);
  end if;
  return public.run_accounting_report_before_intercompany_loans(
    p_report,p_filters
  );
end
$function$
;

-- Source MD5: 63c4bc948586aa92bddacda13a0ff909
CREATE OR REPLACE FUNCTION public.run_accounting_report_before_intercompany_loans(p_report text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
 sids bigint[]; book_id bigint; date_from date; date_to date; page_no int; page_size int; offset_no int;
 hierarchy int; exclude_zero boolean; result jsonb; allowed_count int; requested_count int;
 filter_department_id bigint; filter_location_id bigint; filter_class_id bigint; filter_cost_center_id bigint; filter_account_id bigint; filter_account_from text; filter_account_to text; filter_entity_type text; filter_entity_id bigint; filter_account_ids bigint[];
begin
 if p_report not in ('balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','receivables-payables','bank-reconciliation') then raise exception 'Reporte no válido.'; end if;
 select coalesce(array_agg(value::bigint),array[]::bigint[]) into sids from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'::jsonb));
 if cardinality(sids)=0 then sids:=array[active_subsidiary_id()]; end if;
 if sids[1] is null or exists(select 1 from unnest(sids) selected_id where not exists(select 1 from user_subsidiaries access where access.user_id=app_user_id() and access.subsidiary_id=selected_id)) then raise exception 'No tiene acceso a una o más subsidiarias seleccionadas.'; end if;
 book_id:=nullif(p_filters->>'bookId','')::bigint; date_from:=coalesce(nullif(p_filters->>'dateFrom','')::date,date_trunc('year',current_date)::date); date_to:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
 page_no:=greatest(coalesce((p_filters->>'page')::int,1),1); page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),500); offset_no:=(page_no-1)*page_size;
 hierarchy:=least(greatest(coalesce((p_filters->>'hierarchy')::int,4),1),4); exclude_zero:=coalesce((p_filters->>'excludeZero')::boolean,true);
 filter_department_id:=nullif(p_filters->>'departmentId','')::bigint; filter_location_id:=nullif(p_filters->>'locationId','')::bigint; filter_class_id:=nullif(p_filters->>'classId','')::bigint; filter_cost_center_id:=nullif(p_filters->>'costCenterId','')::bigint;
 filter_account_id:=nullif(p_filters->>'accountId','')::bigint;
 filter_account_from:=nullif(p_filters->>'accountFrom','');filter_account_to:=nullif(p_filters->>'accountTo','');filter_entity_type:=nullif(p_filters->>'entityType','');filter_entity_id:=nullif(p_filters->>'entityId','')::bigint;
 select coalesce(array_agg(value::bigint),array[]::bigint[]) into filter_account_ids from jsonb_array_elements_text(coalesce(p_filters->'accountIds','[]'::jsonb));

 if p_report='general-ledger' then
  with detail_base as (
   select g.gl_impact_id id,g.account_id,g.posting_date date,t.tran_number transaction_number,tt.code transaction_code,tt.name transaction_type,a.account_number,a.account_name,coalesce(a.nature,ag.nature,'Deudora') nature,s.name subsidiary,g.debit_amount debit,g.credit_amount credit,jx.journal_id,jx.journal_number,
    case when transfer_original.recognized then transfer_original.currency_code else original_currency.currency_code end original_currency_code,
    case when transfer_original.recognized then transfer_original.rate else original_conversion.rate end original_exchange_rate,
    case when transfer_original.recognized then transfer_original.native_debit else g.debit_fx end original_debit,
    case when transfer_original.recognized then transfer_original.native_credit else g.credit_fx end original_credit,
    coalesce(line_data.entity_name,customer.company_name,supplier.company_name,'—') entity_name,coalesce(line_data.entity_type,case when t.customer_id is not null then 'Cliente' when t.supplier_id is not null then 'Proveedor' end,'—') entity_type,coalesce(line_data.cost_center,'—') cost_center,coalesce(line_data.note,jx.memo,tt.name) concept,
    coalesce((select sum(case when coalesce(a.nature,ag.nature)='Acreedora' then previous.credit_amount-previous.debit_amount else previous.debit_amount-previous.credit_amount end) from gl_impact previous where previous.account_id=g.account_id and previous.subsidiary_id=g.subsidiary_id and previous.posting_date<date_from and (book_id is null or previous.accounting_book_id=book_id)),0) opening_balance,
    case when coalesce(a.nature,ag.nature)='Acreedora' then g.credit_amount-g.debit_amount else g.debit_amount-g.credit_amount end signed_movement
   from gl_impact g join chart_accounts a using(account_id) join account_group ag on ag.group_id=a.account_group_id join subsidiaries s using(subsidiary_id) join "transaction" t using(transaction_id) join transaction_types tt using(transaction_type_id) left join journal jx using(transaction_id)
   left join customers customer on customer.customer_id=t.customer_id left join suppliers supplier on supplier.supplier_id=t.supplier_id
   left join lateral(
    -- opening-ledger-entity-resolution-v1: exact trace, then scoped GL-only inference.
    select case when center_customer.customer_id is not null then 'Cliente' else jl.entity_type end entity_type,
      case when center_customer.customer_id is not null then center_customer.company_name
        else coalesce(c.company_name,sp.company_name,concat_ws(' ',e.first_name,e.last_name)) end entity_name,
      cc.code cost_center,jl.note,coalesce(jl.customer_id,center_customer.customer_id) customer_id,
      jl.supplier_id,jl.employee_id,jl.cost_center_id,jl.original_currency_id,jl.historical_exchange_rate,
      case when g.opening_balance_line_id is not null then 1
        when jl.historical_exchange_rate is not null then(select count(*)from(
          select 1 from journal_line rate_candidate
          where rate_candidate.journal_id=jl.journal_id and rate_candidate.account_id=jl.account_id limit 2
        )rate_candidates)end original_line_match_count
    from journal_line jl
    left join customers c using(customer_id)
    left join suppliers sp using(supplier_id)
    left join employees e using(employee_id)
    left join cost_centers cc using(cost_center_id)
    left join opening_balance_lines opening_line
      on opening_line.id=jl.opening_balance_line_id
      and opening_line.id=g.opening_balance_line_id
      and opening_line.source_type='GL'
      and opening_line.account_id=jl.account_id
      and opening_line.cost_center_id=jl.cost_center_id
    left join opening_balance_runs opening_run
      on opening_run.id=opening_line.run_id
      and opening_run.journal_id=jx.journal_id
      and opening_run.subsidiary_id=g.subsidiary_id
      and jx.subsidiary_id=g.subsidiary_id
    left join customers center_customer
      on center_customer.customer_id=cc.customer_id
      and opening_run.id is not null
      and cc.cost_center_type='CLIENTE'
      and cc.subsidiary_id=g.subsidiary_id
      and nullif(btrim(jl.entity_type),'') is null
      and jl.customer_id is null and jl.supplier_id is null and jl.employee_id is null
      and nullif(to_jsonb(jl)->>'financial_creditor_id','') is null
      and nullif(to_jsonb(jl)->>'related_company_id','') is null
      and nullif(to_jsonb(jl)->>'tax_agency_id','') is null
      and nullif(to_jsonb(jl)->>'other_name_id','') is null
      and t.customer_id is null and t.supplier_id is null
      and exists(select 1 from entity_subsidiaries scope
        where scope.customer_id=center_customer.customer_id and scope.subsidiary_id=g.subsidiary_id)
    where jl.journal_id=jx.journal_id and jl.account_id=g.account_id
      and(g.opening_balance_line_id is null or jl.opening_balance_line_id=g.opening_balance_line_id)
    order by jl.journal_line_id limit 1
   ) line_data on true
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
   ) original_conversion on true
   left join lateral(
     -- ledger-transfer-original-v1: distinguish recognition from validation.
     -- An identifiable but inconsistent/ambiguous bank leg returns four NULLs.
     select count(*)>0 recognized,count(*)candidate_count,count(*)filter(where candidate.valid)valid_candidate_count,
       case when count(*)=1 and bool_and(candidate.valid)then max(candidate.currency_code)end currency_code,
       case when count(*)=1 and bool_and(candidate.valid)then max(candidate.base_rate)end rate,
       case when count(*)=1 and bool_and(candidate.valid)then max(case when candidate.is_debit then candidate.native_amount else 0 end)end native_debit,
       case when count(*)=1 and bool_and(candidate.valid)then max(case when candidate.is_debit then 0 else candidate.native_amount end)end native_credit
     from(
       select transfer_currency.currency_code,bank_leg.base_rate,bank_money.is_debit,bank_money.native_amount,
         source_bank.subsidiary_id=g.subsidiary_id and destination_bank.subsidiary_id=g.subsidiary_id
         and transfer.subsidiary_id=g.subsidiary_id and transfer_journal.transaction_id=transfer.transaction_id
         and transfer.from_account_id<>transfer.to_account_id
         and(jx.reversed_from_journal_id is not null or transfer.transaction_id=g.transaction_id)
         and transfer_currency.currency_code is not null
         and bank_leg.principal_amount>0 and bank_leg.principal_amount::text not in('NaN','Infinity','-Infinity')
         and bank_leg.base_rate>0 and bank_leg.base_rate::text not in('NaN','Infinity','-Infinity')
         and bank_leg.principal_base_amount>0 and bank_leg.principal_base_amount::text not in('NaN','Infinity','-Infinity')
         and bank_leg.fee_amount>=0 and bank_leg.fee_amount::text not in('NaN','Infinity','-Infinity')
         and(bank_leg.currency_id<>s.currency_id or bank_leg.base_rate=1)
         and round(bank_leg.principal_amount*bank_leg.base_rate,6)=bank_leg.principal_base_amount
         and(case when bank_money.is_debit then g.credit_amount=0 and g.debit_amount=bank_money.local_amount
           else g.debit_amount=0 and g.credit_amount=bank_money.local_amount end)
         and g.posting_date=jx.journal_date
         and(select count(*)=1 and bool_and(movement.amount=case when bank_leg.normal_debit then bank_money.native_amount else -bank_money.native_amount end)
           from(select bank_movement.amount from bank_transaction bank_movement
             where bank_movement.transaction_id=transfer.transaction_id
               and bank_movement.bank_account_id=bank_leg.bank_account_id and bank_movement.tran_type='TRF_BAN'
             limit 2)movement)
         and(select count(*)=1 from(select 1 from gl_impact peer
           where peer.transaction_id=g.transaction_id and peer.subsidiary_id=g.subsidiary_id
             and peer.accounting_book_id=g.accounting_book_id and peer.account_id=g.account_id
             and peer.debit_amount=g.debit_amount and peer.credit_amount=g.credit_amount limit 2)peers)valid
       from bank_transfer transfer
       join journal transfer_journal on transfer_journal.journal_id=transfer.journal_id
         and transfer_journal.subsidiary_id=g.subsidiary_id
         and transfer_journal.journal_type='Transferencia bancaria'
       left join bank_account source_bank on source_bank.bank_account_id=transfer.from_account_id
       left join bank_account destination_bank on destination_bank.bank_account_id=transfer.to_account_id
       cross join lateral(values
         (source_bank.bank_account_id,source_bank.account_id,source_bank.currency_id,false,
           transfer.source_amount,transfer.source_base_amount,transfer.commission_amount,transfer.source_base_rate),
         (destination_bank.bank_account_id,destination_bank.account_id,destination_bank.currency_id,true,
           transfer.destination_amount,transfer.destination_base_amount,0::numeric,transfer.destination_base_rate)
       )bank_leg(bank_account_id,account_id,currency_id,normal_debit,principal_amount,principal_base_amount,fee_amount,base_rate)
       cross join lateral(select bank_leg.principal_amount+bank_leg.fee_amount native_amount,
         round(bank_leg.principal_base_amount+bank_leg.fee_amount*bank_leg.base_rate,6)local_amount,
         bank_leg.normal_debit<>(jx.journal_id<>transfer.journal_id)is_debit
       )bank_money
       left join currencies transfer_currency on transfer_currency.currency_id=bank_leg.currency_id
       where g.opening_balance_line_id is null and jx.fx_revaluation_run_id is null
         and(jx.journal_type='Transferencia bancaria' or jx.reversed_from_journal_id is not null)
         and jx.subsidiary_id=g.subsidiary_id and jx.transaction_id=g.transaction_id
         and transfer.journal_id=coalesce(jx.reversed_from_journal_id,jx.journal_id)
         and bank_leg.account_id=g.account_id
         and(source_bank.account_id is distinct from destination_bank.account_id
           or(case when bank_money.is_debit then g.debit_amount>0 and g.credit_amount=0
             else g.credit_amount>0 and g.debit_amount=0 end)
           or not((g.debit_amount>0 and g.credit_amount=0)or(g.credit_amount>0 and g.debit_amount=0)))
       limit 2
     )candidate
   )transfer_original on true
   where g.subsidiary_id=any(sids) and g.posting_date between date_from and date_to and (book_id is null or g.accounting_book_id=book_id) and (filter_account_id is null or g.account_id=filter_account_id) and (cardinality(filter_account_ids)=0 or g.account_id=any(filter_account_ids)) and (filter_account_from is null or a.account_number>=filter_account_from) and (filter_account_to is null or a.account_number<=filter_account_to)
   and (filter_entity_type is null or coalesce(line_data.entity_type,case when t.customer_id is not null then 'Cliente' when t.supplier_id is not null then 'Proveedor' end)=filter_entity_type) and (filter_entity_id is null or filter_entity_id in(coalesce(line_data.customer_id,t.customer_id),coalesce(line_data.supplier_id,t.supplier_id),line_data.employee_id)) and (filter_cost_center_id is null or line_data.cost_center_id=filter_cost_center_id)
  ), detail as(select *,opening_balance+sum(signed_movement) over(partition by account_id order by date,id) running_balance,sum(debit) over(partition by account_id) account_debit_total,sum(credit) over(partition by account_id) account_credit_total,opening_balance+sum(signed_movement) over(partition by account_id) account_final_balance,count(*) over() total_count from detail_base), numbered as(select * from detail order by account_number,date,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(numbered)-'total_count'-'signed_movement'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,'summary',jsonb_build_object('debit',coalesce(sum(debit),0),'credit',coalesce(sum(credit),0))) into result from numbered;
 elsif p_report='journal' then
  with detail as (
   select g.gl_impact_id as id,g.posting_date as date,t.tran_number as transaction_number,tt.name as transaction_type,
    a.account_number,a.account_name,s.name as subsidiary,g.debit_amount as debit,g.credit_amount as credit,
    sum(g.debit_amount-g.credit_amount) over(partition by g.account_id,g.subsidiary_id order by g.posting_date,g.gl_impact_id) as balance,
    j.journal_id
   from gl_impact g join chart_accounts a using(account_id) join subsidiaries s using(subsidiary_id)
   join "transaction" t using(transaction_id) join transaction_types tt using(transaction_type_id) left join journal j using(transaction_id)
   where g.subsidiary_id=any(sids) and g.posting_date between date_from and date_to and (book_id is null or g.accounting_book_id=book_id)
   and (filter_account_id is null or g.account_id=filter_account_id)
   and (filter_department_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.department_id=filter_department_id))
   and (filter_location_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.location_id=filter_location_id))
   and (filter_class_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.class_id=filter_class_id))
   and (filter_cost_center_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.cost_center_id=filter_cost_center_id))
  ), numbered as (select *,count(*) over() total_count from detail order by date,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(numbered)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,
   'summary',jsonb_build_object('debit',coalesce(sum(debit),0),'credit',coalesce(sum(credit),0))) into result from numbered;
 elsif p_report='receivables-payables' then
  with detail as (
   select g.gl_impact_id id,g.posting_date date,t.tran_number transaction_number,tt.name transaction_type,a.account_number,a.account_name,s.name subsidiary,
    case when a.category='Activo' then 'Por cobrar' else 'Por pagar' end auxiliary,
    greatest(date_to-g.posting_date,0) age_days,g.debit_amount debit,g.credit_amount credit,(g.debit_amount-g.credit_amount) balance
   from gl_impact g join chart_accounts a using(account_id) join subsidiaries s using(subsidiary_id) join "transaction" t using(transaction_id) join transaction_types tt using(transaction_type_id)
   where g.subsidiary_id=any(sids) and g.posting_date<=date_to and (book_id is null or g.accounting_book_id=book_id) and (lower(a.account_name) like '%cobrar%' or lower(a.account_name) like '%pagar%')
  ), aged as (select *,case when age_days<=30 then '0-30' when age_days<=60 then '31-60' when age_days<=90 then '61-90' else '+90' end age_bucket,count(*) over() total_count from detail order by date desc,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(aged)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,'summary',jsonb_build_object('balance',coalesce(sum(balance),0))) into result from aged;
 elsif p_report='bank-reconciliation' then
  with detail as (
   select g.gl_impact_id id,g.posting_date date,t.tran_number transaction_number,a.account_number,a.account_name,s.name subsidiary,g.debit_amount debit,g.credit_amount credit,(g.debit_amount-g.credit_amount) balance
   from gl_impact g join chart_accounts a using(account_id) join subsidiaries s using(subsidiary_id) join "transaction" t using(transaction_id)
   where g.subsidiary_id=any(sids) and g.posting_date between date_from and date_to and (book_id is null or g.accounting_book_id=book_id) and (lower(a.account_name) like '%banco%' or lower(a.account_name) like '%caja%')
  ), numbered as (select *,count(*) over() total_count from detail order by date desc,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(numbered)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,'summary',jsonb_build_object('balance',coalesce(sum(balance),0))) into result from numbered;
 else
  with balances as (
   select a.account_id,a.account_number,a.account_name,a.account_group_id as group_id,a.cash_flow_activity,coalesce(a.category,ag.category,'Sin clasificar') category,coalesce(a.nature,ag.nature,'Deudora') nature,s.name subsidiary,
    sum(case when g.posting_date<date_from then g.debit_amount-g.credit_amount else 0 end) opening,
    sum(case when g.posting_date between date_from and date_to then g.debit_amount else 0 end) debit,
    sum(case when g.posting_date between date_from and date_to then g.credit_amount else 0 end) credit,
    sum(case when g.posting_date<=date_to then g.debit_amount-g.credit_amount else 0 end) closing
   from gl_impact g join chart_accounts a using(account_id) join account_group ag on ag.group_id=a.account_group_id join subsidiaries s using(subsidiary_id)
   where g.subsidiary_id=any(sids) and (book_id is null or g.accounting_book_id=book_id) and (filter_account_id is null or g.account_id=filter_account_id)
   and (filter_department_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.department_id=filter_department_id))
   and (filter_location_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.location_id=filter_location_id))
   and (filter_class_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.class_id=filter_class_id))
   and (filter_cost_center_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.cost_center_id=filter_cost_center_id))
   group by a.account_id,a.account_number,a.account_name,a.account_group_id,a.cash_flow_activity,a.category,ag.category,a.nature,ag.nature,s.name
  ), eligible as (select * from balances where
   (not exclude_zero or opening<>0 or debit<>0 or credit<>0 or closing<>0) and
   (p_report in('trial-balance','cash-flow') or p_report='balance-sheet' and category in('Activo','Pasivo','Patrimonio') or p_report='income-statement' and category in('Ingreso','Costo','Gasto') or p_report='equity-changes' and category='Patrimonio')
  ), filtered as (select *,count(*) over() total_count from eligible
   order by case category when 'Activo' then 1 when 'Pasivo' then 2 when 'Patrimonio' then 3 when 'Ingreso' then 4 when 'Costo' then 5 when 'Gasto' then 6 else 9 end,account_number limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(filtered)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,
   'summary',jsonb_build_object('opening',coalesce((select sum(opening) from eligible),0),'debit',coalesce((select sum(debit) from eligible),0),'credit',coalesce((select sum(credit) from eligible),0),'closing',coalesce((select sum(closing) from eligible),0),'openingDebtor',coalesce((select sum(greatest(opening,0)) from eligible),0),'openingCreditor',coalesce((select sum(greatest(-opening,0)) from eligible),0),'finalDebtor',coalesce((select sum(greatest(closing,0)) from eligible),0),'finalCreditor',coalesce((select sum(greatest(-closing,0)) from eligible),0),'balanced',abs(coalesce((select sum(debit) from eligible),0)-coalesce((select sum(credit) from eligible),0))<0.005,'resultExercise',coalesce((select sum(rx.credit_amount-rx.debit_amount) from gl_impact rx join chart_accounts ax using(account_id) where rx.subsidiary_id=any(sids) and rx.posting_date<=date_to and (book_id is null or rx.accounting_book_id=book_id) and lower(ax.account_name) like '%resultado del ejercicio%'),0),'currentPeriodResult',coalesce((select sum(case when coalesce(ax.category,gx.category)='Ingreso' then rx.credit_amount-rx.debit_amount when coalesce(ax.category,gx.category) in('Costo','Gasto') then rx.credit_amount-rx.debit_amount else 0 end) from gl_impact rx join chart_accounts ax using(account_id) join account_group gx on gx.group_id=ax.account_group_id where rx.subsidiary_id=any(sids) and rx.posting_date between date_trunc('year',date_to)::date and date_to and (book_id is null or rx.accounting_book_id=book_id)),0),'periodResult',coalesce((select sum(case when coalesce(ax.category,gx.category)='Ingreso' then rx.credit_amount-rx.debit_amount when coalesce(ax.category,gx.category) in('Costo','Gasto') then rx.credit_amount-rx.debit_amount else 0 end) from gl_impact rx join chart_accounts ax using(account_id) join account_group gx on gx.group_id=ax.account_group_id where rx.subsidiary_id=any(sids) and rx.posting_date between date_from and date_to and (book_id is null or rx.accounting_book_id=book_id)),0))) into result from filtered;
 end if;
 return coalesce(result,jsonb_build_object('rows','[]'::jsonb,'total',0,'page',page_no,'pageSize',page_size,'summary','{}'::jsonb));
end$function$
;

-- Source MD5: e3983615e7de9ed565c50ac3d1a7d294
CREATE OR REPLACE FUNCTION report_delivery_private.run_accounting_report(p_report text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
  if p_report='intercompany-commercial'then
    return report_delivery_private.run_intercompany_commercial_report(p_filters);
  end if;
  return report_delivery_private.run_accounting_report_before_intercompany_commercial(
    p_report,p_filters
  );
end
;$function$
;

-- Source MD5: 02148d4531886eff25c8caef8ae569d5
CREATE OR REPLACE FUNCTION report_delivery_private.run_accounting_report_before_intercompany_commercial(p_report text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
begin
  if p_report='intercompany-loans'then
    return report_delivery_private.run_intercompany_loan_report(p_filters);
  end if;
  return report_delivery_private.run_accounting_report_before_intercompany_loans(
    p_report,p_filters
  );
end
$function$
;

-- Source MD5: 63c4bc948586aa92bddacda13a0ff909
CREATE OR REPLACE FUNCTION report_delivery_private.run_accounting_report_before_intercompany_loans(p_report text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
 sids bigint[]; book_id bigint; date_from date; date_to date; page_no int; page_size int; offset_no int;
 hierarchy int; exclude_zero boolean; result jsonb; allowed_count int; requested_count int;
 filter_department_id bigint; filter_location_id bigint; filter_class_id bigint; filter_cost_center_id bigint; filter_account_id bigint; filter_account_from text; filter_account_to text; filter_entity_type text; filter_entity_id bigint; filter_account_ids bigint[];
begin
 if p_report not in ('balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','receivables-payables','bank-reconciliation') then raise exception 'Reporte no válido.'; end if;
 select coalesce(array_agg(value::bigint),array[]::bigint[]) into sids from jsonb_array_elements_text(coalesce(p_filters->'subsidiaryIds','[]'::jsonb));
 if cardinality(sids)=0 then sids:=array[active_subsidiary_id()]; end if;
 if sids[1] is null or exists(select 1 from unnest(sids) selected_id where not exists(select 1 from user_subsidiaries access where access.user_id=app_user_id() and access.subsidiary_id=selected_id)) then raise exception 'No tiene acceso a una o más subsidiarias seleccionadas.'; end if;
 book_id:=nullif(p_filters->>'bookId','')::bigint; date_from:=coalesce(nullif(p_filters->>'dateFrom','')::date,date_trunc('year',current_date)::date); date_to:=coalesce(nullif(p_filters->>'dateTo','')::date,current_date);
 page_no:=greatest(coalesce((p_filters->>'page')::int,1),1); page_size:=least(greatest(coalesce((p_filters->>'pageSize')::int,50),10),500); offset_no:=(page_no-1)*page_size;
 hierarchy:=least(greatest(coalesce((p_filters->>'hierarchy')::int,4),1),4); exclude_zero:=coalesce((p_filters->>'excludeZero')::boolean,true);
 filter_department_id:=nullif(p_filters->>'departmentId','')::bigint; filter_location_id:=nullif(p_filters->>'locationId','')::bigint; filter_class_id:=nullif(p_filters->>'classId','')::bigint; filter_cost_center_id:=nullif(p_filters->>'costCenterId','')::bigint;
 filter_account_id:=nullif(p_filters->>'accountId','')::bigint;
 filter_account_from:=nullif(p_filters->>'accountFrom','');filter_account_to:=nullif(p_filters->>'accountTo','');filter_entity_type:=nullif(p_filters->>'entityType','');filter_entity_id:=nullif(p_filters->>'entityId','')::bigint;
 select coalesce(array_agg(value::bigint),array[]::bigint[]) into filter_account_ids from jsonb_array_elements_text(coalesce(p_filters->'accountIds','[]'::jsonb));

 if p_report='general-ledger' then
  with detail_base as (
   select g.gl_impact_id id,g.account_id,g.posting_date date,t.tran_number transaction_number,tt.code transaction_code,tt.name transaction_type,a.account_number,a.account_name,coalesce(a.nature,ag.nature,'Deudora') nature,s.name subsidiary,g.debit_amount debit,g.credit_amount credit,jx.journal_id,jx.journal_number,
    case when transfer_original.recognized then transfer_original.currency_code else original_currency.currency_code end original_currency_code,
    case when transfer_original.recognized then transfer_original.rate else original_conversion.rate end original_exchange_rate,
    case when transfer_original.recognized then transfer_original.native_debit else g.debit_fx end original_debit,
    case when transfer_original.recognized then transfer_original.native_credit else g.credit_fx end original_credit,
    coalesce(line_data.entity_name,customer.company_name,supplier.company_name,'—') entity_name,coalesce(line_data.entity_type,case when t.customer_id is not null then 'Cliente' when t.supplier_id is not null then 'Proveedor' end,'—') entity_type,coalesce(line_data.cost_center,'—') cost_center,coalesce(line_data.note,jx.memo,tt.name) concept,
    coalesce((select sum(case when coalesce(a.nature,ag.nature)='Acreedora' then previous.credit_amount-previous.debit_amount else previous.debit_amount-previous.credit_amount end) from gl_impact previous where previous.account_id=g.account_id and previous.subsidiary_id=g.subsidiary_id and previous.posting_date<date_from and (book_id is null or previous.accounting_book_id=book_id)),0) opening_balance,
    case when coalesce(a.nature,ag.nature)='Acreedora' then g.credit_amount-g.debit_amount else g.debit_amount-g.credit_amount end signed_movement
   from gl_impact g join chart_accounts a using(account_id) join account_group ag on ag.group_id=a.account_group_id join subsidiaries s using(subsidiary_id) join "transaction" t using(transaction_id) join transaction_types tt using(transaction_type_id) left join journal jx using(transaction_id)
   left join customers customer on customer.customer_id=t.customer_id left join suppliers supplier on supplier.supplier_id=t.supplier_id
   left join lateral(
    -- opening-ledger-entity-resolution-v1: exact trace, then scoped GL-only inference.
    select case when center_customer.customer_id is not null then 'Cliente' else jl.entity_type end entity_type,
      case when center_customer.customer_id is not null then center_customer.company_name
        else coalesce(c.company_name,sp.company_name,concat_ws(' ',e.first_name,e.last_name)) end entity_name,
      cc.code cost_center,jl.note,coalesce(jl.customer_id,center_customer.customer_id) customer_id,
      jl.supplier_id,jl.employee_id,jl.cost_center_id,jl.original_currency_id,jl.historical_exchange_rate,
      case when g.opening_balance_line_id is not null then 1
        when jl.historical_exchange_rate is not null then(select count(*)from(
          select 1 from journal_line rate_candidate
          where rate_candidate.journal_id=jl.journal_id and rate_candidate.account_id=jl.account_id limit 2
        )rate_candidates)end original_line_match_count
    from journal_line jl
    left join customers c using(customer_id)
    left join suppliers sp using(supplier_id)
    left join employees e using(employee_id)
    left join cost_centers cc using(cost_center_id)
    left join opening_balance_lines opening_line
      on opening_line.id=jl.opening_balance_line_id
      and opening_line.id=g.opening_balance_line_id
      and opening_line.source_type='GL'
      and opening_line.account_id=jl.account_id
      and opening_line.cost_center_id=jl.cost_center_id
    left join opening_balance_runs opening_run
      on opening_run.id=opening_line.run_id
      and opening_run.journal_id=jx.journal_id
      and opening_run.subsidiary_id=g.subsidiary_id
      and jx.subsidiary_id=g.subsidiary_id
    left join customers center_customer
      on center_customer.customer_id=cc.customer_id
      and opening_run.id is not null
      and cc.cost_center_type='CLIENTE'
      and cc.subsidiary_id=g.subsidiary_id
      and nullif(btrim(jl.entity_type),'') is null
      and jl.customer_id is null and jl.supplier_id is null and jl.employee_id is null
      and nullif(to_jsonb(jl)->>'financial_creditor_id','') is null
      and nullif(to_jsonb(jl)->>'related_company_id','') is null
      and nullif(to_jsonb(jl)->>'tax_agency_id','') is null
      and nullif(to_jsonb(jl)->>'other_name_id','') is null
      and t.customer_id is null and t.supplier_id is null
      and exists(select 1 from entity_subsidiaries scope
        where scope.customer_id=center_customer.customer_id and scope.subsidiary_id=g.subsidiary_id)
    where jl.journal_id=jx.journal_id and jl.account_id=g.account_id
      and(g.opening_balance_line_id is null or jl.opening_balance_line_id=g.opening_balance_line_id)
    order by jl.journal_line_id limit 1
   ) line_data on true
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
   ) original_conversion on true
   left join lateral(
     -- ledger-transfer-original-v1: distinguish recognition from validation.
     -- An identifiable but inconsistent/ambiguous bank leg returns four NULLs.
     select count(*)>0 recognized,count(*)candidate_count,count(*)filter(where candidate.valid)valid_candidate_count,
       case when count(*)=1 and bool_and(candidate.valid)then max(candidate.currency_code)end currency_code,
       case when count(*)=1 and bool_and(candidate.valid)then max(candidate.base_rate)end rate,
       case when count(*)=1 and bool_and(candidate.valid)then max(case when candidate.is_debit then candidate.native_amount else 0 end)end native_debit,
       case when count(*)=1 and bool_and(candidate.valid)then max(case when candidate.is_debit then 0 else candidate.native_amount end)end native_credit
     from(
       select transfer_currency.currency_code,bank_leg.base_rate,bank_money.is_debit,bank_money.native_amount,
         source_bank.subsidiary_id=g.subsidiary_id and destination_bank.subsidiary_id=g.subsidiary_id
         and transfer.subsidiary_id=g.subsidiary_id and transfer_journal.transaction_id=transfer.transaction_id
         and transfer.from_account_id<>transfer.to_account_id
         and(jx.reversed_from_journal_id is not null or transfer.transaction_id=g.transaction_id)
         and transfer_currency.currency_code is not null
         and bank_leg.principal_amount>0 and bank_leg.principal_amount::text not in('NaN','Infinity','-Infinity')
         and bank_leg.base_rate>0 and bank_leg.base_rate::text not in('NaN','Infinity','-Infinity')
         and bank_leg.principal_base_amount>0 and bank_leg.principal_base_amount::text not in('NaN','Infinity','-Infinity')
         and bank_leg.fee_amount>=0 and bank_leg.fee_amount::text not in('NaN','Infinity','-Infinity')
         and(bank_leg.currency_id<>s.currency_id or bank_leg.base_rate=1)
         and round(bank_leg.principal_amount*bank_leg.base_rate,6)=bank_leg.principal_base_amount
         and(case when bank_money.is_debit then g.credit_amount=0 and g.debit_amount=bank_money.local_amount
           else g.debit_amount=0 and g.credit_amount=bank_money.local_amount end)
         and g.posting_date=jx.journal_date
         and(select count(*)=1 and bool_and(movement.amount=case when bank_leg.normal_debit then bank_money.native_amount else -bank_money.native_amount end)
           from(select bank_movement.amount from bank_transaction bank_movement
             where bank_movement.transaction_id=transfer.transaction_id
               and bank_movement.bank_account_id=bank_leg.bank_account_id and bank_movement.tran_type='TRF_BAN'
             limit 2)movement)
         and(select count(*)=1 from(select 1 from gl_impact peer
           where peer.transaction_id=g.transaction_id and peer.subsidiary_id=g.subsidiary_id
             and peer.accounting_book_id=g.accounting_book_id and peer.account_id=g.account_id
             and peer.debit_amount=g.debit_amount and peer.credit_amount=g.credit_amount limit 2)peers)valid
       from bank_transfer transfer
       join journal transfer_journal on transfer_journal.journal_id=transfer.journal_id
         and transfer_journal.subsidiary_id=g.subsidiary_id
         and transfer_journal.journal_type='Transferencia bancaria'
       left join bank_account source_bank on source_bank.bank_account_id=transfer.from_account_id
       left join bank_account destination_bank on destination_bank.bank_account_id=transfer.to_account_id
       cross join lateral(values
         (source_bank.bank_account_id,source_bank.account_id,source_bank.currency_id,false,
           transfer.source_amount,transfer.source_base_amount,transfer.commission_amount,transfer.source_base_rate),
         (destination_bank.bank_account_id,destination_bank.account_id,destination_bank.currency_id,true,
           transfer.destination_amount,transfer.destination_base_amount,0::numeric,transfer.destination_base_rate)
       )bank_leg(bank_account_id,account_id,currency_id,normal_debit,principal_amount,principal_base_amount,fee_amount,base_rate)
       cross join lateral(select bank_leg.principal_amount+bank_leg.fee_amount native_amount,
         round(bank_leg.principal_base_amount+bank_leg.fee_amount*bank_leg.base_rate,6)local_amount,
         bank_leg.normal_debit<>(jx.journal_id<>transfer.journal_id)is_debit
       )bank_money
       left join currencies transfer_currency on transfer_currency.currency_id=bank_leg.currency_id
       where g.opening_balance_line_id is null and jx.fx_revaluation_run_id is null
         and(jx.journal_type='Transferencia bancaria' or jx.reversed_from_journal_id is not null)
         and jx.subsidiary_id=g.subsidiary_id and jx.transaction_id=g.transaction_id
         and transfer.journal_id=coalesce(jx.reversed_from_journal_id,jx.journal_id)
         and bank_leg.account_id=g.account_id
         and(source_bank.account_id is distinct from destination_bank.account_id
           or(case when bank_money.is_debit then g.debit_amount>0 and g.credit_amount=0
             else g.credit_amount>0 and g.debit_amount=0 end)
           or not((g.debit_amount>0 and g.credit_amount=0)or(g.credit_amount>0 and g.debit_amount=0)))
       limit 2
     )candidate
   )transfer_original on true
   where g.subsidiary_id=any(sids) and g.posting_date between date_from and date_to and (book_id is null or g.accounting_book_id=book_id) and (filter_account_id is null or g.account_id=filter_account_id) and (cardinality(filter_account_ids)=0 or g.account_id=any(filter_account_ids)) and (filter_account_from is null or a.account_number>=filter_account_from) and (filter_account_to is null or a.account_number<=filter_account_to)
   and (filter_entity_type is null or coalesce(line_data.entity_type,case when t.customer_id is not null then 'Cliente' when t.supplier_id is not null then 'Proveedor' end)=filter_entity_type) and (filter_entity_id is null or filter_entity_id in(coalesce(line_data.customer_id,t.customer_id),coalesce(line_data.supplier_id,t.supplier_id),line_data.employee_id)) and (filter_cost_center_id is null or line_data.cost_center_id=filter_cost_center_id)
  ), detail as(select *,opening_balance+sum(signed_movement) over(partition by account_id order by date,id) running_balance,sum(debit) over(partition by account_id) account_debit_total,sum(credit) over(partition by account_id) account_credit_total,opening_balance+sum(signed_movement) over(partition by account_id) account_final_balance,count(*) over() total_count from detail_base), numbered as(select * from detail order by account_number,date,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(numbered)-'total_count'-'signed_movement'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,'summary',jsonb_build_object('debit',coalesce(sum(debit),0),'credit',coalesce(sum(credit),0))) into result from numbered;
 elsif p_report='journal' then
  with detail as (
   select g.gl_impact_id as id,g.posting_date as date,t.tran_number as transaction_number,tt.name as transaction_type,
    a.account_number,a.account_name,s.name as subsidiary,g.debit_amount as debit,g.credit_amount as credit,
    sum(g.debit_amount-g.credit_amount) over(partition by g.account_id,g.subsidiary_id order by g.posting_date,g.gl_impact_id) as balance,
    j.journal_id
   from gl_impact g join chart_accounts a using(account_id) join subsidiaries s using(subsidiary_id)
   join "transaction" t using(transaction_id) join transaction_types tt using(transaction_type_id) left join journal j using(transaction_id)
   where g.subsidiary_id=any(sids) and g.posting_date between date_from and date_to and (book_id is null or g.accounting_book_id=book_id)
   and (filter_account_id is null or g.account_id=filter_account_id)
   and (filter_department_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.department_id=filter_department_id))
   and (filter_location_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.location_id=filter_location_id))
   and (filter_class_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.class_id=filter_class_id))
   and (filter_cost_center_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.cost_center_id=filter_cost_center_id))
  ), numbered as (select *,count(*) over() total_count from detail order by date,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(numbered)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,
   'summary',jsonb_build_object('debit',coalesce(sum(debit),0),'credit',coalesce(sum(credit),0))) into result from numbered;
 elsif p_report='receivables-payables' then
  with detail as (
   select g.gl_impact_id id,g.posting_date date,t.tran_number transaction_number,tt.name transaction_type,a.account_number,a.account_name,s.name subsidiary,
    case when a.category='Activo' then 'Por cobrar' else 'Por pagar' end auxiliary,
    greatest(date_to-g.posting_date,0) age_days,g.debit_amount debit,g.credit_amount credit,(g.debit_amount-g.credit_amount) balance
   from gl_impact g join chart_accounts a using(account_id) join subsidiaries s using(subsidiary_id) join "transaction" t using(transaction_id) join transaction_types tt using(transaction_type_id)
   where g.subsidiary_id=any(sids) and g.posting_date<=date_to and (book_id is null or g.accounting_book_id=book_id) and (lower(a.account_name) like '%cobrar%' or lower(a.account_name) like '%pagar%')
  ), aged as (select *,case when age_days<=30 then '0-30' when age_days<=60 then '31-60' when age_days<=90 then '61-90' else '+90' end age_bucket,count(*) over() total_count from detail order by date desc,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(aged)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,'summary',jsonb_build_object('balance',coalesce(sum(balance),0))) into result from aged;
 elsif p_report='bank-reconciliation' then
  with detail as (
   select g.gl_impact_id id,g.posting_date date,t.tran_number transaction_number,a.account_number,a.account_name,s.name subsidiary,g.debit_amount debit,g.credit_amount credit,(g.debit_amount-g.credit_amount) balance
   from gl_impact g join chart_accounts a using(account_id) join subsidiaries s using(subsidiary_id) join "transaction" t using(transaction_id)
   where g.subsidiary_id=any(sids) and g.posting_date between date_from and date_to and (book_id is null or g.accounting_book_id=book_id) and (lower(a.account_name) like '%banco%' or lower(a.account_name) like '%caja%')
  ), numbered as (select *,count(*) over() total_count from detail order by date desc,id limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(numbered)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,'summary',jsonb_build_object('balance',coalesce(sum(balance),0))) into result from numbered;
 else
  with balances as (
   select a.account_id,a.account_number,a.account_name,a.account_group_id as group_id,a.cash_flow_activity,coalesce(a.category,ag.category,'Sin clasificar') category,coalesce(a.nature,ag.nature,'Deudora') nature,s.name subsidiary,
    sum(case when g.posting_date<date_from then g.debit_amount-g.credit_amount else 0 end) opening,
    sum(case when g.posting_date between date_from and date_to then g.debit_amount else 0 end) debit,
    sum(case when g.posting_date between date_from and date_to then g.credit_amount else 0 end) credit,
    sum(case when g.posting_date<=date_to then g.debit_amount-g.credit_amount else 0 end) closing
   from gl_impact g join chart_accounts a using(account_id) join account_group ag on ag.group_id=a.account_group_id join subsidiaries s using(subsidiary_id)
   where g.subsidiary_id=any(sids) and (book_id is null or g.accounting_book_id=book_id) and (filter_account_id is null or g.account_id=filter_account_id)
   and (filter_department_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.department_id=filter_department_id))
   and (filter_location_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.location_id=filter_location_id))
   and (filter_class_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.class_id=filter_class_id))
   and (filter_cost_center_id is null or exists(select 1 from journal jx join journal_line lx using(journal_id) where jx.transaction_id=g.transaction_id and lx.account_id=g.account_id and lx.cost_center_id=filter_cost_center_id))
   group by a.account_id,a.account_number,a.account_name,a.account_group_id,a.cash_flow_activity,a.category,ag.category,a.nature,ag.nature,s.name
  ), eligible as (select * from balances where
   (not exclude_zero or opening<>0 or debit<>0 or credit<>0 or closing<>0) and
   (p_report in('trial-balance','cash-flow') or p_report='balance-sheet' and category in('Activo','Pasivo','Patrimonio') or p_report='income-statement' and category in('Ingreso','Costo','Gasto') or p_report='equity-changes' and category='Patrimonio')
  ), filtered as (select *,count(*) over() total_count from eligible
   order by case category when 'Activo' then 1 when 'Pasivo' then 2 when 'Patrimonio' then 3 when 'Ingreso' then 4 when 'Costo' then 5 when 'Gasto' then 6 else 9 end,account_number limit page_size offset offset_no)
  select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(filtered)-'total_count'),'[]'::jsonb),'total',coalesce(max(total_count),0),'page',page_no,'pageSize',page_size,
   'summary',jsonb_build_object('opening',coalesce((select sum(opening) from eligible),0),'debit',coalesce((select sum(debit) from eligible),0),'credit',coalesce((select sum(credit) from eligible),0),'closing',coalesce((select sum(closing) from eligible),0),'openingDebtor',coalesce((select sum(greatest(opening,0)) from eligible),0),'openingCreditor',coalesce((select sum(greatest(-opening,0)) from eligible),0),'finalDebtor',coalesce((select sum(greatest(closing,0)) from eligible),0),'finalCreditor',coalesce((select sum(greatest(-closing,0)) from eligible),0),'balanced',abs(coalesce((select sum(debit) from eligible),0)-coalesce((select sum(credit) from eligible),0))<0.005,'resultExercise',coalesce((select sum(rx.credit_amount-rx.debit_amount) from gl_impact rx join chart_accounts ax using(account_id) where rx.subsidiary_id=any(sids) and rx.posting_date<=date_to and (book_id is null or rx.accounting_book_id=book_id) and lower(ax.account_name) like '%resultado del ejercicio%'),0),'currentPeriodResult',coalesce((select sum(case when coalesce(ax.category,gx.category)='Ingreso' then rx.credit_amount-rx.debit_amount when coalesce(ax.category,gx.category) in('Costo','Gasto') then rx.credit_amount-rx.debit_amount else 0 end) from gl_impact rx join chart_accounts ax using(account_id) join account_group gx on gx.group_id=ax.account_group_id where rx.subsidiary_id=any(sids) and rx.posting_date between date_trunc('year',date_to)::date and date_to and (book_id is null or rx.accounting_book_id=book_id)),0),'periodResult',coalesce((select sum(case when coalesce(ax.category,gx.category)='Ingreso' then rx.credit_amount-rx.debit_amount when coalesce(ax.category,gx.category) in('Costo','Gasto') then rx.credit_amount-rx.debit_amount else 0 end) from gl_impact rx join chart_accounts ax using(account_id) join account_group gx on gx.group_id=ax.account_group_id where rx.subsidiary_id=any(sids) and rx.posting_date between date_from and date_to and (book_id is null or rx.accounting_book_id=book_id)),0))) into result from filtered;
 end if;
 return coalesce(result,jsonb_build_object('rows','[]'::jsonb,'total',0,'page',page_no,'pageSize',page_size,'summary','{}'::jsonb));
end$function$
;

-- Source MD5: 91fc047935f066b30e29a30452fed82b
CREATE OR REPLACE FUNCTION report_template_private.enter(resource text, action text DEFAULT 'view'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare sid bigint:=public.active_subsidiary_id();uid bigint:=public.app_user_id();rid bigint:=public.app_active_role_id();
begin
 if auth.uid() is null or uid is null or rid is null or sid is null
  or not exists(select 1 from public.users where user_id=uid and is_active)
  or not exists(select 1 from public.user_roles where user_id=uid and role_id=rid)
  or not exists(select 1 from public.user_subsidiaries where user_id=uid and subsidiary_id=sid)
 then raise exception using errcode='42501',message='Seleccione usuario, rol y subsidiaria autorizados.';end if;
 perform public.security_assert_role_access(resource,'view');
 if action<>'view' then perform public.security_assert_role_access(resource,action);end if;
 return sid;
end$function$
;
