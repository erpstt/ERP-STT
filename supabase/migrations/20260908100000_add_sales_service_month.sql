alter table sales_invoice_line
  add column if not exists service_month text
  check (service_month is null or service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

alter table sales_note_line
  add column if not exists service_month text
  check (service_month is null or service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- Keep the established accounting routines intact and enrich their generated
-- detail rows with the service month supplied by the user.
alter function save_sales_invoice(jsonb,bigint) rename to save_sales_invoice_without_service_month;

create function save_sales_invoice(payload jsonb,target_invoice_id bigint default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  result := save_sales_invoice_without_service_month(payload,target_invoice_id);
  with supplied as (
    select ordinality, nullif(value->>'service_month','') service_month
    from jsonb_array_elements(payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from sales_invoice_line where invoice_id=(result->>'invoiceId')::bigint
  )
  update sales_invoice_line line set service_month=supplied.service_month
  from supplied join stored using(ordinality) where line.line_id=stored.line_id;
  return result;
end$$;
revoke all on function save_sales_invoice(jsonb,bigint) from public;
grant execute on function save_sales_invoice(jsonb,bigint) to authenticated;

alter function save_sales_note(text,jsonb,bigint) rename to save_sales_note_without_service_month;

create function save_sales_note(p_kind text,p_payload jsonb,p_target_id bigint default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; normalized_kind text:=upper(p_kind);
begin
  result := save_sales_note_without_service_month(p_kind,p_payload,p_target_id);
  with supplied as (
    select ordinality, nullif(value->>'service_month','') service_month
    from jsonb_array_elements(p_payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from sales_note_line
    where note_kind=normalized_kind and note_id=(result->>'noteId')::bigint
  )
  update sales_note_line line set service_month=supplied.service_month
  from supplied join stored using(ordinality) where line.line_id=stored.line_id;
  return result;
end$$;
revoke all on function save_sales_note(text,jsonb,bigint) from public;
grant execute on function save_sales_note(text,jsonb,bigint) to authenticated;
