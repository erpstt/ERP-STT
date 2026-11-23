CREATE OR REPLACE FUNCTION public.run_pending_invoice_control_report_before_consolidation(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      'cost_center',case when b.source_type='JOURNAL' then (
        select string_agg(distinct cc.name,'; ' order by cc.name)
        from public.journal_line l join public.cost_centers cc using(cost_center_id)
        join public.journal source on source.journal_id=l.journal_id and source.subsidiary_id=cc.subsidiary_id
        where l.journal_id=b.source_id
      ) else (
        select string_agg(distinct nullif(btrim(line->>'costCenter'),''),'; ' order by nullif(btrim(line->>'costCenter'),''))
        from public.opening_pending_invoice_items item
        cross join lateral jsonb_array_elements(case when jsonb_typeof(item.raw_data->'lines')='array' then item.raw_data->'lines' else '[]'::jsonb end) line
        where item.id=b.source_id
      ) end,
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
$function$
;

