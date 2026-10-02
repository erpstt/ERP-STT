-- Add País de servicio to customer credit/debit note lines and keep it linked
-- to the source invoice, the editable document and the generated journal.
alter table public.sales_note_line
  add column if not exists service_country_id bigint
  references public.countries(country_id) on delete restrict;

create index if not exists sales_note_line_service_country_idx
  on public.sales_note_line(service_country_id);

-- Existing notes inherit the country from the corresponding source invoice
-- line. If that historical invoice line has no country, use the subsidiary.
with note_lines as (
  select line.line_id,note.invoice_id,invoice.subsidiary_id,
    row_number() over(partition by line.note_kind,line.note_id order by line.line_id) ordinality
  from public.sales_note_line line
  join public.credit_note note on line.note_kind='CREDIT' and note.cn_id=line.note_id
  join public.invoice invoice using(invoice_id)
  union all
  select line.line_id,note.invoice_id,invoice.subsidiary_id,
    row_number() over(partition by line.note_kind,line.note_id order by line.line_id) ordinality
  from public.sales_note_line line
  join public.debit_note note on line.note_kind='DEBIT' and note.dn_id=line.note_id
  join public.invoice invoice using(invoice_id)
), invoice_lines as (
  select line.invoice_id,line.service_country_id,
    row_number() over(partition by line.invoice_id order by line.line_id) ordinality
  from public.sales_invoice_line line
), mapped as (
  select note.line_id,coalesce(source.service_country_id,subsidiary.country_id) service_country_id
  from note_lines note
  left join invoice_lines source using(invoice_id,ordinality)
  join public.subsidiaries subsidiary on subsidiary.subsidiary_id=note.subsidiary_id
)
update public.sales_note_line target
set service_country_id=mapped.service_country_id
from mapped
where target.line_id=mapped.line_id and target.service_country_id is null;

-- Backfill the matching income lines in the accounting entries.
with commercial as (
  select note.journal_id,line.service_country_id,
    row_number() over(partition by note.journal_id order by line.line_id) ordinality
  from public.credit_note note
  join public.sales_note_line line
    on line.note_kind='CREDIT' and line.note_id=note.cn_id
  union all
  select note.journal_id,line.service_country_id,
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
  select accounting.journal_line_id,commercial.service_country_id
  from commercial join accounting using(journal_id,ordinality)
)
update public.journal_line target
set service_country_id=mapped.service_country_id
from mapped where target.journal_line_id=mapped.journal_line_id;

do $$
begin
  if to_regprocedure('public.save_sales_note_before_service_country_fix(text,jsonb,bigint)') is null then
    alter function public.save_sales_note(text,jsonb,bigint)
      rename to save_sales_note_before_service_country_fix;
  end if;
end
$$;

revoke all on function public.save_sales_note_before_service_country_fix(text,jsonb,bigint)
  from public,anon,authenticated;

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
  subsidiary_country_key bigint;
begin
  if normalized_kind not in('CREDIT','DEBIT') then
    raise exception 'Tipo de nota no válido.';
  end if;

  select subsidiary.country_id into subsidiary_country_key
  from public.invoice invoice
  join public.subsidiaries subsidiary using(subsidiary_id)
  where invoice.invoice_id=nullif(p_payload->>'invoice_id','')::bigint
    and invoice.subsidiary_id=public.active_subsidiary_id();

  with supplied as (
    select value item,ordinality
    from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb)) with ordinality
  ), stored as (
    select service_country_id,row_number() over(order by line_id) ordinality
    from public.sales_note_line
    where p_target_id is not null
      and note_kind=normalized_kind and note_id=p_target_id
  ), source as (
    select service_country_id,row_number() over(order by line_id) ordinality
    from public.sales_invoice_line
    where invoice_id=nullif(p_payload->>'invoice_id','')::bigint
  )
  select coalesce(jsonb_agg(
    supplied.item||jsonb_build_object(
      'service_country_id',coalesce(
        case when coalesce(supplied.item->>'service_country_id','') ~ '^[0-9]+$'
          then (supplied.item->>'service_country_id')::bigint end,
        stored.service_country_id,source.service_country_id,subsidiary_country_key
      )
    ) order by supplied.ordinality
  ),'[]'::jsonb)
  into effective_lines
  from supplied
  left join stored using(ordinality)
  left join source using(ordinality);
  effective_payload:=jsonb_set(p_payload,'{lines}',effective_lines,true);

  if exists(
    select 1 from jsonb_array_elements(effective_payload->'lines') item
    where nullif(item->>'service_country_id','') is null
      or coalesce(item->>'service_country_id','') !~ '^[0-9]+$'
      or not exists(
        select 1 from public.countries country
        where country.country_id=(item->>'service_country_id')::bigint
      )
  )then
    raise exception 'Seleccione un País de servicio válido en cada línea de la nota.';
  end if;

  result:=public.save_sales_note_before_service_country_fix(
    p_kind,effective_payload,p_target_id
  );
  note_key:=(result->>'noteId')::bigint;
  journal_key:=(result->>'journalId')::bigint;

  with supplied as (
    select ordinality,(value->>'service_country_id')::bigint service_country_id
    from jsonb_array_elements(effective_payload->'lines') with ordinality
  ), stored as (
    select line_id,row_number() over(order by line_id) ordinality
    from public.sales_note_line
    where note_kind=normalized_kind and note_id=note_key
  )
  update public.sales_note_line line
  set service_country_id=supplied.service_country_id
  from supplied join stored using(ordinality)
  where line.line_id=stored.line_id;

  with commercial as (
    select line.service_country_id,
      row_number() over(order by line.line_id) ordinality
    from public.sales_note_line line
    where line.note_kind=normalized_kind and line.note_id=note_key
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

revoke all on function public.save_sales_note(text,jsonb,bigint) from public,anon;
grant execute on function public.save_sales_note(text,jsonb,bigint) to authenticated;

notify pgrst,'reload schema';
