create or replace function account_belongs_to_group(
  p_account_id bigint,
  p_group_pattern text
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive ancestry as (
    select g.group_id, g.parent_id, g.group_name
      from chart_accounts a
      join account_group g on g.group_id = a.account_group_id
     where a.account_id = p_account_id
    union all
    select parent.group_id, parent.parent_id, parent.group_name
      from account_group parent
      join ancestry child on child.parent_id = parent.group_id
  )
  select exists (
    select 1
      from ancestry
     where group_name ~* p_group_pattern
  );
$$;

create or replace function asset_category_options()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'subsidiary', jsonb_build_object('id', s.subsidiary_id, 'name', s.name),
    'assetAccounts', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', a.account_id, 'number', a.account_number, 'name', a.account_name)
        order by a.account_number
      )
        from chart_accounts a
        join account_subsidiaries x using (account_id)
       where x.subsidiary_id = s.subsidiary_id
         and x.is_active
         and a.accepts_entries
         and not a.is_inactive
         and account_belongs_to_group(a.account_id, 'propiedad.*planta.*equipo')
    ), '[]'::jsonb),
    'depreciationAccounts', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', a.account_id, 'number', a.account_number, 'name', a.account_name)
        order by a.account_number
      )
        from chart_accounts a
        join account_subsidiaries x using (account_id)
       where x.subsidiary_id = s.subsidiary_id
         and x.is_active
         and a.accepts_entries
         and not a.is_inactive
         and account_belongs_to_group(a.account_id, 'depreciaci.n acumulada')
    ), '[]'::jsonb),
    'expenseAccounts', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', a.account_id, 'number', a.account_number, 'name', a.account_name)
        order by a.account_number
      )
        from chart_accounts a
        join account_subsidiaries x using (account_id)
       where x.subsidiary_id = s.subsidiary_id
         and x.is_active
         and a.accepts_entries
         and not a.is_inactive
         and account_belongs_to_group(a.account_id, 'depreciaci.n y amortizaci.n')
    ), '[]'::jsonb)
  )
  from subsidiaries s
  where s.subsidiary_id = active_subsidiary_id();
$$;

create or replace function validate_asset_category_account_groups()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not account_belongs_to_group(new.asset_account_id, 'propiedad.*planta.*equipo') then
    raise exception 'La cuenta de activo debe pertenecer al grupo Propiedad, Planta y Equipo.';
  end if;
  if not account_belongs_to_group(new.depreciation_account_id, 'depreciaci.n acumulada') then
    raise exception 'La cuenta de depreciación debe pertenecer al grupo Depreciación Acumulada.';
  end if;
  if not account_belongs_to_group(new.depreciation_expense_account_id, 'depreciaci.n y amortizaci.n') then
    raise exception 'La cuenta de gasto debe pertenecer al grupo Depreciación y Amortización.';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_asset_category_account_groups_trigger on asset_category;
create trigger validate_asset_category_account_groups_trigger
before insert or update of asset_account_id, depreciation_account_id, depreciation_expense_account_id
on asset_category
for each row execute function validate_asset_category_account_groups();

revoke all on function account_belongs_to_group(bigint, text) from public, anon;
grant execute on function account_belongs_to_group(bigint, text) to authenticated;
grant execute on function asset_category_options() to authenticated;

notify pgrst, 'reload schema';
