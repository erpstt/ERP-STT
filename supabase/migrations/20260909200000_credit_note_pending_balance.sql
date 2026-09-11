create or replace function validate_customer_credit_note_balance() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare invoice_total numeric;debits numeric;credits numeric;payments numeric;available numeric;invoice_number text;
begin
  select i.total_amount,i.invoice_number into invoice_total,invoice_number from invoice i where i.invoice_id=new.invoice_id for update;
  if not found then raise exception 'La factura relacionada no existe.';end if;
  select coalesce(sum(n.amount),0) into debits from debit_note n where n.invoice_id=new.invoice_id;
  select coalesce(sum(n.amount),0) into credits from credit_note n where n.invoice_id=new.invoice_id and n.cn_id<>coalesce(new.cn_id,-1);
  select coalesce(sum(a.amount),0) into payments from customer_payment_application a where a.invoice_id=new.invoice_id;
  available:=greatest(invoice_total+debits-credits-payments,0);
  if new.amount>available+0.000001 then
    raise exception 'El monto de la nota de crédito supera el saldo pendiente de la factura %. Saldo máximo permitido: %.',invoice_number,trim(to_char(available,'FM999999999999990D00'));
  end if;
  return new;
end$$;
drop trigger if exists validate_customer_credit_note_balance_trigger on credit_note;
create trigger validate_customer_credit_note_balance_trigger before insert or update of invoice_id,amount on credit_note
for each row execute function validate_customer_credit_note_balance();

create or replace function validate_supplier_credit_note_balance() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare invoice_total numeric;debits numeric;credits numeric;payments numeric;available numeric;invoice_number text;
begin
  select i.total_amount,i.invoice_number into invoice_total,invoice_number from supplier_invoice i where i.invoice_id=new.invoice_id for update;
  if not found then raise exception 'La factura relacionada no existe.';end if;
  select coalesce(sum(n.amount),0) into debits from supplier_debit_note n where n.invoice_id=new.invoice_id;
  select coalesce(sum(n.amount),0) into credits from supplier_credit_note n where n.invoice_id=new.invoice_id and n.cn_id<>coalesce(new.cn_id,-1);
  select coalesce(sum(a.amount),0) into payments from supplier_payment_application a where a.invoice_id=new.invoice_id;
  available:=greatest(invoice_total+debits-credits-payments,0);
  if new.amount>available+0.000001 then
    raise exception 'El monto de la nota de crédito supera el saldo pendiente de la factura %. Saldo máximo permitido: %.',invoice_number,trim(to_char(available,'FM999999999999990D00'));
  end if;
  return new;
end$$;
drop trigger if exists validate_supplier_credit_note_balance_trigger on supplier_credit_note;
create trigger validate_supplier_credit_note_balance_trigger before insert or update of invoice_id,amount on supplier_credit_note
for each row execute function validate_supplier_credit_note_balance();

revoke all on function validate_customer_credit_note_balance(),validate_supplier_credit_note_balance() from public,anon;
notify pgrst,'reload schema';

