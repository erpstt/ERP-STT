-- The deployed database did not contain journal_line.service_month even though
-- the UI already sent it. Add the physical column and persist both service
-- dimensions through create, update and pending-invoice reversals.
alter table public.journal_line
  add column if not exists service_month text;

alter table public.journal_line
  drop constraint if exists journal_line_service_month_format;

alter table public.journal_line
  add constraint journal_line_service_month_format
  check(service_month is null or service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- The original values sent by the browser were not stored and cannot be
-- recovered. Use the journal month as the safest historical default.
update public.journal_line line
set service_month=to_char(entry.journal_date,'YYYY-MM')
from public.journal entry
where entry.journal_id=line.journal_id
  and (entry.journal_type='Asientos Pendientes de Facturar'
       or entry.journal_number like 'ASI_PEN-%')
  and line.service_month is null;

update public.journal_line line
set service_country_id=subsidiary.country_id
from public.journal entry
join public.subsidiaries subsidiary
  on subsidiary.subsidiary_id=entry.subsidiary_id
where entry.journal_id=line.journal_id
  and (entry.journal_type='Asientos Pendientes de Facturar'
       or entry.journal_number like 'ASI_PEN-%')
  and line.service_country_id is null
  and subsidiary.country_id is not null;

alter function public.create_journal_entry(jsonb)
  rename to create_journal_entry_before_service_month_fix;

revoke all on function public.create_journal_entry_before_service_month_fix(jsonb)
  from public,anon,authenticated;

create function public.create_journal_entry(payload jsonb)
returns bigint
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  jid bigint;
  pending_type text;
begin
  select name into pending_type
  from public.transaction_types
  where abbreviation='ASI_PEN'
  limit 1;

  if payload->>'journal_type'=pending_type and exists(
    select 1
    from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) item
    where nullif(btrim(item->>'service_month'),'') is not null
      and item->>'service_month' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  ) then
    raise exception 'Mes de servicio inválido. Utilice el formato AAAA-MM.';
  end if;

  jid:=public.create_journal_entry_before_service_month_fix(payload);

  with supplied as (
    select ordinality,
      case when payload->>'journal_type'=pending_type
        then nullif(btrim(value->>'service_month'),'')
      end service_month
    from jsonb_array_elements(payload->'lines') with ordinality
  ), stored as (
    select journal_line_id,row_number() over(order by journal_line_id) ordinality
    from public.journal_line
    where journal_id=jid
  )
  update public.journal_line line
  set service_month=supplied.service_month
  from supplied join stored using(ordinality)
  where line.journal_line_id=stored.journal_line_id;

  return jid;
end$$;

revoke all on function public.create_journal_entry(jsonb) from public,anon;
grant execute on function public.create_journal_entry(jsonb) to authenticated;

alter function public.update_journal_entry(bigint,jsonb)
  rename to update_journal_entry_before_service_month_fix;

revoke all on function public.update_journal_entry_before_service_month_fix(bigint,jsonb)
  from public,anon,authenticated;

create function public.update_journal_entry(target_journal_id bigint,payload jsonb)
returns bigint
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  jid bigint;
  pending_type text;
  effective_payload jsonb:=payload;
  effective_lines jsonb;
begin
  select name into pending_type
  from public.transaction_types
  where abbreviation='ASI_PEN'
  limit 1;

  -- Preserve the saved month when an older client omits this key entirely.
  if payload->>'journal_type'=pending_type then
    with supplied as (
      select value item,ordinality
      from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) with ordinality
    ), stored as (
      select service_month,row_number() over(order by journal_line_id) ordinality
      from public.journal_line
      where journal_id=target_journal_id
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

  if effective_payload->>'journal_type'=pending_type and exists(
    select 1
    from jsonb_array_elements(coalesce(effective_payload->'lines','[]'::jsonb)) item
    where nullif(btrim(item->>'service_month'),'') is not null
      and item->>'service_month' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  ) then
    raise exception 'Mes de servicio inválido. Utilice el formato AAAA-MM.';
  end if;

  jid:=public.update_journal_entry_before_service_month_fix(target_journal_id,effective_payload);

  with supplied as (
    select ordinality,
      case when effective_payload->>'journal_type'=pending_type
        then nullif(btrim(value->>'service_month'),'')
      end service_month
    from jsonb_array_elements(effective_payload->'lines') with ordinality
  ), stored as (
    select journal_line_id,row_number() over(order by journal_line_id) ordinality
    from public.journal_line
    where journal_id=jid
  )
  update public.journal_line line
  set service_month=supplied.service_month
  from supplied join stored using(ordinality)
  where line.journal_line_id=stored.journal_line_id;

  return jid;
end$$;

revoke all on function public.update_journal_entry(bigint,jsonb) from public,anon;
grant execute on function public.update_journal_entry(bigint,jsonb) to authenticated;

-- Backfill all reversals already created by matching their line order to the
-- source ASI_PEN line order.
with source_lines as (
  select line.journal_id,line.service_month,line.service_country_id,
    row_number() over(partition by line.journal_id order by line.journal_line_id) ordinality
  from public.journal_line line
), reversal_lines as (
  select line.journal_line_id,entry.reversed_from_journal_id source_journal_id,
    row_number() over(partition by line.journal_id order by line.journal_line_id) ordinality
  from public.journal_line line
  join public.journal entry on entry.journal_id=line.journal_id
  where entry.journal_type='Reversión de Pendiente de Facturar'
    and entry.reversed_from_journal_id is not null
), mapped as (
  select reversal.journal_line_id,source.service_month,source.service_country_id
  from reversal_lines reversal
  join source_lines source
    on source.journal_id=reversal.source_journal_id
   and source.ordinality=reversal.ordinality
)
update public.journal_line target
set service_month=mapped.service_month,
    service_country_id=mapped.service_country_id
from mapped
where target.journal_line_id=mapped.journal_line_id;

alter function public.reverse_pending_invoice_journal(bigint,jsonb)
  rename to reverse_pending_invoice_journal_before_service_dimensions;

revoke all on function public.reverse_pending_invoice_journal_before_service_dimensions(bigint,jsonb)
  from public,anon,authenticated;

create function public.reverse_pending_invoice_journal(p_journal_id bigint,p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  result jsonb;
  reversal_journal_id bigint;
begin
  result:=public.reverse_pending_invoice_journal_before_service_dimensions(p_journal_id,p_payload);
  reversal_journal_id:=(result->>'journalId')::bigint;

  with source_lines as (
    select service_month,service_country_id,
      row_number() over(order by journal_line_id) ordinality
    from public.journal_line
    where journal_id=p_journal_id
  ), reversal_lines as (
    select journal_line_id,
      row_number() over(order by journal_line_id) ordinality
    from public.journal_line
    where journal_id=reversal_journal_id
  ), mapped as (
    select reversal.journal_line_id,source.service_month,source.service_country_id
    from reversal_lines reversal
    join source_lines source using(ordinality)
  )
  update public.journal_line target
  set service_month=mapped.service_month,
      service_country_id=mapped.service_country_id
  from mapped
  where target.journal_line_id=mapped.journal_line_id;

  return result;
end$$;

revoke all on function public.reverse_pending_invoice_journal(bigint,jsonb)
  from public,anon;
grant execute on function public.reverse_pending_invoice_journal(bigint,jsonb)
  to authenticated;

notify pgrst,'reload schema';
