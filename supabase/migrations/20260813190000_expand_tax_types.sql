alter table public.tax_types add column if not exists applies_to text;
alter table public.tax_types add column if not exists asset_account_id bigint references public.chart_accounts(account_id) on delete restrict;
alter table public.tax_types add column if not exists liability_account_id bigint references public.chart_accounts(account_id) on delete restrict;

update public.tax_types set applies_to='Ambos' where applies_to is null;
alter table public.tax_types alter column applies_to set default 'Ambos';
alter table public.tax_types alter column applies_to set not null;
alter table public.tax_types drop constraint if exists tax_types_applies_to_allowed;
alter table public.tax_types add constraint tax_types_applies_to_allowed check(applies_to in ('Compras','Ventas','Ambos'));

create or replace function public.validate_tax_type_level_four_accounts()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.asset_account_id is not null and not exists(select 1 from public.chart_accounts account join public.account_group group_record on group_record.group_id=account.account_group_id where account.account_id=new.asset_account_id and account.level=4 and not account.is_inactive and group_record.group_code='117') then
    raise exception 'La Cuenta Activo debe pertenecer al grupo Impuestos por Cobrar y Anticipados.';
  end if;
  if new.liability_account_id is not null and not exists(select 1 from public.chart_accounts account join public.account_group group_record on group_record.group_id=account.account_group_id where account.account_id=new.liability_account_id and account.level=4 and not account.is_inactive and group_record.group_code='215') then
    raise exception 'La Cuenta Pasivo debe pertenecer al grupo Impuestos por Pagar.';
  end if;
  return new;
end;$$;

drop trigger if exists tax_type_level_four_accounts on public.tax_types;
create trigger tax_type_level_four_accounts before insert or update of asset_account_id,liability_account_id on public.tax_types for each row execute function public.validate_tax_type_level_four_accounts();

create index if not exists tax_types_asset_account_idx on public.tax_types(asset_account_id);
create index if not exists tax_types_liability_account_idx on public.tax_types(liability_account_id);
