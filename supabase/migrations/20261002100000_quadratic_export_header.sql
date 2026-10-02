-- Enriquece el encabezado para las exportaciones profesionales PDF y Excel.
create or replace function public.quadratic_reconciliation_get(p_reconciliation_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.quadratic_bank_reconciliations%rowtype;matrix jsonb;continuity jsonb;d1 date;d2 date;statement_key bigint;
begin
 select * into r from public.quadratic_bank_reconciliations where reconciliation_id=p_reconciliation_id;
 if r.reconciliation_id is null or not public.quadratic_can(r.subsidiary_id,'BANK_QUADRATIC_VIEW')then raise exception using errcode='42501',message='Conciliacion cuadratica no encontrada o no autorizada.';end if;
 d1:=make_date(r.period_year,r.period_month,1);d2:=(d1+interval'1 month')::date;
 select statement_id into statement_key from public.bank_statement where bank_account_id=r.bank_account_id and statement_date>=d1 and statement_date<d2 order by statement_date desc,statement_id desc limit 1;
 matrix:=public.quadratic_matrix_core(r.reconciliation_id);continuity:=public.quadratic_continuity(r.reconciliation_id);matrix:=matrix||jsonb_build_object('continuity',continuity);
 return jsonb_build_object(
  'header',(select jsonb_build_object('id',r.reconciliation_id,'subsidiaryId',r.subsidiary_id,'subsidiaryName',s.name,
   'subsidiaryLegalName',coalesce(nullif(s.legal_name,''),s.name),'taxId',s.tax_id,'logoUrl',s.logo_url,
   'bankAccountId',r.bank_account_id,'accountNumber',b.account_number,'bankAccountNumber',b.account_number,'bankName',bk.bank_name,
   'ledgerAccountNumber',ca.account_number,'ledgerAccountName',ca.account_name,'currencyCode',c.currency_code,'currencySymbol',c.symbol,
   'periodYear',r.period_year,'periodMonth',r.period_month,'bankStartBalance',r.bank_start_balance,'bankTotalReceipts',r.bank_total_receipts,
   'bankTotalDisbursements',r.bank_total_disbursements,'bankEndBalance',r.bank_end_balance,'status',r.status,'notes',r.notes,
   'createdBy',r.created_by,'reconciledBy',r.reconciled_by,'approvedBy',r.approved_by,'closedBy',r.closed_by,
   'reconciledByName',(select coalesce(nullif(concat_ws(' ',u.first_name,u.last_name),''),u.email)from public.users u where u.user_id=r.reconciled_by),
   'approvedByName',(select coalesce(nullif(concat_ws(' ',u.first_name,u.last_name),''),u.email)from public.users u where u.user_id=r.approved_by),
   'closedByName',(select coalesce(nullif(concat_ws(' ',u.first_name,u.last_name),''),u.email)from public.users u where u.user_id=r.closed_by),
   'approvedAt',r.approved_at,'closedAt',r.closed_at,'createdAt',r.created_at,'updatedAt',r.updated_at)
   from public.bank_account b join public.banks bk using(bank_id)join public.currencies c using(currency_id)join public.chart_accounts ca using(account_id)
   join public.subsidiaries s on s.subsidiary_id=r.subsidiary_id where b.bank_account_id=r.bank_account_id),
  'matrix',matrix,'continuity',continuity,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.item_id,'itemType',i.item_type,'adjustmentSide',i.adjustment_side,
   'sourceKind',i.source_kind,'description',i.description,'referenceNumber',i.reference_number,'transactionDate',i.transaction_date,
   'amount',i.amount,'impactStartBalance',i.impact_start_balance,'impactReceipts',i.impact_receipts,
   'impactDisbursements',i.impact_disbursements,'impactEndBalance',i.impact_end_balance,'bankTransactionId',i.bank_tran_id,
   'statementLineId',i.statement_line_id,'originItemId',i.origin_item_id)order by i.transaction_date,i.item_id)
   from public.quadratic_reconciliation_items i where i.reconciliation_id=r.reconciliation_id),'[]'::jsonb),
  'matches',coalesce((select jsonb_agg(jsonb_build_object('id',m.match_id,'bankTransactionId',m.bank_tran_id,
   'statementLineId',m.statement_line_id,'matchType',m.match_type,'matchedBy',m.matched_by,'matchedAt',m.matched_at)
   order by m.matched_at,m.match_id)from public.quadratic_reconciliation_matches m where m.reconciliation_id=r.reconciliation_id),'[]'::jsonb),
  'statementLines',coalesce((select jsonb_agg(jsonb_build_object('id',l.statement_line_id,'date',l.bank_date,'valueDate',l.value_date,
   'reference',l.reference,'description',l.description,'beneficiary',l.beneficiary,'amount',l.amount,'matchId',m.match_id)
   order by l.bank_date,l.statement_line_id)from public.bank_statement_line l left join public.quadratic_reconciliation_matches m
   on m.reconciliation_id=r.reconciliation_id and m.statement_line_id=l.statement_line_id where l.statement_id=statement_key),'[]'::jsonb),
  'bookTransactions',coalesce((select jsonb_agg(jsonb_build_object('id',b.bank_tran_id,'date',b.tran_date,'valueDate',b.value_date,
   'reference',b.reference_number,'description',b.description,'beneficiary',b.beneficiary,'amount',b.amount,'matchId',m.match_id)
   order by b.tran_date,b.bank_tran_id)from public.bank_transaction b left join public.quadratic_reconciliation_matches m
   on m.reconciliation_id=r.reconciliation_id and m.bank_tran_id=b.bank_tran_id
   where b.bank_account_id=r.bank_account_id and b.tran_date>=d1 and b.tran_date<d2),'[]'::jsonb),
  'history',coalesce((select jsonb_agg(jsonb_build_object('id',h.history_id,'priorStatus',h.prior_status,'newStatus',h.new_status,
   'changedBy',h.changed_by,'details',h.details,'changedAt',h.changed_at)order by h.changed_at,h.history_id)
   from public.quadratic_reconciliation_history h where h.reconciliation_id=r.reconciliation_id),'[]'::jsonb),
  'permissions',jsonb_build_object('manage',public.quadratic_has_permission('BANK_QUADRATIC_MANAGE'),'approve',public.quadratic_has_permission('BANK_QUADRATIC_APPROVE'))
 );
end$$;

revoke all on function public.quadratic_reconciliation_get(bigint) from public,anon,authenticated;
grant execute on function public.quadratic_reconciliation_get(bigint) to authenticated;
