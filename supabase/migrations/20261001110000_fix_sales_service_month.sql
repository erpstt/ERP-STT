-- Persist the service month sent by sales invoices, credit notes and debit
-- notes. The historical migration that originally added these columns was not
-- present in the deployed database, while the browser already submitted them.
alter table public.sales_invoice_line
  add column if not exists service_month text;

alter table public.sales_note_line
  add column if not exists service_month text;

alter table public.sales_invoice_line
  drop constraint if exists sales_invoice_line_service_month_format;
alter table public.sales_invoice_line
  add constraint sales_invoice_line_service_month_format
  check(service_month is null or service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

alter table public.sales_note_line
  drop constraint if exists sales_note_line_service_month_format;
alter table public.sales_note_line
  add constraint sales_note_line_service_month_format
  check(service_month is null or service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- Values previously sent by the UI were discarded and cannot be recovered.
-- Initialize historical documents with their document month.
update public.sales_invoice_line line
set service_month=to_char(invoice.invoice_date,'YYYY-MM')
from public.invoice invoice
where invoice.invoice_id=line.invoice_id and line.service_month is null;

update public.sales_note_line line
set service_month=to_char(note.note_date,'YYYY-MM')
from public.credit_note note
where line.note_kind='CREDIT' and line.note_id=note.cn_id
  and line.service_month is null;

update public.sales_note_line line
set service_month=to_char(note.note_date,'YYYY-MM')
from public.debit_note note
where line.note_kind='DEBIT' and line.note_id=note.dn_id
  and line.service_month is null;

-- Copy the inferred/persisted dimensions into the corresponding income line
-- of existing accounting entries. Balance, tax and autorent lines remain
-- dimensionless because they do not represent the delivered service.
with commercial as (
  select invoice.journal_id,line.service_month,line.service_country_id,
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
  select accounting.journal_line_id,commercial.service_month,commercial.service_country_id
  from commercial join accounting using(journal_id,ordinality)
)
update public.journal_line target
set service_month=mapped.service_month,
    service_country_id=mapped.service_country_id
from mapped where target.journal_line_id=mapped.journal_line_id;

with commercial as (
  select note.journal_id,line.service_month,
    row_number() over(partition by note.journal_id order by line.line_id) ordinality
  from public.credit_note note
  join public.sales_note_line line
    on line.note_kind='CREDIT' and line.note_id=note.cn_id
  union all
  select note.journal_id,line.service_month,
    row_number() over(partition by note.journal_id order by line.line_id) ordinality
  from public.debit_note note
  join public.sales_note_line line
    on line.note_kind='DEBIT' and line.note_id=note.dn_id
), accounting as (
  select journal.journal_id,line.journal_line_id,
    row_number() over(partition by journal.journal_id order by line.journal_line_id) ordinality
  from public.journal journal
  join public.journal_line line using(journal_id)
  join public.chart_accounts account using(account_id)
  where journal.journal_type in('Nota de Crédito Cliente','Nota de Débito Cliente')
    and account.category='Ingreso'
), mapped as (
  select accounting.journal_line_id,commercial.service_month
  from commercial join accounting using(journal_id,ordinality)
)
update public.journal_line target
set service_month=mapped.service_month
from mapped where target.journal_line_id=mapped.journal_line_id;

do $$
begin
  if to_regprocedure('public.save_sales_invoice_before_service_month_fix(jsonb,bigint)') is null then
    alter function public.save_sales_invoice(jsonb,bigint)
      rename to save_sales_invoice_before_service_month_fix;
  end if;
  if to_regprocedure('public.save_sales_note_before_service_month_fix(text,jsonb,bigint)') is null then
    alter function public.save_sales_note(text,jsonb,bigint)
      rename to save_sales_note_before_service_month_fix;
  end if;
end
$$;

revoke all on function public.save_sales_invoice_before_service_month_fix(jsonb,bigint)
  from public,anon,authenticated;
revoke all on function public.save_sales_note_before_service_month_fix(text,jsonb,bigint)
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
  invoice_key bigint;
  journal_key bigint;
begin
  -- Preserve saved months when an older client edits without sending the key.
  if target_invoice_id is not null then
    with supplied as (
      select value item,ordinality
      from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) with ordinality
    ), stored as (
      select service_month,row_number() over(order by line_id) ordinality
      from public.sales_invoice_line where invoice_id=target_invoice_id
    )
    select coalesce(jsonb_agg(
      case when supplied.item ? 'service_month' then supplied.item
           else supplied.item||jsonb_build_object('service_month',stored.service_month)
      end order by supplied.ordinality
    ),'[]'::jsonb)
    into effective_lines
    from supplied left join stored using(ordinality);
    effective_payload:=jsonb_set(payload,'{lines}',effective_lines,true);
  end if;

  if exists(
    select 1 from jsonb_array_elements(coalesce(effective_payload->'lines','[]'::jsonb)) item
    where nullif(btrim(item->>'service_month'),'') is not null
      and item->>'service_month' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  )then
    raise exception 'Mes de servicio inválido. Utilice el formato AAAA-MM.';
  end if;

  result:=public.save_sales_invoice_before_service_month_fix(
    effective_payload,target_invoice_id
  );
  invoice_key:=(result->>'invoiceId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  with supplied as (
    select ordinality,nullif(btrim(value->>'service_month'),'') service_month
    from jsonb_array_elements(effective_payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from public.sales_invoice_line where invoice_id=invoice_key
  )
  update public.sales_invoice_line line
  set service_month=supplied.service_month
  from supplied join stored using(ordinality)
  where line.line_id=stored.line_id;

  with commercial as (
    select line.service_month,line.service_country_id,
      row_number() over(order by line.line_id) ordinality
    from public.sales_invoice_line line where line.invoice_id=invoice_key
  ), accounting as (
    select line.journal_line_id,
      row_number() over(order by line.journal_line_id) ordinality
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=journal_key and account.category='Ingreso'
  ), mapped as (
    select accounting.journal_line_id,commercial.service_month,commercial.service_country_id
    from commercial join accounting using(ordinality)
  )
  update public.journal_line target
  set service_month=mapped.service_month,
      service_country_id=mapped.service_country_id
  from mapped where target.journal_line_id=mapped.journal_line_id;

  return result;
end
$$;

create or replace function public.save_sales_note(
  p_kind text,p_payload jsonb,p_target_id bigint default null
)returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  normalized_kind text:=upper(p_kind);
  effective_payload jsonb:=p_payload;
  effective_lines jsonb;
  note_key bigint;
  journal_key bigint;
begin
  if normalized_kind not in('CREDIT','DEBIT') then
    raise exception 'Tipo de nota no válido.';
  end if;

  -- Preserve saved months when an older client edits without sending the key.
  if p_target_id is not null then
    with supplied as (
      select value item,ordinality
      from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb)) with ordinality
    ), stored as (
      select service_month,row_number() over(order by line_id) ordinality
      from public.sales_note_line
      where note_kind=normalized_kind and note_id=p_target_id
    )
    select coalesce(jsonb_agg(
      case when supplied.item ? 'service_month' then supplied.item
           else supplied.item||jsonb_build_object('service_month',stored.service_month)
      end order by supplied.ordinality
    ),'[]'::jsonb)
    into effective_lines
    from supplied left join stored using(ordinality);
    effective_payload:=jsonb_set(p_payload,'{lines}',effective_lines,true);
  end if;

  if exists(
    select 1 from jsonb_array_elements(coalesce(effective_payload->'lines','[]'::jsonb)) item
    where nullif(btrim(item->>'service_month'),'') is not null
      and item->>'service_month' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  )then
    raise exception 'Mes de servicio inválido. Utilice el formato AAAA-MM.';
  end if;

  result:=public.save_sales_note_before_service_month_fix(
    p_kind,effective_payload,p_target_id
  );
  note_key:=(result->>'noteId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  with supplied as (
    select ordinality,nullif(btrim(value->>'service_month'),'') service_month
    from jsonb_array_elements(effective_payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from public.sales_note_line
    where note_kind=normalized_kind and note_id=note_key
  )
  update public.sales_note_line line
  set service_month=supplied.service_month
  from supplied join stored using(ordinality)
  where line.line_id=stored.line_id;

  with commercial as (
    select line.service_month,row_number() over(order by line.line_id) ordinality
    from public.sales_note_line line
    where line.note_kind=normalized_kind and line.note_id=note_key
  ), accounting as (
    select line.journal_line_id,
      row_number() over(order by line.journal_line_id) ordinality
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=journal_key and account.category='Ingreso'
  ), mapped as (
    select accounting.journal_line_id,commercial.service_month
    from commercial join accounting using(ordinality)
  )
  update public.journal_line target
  set service_month=mapped.service_month
  from mapped where target.journal_line_id=mapped.journal_line_id;

  return result;
end
$$;

revoke all on function public.save_sales_invoice(jsonb,bigint),
  public.save_sales_note(text,jsonb,bigint) from public,anon;
grant execute on function public.save_sales_invoice(jsonb,bigint),
  public.save_sales_note(text,jsonb,bigint) to authenticated;

notify pgrst,'reload schema';
