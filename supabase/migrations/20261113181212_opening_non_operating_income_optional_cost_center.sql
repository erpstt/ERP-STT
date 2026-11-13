-- Only relax the opening-balance cost-center requirement for this group and
-- its descendants. Account category, department validation and posting stay intact.
create or replace function public.opening_balance_is_non_operating_income(p_account_id bigint)
returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select public.account_belongs_to_group(
  p_account_id,
  '(^|[^[:alnum:]])otros[[:space:]]+ingresos?[[:space:]]+no[[:space:]]+operativos?([^[:alnum:]]|$)'
 )
$$;
revoke all on function public.opening_balance_is_non_operating_income(bigint) from public,anon,authenticated;

create or replace function public.opening_balance_assert_result_dimensions(
 p_account_id bigint,p_category text,p_department_id bigint,p_cost_center_id bigint,p_row integer
)returns void language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
begin
 if p_cost_center_id is null and(
  lower(trim(coalesce(p_category,'')))in('costo','costos')
  or(
   lower(trim(coalesce(p_category,'')))in('ingreso','ingresos')
   and not public.opening_balance_is_financial_income(p_account_id)
   and not public.opening_balance_is_non_operating_income(p_account_id)
  )
 )then
  raise exception 'Libro Mayor fila %: el centro de costos es obligatorio para cuentas de ingreso operativo o costo.',p_row;
 end if;
 if lower(trim(coalesce(p_category,'')))in('gasto','gastos')and p_department_id is null then
  raise exception 'Libro Mayor fila %: el departamento es obligatorio para cuentas de gasto.',p_row;
 end if;
end$$;
revoke all on function public.opening_balance_assert_result_dimensions(bigint,text,bigint,bigint,integer) from public,anon,authenticated;

comment on function public.opening_balance_is_non_operating_income(bigint) is
 'Identifica Otros Ingresos No Operativos y sus subgrupos mediante la jerarquía contable, sin depender de prefijos de cuenta.';
comment on function public.opening_balance_assert_result_dimensions(bigint,text,bigint,bigint,integer) is
 'Saldos iniciales: ingresos financieros y Otros Ingresos No Operativos sin centro obligatorio; demás ingresos y costos con centro, gastos con departamento.';
notify pgrst,'reload schema';
