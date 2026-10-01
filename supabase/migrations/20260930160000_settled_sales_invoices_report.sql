alter table public.invoice
  add column if not exists sales_representative_id bigint references public.employees(employee_id) on delete set null;

update public.invoice i
set sales_representative_id=c.sales_representative_id
from public.customers c
where c.customer_id=i.customer_id
  and i.sales_representative_id is null
  and c.sales_representative_id is not null;

create index if not exists invoice_sales_representative_idx
  on public.invoice(subsidiary_id,sales_representative_id,invoice_date);

create or replace function public.snapshot_invoice_sales_representative()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.sales_representative_id is null then
    select c.sales_representative_id into new.sales_representative_id
    from customers c where c.customer_id=new.customer_id;
  end if;
  return new;
end$$;

drop trigger if exists invoice_sales_representative_snapshot on public.invoice;
create trigger invoice_sales_representative_snapshot
before insert on public.invoice for each row
execute function public.snapshot_invoice_sales_representative();

create index if not exists customer_payment_application_settlement_idx
  on public.customer_payment_application(invoice_id,application_date,payment_id);
create index if not exists credit_note_settlement_idx
  on public.credit_note(invoice_id,note_date,cn_id);
create index if not exists debit_note_settlement_idx
  on public.debit_note(invoice_id,note_date,dn_id);

create or replace function public.settled_sales_invoice_report_options()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
select jsonb_build_object(
  'subsidiary',jsonb_build_object(
    'id',s.subsidiary_id,'name',s.name,'legalName',s.legal_name,'taxId',s.tax_id,
    'logoUrl',s.logo_url,'currencyId',s.currency_id,'currency',cu.currency_code,
    'currencyName',cu.name,'symbol',cu.symbol
  ),
  'salesRepresentatives',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',e.employee_id,'name',concat_ws(' ',e.first_name,e.last_name),
      'number',e.employee_number,'active',e.is_active
    ) order by e.is_active desc,e.first_name,e.last_name)
    from employees e
    where e.subsidiary_id=s.subsidiary_id
      and (e.is_sales_representative or exists(
        select 1 from invoice i join customers c using(customer_id)
        where i.subsidiary_id=s.subsidiary_id
          and coalesce(i.sales_representative_id,c.sales_representative_id)=e.employee_id
      ))
  ),'[]'::jsonb)
)
from subsidiaries s join currencies cu using(currency_id)
where s.subsidiary_id=active_subsidiary_id()
  and exists(select 1 from user_subsidiaries u where u.user_id=app_user_id()and u.subsidiary_id=s.subsidiary_id)
$$;

create or replace function public.run_settled_sales_invoice_report(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
  sid bigint:=active_subsidiary_id();
  month_value text:=coalesce(nullif(p_filters->>'periodMonth',''),to_char(current_date,'YYYY-MM'));
  start_date date;
  end_date date;
  seller_ids bigint[]:=array(select value::bigint from jsonb_array_elements_text(coalesce(p_filters->'salesRepresentativeIds','[]'::jsonb)));
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
  if exists(select 1 from unnest(seller_ids)x where not exists(select 1 from employees e where e.employee_id=x and e.subsidiary_id=sid))then raise exception 'Uno de los vendedores seleccionados no pertenece a la subsidiaria activa.';end if;
  start_date:=to_date(month_value||'-01','YYYY-MM-DD');
  end_date:=(start_date+interval'1 month'-interval'1 day')::date;

  with invoice_state as(
    select i.invoice_id,i.invoice_number,i.customer_id,i.subsidiary_id,
      coalesce(i.invoice_date,t.tran_date)issue_date,i.due_date,i.total_amount,
      coalesce(nullif(i.receivable_amount,0),i.total_amount)receivable_amount,
      coalesce(i.exchange_rate,t.exchange_rate,1)exchange_rate,cu.currency_code,cu.symbol,
      c.company_name customer_name,c.tax_id customer_tax_id,
      coalesce(i.sales_representative_id,c.sales_representative_id)sales_representative_id,
      coalesce(nullif(concat_ws(' ',rep.first_name,rep.last_name),''),'Sin vendedor')sales_representative_name,
      coalesce(pay.amount,0)payment_amount,coalesce(pay.local_amount,0)local_payment_amount,pay.last_date payment_last_date,
      coalesce(credit.amount,0)credit_amount,coalesce(credit.local_amount,0)local_credit_amount,credit.last_date credit_last_date,
      coalesce(debit.amount,0)debit_amount,
      greatest(coalesce(nullif(i.receivable_amount,0),i.total_amount)+coalesce(debit.amount,0)-coalesce(pay.amount,0)-coalesce(credit.amount,0),0)balance_due
    from invoice i join "transaction"t using(transaction_id)
    join customers c on c.customer_id=i.customer_id
    join currencies cu on cu.currency_id=coalesce(i.currency_id,t.currency_id)
    left join employees rep on rep.employee_id=coalesce(i.sales_representative_id,c.sales_representative_id)
    left join status invoice_status on invoice_status.status_id=t.status_id
    left join lateral(
      select sum(a.amount)amount,sum(a.amount*coalesce(i.exchange_rate,t.exchange_rate,1))local_amount,max(a.application_date)last_date
      from customer_payment_application a join customer_payment p using(payment_id)
      where a.invoice_id=i.invoice_id and coalesce(p.status,'APROBADO')<>'ANULADO'
    )pay on true
    left join lateral(
      select sum(n.amount)amount,sum(n.amount*coalesce(i.exchange_rate,t.exchange_rate,1))local_amount,
        max(coalesce(n.note_date,nt.tran_date))last_date
      from credit_note n left join "transaction"nt on nt.transaction_id=n.transaction_id
      where n.invoice_id=i.invoice_id
    )credit on true
    left join lateral(
      select sum(n.amount)amount from debit_note n where n.invoice_id=i.invoice_id
    )debit on true
    where i.subsidiary_id=sid
      and coalesce(invoice_status.code,'APROBADO')not in('ANULADO','CANCELADO')
  ),settled as(
    select state.*,
      greatest(state.payment_last_date,state.credit_last_date)settlement_date,
      case when state.payment_amount>.005 and state.credit_amount>.005 then'MIXED'
           when state.payment_amount>.005 then'PAYMENT'else'CREDIT_NOTE'end settlement_type,
      greatest(greatest(state.payment_last_date,state.credit_last_date)-state.issue_date,0)days_to_collect,
      state.total_amount*state.exchange_rate local_invoice_amount,
      (state.payment_amount+state.credit_amount)*state.exchange_rate local_applied_amount,
      coalesce((select string_agg(event.reference,' · 'order by event.event_date,event.sort_order,event.reference)from(
        select a.application_date event_date,1 sort_order,p.payment_number||coalesce(' / '||nullif(p.bank_reference,''),'')reference
        from customer_payment_application a join customer_payment p using(payment_id)
        where a.invoice_id=state.invoice_id and coalesce(p.status,'APROBADO')<>'ANULADO'
        union all
        select coalesce(n.note_date,nt.tran_date),2,n.cn_number
        from credit_note n left join "transaction"nt on nt.transaction_id=n.transaction_id where n.invoice_id=state.invoice_id
      )event),'—')settlement_references,
      coalesce((select jsonb_agg(jsonb_build_object(
        'date',event.event_date,'type',event.event_type,'typeLabel',event.type_label,
        'reference',event.reference,'secondaryReference',event.secondary_reference,
        'method',event.method,'amount',event.amount
      )order by event.event_date,event.sort_order,event.reference)from(
        select a.application_date event_date,1 sort_order,'PAYMENT'event_type,'Pago (Caja/Banco)'type_label,
          p.payment_number reference,p.bank_reference secondary_reference,b.bank_name method,a.amount
        from customer_payment_application a join customer_payment p using(payment_id)
        left join bank_account ba using(bank_account_id)left join banks b using(bank_id)
        where a.invoice_id=state.invoice_id and coalesce(p.status,'APROBADO')<>'ANULADO'
        union all
        select coalesce(n.note_date,nt.tran_date),2,'CREDIT_NOTE','Nota de Crédito',n.cn_number,null,'Compensación',n.amount
        from credit_note n left join "transaction"nt on nt.transaction_id=n.transaction_id where n.invoice_id=state.invoice_id
      )event),'[]'::jsonb)applications
    from invoice_state state
    where state.balance_due<.005 and state.payment_amount+state.credit_amount>.005
  ),filtered as(
    select * from settled
    where settlement_date between start_date and end_date
      and(cardinality(seller_ids)=0 or sales_representative_id=any(seller_ids))
      and(settlement_filter='ALL'
        or settlement_filter='CASH_PAYMENTS_ONLY'and settlement_type='PAYMENT'
        or settlement_filter='CREDIT_NOTES_ONLY'and settlement_type='CREDIT_NOTE')
  ),paged as(
    select * from filtered order by settlement_date desc,invoice_number
    limit case when export_all then 5000 else page_size end
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
      'customerName',p.customer_name,'customerTaxId',p.customer_tax_id,
      'salesRepresentativeId',p.sales_representative_id,'salesRepresentative',p.sales_representative_name,
      'issueDate',p.issue_date,'dueDate',p.due_date,'invoiceAmount',p.total_amount,
      'receivableAmount',p.receivable_amount,'currency',p.currency_code,'symbol',p.symbol,
      'settlementDate',p.settlement_date,'settlementType',p.settlement_type,
      'settlementTypeLabel',case p.settlement_type when'PAYMENT'then'Pago (Caja/Banco)'when'CREDIT_NOTE'then'Nota de Crédito'else'Mixto'end,
      'settlementReferences',p.settlement_references,'paymentAmount',p.payment_amount,
      'creditNoteAmount',p.credit_amount,'appliedAmount',p.payment_amount+p.credit_amount,
      'balanceDue',p.balance_due,'daysToCollect',p.days_to_collect,'applications',p.applications
    )order by p.settlement_date desc,p.invoice_number)from paged p),'[]'::jsonb),
    'summary',(select jsonb_build_object(
      'invoiceCount',count(*),'invoiceAmount',coalesce(sum(local_invoice_amount),0),
      'appliedAmount',coalesce(sum(local_applied_amount),0),
      'cashAmount',coalesce(sum(local_payment_amount),0),
      'creditNoteAmount',coalesce(sum(local_credit_amount),0),
      'paymentCount',count(*)filter(where settlement_type='PAYMENT'),
      'creditNoteCount',count(*)filter(where settlement_type='CREDIT_NOTE'),
      'mixedCount',count(*)filter(where settlement_type='MIXED'),
      'averageDso',coalesce(round(avg(days_to_collect),1),0)
    )from filtered),
    'total',(select count(*)from filtered),'page',page_number,
    'pageSize',case when export_all then 5000 else page_size end
  )into result;
  return result;
end$$;

revoke all on function public.snapshot_invoice_sales_representative(),public.settled_sales_invoice_report_options(),public.run_settled_sales_invoice_report(jsonb)from public,anon;
grant execute on function public.settled_sales_invoice_report_options(),public.run_settled_sales_invoice_report(jsonb)to authenticated;
notify pgrst,'reload schema';
