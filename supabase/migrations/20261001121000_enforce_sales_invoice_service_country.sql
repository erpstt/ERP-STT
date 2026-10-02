-- Complete País de servicio for historical sales invoices and guarantee that
-- create/edit operations cannot silently discard it.
update public.sales_invoice_line line
set service_country_id=subsidiary.country_id
from public.invoice invoice
join public.subsidiaries subsidiary using(subsidiary_id)
where invoice.invoice_id=line.invoice_id
  and line.service_country_id is null
  and subsidiary.country_id is not null;

with commercial as (
  select invoice.journal_id,line.service_country_id,
    row_number() over(partition by invoice.journal_id order by line.line_id) ordinality
  from public.invoice invoice
  join public.sales_invoice_line line using(invoice_id)
), accounting as (
  select invoice.journal_id,line.journal_line_id,
    row_number() over(partition by invoice.journal_id order by line.journal_line_id) ordinality
  from public.invoice invoice
  join public.journal_line line using(journal_id)
  join public.chart_accounts account using(account_id)
  where account.category='Ingreso'
), mapped as (
  select accounting.journal_line_id,commercial.service_country_id
  from commercial join accounting using(journal_id,ordinality)
)
update public.journal_line target
set service_country_id=mapped.service_country_id
from mapped where target.journal_line_id=mapped.journal_line_id;

do $$
begin
  if to_regprocedure('public.save_sales_invoice_before_service_country_integrity(jsonb,bigint)') is null then
    alter function public.save_sales_invoice(jsonb,bigint)
      rename to save_sales_invoice_before_service_country_integrity;
  end if;
end
$$;

revoke all on function public.save_sales_invoice_before_service_country_integrity(jsonb,bigint)
  from public,anon,authenticated;

create or replace function public.save_sales_invoice(
  payload jsonb,target_invoice_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  effective_payload jsonb:=payload;
  effective_lines jsonb;
  subsidiary_country_key bigint;
  invoice_key bigint;
  journal_key bigint;
begin
  select country_id into subsidiary_country_key
  from public.subsidiaries where subsidiary_id=public.active_subsidiary_id();

  with supplied as (
    select value item,ordinality
    from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) with ordinality
  ), stored as (
    select service_country_id,row_number() over(order by line_id) ordinality
    from public.sales_invoice_line
    where target_invoice_id is not null and invoice_id=target_invoice_id
  )
  select coalesce(jsonb_agg(
    supplied.item||jsonb_build_object(
      'service_country_id',coalesce(
        case when coalesce(supplied.item->>'service_country_id','') ~ '^[0-9]+$'
          then (supplied.item->>'service_country_id')::bigint end,
        stored.service_country_id,subsidiary_country_key
      )
    ) order by supplied.ordinality
  ),'[]'::jsonb)
  into effective_lines
  from supplied left join stored using(ordinality);
  effective_payload:=jsonb_set(payload,'{lines}',effective_lines,true);

  if exists(
    select 1 from jsonb_array_elements(effective_payload->'lines') item
    where nullif(item->>'service_country_id','') is null
      or coalesce(item->>'service_country_id','') !~ '^[0-9]+$'
      or not exists(
        select 1 from public.countries country
        where country.country_id=(item->>'service_country_id')::bigint
      )
  )then
    raise exception 'Seleccione un País de servicio válido en cada línea de la factura.';
  end if;

  result:=public.save_sales_invoice_before_service_country_integrity(
    effective_payload,target_invoice_id
  );
  invoice_key:=(result->>'invoiceId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  with supplied as (
    select ordinality,(value->>'service_country_id')::bigint service_country_id
    from jsonb_array_elements(effective_payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from public.sales_invoice_line where invoice_id=invoice_key
  )
  update public.sales_invoice_line line
  set service_country_id=supplied.service_country_id
  from supplied join stored using(ordinality)
  where line.line_id=stored.line_id;

  with commercial as (
    select line.service_country_id,
      row_number() over(order by line.line_id) ordinality
    from public.sales_invoice_line line where line.invoice_id=invoice_key
  ), accounting as (
    select line.journal_line_id,
      row_number() over(order by line.journal_line_id) ordinality
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=journal_key and account.category='Ingreso'
  ), mapped as (
    select accounting.journal_line_id,commercial.service_country_id
    from commercial join accounting using(ordinality)
  )
  update public.journal_line target
  set service_country_id=mapped.service_country_id
  from mapped where target.journal_line_id=mapped.journal_line_id;

  return result;
end
$$;

revoke all on function public.save_sales_invoice(jsonb,bigint) from public,anon;
grant execute on function public.save_sales_invoice(jsonb,bigint) to authenticated;

notify pgrst,'reload schema';
