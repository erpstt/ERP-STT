-- Opciones de cuentas para Crear/Editar extractos bancarios. La consulta se
-- autoriza con el permiso del propio catálogo y no obliga a conceder acceso a
-- los catálogos independientes de cuentas, bancos o monedas.

create or replace function public.bank_statement_account_options()
returns table(
  bank_account_id bigint,
  subsidiary_id bigint,
  bank_name text,
  account_number text,
  currency_code text
)
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare
  active_company_id bigint:=public.active_subsidiary_id();
begin
  if active_company_id is null then
    raise exception 'Seleccione una subsidiaria activa antes de consultar las cuentas bancarias.' using errcode='42501';
  end if;

  if not (
    public.security_resource_allowed('banking:bank-statements','view')
    or public.security_resource_allowed('banking:bank-statements','create')
    or public.security_resource_allowed('banking:bank-statements','edit')
  ) then
    raise exception 'El rol activo no tiene permiso para consultar las cuentas de extractos bancarios.' using errcode='42501';
  end if;

  return query
  select
    account.bank_account_id,
    account.subsidiary_id,
    bank.bank_name::text,
    account.account_number::text,
    currency.currency_code::text
  from public.bank_account account
  join public.banks bank using(bank_id)
  join public.currencies currency using(currency_id)
  where account.subsidiary_id=active_company_id
  order by bank.bank_name,account.account_number,currency.currency_code;
end
$$;

revoke all on function public.bank_statement_account_options() from public,anon;
grant execute on function public.bank_statement_account_options() to authenticated,service_role;

comment on function public.bank_statement_account_options() is
  'Lista Banco · Cuenta · Moneda exclusivamente para la subsidiaria activa y con permisos de extractos bancarios.';

notify pgrst,'reload schema';
