-- Replicate the canonical fixed-asset categories to every active subsidiary.
-- Categories remain subsidiary-owned because the fixed-asset workflows and RLS
-- resolve them by subsidiary. Existing target definitions are never overwritten.

create or replace function public.replicate_asset_categories_to_active_subsidiaries(
  p_source_subsidiary_id bigint,
  p_apply boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_name text;
  source_category_count integer;
  target_count integer;
  planned_count integer;
  unchanged_count integer;
  created_count integer := 0;
  conflict_rows jsonb := '[]'::jsonb;
  account_issue_rows jsonb := '[]'::jsonb;
begin
  select subsidiary.name
    into source_name
    from public.subsidiaries subsidiary
   where subsidiary.subsidiary_id = p_source_subsidiary_id
     and subsidiary.is_active;

  if source_name is null then
    raise exception 'La subsidiaria origen de categorías no existe o está inactiva.';
  end if;

  select count(*)::integer
    into source_category_count
    from public.asset_category category
   where category.subsidiary_id = p_source_subsidiary_id;

  if source_category_count = 0 then
    raise exception 'La subsidiaria origen % no tiene categorías de activos para copiar.', source_name;
  end if;

  -- Serialise this catalogue copy without blocking normal fixed-asset activity.
  perform pg_advisory_xact_lock(hashtextextended('replicate-asset-categories', 0));

  select count(*)::integer
    into target_count
    from public.subsidiaries subsidiary
   where subsidiary.is_active
     and subsidiary.subsidiary_id <> p_source_subsidiary_id;

  -- A copied category is only valid when each referenced posting account is
  -- active, accepts entries and is enabled for the target subsidiary.
  with required_accounts as (
    select
      target.subsidiary_id,
      target.name as subsidiary_name,
      source.category_code,
      source.category_name,
      required.account_role,
      required.account_id
    from public.asset_category source
    cross join public.subsidiaries target
    cross join lateral (
      values
        ('ACTIVO'::text, source.asset_account_id),
        ('DEPRECIACION_ACUMULADA'::text, source.depreciation_account_id),
        ('GASTO_DEPRECIACION'::text, source.depreciation_expense_account_id)
    ) required(account_role, account_id)
    where source.subsidiary_id = p_source_subsidiary_id
      and target.is_active
      and target.subsidiary_id <> p_source_subsidiary_id
      and required.account_id is not null
  ), issues as (
    select
      required.*,
      account.account_number,
      account.account_name,
      case
        when account.account_id is null then 'CUENTA_NO_EXISTE'
        when account.is_inactive then 'CUENTA_INACTIVA'
        when not account.accepts_entries then 'CUENTA_NO_RECIBE_MOVIMIENTOS'
        when scope.account_id is null then 'CUENTA_NO_ASIGNADA_A_SUBSIDIARIA'
        when not scope.is_active then 'CUENTA_INACTIVA_EN_SUBSIDIARIA'
      end as reason
    from required_accounts required
    left join public.chart_accounts account
      on account.account_id = required.account_id
    left join public.account_subsidiaries scope
      on scope.account_id = required.account_id
     and scope.subsidiary_id = required.subsidiary_id
    where account.account_id is null
       or account.is_inactive
       or not account.accepts_entries
       or scope.account_id is null
       or not scope.is_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'subsidiaryId', issue.subsidiary_id,
    'subsidiary', issue.subsidiary_name,
    'categoryCode', issue.category_code,
    'category', issue.category_name,
    'accountRole', issue.account_role,
    'accountId', issue.account_id,
    'account', concat_ws(' · ', issue.account_number, issue.account_name),
    'reason', issue.reason
  ) order by issue.subsidiary_name, issue.category_code, issue.account_role), '[]'::jsonb)
    into account_issue_rows
    from issues issue;

  -- A row with the same code or the same name is considered the same logical
  -- category. It is skipped only when every canonical field already matches;
  -- otherwise it is reported as a conflict and remains untouched.
  with matches as (
    select
      target.subsidiary_id,
      target.name as subsidiary_name,
      source.category_code as source_code,
      source.category_name as source_name,
      source.description as source_description,
      source.useful_life_months as source_life,
      source.depreciation_method as source_method,
      source.residual_value_percentage as source_residual,
      source.asset_account_id as source_asset_account,
      source.depreciation_account_id as source_depreciation_account,
      source.depreciation_expense_account_id as source_expense_account,
      source.is_active as source_active,
      existing.category_id as existing_id,
      existing.category_code as existing_code,
      existing.category_name as existing_name,
      existing.description as existing_description,
      existing.useful_life_months as existing_life,
      existing.depreciation_method as existing_method,
      existing.residual_value_percentage as existing_residual,
      existing.asset_account_id as existing_asset_account,
      existing.depreciation_account_id as existing_depreciation_account,
      existing.depreciation_expense_account_id as existing_expense_account,
      existing.is_active as existing_active
    from public.asset_category source
    cross join public.subsidiaries target
    join public.asset_category existing
      on existing.subsidiary_id = target.subsidiary_id
     and (
       upper(trim(existing.category_code)) = upper(trim(source.category_code))
       or lower(trim(existing.category_name)) = lower(trim(source.category_name))
     )
    where source.subsidiary_id = p_source_subsidiary_id
      and target.is_active
      and target.subsidiary_id <> p_source_subsidiary_id
  ), conflicts as (
    select match_row.*,
      array_remove(array[
        case when upper(trim(match_row.existing_code)) is distinct from upper(trim(match_row.source_code)) then 'codigo' end,
        case when lower(trim(match_row.existing_name)) is distinct from lower(trim(match_row.source_name)) then 'nombre' end,
        case when match_row.existing_description is distinct from match_row.source_description then 'descripcion' end,
        case when match_row.existing_life is distinct from match_row.source_life then 'vida_util' end,
        case when match_row.existing_method is distinct from match_row.source_method then 'metodo' end,
        case when match_row.existing_residual is distinct from match_row.source_residual then 'valor_residual' end,
        case when match_row.existing_asset_account is distinct from match_row.source_asset_account then 'cuenta_activo' end,
        case when match_row.existing_depreciation_account is distinct from match_row.source_depreciation_account then 'cuenta_depreciacion' end,
        case when match_row.existing_expense_account is distinct from match_row.source_expense_account then 'cuenta_gasto' end,
        case when match_row.existing_active is distinct from match_row.source_active then 'estado' end
      ], null)::text[] as different_fields
    from matches match_row
    where upper(trim(match_row.existing_code)) is distinct from upper(trim(match_row.source_code))
       or lower(trim(match_row.existing_name)) is distinct from lower(trim(match_row.source_name))
       or match_row.existing_description is distinct from match_row.source_description
       or match_row.existing_life is distinct from match_row.source_life
       or match_row.existing_method is distinct from match_row.source_method
       or match_row.existing_residual is distinct from match_row.source_residual
       or match_row.existing_asset_account is distinct from match_row.source_asset_account
       or match_row.existing_depreciation_account is distinct from match_row.source_depreciation_account
       or match_row.existing_expense_account is distinct from match_row.source_expense_account
       or match_row.existing_active is distinct from match_row.source_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'subsidiaryId', conflict.subsidiary_id,
    'subsidiary', conflict.subsidiary_name,
    'canonicalCode', conflict.source_code,
    'canonicalName', conflict.source_name,
    'existingCategoryId', conflict.existing_id,
    'existingCode', conflict.existing_code,
    'existingName', conflict.existing_name,
    'differentFields', to_jsonb(conflict.different_fields)
  ) order by conflict.subsidiary_name, conflict.source_code, conflict.existing_id), '[]'::jsonb)
    into conflict_rows
    from conflicts conflict;

  select count(*)::integer
    into planned_count
    from public.asset_category source
    cross join public.subsidiaries target
   where source.subsidiary_id = p_source_subsidiary_id
     and target.is_active
     and target.subsidiary_id <> p_source_subsidiary_id
     and not exists (
       select 1
         from public.asset_category existing
        where existing.subsidiary_id = target.subsidiary_id
          and (
            upper(trim(existing.category_code)) = upper(trim(source.category_code))
            or lower(trim(existing.category_name)) = lower(trim(source.category_name))
          )
     );

  select count(*)::integer
    into unchanged_count
    from public.asset_category source
    cross join public.subsidiaries target
    join public.asset_category existing
      on existing.subsidiary_id = target.subsidiary_id
     and upper(trim(existing.category_code)) = upper(trim(source.category_code))
     and lower(trim(existing.category_name)) = lower(trim(source.category_name))
     and existing.description is not distinct from source.description
     and existing.useful_life_months is not distinct from source.useful_life_months
     and existing.depreciation_method is not distinct from source.depreciation_method
     and existing.residual_value_percentage is not distinct from source.residual_value_percentage
     and existing.asset_account_id is not distinct from source.asset_account_id
     and existing.depreciation_account_id is not distinct from source.depreciation_account_id
     and existing.depreciation_expense_account_id is not distinct from source.depreciation_expense_account_id
     and existing.is_active is not distinct from source.is_active
   where source.subsidiary_id = p_source_subsidiary_id
     and target.is_active
     and target.subsidiary_id <> p_source_subsidiary_id;

  if p_apply and (jsonb_array_length(conflict_rows) > 0 or jsonb_array_length(account_issue_rows) > 0) then
    raise exception using
      message = 'No se copiaron las categorías de activos porque existen conflictos que requieren corrección.',
      detail = jsonb_build_object(
        'conflicts', conflict_rows,
        'accountIssues', account_issue_rows
      )::text,
      hint = 'Revise las categorías existentes y la asignación de cuentas por subsidiaria. Ningún registro fue sobrescrito.';
  end if;

  if p_apply then
    insert into public.asset_category (
      category_code,
      category_name,
      description,
      subsidiary_id,
      useful_life_months,
      depreciation_method,
      residual_value_percentage,
      asset_account_id,
      depreciation_account_id,
      depreciation_expense_account_id,
      is_active
    )
    select
      source.category_code,
      source.category_name,
      source.description,
      target.subsidiary_id,
      source.useful_life_months,
      source.depreciation_method,
      source.residual_value_percentage,
      source.asset_account_id,
      source.depreciation_account_id,
      source.depreciation_expense_account_id,
      source.is_active
    from public.asset_category source
    cross join public.subsidiaries target
    where source.subsidiary_id = p_source_subsidiary_id
      and target.is_active
      and target.subsidiary_id <> p_source_subsidiary_id
      and not exists (
        select 1
          from public.asset_category existing
         where existing.subsidiary_id = target.subsidiary_id
           and (
             upper(trim(existing.category_code)) = upper(trim(source.category_code))
             or lower(trim(existing.category_name)) = lower(trim(source.category_name))
           )
      )
    on conflict do nothing;

    get diagnostics created_count = row_count;
  end if;

  return jsonb_build_object(
    'sourceSubsidiaryId', p_source_subsidiary_id,
    'sourceSubsidiary', source_name,
    'sourceCategories', source_category_count,
    'targetSubsidiaries', target_count,
    'planned', planned_count,
    'created', created_count,
    'unchanged', unchanged_count,
    'conflictCount', jsonb_array_length(conflict_rows),
    'conflicts', conflict_rows,
    'accountIssueCount', jsonb_array_length(account_issue_rows),
    'accountIssues', account_issue_rows,
    'applied', p_apply
  );
end;
$$;

revoke all on function public.replicate_asset_categories_to_active_subsidiaries(bigint, boolean)
  from public, anon, authenticated;

do $$
declare
  source_id bigint;
  matching_sources integer;
  copy_result jsonb;
begin
  select count(*)::integer, min(subsidiary_id)
    into matching_sources, source_id
    from public.subsidiaries
   where upper(trim(name)) = 'EMPRESA DE PRUEBAS'
     and is_active;

  if matching_sources <> 1 then
    raise exception 'Se esperaba una única subsidiaria activa llamada EMPRESA DE PRUEBAS; se encontraron %.', matching_sources;
  end if;

  select public.replicate_asset_categories_to_active_subsidiaries(source_id, true)
    into copy_result;

  raise notice 'Resultado de copia de categorías de activos: %', copy_result;
end;
$$;

