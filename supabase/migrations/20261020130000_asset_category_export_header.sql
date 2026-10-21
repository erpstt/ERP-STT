-- Encabezado liviano para las descargas del catálogo de categorías de activos.
-- La subsidiaria siempre se obtiene del contexto autenticado y no del navegador.
create or replace function public.asset_category_report(p_filters jsonb default '{}')
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
with scope as (
  select s.subsidiary_id, s.name
  from public.subsidiaries s
  where s.subsidiary_id=public.active_subsidiary_id()
)
select jsonb_build_object(
  'subsidiary',jsonb_build_object('id',scope.subsidiary_id,'name',scope.name),
  'rows',coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',c.category_id,
        'code',c.category_code,
        'name',c.category_name,
        'description',c.description,
        'usefulLife',c.useful_life_months,
        'method',c.depreciation_method,
        'residual',c.residual_value_percentage,
        'active',c.is_active,
        'assetAccountId',c.asset_account_id,
        'assetAccount',aa.account_number||' · '||aa.account_name,
        'depreciationAccountId',c.depreciation_account_id,
        'depreciationAccount',da.account_number||' · '||da.account_name,
        'expenseAccountId',c.depreciation_expense_account_id,
        'expenseAccount',case when ea.account_id is null then 'No aplica' else ea.account_number||' · '||ea.account_name end,
        'assets',coalesce(asset_totals.total,0)
      )
      order by c.category_name,c.category_id
    )
    from public.asset_category c
    join public.chart_accounts aa on aa.account_id=c.asset_account_id
    join public.chart_accounts da on da.account_id=c.depreciation_account_id
    left join public.chart_accounts ea on ea.account_id=c.depreciation_expense_account_id
    left join lateral(
      select count(*) total
      from public.asset a
      where a.category_id=c.category_id
        and a.subsidiary_id=scope.subsidiary_id
        and a.opening_reversed_at is null
    )asset_totals on true
    where c.subsidiary_id=scope.subsidiary_id
      and(
        coalesce(nullif(trim(p_filters->>'search'),''),'')=''
        or concat_ws(' ',c.category_code,c.category_name,c.description) ilike '%'||trim(p_filters->>'search')||'%'
      )
      and(
        coalesce(p_filters->>'status','ALL')='ALL'
        or c.is_active=(p_filters->>'status'='ACTIVE')
      )
  ),'[]'::jsonb)
)
from scope
$$;

revoke all on function public.asset_category_report(jsonb) from public,anon;
grant execute on function public.asset_category_report(jsonb) to authenticated;

notify pgrst,'reload schema';
