CREATE OR REPLACE FUNCTION public.validate_customer_credit_note_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end$function$;
