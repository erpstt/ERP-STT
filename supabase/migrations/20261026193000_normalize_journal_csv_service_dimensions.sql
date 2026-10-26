-- Service dimensions are line-controlled only for pending-invoice journals.
-- Ordinary, payroll and settlement journals derive service_month from their
-- posting date and ignore a country accidentally copied into the CSV.

do $$
begin
  if to_regprocedure(
    'public.import_journal_csv_before_automatic_service_month(jsonb,boolean,bigint)'
  ) is null then
    raise exception 'Apply 20261026190000_automatic_journal_service_month.sql before this migration.';
  end if;
end
$$;

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
        then (row_value-'pais_servicio')
          ||jsonb_build_object('mes_servicio','')
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
  'Normalizes service month and country for ASI_DIA, ASI_NOM and ASI_LIQ, then delegates to the authoritative CSV importer; ASI_PEN keeps and validates both explicit dimensions.';

revoke all on function public.import_journal_csv(jsonb,boolean,bigint)
  from public,anon;
grant execute on function public.import_journal_csv(jsonb,boolean,bigint)
  to authenticated;

notify pgrst,'reload schema';
