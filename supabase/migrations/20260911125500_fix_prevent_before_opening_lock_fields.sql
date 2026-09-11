create or replace function prevent_before_opening_lock()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  row_data jsonb := to_jsonb(new);
  d date;
  sid bigint;
  opening_entry boolean;
begin
  d := case tg_table_name
    when 'journal' then nullif(row_data->>'journal_date','')::date
    when 'invoice' then nullif(row_data->>'invoice_date','')::date
    when 'supplier_invoice' then nullif(row_data->>'invoice_date','')::date
    when 'purchase_document' then nullif(row_data->>'document_date','')::date
    when 'sales_document' then nullif(row_data->>'document_date','')::date
  end;
  sid := nullif(row_data->>'subsidiary_id','')::bigint;
  opening_entry := coalesce(nullif(row_data->>'is_opening_balance','')::boolean,false);

  if not opening_entry
     and d is not null
     and sid is not null
     and exists(
       select 1
       from opening_balance_runs
       where subsidiary_id=sid
         and status='POSTED'
         and d<=opening_date
     ) then
    raise exception 'La fecha está bloqueada por la contabilización de saldos iniciales.';
  end if;

  return new;
end
$$;

revoke all on function prevent_before_opening_lock() from public,anon;
notify pgrst,'reload schema';
