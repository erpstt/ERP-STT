-- A billing reversal clears revenue that was accrued without indirect taxes.
-- Therefore its ceiling is the sales invoice subtotal, never the gross total.

do $$
begin
  if to_regprocedure('public.pending_invoice_reversal_options_before_invoice_subtotal_limit(bigint,date)') is null then
    alter function public.pending_invoice_reversal_options(bigint,date)
      rename to pending_invoice_reversal_options_before_invoice_subtotal_limit;
  end if;
end
$$;

revoke all on function public.pending_invoice_reversal_options_before_invoice_subtotal_limit(bigint,date)
  from public,anon,authenticated;

create or replace function public.pending_invoice_reversal_options(
  p_journal_id bigint,
  p_reversal_date date
) returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  enriched_invoices jsonb;
begin
  result:=public.pending_invoice_reversal_options_before_invoice_subtotal_limit(
    p_journal_id,p_reversal_date
  );

  select coalesce(jsonb_agg(
    candidate.item||jsonb_build_object(
      'subtotal',candidate.subtotal,
      'applied',candidate.applied,
      'available',greatest(candidate.subtotal-candidate.applied,0)
    ) order by candidate.ordinality
  ),'[]'::jsonb)
  into enriched_invoices
  from(
    select source.item,source.ordinality,
      round(coalesce(
        (select sum(line.amount) from public.sales_invoice_line line where line.invoice_id=invoice.invoice_id),
        greatest(invoice.total_amount-coalesce(
          (select sum(line.tax_amount) from public.sales_invoice_line line where line.invoice_id=invoice.invoice_id),0
        ),0)
      ),6) subtotal,
      round(coalesce((
        select sum(reversal.reversed_local)
        from public.pending_invoice_reversal reversal
        where reversal.sales_invoice_id=invoice.invoice_id
          and reversal.reversal_type='FACTURACION'
      ),0),6) applied
    from jsonb_array_elements(coalesce(result->'invoices','[]'::jsonb))
      with ordinality source(item,ordinality)
    join public.invoice invoice
      on invoice.invoice_id=(source.item->>'id')::bigint
  ) candidate;

  return jsonb_set(result,'{invoices}',coalesce(enriched_invoices,'[]'::jsonb),true);
end
$$;

revoke all on function public.pending_invoice_reversal_options(bigint,date)
  from public,anon;
grant execute on function public.pending_invoice_reversal_options(bigint,date)
  to authenticated;

do $$
begin
  if to_regprocedure('public.reverse_pending_invoice_journal_before_invoice_subtotal_limit(bigint,jsonb)') is null then
    alter function public.reverse_pending_invoice_journal(bigint,jsonb)
      rename to reverse_pending_invoice_journal_before_invoice_subtotal_limit;
  end if;
end
$$;

revoke all on function public.reverse_pending_invoice_journal_before_invoice_subtotal_limit(bigint,jsonb)
  from public,anon,authenticated;

create or replace function public.reverse_pending_invoice_journal(
  p_journal_id bigint,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  kind text:=p_payload->>'type';
  invoice_key bigint;
  amount_value numeric(24,6);
  invoice_subtotal numeric(24,6);
  invoice_applied numeric(24,6);
  invoice_available numeric(24,6);
begin
  if kind='FACTURACION' then
    invoice_key:=nullif(p_payload->>'invoiceId','')::bigint;
    amount_value:=nullif(p_payload->>'amount','')::numeric;
    if invoice_key is null then
      raise exception 'Seleccione una factura de venta para realizar la reversión.';
    end if;

    -- All billing reversals for the same invoice serialize on its header.
    perform 1
    from public.invoice invoice
    join public.user_subsidiaries access
      on access.subsidiary_id=invoice.subsidiary_id
     and access.user_id=public.app_user_id()
    where invoice.invoice_id=invoice_key
    for update of invoice;
    if not found then
      raise exception 'La factura seleccionada no existe o no pertenece a una subsidiaria autorizada.';
    end if;

    select round(coalesce(
      (select sum(line.amount) from public.sales_invoice_line line where line.invoice_id=invoice.invoice_id),
      greatest(invoice.total_amount-coalesce(
        (select sum(line.tax_amount) from public.sales_invoice_line line where line.invoice_id=invoice.invoice_id),0
      ),0)
    ),6)
    into invoice_subtotal
    from public.invoice invoice
    where invoice.invoice_id=invoice_key;

    select round(coalesce(sum(reversal.reversed_local),0),6)
    into invoice_applied
    from public.pending_invoice_reversal reversal
    where reversal.sales_invoice_id=invoice_key
      and reversal.reversal_type='FACTURACION';

    invoice_available:=greatest(invoice_subtotal-invoice_applied,0);
    if amount_value is not null and amount_value>invoice_subtotal+.000001 then
      raise exception 'El monto a reversar (%) supera el subtotal de la factura sin impuestos (%).',
        to_char(amount_value,'FM999G999G999G990D00'),
        to_char(invoice_subtotal,'FM999G999G999G990D00');
    end if;
    if amount_value is not null and amount_value>invoice_available+.000001 then
      raise exception 'El monto a reversar (%) supera el importe disponible de la factura sin impuestos (%). Ya se utilizaron % en otras reversiones.',
        to_char(amount_value,'FM999G999G999G990D00'),
        to_char(invoice_available,'FM999G999G999G990D00'),
        to_char(invoice_applied,'FM999G999G999G990D00');
    end if;
  end if;

  return public.reverse_pending_invoice_journal_before_invoice_subtotal_limit(
    p_journal_id,p_payload
  );
end
$$;

revoke all on function public.reverse_pending_invoice_journal(bigint,jsonb)
  from public,anon;
grant execute on function public.reverse_pending_invoice_journal(bigint,jsonb)
  to authenticated;

create or replace function public.validate_pending_reversal_invoice()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$
declare
  source_customer bigint;
  source_subsidiary bigint;
  linked_invoice public.invoice%rowtype;
  invoice_subtotal numeric(24,6);
  already_applied numeric(24,6);
begin
  if(new.source_journal_id is null)=(new.source_opening_pending_id is null) then
    raise exception 'La reversión debe tener un único origen.';
  end if;
  if new.reversal_type<>'FACTURACION' then return new;end if;

  if new.source_journal_id is not null then
    select line.customer_id,journal.subsidiary_id
    into source_customer,source_subsidiary
    from public.journal journal
    left join lateral(
      select customer_id from public.journal_line
      where journal_id=journal.journal_id and customer_id is not null
      order by journal_line_id limit 1
    ) line on true
    where journal.journal_id=new.source_journal_id;
  else
    select customer_id,subsidiary_id
    into source_customer,source_subsidiary
    from public.opening_pending_invoice_items
    where id=new.source_opening_pending_id;
  end if;

  select * into linked_invoice
  from public.invoice
  where invoice_id=new.sales_invoice_id
  for update;
  if source_customer is null or linked_invoice.invoice_id is null
    or linked_invoice.customer_id<>source_customer
    or linked_invoice.subsidiary_id<>source_subsidiary
    or date_trunc('month',linked_invoice.invoice_date)<>date_trunc('month',new.reversal_date) then
    raise exception 'La factura vinculada debe pertenecer al cliente, subsidiaria y mes de la reversión.';
  end if;

  select round(coalesce(
    (select sum(line.amount) from public.sales_invoice_line line where line.invoice_id=linked_invoice.invoice_id),
    greatest(linked_invoice.total_amount-coalesce(
      (select sum(line.tax_amount) from public.sales_invoice_line line where line.invoice_id=linked_invoice.invoice_id),0
    ),0)
  ),6) into invoice_subtotal;

  select round(coalesce(sum(reversal.reversed_local),0),6)
  into already_applied
  from public.pending_invoice_reversal reversal
  where reversal.sales_invoice_id=linked_invoice.invoice_id
    and reversal.reversal_type='FACTURACION'
    and reversal.reversal_id<>coalesce(new.reversal_id,-1);

  if new.reversed_local>invoice_subtotal+.000001 then
    raise exception 'El monto de reversión supera el subtotal de la factura sin impuestos (%).',
      to_char(invoice_subtotal,'FM999G999G999G990D00');
  end if;
  if already_applied+new.reversed_local>invoice_subtotal+.000001 then
    raise exception 'La factura no tiene suficiente subtotal disponible sin impuestos. Disponible: %.',
      to_char(greatest(invoice_subtotal-already_applied,0),'FM999G999G999G990D00');
  end if;
  return new;
end
$$;

drop trigger if exists validate_pending_reversal_invoice_trigger
  on public.pending_invoice_reversal;
create trigger validate_pending_reversal_invoice_trigger
before insert or update of source_journal_id,source_opening_pending_id,reversal_date,
  reversal_type,sales_invoice_id,reversed_local
on public.pending_invoice_reversal
for each row execute function public.validate_pending_reversal_invoice();

notify pgrst,'reload schema';
