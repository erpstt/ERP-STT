alter table public.sales_invoice_line
  add column if not exists service_country_id bigint
  references public.countries(country_id) on delete restrict;

create index if not exists sales_invoice_line_service_country_idx
  on public.sales_invoice_line(service_country_id);

-- Preserve the current accounting and withholding workflow, then enrich each
-- generated invoice line with the service country supplied in the same order.
alter function public.save_sales_invoice(jsonb,bigint)
  rename to save_sales_invoice_without_service_country;

revoke all on function public.save_sales_invoice_without_service_country(jsonb,bigint)
  from public,anon,authenticated;

create function public.save_sales_invoice(payload jsonb,target_invoice_id bigint default null)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare result jsonb;
begin
  result:=public.save_sales_invoice_without_service_country(payload,target_invoice_id);

  with supplied as (
    select ordinality,
      nullif(btrim(value->>'service_country_id'),'')::bigint service_country_id
    from jsonb_array_elements(payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from public.sales_invoice_line
    where invoice_id=(result->>'invoiceId')::bigint
  )
  update public.sales_invoice_line line
  set service_country_id=supplied.service_country_id
  from supplied join stored using(ordinality)
  where line.line_id=stored.line_id;

  return result;
end$$;

revoke all on function public.save_sales_invoice(jsonb,bigint) from public,anon;
grant execute on function public.save_sales_invoice(jsonb,bigint) to authenticated;

notify pgrst,'reload schema';
