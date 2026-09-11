create or replace function supplier_credit_note_available_balance(p_invoice_id bigint,p_exclude_cn_id bigint default null)
returns numeric language sql stable security definer set search_path=public,pg_temp as $$
 select greatest(i.total_amount
  +coalesce((select sum(n.amount)from supplier_debit_note n where n.invoice_id=i.invoice_id),0)
  -coalesce((select sum(n.amount)from supplier_credit_note n where n.invoice_id=i.invoice_id and n.cn_id<>coalesce(p_exclude_cn_id,-1)),0)
  -coalesce((select sum(a.amount)from supplier_payment_application a where a.invoice_id=i.invoice_id),0),0)
 from supplier_invoice i where i.invoice_id=p_invoice_id and i.subsidiary_id=active_subsidiary_id()
$$;
revoke all on function supplier_credit_note_available_balance(bigint,bigint) from public,anon;
grant execute on function supplier_credit_note_available_balance(bigint,bigint) to authenticated;
notify pgrst,'reload schema';

