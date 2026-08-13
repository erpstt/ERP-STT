create or replace function public.validate_tax_type_level_four_accounts()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.asset_account_id is not null and not exists(
    select 1 from public.chart_accounts account
    join public.account_group group_record on group_record.group_id=account.account_group_id
    where account.account_id=new.asset_account_id and account.level=4 and not account.is_inactive and group_record.group_code='117'
  ) then raise exception 'La Cuenta Activo debe pertenecer al grupo Impuestos por Cobrar y Anticipados.'; end if;
  if new.liability_account_id is not null and not exists(
    select 1 from public.chart_accounts account
    join public.account_group group_record on group_record.group_id=account.account_group_id
    where account.account_id=new.liability_account_id and account.level=4 and not account.is_inactive and group_record.group_code='215'
  ) then raise exception 'La Cuenta Pasivo debe pertenecer al grupo Impuestos por Pagar.'; end if;
  return new;
end;$$;
