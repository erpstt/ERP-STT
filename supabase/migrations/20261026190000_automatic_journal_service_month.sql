-- Service month is derived from the journal date for ordinary, payroll and
-- settlement journals. ASI_PEN remains line-controlled because a pending
-- invoice can correspond to a service month other than its posting month.

create or replace function public.automatic_journal_service_month(
  p_journal_id bigint
)
returns text
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select case
    when type_by_name.abbreviation in('ASI_DIA','ASI_NOM','ASI_LIQ')
      or(
        type_by_name.abbreviation is null
        and entry.journal_number ~ '^ASI_(DIA|NOM|LIQ)-'
      )
    then to_char(entry.journal_date,'YYYY-MM')
  end
  from public.journal entry
  left join lateral(
    select configured_type.abbreviation
    from public.transaction_types configured_type
    where configured_type.name=entry.journal_type
    order by configured_type.transaction_type_id
    limit 1
  )type_by_name on true
  where entry.journal_id=p_journal_id
$$;

revoke all on function public.automatic_journal_service_month(bigint)
  from public,anon,authenticated;

comment on function public.automatic_journal_service_month(bigint) is
  'Returns YYYY-MM from journal_date for ASI_DIA, ASI_NOM and ASI_LIQ; returns null for line-controlled types, including ASI_PEN.';

create or replace function public.enforce_automatic_journal_service_month()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  expected_month text;
begin
  expected_month:=public.automatic_journal_service_month(new.journal_id);
  if expected_month is not null then
    new.service_month:=expected_month;
  end if;
  return new;
end
$$;

revoke all on function public.enforce_automatic_journal_service_month()
  from public,anon,authenticated;

drop trigger if exists enforce_automatic_journal_service_month_trigger
  on public.journal_line;
create trigger enforce_automatic_journal_service_month_trigger
before insert or update of journal_id,service_month
on public.journal_line
for each row
execute function public.enforce_automatic_journal_service_month();

create or replace function public.refresh_automatic_journal_service_month()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  expected_month text;
begin
  expected_month:=public.automatic_journal_service_month(new.journal_id);
  if expected_month is not null then
    update public.journal_line line
    set service_month=expected_month
    where line.journal_id=new.journal_id
      and line.service_month is distinct from expected_month;
  end if;
  return new;
end
$$;

revoke all on function public.refresh_automatic_journal_service_month()
  from public,anon,authenticated;

drop trigger if exists refresh_automatic_journal_service_month_trigger
  on public.journal;
create trigger refresh_automatic_journal_service_month_trigger
after update of journal_date,journal_type,journal_number
on public.journal
for each row
when(
  old.journal_date is distinct from new.journal_date
  or old.journal_type is distinct from new.journal_type
  or old.journal_number is distinct from new.journal_number
)
execute function public.refresh_automatic_journal_service_month();

-- Metadata-only repair for existing rows. Suppressing user triggers while the
-- table is locked prevents a dimension backfill from rebuilding GL impacts or
-- mutating operational auxiliaries. DDL is transactional, so a failure also
-- restores the original trigger state.
alter table public.journal_line disable trigger user;

update public.journal_line line
set service_month=to_char(entry.journal_date,'YYYY-MM')
from public.journal entry
left join lateral(
  select configured_type.abbreviation
  from public.transaction_types configured_type
  where configured_type.name=entry.journal_type
  order by configured_type.transaction_type_id
  limit 1
)type_by_name on true
where line.journal_id=entry.journal_id
  and(
    type_by_name.abbreviation in('ASI_DIA','ASI_NOM','ASI_LIQ')
    or(
      type_by_name.abbreviation is null
      and entry.journal_number ~ '^ASI_(DIA|NOM|LIQ)-'
    )
  )
  and line.service_month is distinct from to_char(entry.journal_date,'YYYY-MM');

alter table public.journal_line enable trigger user;

-- Normalize the CSV at the database boundary as well. This keeps direct RPC
-- callers compatible and delegates every other validation/calculation to the
-- latest importer, including the authoritative template exchange rate added
-- by 20261026180000.
do $$
begin
  if to_regprocedure(
    'public.import_journal_csv_before_automatic_service_month(jsonb,boolean,bigint)'
  ) is null then
    alter function public.import_journal_csv(jsonb,boolean,bigint)
      rename to import_journal_csv_before_automatic_service_month;
  end if;
end
$$;

revoke all on function public.import_journal_csv_before_automatic_service_month(
  jsonb,boolean,bigint
) from public,anon,authenticated;

create or replace function public.import_journal_csv(
  p_rows jsonb,
  p_preview boolean,
  p_subsidiary_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  normalized_rows jsonb:=p_rows;
begin
  if jsonb_typeof(p_rows)='array' then
    select coalesce(jsonb_agg(
      case
        when row_value->>'tipo_asiento' in('ASI_DIA','ASI_NOM','ASI_LIQ')
        then jsonb_set(row_value,'{mes_servicio}',to_jsonb(''::text),true)
        else row_value
      end
      order by ordinal
    ),'[]'::jsonb)
    into normalized_rows
    from jsonb_array_elements(p_rows) with ordinality source(row_value,ordinal);
  end if;

  return public.import_journal_csv_before_automatic_service_month(
    normalized_rows,p_preview,p_subsidiary_id
  );
end
$$;

comment on function public.import_journal_csv(jsonb,boolean,bigint) is
  'Normalizes service_month for ASI_DIA, ASI_NOM and ASI_LIQ, then delegates to the authoritative CSV importer; ASI_PEN keeps its explicit line value.';

revoke all on function public.import_journal_csv(jsonb,boolean,bigint)
  from public,anon;
grant execute on function public.import_journal_csv(jsonb,boolean,bigint)
  to authenticated;

notify pgrst,'reload schema';
