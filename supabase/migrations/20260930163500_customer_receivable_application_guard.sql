create or replace function public.validate_customer_payment_application_receivable()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare
  base_due numeric;
  debit_total numeric;
  credit_total numeric;
  payment_total numeric;
  available numeric;
  invoice_number_value text;
begin
  select coalesce(nullif(i.receivable_amount,0),i.total_amount),i.invoice_number
    into base_due,invoice_number_value
  from invoice i where i.invoice_id=new.invoice_id for update;
  if not found then raise exception 'La factura relacionada no existe.';end if;

  select coalesce(sum(n.amount),0) into debit_total
  from debit_note n
  left join "transaction" t on t.transaction_id=n.transaction_id
  left join status s on s.status_id=t.status_id
  where n.invoice_id=new.invoice_id
    and upper(coalesce(s.code,'APROBADO'))not in('ANULADO','CANCELADO');

  select coalesce(sum(n.amount),0) into credit_total
  from credit_note n
  left join "transaction" t on t.transaction_id=n.transaction_id
  left join status s on s.status_id=t.status_id
  where n.invoice_id=new.invoice_id
    and upper(coalesce(s.code,'APROBADO'))not in('ANULADO','CANCELADO');

  select coalesce(sum(a.amount),0) into payment_total
  from customer_payment_application a
  join customer_payment p using(payment_id)
  left join "transaction" t on t.transaction_id=p.transaction_id
  left join status s on s.status_id=t.status_id
  where a.invoice_id=new.invoice_id
    and a.application_id<>coalesce(new.application_id,-1)
    and upper(coalesce(p.status,'APROBADO'))not in('ANULADO','CANCELADO')
    and upper(coalesce(s.code,'APROBADO'))not in('ANULADO','CANCELADO');

  available:=greatest(base_due+debit_total-credit_total-payment_total,0);
  if new.amount>available+0.000001 then
    raise exception 'El cobro supera el saldo pendiente de la factura %. Saldo máximo disponible: %.',
      invoice_number_value,trim(to_char(available,'FM999999999999990D00'));
  end if;
  return new;
end$$;

drop trigger if exists customer_payment_application_receivable_guard on public.customer_payment_application;
create trigger customer_payment_application_receivable_guard
before insert or update of invoice_id,amount on public.customer_payment_application
for each row execute function public.validate_customer_payment_application_receivable();

create or replace function public.validate_customer_credit_note_balance()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  base_due numeric;
  debits numeric;
  credits numeric;
  payments numeric;
  available numeric;
  invoice_number_value text;
begin
  select coalesce(nullif(i.receivable_amount,0),i.total_amount),i.invoice_number
    into base_due,invoice_number_value
  from invoice i where i.invoice_id=new.invoice_id for update;
  if not found then raise exception 'La factura relacionada no existe.';end if;

  select coalesce(sum(n.amount),0) into debits
  from debit_note n
  left join "transaction" t on t.transaction_id=n.transaction_id
  left join status s on s.status_id=t.status_id
  where n.invoice_id=new.invoice_id
    and upper(coalesce(s.code,'APROBADO'))not in('ANULADO','CANCELADO');

  select coalesce(sum(n.amount),0) into credits
  from credit_note n
  left join "transaction" t on t.transaction_id=n.transaction_id
  left join status s on s.status_id=t.status_id
  where n.invoice_id=new.invoice_id and n.cn_id<>coalesce(new.cn_id,-1)
    and upper(coalesce(s.code,'APROBADO'))not in('ANULADO','CANCELADO');

  select coalesce(sum(a.amount),0) into payments
  from customer_payment_application a
  join customer_payment p using(payment_id)
  left join "transaction" t on t.transaction_id=p.transaction_id
  left join status s on s.status_id=t.status_id
  where a.invoice_id=new.invoice_id
    and upper(coalesce(p.status,'APROBADO'))not in('ANULADO','CANCELADO')
    and upper(coalesce(s.code,'APROBADO'))not in('ANULADO','CANCELADO');

  available:=greatest(base_due+debits-credits-payments,0);
  if new.amount>available+0.000001 then
    raise exception 'El monto de la nota de crédito supera el saldo pendiente de la factura %. Saldo máximo permitido: %.',
      invoice_number_value,trim(to_char(available,'FM999999999999990D00'));
  end if;
  return new;
end$$;

drop trigger if exists validate_customer_credit_note_balance_trigger on public.credit_note;
create trigger validate_customer_credit_note_balance_trigger
before insert or update of invoice_id,amount on public.credit_note
for each row execute function public.validate_customer_credit_note_balance();

create or replace function public.protect_customer_debit_note_balance()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  base_due numeric;
  debit_total numeric;
  credit_total numeric;
  payment_total numeric;
  replacement_amount numeric:=0;
  invoice_number_value text;
  old_is_active boolean;
begin
  if tg_op='UPDATE'and new.invoice_id=old.invoice_id and new.amount>=old.amount then return new;end if;

  select upper(coalesce(s.code,'APROBADO'))not in('ANULADO','CANCELADO')into old_is_active
  from debit_note n
  left join "transaction" t on t.transaction_id=n.transaction_id
  left join status s on s.status_id=t.status_id
  where n.dn_id=old.dn_id;
  if not coalesce(old_is_active,true)then return case when tg_op='DELETE'then old else new end;end if;

  select coalesce(nullif(i.receivable_amount,0),i.total_amount),i.invoice_number
    into base_due,invoice_number_value
  from invoice i where i.invoice_id=old.invoice_id for update;
  if not found then return case when tg_op='DELETE'then old else new end;end if;

  if tg_op='UPDATE'and new.invoice_id=old.invoice_id then replacement_amount:=new.amount;end if;
  select coalesce(sum(n.amount),0)+replacement_amount into debit_total
  from debit_note n
  left join "transaction" t on t.transaction_id=n.transaction_id
  left join status s on s.status_id=t.status_id
  where n.invoice_id=old.invoice_id and n.dn_id<>old.dn_id
    and upper(coalesce(s.code,'APROBADO'))not in('ANULADO','CANCELADO');

  select coalesce(sum(n.amount),0)into credit_total
  from credit_note n
  left join "transaction" t on t.transaction_id=n.transaction_id
  left join status s on s.status_id=t.status_id
  where n.invoice_id=old.invoice_id
    and upper(coalesce(s.code,'APROBADO'))not in('ANULADO','CANCELADO');

  select coalesce(sum(a.amount),0)into payment_total
  from customer_payment_application a
  join customer_payment p using(payment_id)
  left join "transaction" t on t.transaction_id=p.transaction_id
  left join status s on s.status_id=t.status_id
  where a.invoice_id=old.invoice_id
    and upper(coalesce(p.status,'APROBADO'))not in('ANULADO','CANCELADO')
    and upper(coalesce(s.code,'APROBADO'))not in('ANULADO','CANCELADO');

  if payment_total+credit_total>base_due+debit_total+0.000001 then
    raise exception 'No puede reducir o eliminar la nota de débito: la factura % quedaría sobreaplicada por %.',
      invoice_number_value,trim(to_char(payment_total+credit_total-base_due-debit_total,'FM999999999999990D00'));
  end if;
  return case when tg_op='DELETE'then old else new end;
end$$;

drop trigger if exists protect_customer_debit_note_balance_trigger on public.debit_note;
create trigger protect_customer_debit_note_balance_trigger
before delete or update of invoice_id,amount on public.debit_note
for each row execute function public.protect_customer_debit_note_balance();

create or replace function public.customer_payment_options()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
select jsonb_build_object(
  'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id),
  'location',(select jsonb_build_object('id',l.location_id,'name',l.name)
    from locations l left join location_subsidiaries ls using(location_id)
    where l.subsidiary_id=s.subsidiary_id or ls.subsidiary_id=s.subsidiary_id
    order by l.location_id limit 1),
  'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.customer_id,'name',c.company_name))
    from customers c join entity_subsidiaries es using(customer_id)
    where es.subsidiary_id=s.subsidiary_id),'[]'),
  'accounts',coalesce((select jsonb_agg(jsonb_build_object(
      'id',ba.bank_account_id,'bank',b.bank_name,'number',ba.account_number,
      'currencyId',ba.currency_id,'currency',cu.currency_code,'balance',ba.balance))
    from bank_account ba join banks b using(bank_id)join currencies cu using(currency_id)
    where ba.subsidiary_id=s.subsidiary_id and not coalesce(ba.is_credit_card,false)),'[]'),
  'periods',coalesce((select jsonb_agg(jsonb_build_object(
      'id',fiscal_period_id,'name',period_name,'start',start_date,'end',end_date))
    from fiscal_periods where subsidiary_id=s.subsidiary_id and not is_closed and not coalesce(ar_closed,false)),'[]'),
  'rates',coalesce((select jsonb_agg(jsonb_build_object(
      'fromCurrencyId',from_currency_id,'toCurrencyId',to_currency_id,'date',effective_date,'rate',spot_rate)
      order by effective_date desc)from exchange_rates),'[]'),
  'invoices',coalesce((
    with balances as(
      select i.invoice_id,i.invoice_number,i.customer_id,i.invoice_date,i.due_date,i.currency_id,
        cu.currency_code,i.total_amount,i.withholding_total,
        coalesce(nullif(i.receivable_amount,0),i.total_amount)receivable,
        coalesce(d.total,0)debit_notes,coalesce(n.total,0)credit_notes,coalesce(p.total,0)paid
      from invoice i join currencies cu using(currency_id)
      left join lateral(select sum(dn.amount)total from debit_note dn
        left join "transaction" t on t.transaction_id=dn.transaction_id
        left join status st on st.status_id=t.status_id
        where dn.invoice_id=i.invoice_id and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO'))d on true
      left join lateral(select sum(cn.amount)total from credit_note cn
        left join "transaction" t on t.transaction_id=cn.transaction_id
        left join status st on st.status_id=t.status_id
        where cn.invoice_id=i.invoice_id and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO'))n on true
      left join lateral(select sum(a.amount)total from customer_payment_application a
        join customer_payment cp using(payment_id)
        left join "transaction" t on t.transaction_id=cp.transaction_id
        left join status st on st.status_id=t.status_id
        where a.invoice_id=i.invoice_id
          and upper(coalesce(cp.status,'APROBADO'))not in('ANULADO','CANCELADO')
          and upper(coalesce(st.code,'APROBADO'))not in('ANULADO','CANCELADO'))p on true
      where i.subsidiary_id=s.subsidiary_id
    )
    select jsonb_agg(jsonb_build_object(
      'id',invoice_id,'number',invoice_number,'customerId',customer_id,'date',invoice_date,'dueDate',due_date,
      'currencyId',currency_id,'currency',currency_code,'total',total_amount,'withholdingTotal',withholding_total,
      'receivable',receivable,'debitNotes',debit_notes,'creditNotes',credit_notes,'paid',paid,
      'balance',greatest(receivable+debit_notes-credit_notes-paid,0))order by invoice_date,invoice_id)
    from balances where receivable+debit_notes-credit_notes-paid>.000001
  ),'[]')
)from subsidiaries s where s.subsidiary_id=active_subsidiary_id()$$;

revoke all on function public.validate_customer_payment_application_receivable(),
  public.validate_customer_credit_note_balance(),public.protect_customer_debit_note_balance()from public,anon;
grant execute on function public.customer_payment_options()to authenticated;
notify pgrst,'reload schema';
