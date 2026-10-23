-- Financial income does not use an operational cost center. Classification
-- follows the account-group hierarchy instead of account-number prefixes.
create or replace function public.opening_balance_is_financial_income(p_account_id bigint)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.account_belongs_to_group(
  p_account_id,
  '(^|[^[:alnum:]])ingresos?[[:space:]]+financieros?([^[:alnum:]]|$)'
 )
$$;

revoke all on function public.opening_balance_is_financial_income(bigint)from public,anon,authenticated;

create or replace function public.opening_balance_assert_result_dimensions(
 p_account_id bigint,p_category text,p_department_id bigint,p_cost_center_id bigint,p_row integer
)returns void language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if p_cost_center_id is null and(
  lower(trim(coalesce(p_category,'')))in('costo','costos')
  or(
   lower(trim(coalesce(p_category,'')))in('ingreso','ingresos')
   and not public.opening_balance_is_financial_income(p_account_id)
  )
 )then
  raise exception 'Libro Mayor fila %: el centro de costos es obligatorio para cuentas de ingreso operativo o costo.',p_row;
 end if;
 if lower(trim(coalesce(p_category,'')))in('gasto','gastos')and p_department_id is null then
  raise exception 'Libro Mayor fila %: el departamento es obligatorio para cuentas de gasto.',p_row;
 end if;
end$$;

revoke all on function public.opening_balance_assert_result_dimensions(bigint,text,bigint,bigint,integer)from public,anon,authenticated;

-- 20261022120000 installed the four-argument validator in the private core
-- function used by the pending and bank wrappers. Upgrade that call in place
-- so the wrappers and their later auxiliary behavior remain intact.
do $upgrade_opening_dimension_validator$
declare
 function_body text;
 patched_body text;
 old_call text:='opening_balance_assert_result_dimensions(line.category,line.department_id,line.cost_center_id,line.row_number)';
 new_call text:='opening_balance_assert_result_dimensions(line.account_id,line.category,line.department_id,line.cost_center_id,line.row_number)';
 old_count integer;
 new_count integer;
begin
 select procedure.prosrc into function_body
 from pg_proc procedure
 where procedure.oid=to_regprocedure('public.opening_balance_validate_before_opening_pending(jsonb)');
 if function_body is null then
  raise exception 'No existe la validación interna del levantamiento de saldos.';
 end if;

 old_count:=(length(function_body)-length(replace(function_body,old_call,'')))/length(old_call);
 new_count:=(length(function_body)-length(replace(function_body,new_call,'')))/length(new_call);
 if old_count=1 and new_count=0 then
  patched_body:=replace(function_body,old_call,new_call);
  execute format(
   'create or replace function public.opening_balance_validate_before_opening_pending(p jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as %L',
   patched_body
  );
 elsif old_count=0 and new_count=1 then
  patched_body:=function_body;
 else
  raise exception 'La llamada al validador de dimensiones no tiene una forma segura para actualizarse (anterior %, nueva %).',old_count,new_count;
 end if;

 if strpos(patched_body,new_call)=0 then
  raise exception 'La validación de dimensiones no recibió la cuenta contable.';
 end if;
end
$upgrade_opening_dimension_validator$;

revoke all on function public.opening_balance_validate_before_opening_pending(jsonb)from public,anon,authenticated;

drop function if exists public.opening_balance_assert_result_dimensions(text,bigint,bigint,integer);

comment on function public.opening_balance_is_financial_income(bigint)is
 'Identifica ingresos financieros mediante la jerarquía de grupos contables.';
comment on function public.opening_balance_validate_before_opening_pending(jsonb)is
 'Valida el Mayor inicial: centro para ingresos operativos y costos, departamento para gastos e ingresos financieros sin centro obligatorio.';

notify pgrst,'reload schema';
