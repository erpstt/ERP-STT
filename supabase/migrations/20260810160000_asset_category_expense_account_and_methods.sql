alter table public.asset_category
  add column if not exists depreciation_expense_account_id bigint
  references public.chart_accounts(account_id);

alter table public.asset_category
  drop constraint if exists asset_category_expense_account_required;

alter table public.asset_category
  add constraint asset_category_expense_account_required
  check (depreciation_expense_account_id is not null) not valid;

alter table public.asset_category
  drop constraint if exists asset_category_depreciation_method_allowed;

alter table public.asset_category
  add constraint asset_category_depreciation_method_allowed
  check (depreciation_method in (
    'Línea Recta',
    'Suma de los Dígitos de los Años',
    'No Depreciable'
  )) not valid;

alter table public.asset_category
  drop constraint if exists asset_category_distinct_accounts;

alter table public.asset_category
  add constraint asset_category_distinct_accounts
  check (
    asset_account_id <> depreciation_account_id
    and asset_account_id <> depreciation_expense_account_id
    and depreciation_account_id <> depreciation_expense_account_id
  ) not valid;
