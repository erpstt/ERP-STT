create index if not exists supplier_payment_application_settlement_idx
  on public.supplier_payment_application(invoice_id,application_date,payment_id);
create index if not exists supplier_credit_note_settlement_idx
  on public.supplier_credit_note(invoice_id,note_date,cn_id);
create index if not exists supplier_debit_note_settlement_idx
  on public.supplier_debit_note(invoice_id,note_date,dn_id);

create or replace function public.settled_supplier_invoice_report_options()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
select jsonb_build_object(
  'subsidiary',jsonb_build_object(
    'id',s.subsidiary_id,'name',s.name,'legalName',s.legal_name,'taxId',s.tax_id,
    'logoUrl',s.logo_url,'currencyId',s.currency_id,'currency',cu.currency_code,
    'currencyName',cu.name,'symbol',cu.symbol
  ),
  'suppliers',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',p.supplier_id,'name',p.company_name,'taxId',p.tax_id
    )order by p.company_name,p.supplier_id)
    from suppliers p
    where p.primary_subsidiary_id=s.subsidiary_id or exists(
      select 1 from entity_subsidiaries es
      where es.supplier_id=p.supplier_id and es.subsidiary_id=s.subsidiary_id
    )
  ),'[]'::jsonb)
)
from subsidiaries s join currencies cu using(currency_id)
where s.subsidiary_id=active_subsidiary_id()
  and exists(
    select 1 from user_subsidiaries u
    where u.user_id=app_user_id() and u.subsidiary_id=s.subsidiary_id
  )
$$;

create or replace function public.run_settled_supplier_invoice_report(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
  sid bigint:=active_subsidiary_id();
  month_value text:=coalesce(nullif(p_filters->>'periodMonth',''),to_char(current_date,'YYYY-MM'));
  start_date date;
  end_date date;
  supplier_ids bigint[]:=array(select value::bigint from jsonb_array_elements_text(coalesce(p_filters->'supplierIds','[]'::jsonb)));
  settlement_filter text:=coalesce(nullif(p_filters->>'settlementType',''),'ALL');
  group_results boolean:=coalesce((p_filters->>'groupBySettlementType')::boolean,true);
  export_all boolean:=coalesce((p_filters->>'export')::boolean,false);
  page_number integer:=greatest(coalesce((p_filters->>'page')::integer,1),1);
  page_size integer:=least(greatest(coalesce((p_filters->>'pageSize')::integer,50),10),250);
  result jsonb;
begin
  if month_value!~'^[0-9]{4}-(0[1-9]|1[0-2])$'then raise exception 'Seleccione un mes de liquidación válido.';end if;
  if settlement_filter not in('ALL','CASH_PAYMENTS_ONLY','CREDIT_NOTES_ONLY')then raise exception 'El tipo de liquidación seleccionado no es válido.';end if;
  if sid is null or not exists(select 1 from user_subsidiaries where user_id=app_user_id()and subsidiary_id=sid)then raise exception 'No tiene acceso a la subsidiaria activa.';end if;
  if exists(
    select 1 from unnest(supplier_ids)x
    where not exists(select 1 from suppliers p where p.supplier_id=x and p.primary_subsidiary_id=sid)
      and not exists(
      select 1 from entity_subsidiaries es
      where es.supplier_id=x and es.subsidiary_id=sid
    )
  )then raise exception 'Uno de los proveedores seleccionados no pertenece a la subsidiaria activa.';end if;
  start_date:=to_date(month_value||'-01','YYYY-MM-DD');
  end_date:=(start_date+interval'1 month'-interval'1 day')::date;

  with invoice_base as(
    select i.invoice_id,i.invoice_number,i.supplier_id,i.subsidiary_id,
      coalesce(i.invoice_date,t.tran_date)issue_date,i.due_date,i.total_amount,
      case when i.payable_amount=0 and coalesce(i.withholding_total,0)=0 and i.total_amount<>0
        then i.total_amount else i.payable_amount end base_due,
      coalesce(i.exchange_rate,t.exchange_rate,1)exchange_rate,
      coalesce(i.currency_id,t.currency_id)currency_id,cu.currency_code,cu.symbol,
      p.company_name supplier_name,p.tax_id supplier_tax_id,
      greatest(i.total_amount-(case when i.payable_amount=0 and coalesce(i.withholding_total,0)=0 and i.total_amount<>0
        then i.total_amount else i.payable_amount end),0)invoice_withholding_amount
    from supplier_invoice i join "transaction"t using(transaction_id)
    join suppliers p on p.supplier_id=i.supplier_id
    join currencies cu on cu.currency_id=coalesce(i.currency_id,t.currency_id)
    left join status invoice_status on invoice_status.status_id=t.status_id
    where i.subsidiary_id=sid
      and upper(coalesce(invoice_status.code,'APROBADO'))not in('ANULADO','CANCELADO')
  ),payment_sources as(
    select a.invoice_id,a.application_date,p.payment_id,p.payment_number,p.bank_reference,
      b.bank_name method,a.amount,coalesce(p.exchange_rate,1)exchange_rate,
      ib.exchange_rate invoice_exchange_rate,
      coalesce(p.currency_id,pt.currency_id)payment_currency_id,ib.currency_id invoice_currency_id,
      least(coalesce(withholding.withholding_amount,0),a.amount)withholding_amount,
      greatest(a.amount-least(coalesce(withholding.withholding_amount,0),a.amount),0)funding_need,
      coalesce(payment_total.net_funding_amount,0)net_funding_amount,
      coalesce(bank.cash_amount,0)payment_cash_amount,
      coalesce(advance.advance_amount,0)payment_advance_amount,
      case
        when coalesce(bank.cash_amount,0)+coalesce(advance.advance_amount,0)<=0 then 0
        else least(1,coalesce(payment_total.net_funding_amount,0)
          /nullif(coalesce(bank.cash_amount,0)+coalesce(advance.advance_amount,0),0))
      end funding_scale
    from supplier_payment_application a join invoice_base ib using(invoice_id)
    join supplier_payment p using(payment_id)
    join "transaction"pt on pt.transaction_id=p.transaction_id
    left join status payment_status on payment_status.status_id=pt.status_id
    left join bank_account ba using(bank_account_id)left join banks b using(bank_id)
    left join lateral(
      select sum(greatest(pa.amount-least(coalesce(paw.withholding_amount,0),pa.amount),0))net_funding_amount
      from supplier_payment_application pa
      left join lateral(
        select sum(pwi.withholding_amount)withholding_amount
        from supplier_payment_withholding pwi
        where pwi.payment_id=p.payment_id and pwi.invoice_id=pa.invoice_id
      )paw on true
      where pa.payment_id=p.payment_id
    )payment_total on true
    left join lateral(select sum(abs(bt.amount))cash_amount from bank_transaction bt where bt.transaction_id=p.transaction_id)bank on true
    left join lateral(select sum(caa.amount)advance_amount from supplier_advance_application caa where caa.payment_id=p.payment_id)advance on true
    left join lateral(select sum(cpw.withholding_amount)withholding_amount from supplier_payment_withholding cpw where cpw.payment_id=p.payment_id and cpw.invoice_id=a.invoice_id)withholding on true
    where upper(coalesce(p.status,'APROBADO'))not in('ANULADO','CANCELADO')
      and upper(coalesce(payment_status.code,'APROBADO'))not in('ANULADO','CANCELADO')
  ),payment_events as(
    select p.invoice_id,p.application_date event_date,1 sort_order,'PAYMENT'::text event_type,
      'Pago a proveedor'::text type_label,p.payment_number reference,p.bank_reference secondary_reference,
      p.method,
      case when p.payment_currency_id is null or p.payment_currency_id=p.invoice_currency_id then p.amount
        else p.amount*p.exchange_rate/nullif(p.invoice_exchange_rate,0) end reduction,0::numeric addition,
      p.amount*p.exchange_rate local_reduction,0::numeric local_addition,
      coalesce(p.payment_cash_amount*p.funding_scale*p.funding_need/nullif(p.net_funding_amount,0),0)
        *case when p.payment_currency_id is null or p.payment_currency_id=p.invoice_currency_id then 1
          else p.exchange_rate/nullif(p.invoice_exchange_rate,0) end cash_amount,
      coalesce(p.payment_cash_amount*p.funding_scale*p.funding_need/nullif(p.net_funding_amount,0),0)*p.exchange_rate local_cash_amount,
      coalesce(p.payment_advance_amount*p.funding_scale*p.funding_need/nullif(p.net_funding_amount,0),0)
        *case when p.payment_currency_id is null or p.payment_currency_id=p.invoice_currency_id then 1
          else p.exchange_rate/nullif(p.invoice_exchange_rate,0) end advance_amount,
      coalesce(p.payment_advance_amount*p.funding_scale*p.funding_need/nullif(p.net_funding_amount,0),0)*p.exchange_rate local_advance_amount,
      p.withholding_amount*case when p.payment_currency_id is null or p.payment_currency_id=p.invoice_currency_id then 1
        else p.exchange_rate/nullif(p.invoice_exchange_rate,0) end withholding_amount,
      p.withholding_amount*p.exchange_rate local_withholding_amount,
      greatest(p.funding_need
        -coalesce((p.payment_cash_amount+p.payment_advance_amount)*p.funding_scale*p.funding_need/nullif(p.net_funding_amount,0),0),0)
        *case when p.payment_currency_id is null or p.payment_currency_id=p.invoice_currency_id then 1
          else p.exchange_rate/nullif(p.invoice_exchange_rate,0) end other_funding_amount,
      greatest(p.funding_need
        -coalesce((p.payment_cash_amount+p.payment_advance_amount)*p.funding_scale*p.funding_need/nullif(p.net_funding_amount,0),0),0)*p.exchange_rate local_other_funding_amount
    from payment_sources p
  ),credit_events as(
    select n.invoice_id,coalesce(n.note_date,nt.tran_date)event_date,2 sort_order,'CREDIT_NOTE'::text event_type,
      'Nota de Crédito'::text type_label,n.cn_number reference,null::text secondary_reference,
      'Compensación'::text method,
      case when coalesce(n.currency_id,nt.currency_id) is null or coalesce(n.currency_id,nt.currency_id)=ib.currency_id then n.amount
        else n.amount*coalesce(n.exchange_rate,nt.exchange_rate,1)/nullif(ib.exchange_rate,0) end reduction,0::numeric addition,
      n.amount*coalesce(n.exchange_rate,nt.exchange_rate,ib.exchange_rate,1)local_reduction,
      0::numeric local_addition,0::numeric cash_amount,0::numeric local_cash_amount,
      0::numeric advance_amount,0::numeric local_advance_amount,
      0::numeric withholding_amount,0::numeric local_withholding_amount,
      0::numeric other_funding_amount,0::numeric local_other_funding_amount
    from supplier_credit_note n join invoice_base ib using(invoice_id)
    join "transaction"nt on nt.transaction_id=n.transaction_id
    left join status note_status on note_status.status_id=nt.status_id
    where upper(coalesce(note_status.code,'APROBADO'))not in('ANULADO','CANCELADO')
  ),debit_events as(
    select n.invoice_id,coalesce(n.note_date,nt.tran_date)event_date,3 sort_order,'DEBIT_NOTE'::text event_type,
      'Nota de Débito'::text type_label,n.dn_number reference,null::text secondary_reference,
      'Reapertura de saldo'::text method,0::numeric reduction,
      case when coalesce(n.currency_id,nt.currency_id) is null or coalesce(n.currency_id,nt.currency_id)=ib.currency_id then n.amount
        else n.amount*coalesce(n.exchange_rate,nt.exchange_rate,1)/nullif(ib.exchange_rate,0) end addition,
      0::numeric local_reduction,n.amount*coalesce(n.exchange_rate,nt.exchange_rate,ib.exchange_rate,1)local_addition,
      0::numeric cash_amount,0::numeric local_cash_amount,
      0::numeric advance_amount,0::numeric local_advance_amount,
      0::numeric withholding_amount,0::numeric local_withholding_amount,
      0::numeric other_funding_amount,0::numeric local_other_funding_amount
    from supplier_debit_note n join invoice_base ib using(invoice_id)
    join "transaction"nt on nt.transaction_id=n.transaction_id
    left join status note_status on note_status.status_id=nt.status_id
    where upper(coalesce(note_status.code,'APROBADO'))not in('ANULADO','CANCELADO')
  ),events as(
    select * from payment_events union all select * from credit_events union all select * from debit_events
  ),day_events as(
    select invoice_id,event_date,sum(addition-reduction)delta
    from events where event_date is not null group by invoice_id,event_date
  ),running as(
    select d.invoice_id,d.event_date,
      b.base_due+coalesce(sum(d.delta)over(partition by d.invoice_id order by d.event_date rows between unbounded preceding and 1 preceding),0)balance_before,
      b.base_due+sum(d.delta)over(partition by d.invoice_id order by d.event_date rows unbounded preceding)balance_after
    from day_events d join invoice_base b using(invoice_id)
  ),current_state as(
    select b.invoice_id,b.base_due+coalesce(sum(e.addition-e.reduction),0)raw_balance
    from invoice_base b left join events e using(invoice_id) group by b.invoice_id,b.base_due
  ),final_close as(
    select distinct on(r.invoice_id)r.invoice_id,r.event_date settlement_date
    from running r join current_state s using(invoice_id)
    where s.raw_balance<=.005 and r.balance_before>.005 and r.balance_after<=.005
    order by r.invoice_id,r.event_date desc
  ),event_totals as(
    select e.invoice_id,
      coalesce(sum(e.reduction)filter(where e.event_type='PAYMENT'),0)payment_amount,
      coalesce(sum(e.reduction)filter(where e.event_type='CREDIT_NOTE'),0)credit_amount,
      coalesce(sum(e.addition)filter(where e.event_type='DEBIT_NOTE'),0)debit_amount,
      coalesce(sum(e.local_reduction)filter(where e.event_type='PAYMENT'),0)local_payment_amount,
      coalesce(sum(e.local_reduction)filter(where e.event_type='CREDIT_NOTE'),0)local_credit_amount,
      coalesce(sum(e.local_addition)filter(where e.event_type='DEBIT_NOTE'),0)local_debit_amount,
      coalesce(sum(e.cash_amount)filter(where e.event_type='PAYMENT'),0)cash_amount,
      coalesce(sum(e.local_cash_amount)filter(where e.event_type='PAYMENT'),0)local_cash_amount,
      coalesce(sum(e.advance_amount)filter(where e.event_type='PAYMENT'),0)advance_amount,
      coalesce(sum(e.local_advance_amount)filter(where e.event_type='PAYMENT'),0)local_advance_amount,
      coalesce(sum(e.withholding_amount)filter(where e.event_type='PAYMENT'),0)withholding_amount,
      coalesce(sum(e.local_withholding_amount)filter(where e.event_type='PAYMENT'),0)local_withholding_amount,
      coalesce(sum(e.other_funding_amount)filter(where e.event_type='PAYMENT'),0)other_funding_amount,
      coalesce(sum(e.local_other_funding_amount)filter(where e.event_type='PAYMENT'),0)local_other_funding_amount,
      bool_or(e.event_type='PAYMENT')has_payment,bool_or(e.event_type='CREDIT_NOTE')has_credit,
      coalesce(string_agg(e.reference,' · 'order by e.event_date,e.sort_order,e.reference)
        filter(where e.event_type in('PAYMENT','CREDIT_NOTE')),'—')settlement_references,
      coalesce(jsonb_agg(jsonb_build_object(
        'date',e.event_date,'type',e.event_type,'typeLabel',e.type_label,
        'reference',e.reference,'secondaryReference',e.secondary_reference,
        'method',e.method,'amount',case when e.event_type='DEBIT_NOTE'then-e.addition else e.reduction end,
        'cashAmount',e.cash_amount,'advanceAmount',e.advance_amount,
        'withholdingAmount',e.withholding_amount,'otherFundingAmount',e.other_funding_amount
      )order by e.event_date,e.sort_order,e.reference),'[]'::jsonb)applications
    from events e group by e.invoice_id
  ),settled as(
    select b.*,f.settlement_date,s.raw_balance,greatest(s.raw_balance,0)balance_due,
      greatest(-s.raw_balance,0)overapplied_amount,
      e.payment_amount,e.credit_amount,e.debit_amount,e.local_payment_amount,e.local_credit_amount,e.local_debit_amount,
      e.cash_amount,e.local_cash_amount,e.advance_amount,e.local_advance_amount,
      e.withholding_amount,e.local_withholding_amount,e.other_funding_amount,e.local_other_funding_amount,
      e.settlement_references,e.applications,
      case when e.has_payment and e.has_credit then'MIXED'
           when e.has_payment then'PAYMENT'else'CREDIT_NOTE'end settlement_type,
      greatest(f.settlement_date-b.issue_date,0)days_to_pay,
      b.total_amount*b.exchange_rate local_invoice_amount,b.base_due*b.exchange_rate local_payable_amount,
      b.invoice_withholding_amount*b.exchange_rate local_invoice_withholding_amount,
      b.base_due*b.exchange_rate+e.local_debit_amount local_settlement_base_amount,
      e.local_payment_amount+e.local_credit_amount local_applied_amount,
      greatest(-s.raw_balance,0)*b.exchange_rate local_overapplied_amount,
      e.local_payment_amount+e.local_credit_amount-(b.base_due*b.exchange_rate+e.local_debit_amount)
        -greatest(-s.raw_balance,0)*b.exchange_rate local_exchange_difference_amount
    from invoice_base b join current_state s using(invoice_id)
    join final_close f using(invoice_id)join event_totals e using(invoice_id)
    where e.payment_amount+e.credit_amount>.005
  ),filtered as(
    select * from settled
    where settlement_date between start_date and end_date
      and(cardinality(supplier_ids)=0 or supplier_id=any(supplier_ids))
      and(settlement_filter='ALL'
        or settlement_filter='CASH_PAYMENTS_ONLY'and settlement_type in('PAYMENT','MIXED')
        or settlement_filter='CREDIT_NOTES_ONLY'and settlement_type='CREDIT_NOTE')
  ),paged as(
    select * from filtered order by settlement_date desc,invoice_number,invoice_id
    limit case when export_all then null else page_size end
    offset case when export_all then 0 else(page_number-1)*page_size end
  )
  select jsonb_build_object(
    'header',(select jsonb_build_object(
      'subsidiaryId',s.subsidiary_id,'subsidiary',s.name,'legalName',s.legal_name,'taxId',s.tax_id,'logoUrl',s.logo_url,
      'currency',cur.currency_code,'currencyName',cur.name,'symbol',cur.symbol,
      'periodMonth',month_value,'periodStart',start_date,'periodEnd',end_date,
      'settlementType',settlement_filter,'groupBySettlementType',group_results,'generatedAt',clock_timestamp()
    )from subsidiaries s join currencies cur using(currency_id)where s.subsidiary_id=sid),
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'invoiceId',p.invoice_id,'invoiceNumber',p.invoice_number,
      'supplierId',p.supplier_id,'supplierName',p.supplier_name,'supplierTaxId',p.supplier_tax_id,
      'issueDate',p.issue_date,'dueDate',p.due_date,'invoiceAmount',p.total_amount,
      'payableAmount',p.base_due,'invoiceWithholdingAmount',p.invoice_withholding_amount,
      'currency',p.currency_code,'symbol',p.symbol,'exchangeRate',p.exchange_rate,
      'localInvoiceAmount',p.local_invoice_amount,'localPayableAmount',p.local_payable_amount,
      'localSettlementBaseAmount',p.local_settlement_base_amount,
      'localAppliedAmount',p.local_applied_amount,'localOverappliedAmount',p.local_overapplied_amount,
      'settlementDate',p.settlement_date,'settlementType',p.settlement_type,
      'settlementTypeLabel',case p.settlement_type when'PAYMENT'then'Pago a proveedor'when'CREDIT_NOTE'then'Nota de Crédito'else'Mixto'end,
      'settlementReferences',p.settlement_references,'paymentAmount',p.payment_amount,
      'creditNoteAmount',p.credit_amount,'debitNoteAmount',p.debit_amount,
      'cashAmount',p.cash_amount,'advanceAmount',p.advance_amount,
      'withholdingAmount',p.withholding_amount,
      'totalWithholdingAmount',p.invoice_withholding_amount+p.withholding_amount,
      'otherFundingAmount',p.other_funding_amount,
      'grossAppliedAmount',p.payment_amount+p.credit_amount,
      'netAppliedAmount',p.payment_amount+p.credit_amount-p.debit_amount,
      'settlementBaseAmount',p.base_due+p.debit_amount,
      'appliedAmount',p.payment_amount+p.credit_amount,'balanceDue',p.balance_due,
      'rawBalance',p.raw_balance,'overappliedAmount',p.overapplied_amount,
      'exchangeDifferenceAmount',p.local_exchange_difference_amount,
      'daysToPay',p.days_to_pay,'applications',p.applications
    )order by p.settlement_date desc,p.invoice_number,p.invoice_id)from paged p),'[]'::jsonb),
    'summary',(select jsonb_build_object(
      'invoiceCount',count(*),'invoiceAmount',coalesce(sum(local_invoice_amount),0),
      'payableAmount',coalesce(sum(local_payable_amount),0),
      'invoiceWithholdingAmount',coalesce(sum(local_invoice_withholding_amount),0),
      'settlementBaseAmount',coalesce(sum(local_settlement_base_amount),0),
      'appliedAmount',coalesce(sum(local_applied_amount),0),
      'netAppliedAmount',coalesce(sum(local_payment_amount+local_credit_amount-local_debit_amount),0),
      'paymentAppliedAmount',coalesce(sum(local_payment_amount),0),
      'cashAmount',coalesce(sum(local_cash_amount),0),
      'advanceAmount',coalesce(sum(local_advance_amount),0),
      'withholdingAmount',coalesce(sum(local_withholding_amount),0),
      'totalWithholdingAmount',coalesce(sum(local_invoice_withholding_amount+local_withholding_amount),0),
      'otherFundingAmount',coalesce(sum(local_other_funding_amount),0),
      'creditNoteAmount',coalesce(sum(local_credit_amount),0),
      'debitNoteAmount',coalesce(sum(local_debit_amount),0),
      'paymentCount',count(*)filter(where settlement_type='PAYMENT'),
      'creditNoteCount',count(*)filter(where settlement_type='CREDIT_NOTE'),
      'mixedCount',count(*)filter(where settlement_type='MIXED'),
      'overappliedCount',count(*)filter(where overapplied_amount>.005),
      'overappliedAmount',coalesce(sum(local_overapplied_amount),0),
      'exchangeDifferenceAmount',coalesce(sum(local_exchange_difference_amount),0),
      'averageDpo',coalesce(round(avg(days_to_pay),1),0)
    )from filtered),
    'total',(select count(*)from filtered),'page',page_number,
    'pageSize',case when export_all then(select count(*)from filtered)::integer else page_size end
  )into result;
  return result;
end$$;

revoke all on function public.settled_supplier_invoice_report_options(),public.run_settled_supplier_invoice_report(jsonb)from public,anon;
grant execute on function public.settled_supplier_invoice_report_options(),public.run_settled_supplier_invoice_report(jsonb)to authenticated;
notify pgrst,'reload schema';

