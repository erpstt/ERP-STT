create or replace function public.customer_payment_edit_options(p_payment_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  invoice_options jsonb;
  current_payment_is_active boolean;
begin
  select upper(coalesce(p.status,'APROBADO'))not in('ANULADO','CANCELADO')
      and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO')
    into current_payment_is_active
  from customer_payment p
  join "transaction" t using(transaction_id)
  left join status st on st.status_id=t.status_id
  where p.payment_id=p_payment_id
    and t.subsidiary_id=active_subsidiary_id();

  if not found then
    raise exception 'Cobro no encontrado.';
  end if;

  if not current_payment_is_active then
    raise exception 'Un cobro anulado o cancelado no puede editarse.';
  end if;

  result:=public.customer_payment_options();

  with balances as(
    select
      i.invoice_id,i.invoice_number,i.customer_id,i.invoice_date,i.due_date,
      i.currency_id,cu.currency_code,i.total_amount,i.withholding_total,
      coalesce(nullif(i.receivable_amount,0),i.total_amount)receivable,
      coalesce(d.total,0)debit_notes,
      coalesce(n.total,0)credit_notes,
      coalesce(p.total,0)paid,
      coalesce(current_application.total,0)current_applied
    from invoice i
    join currencies cu using(currency_id)
    left join lateral(
      select sum(dn.amount)total
      from debit_note dn
      left join "transaction" t on t.transaction_id=dn.transaction_id
      left join status st on st.status_id=t.status_id
      where dn.invoice_id=i.invoice_id
        and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO')
    )d on true
    left join lateral(
      select sum(cn.amount)total
      from credit_note cn
      left join "transaction" t on t.transaction_id=cn.transaction_id
      left join status st on st.status_id=t.status_id
      where cn.invoice_id=i.invoice_id
        and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO')
    )n on true
    left join lateral(
      select sum(a.amount)total
      from customer_payment_application a
      join customer_payment cp using(payment_id)
      left join "transaction" t on t.transaction_id=cp.transaction_id
      left join status st on st.status_id=t.status_id
      where a.invoice_id=i.invoice_id
        and upper(coalesce(cp.status,'APROBADO'))not in('ANULADO','CANCELADO')
        and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO')
    )p on true
    left join lateral(
      select sum(a.amount)total
      from customer_payment_application a
      where a.invoice_id=i.invoice_id and a.payment_id=p_payment_id
    )current_application on true
    where i.subsidiary_id=active_subsidiary_id()
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',invoice_id,
    'number',invoice_number,
    'customerId',customer_id,
    'date',invoice_date,
    'dueDate',due_date,
    'currencyId',currency_id,
    'currency',currency_code,
    'total',total_amount,
    'withholdingTotal',withholding_total,
    'receivable',receivable,
    'debitNotes',debit_notes,
    'creditNotes',credit_notes,
    'paid',paid,
    'currentApplied',current_applied,
    'balance',greatest(receivable+debit_notes-credit_notes-paid,0),
    'editableBalance',greatest(
      receivable+debit_notes-credit_notes-paid
        +case when current_payment_is_active then current_applied else 0 end,
      0
    )
  )order by invoice_date,invoice_id),'[]'::jsonb)
  into invoice_options
  from balances
  where receivable+debit_notes-credit_notes-paid>.000001
     or current_applied>.000001;

  return jsonb_set(result,'{invoices}',invoice_options,true);
end$$;

revoke all on function public.customer_payment_edit_options(bigint) from public,anon;
grant execute on function public.customer_payment_edit_options(bigint) to authenticated;

notify pgrst,'reload schema';
