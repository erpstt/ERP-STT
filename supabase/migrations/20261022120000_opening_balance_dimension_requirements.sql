-- Dimensiones obligatorias en la carga inicial según la clasificación contable.
-- Ingreso/Costo: centro de costos. Gasto: departamento.
create or replace function public.opening_balance_assert_result_dimensions(
 p_category text,p_department_id bigint,p_cost_center_id bigint,p_row integer
)returns void language plpgsql immutable set search_path=public,pg_temp as $$
begin
 if lower(trim(coalesce(p_category,'')))in('ingreso','ingresos','costo','costos')and p_cost_center_id is null then
  raise exception 'Libro Mayor fila %: el centro de costos es obligatorio para cuentas de ingreso o costo.',p_row;
 end if;
 if lower(trim(coalesce(p_category,'')))in('gasto','gastos')and p_department_id is null then
  raise exception 'Libro Mayor fila %: el departamento es obligatorio para cuentas de gasto.',p_row;
 end if;
end$$;

revoke all on function public.opening_balance_assert_result_dimensions(text,bigint,bigint,integer)from public,anon,authenticated;

-- The period-type wrapper delegates all entity, FX and dimension checks to
-- this private implementation. Ensure the 413001 income line requires a cost
-- center even when this migration is reapplied after an earlier version had
-- removed that validation. Supplied centers keep every existing consistency
-- check for customer, department and class.
do $ensure_pending_cost_center_requirement$
declare
 function_body text;
 patched_body text;
 requirement_marker text:='if role_value=''COUNTERPART''and cost_key is null then';
 insertion_anchor text:='if cost_key is not null then';
 requirement_block text:=E'if role_value=''COUNTERPART''and cost_key is null then\n    raise exception ''Pendiente % línea %: el centro de costos es obligatorio para la cuenta 413001.'',reference_value,row_value;\n   end if;\n   ';
 anchor_position integer;
 occurrence_count integer;
begin
 select procedure.prosrc into function_body
 from pg_proc procedure
 where procedure.oid=to_regprocedure('public.opening_pending_invoice_stage_before_period_type(bigint,jsonb)');
 if function_body is null then
  raise exception 'No existe la implementación interna del auxiliar de pendientes de facturar.';
 end if;

 occurrence_count:=(length(function_body)-length(replace(function_body,requirement_marker,'')))/length(requirement_marker);
 if occurrence_count>1 then
  raise exception 'La validación de centro de costos para 413001 está duplicada.';
 end if;
 if occurrence_count=0 then
  anchor_position:=strpos(function_body,insertion_anchor);
  if anchor_position=0 then
   raise exception 'No fue posible localizar el punto de validación de dimensiones del auxiliar.';
  end if;
  patched_body:=overlay(function_body placing requirement_block from anchor_position for 0);
  execute format(
   'create or replace function public.opening_pending_invoice_stage_before_period_type(p_run_id bigint,p_items jsonb) returns integer language plpgsql security definer set search_path=public,pg_temp as %L',
   patched_body
  );
 else
  patched_body:=function_body;
 end if;

 if strpos(patched_body,requirement_marker)=0
  or strpos(patched_body,'el centro de costos es obligatorio para la cuenta 413001')=0 then
  raise exception 'No quedó activa la obligatoriedad de centro de costos para 413001.';
 end if;
 if strpos(patched_body,'el centro de costos pertenece a otro cliente')=0
  or strpos(patched_body,'el centro de costos no corresponde al departamento')=0
  or strpos(patched_body,'la clase no corresponde al centro de costos')=0 then
  raise exception 'La actualización no preservó las validaciones de coherencia de las dimensiones suministradas.';
 end if;
end
$ensure_pending_cost_center_requirement$;

revoke all on function public.opening_pending_invoice_stage_before_period_type(bigint,jsonb)from public,anon,authenticated;

create or replace function public.opening_balance_validate_before_opening_pending(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare output jsonb;rid bigint;line record;existing opening_balance_runs%rowtype;asset_count integer;sid bigint;entity_customer bigint;entity_department bigint;center_customer bigint;
begin
 sid:=opening_balance_assert_access('create');
 if coalesce(p->>'expectedSubsidiaryId','')<>sid::text then raise exception 'La empresa activa cambió desde que abrió la carga. Recargue la pantalla y seleccione nuevamente los archivos.';end if;
 select * into existing from opening_balance_runs where subsidiary_id=sid and status<>'REVERSED'order by id desc limit 1;
 if existing.status='POSTED'then
  if jsonb_array_length(coalesce(p->'rows','[]'::jsonb))>0 then raise exception 'La apertura ya está contabilizada. Solo puede agregar el auxiliar de activos fijos pendiente.';end if;
  if jsonb_array_length(coalesce(p->'assets','[]'::jsonb))=0 then raise exception 'Seleccione la plantilla del auxiliar de activos fijos.';end if;
  rid:=existing.id;asset_count:=opening_fixed_asset_stage(rid,p->'assets');
 else
  output:=opening_balance_stage(p);rid:=(output->>'runId')::bigint;
  for line in select l.*,a.category from opening_balance_lines l join chart_accounts a using(account_id)where l.run_id=rid loop
   if(select load_type from opening_balance_runs where id=rid)='FISCAL_YEAR'and lower(trim(coalesce(line.category,'')))in('ingreso','ingresos','gasto','gastos','costo','costos')then raise exception 'Fila %: las cuentas de resultados solo se permiten en apertura a mitad de período.',line.row_number;end if;
   perform opening_balance_assert_result_dimensions(line.category,line.department_id,line.cost_center_id,line.row_number);
   if line.source_type='AR'then
    entity_customer:=null;entity_department:=null;center_customer:=null;
    select c.customer_id,case when exists(
     select 1 from departments d left join department_subsidiaries ds using(department_id)
     where d.department_id=c.department_id and not d.is_inactive and(d.subsidiary_id=sid or ds.subsidiary_id=sid)
    )then c.department_id end into entity_customer,entity_department from customers c
    where c.tax_id=line.raw_data->>'entityTaxId'and(c.primary_subsidiary_id=sid or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=sid))limit 1;
    if entity_customer is null then raise exception 'CxC fila %: cliente % no encontrado.',line.row_number,line.raw_data->>'entityTaxId';end if;
    if entity_department is not null then
     if line.department_id is null then update opening_balance_lines set department_id=entity_department where id=line.id;
     elsif line.department_id is distinct from entity_department then raise exception 'CxC fila %: el departamento no corresponde al cliente.',line.row_number;
     end if;
    end if;
    if line.cost_center_id is not null then
     select customer_id into center_customer from cost_centers where cost_center_id=line.cost_center_id;
     if center_customer is not null and center_customer is distinct from entity_customer then raise exception 'CxC fila %: el centro de costos no corresponde al cliente.',line.row_number;end if;
    end if;
   end if;
   if line.source_type='AP'and not exists(select 1 from suppliers s where s.tax_id=line.raw_data->>'entityTaxId'and(s.primary_subsidiary_id=sid or exists(select 1 from entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=sid)))then raise exception 'CxP fila %: proveedor % no encontrado.',line.row_number,line.raw_data->>'entityTaxId';end if;
  end loop;
  asset_count:=opening_fixed_asset_stage(rid,coalesce(p->'assets','[]'::jsonb));
  update opening_balance_runs set status='VALIDATED'where id=rid;
 end if;
 if exists(select 1 from opening_balance_lines l join chart_accounts a using(account_id)where l.run_id=rid and(account_belongs_to_group(l.account_id,'deterioro|revaluaci.n')or a.account_name~*'deterioro|revaluaci.n'))then
  raise exception 'La plantilla actual del auxiliar no admite saldos iniciales de revaluación o deterioro. Separe esos ajustes antes de continuar.';
 end if;
 if(exists(select 1 from opening_fixed_asset_lines where run_id=rid)or exists(select 1 from opening_balance_lines l where l.run_id=rid and(fixed_asset_ppe_account(l.account_id)or account_belongs_to_group(l.account_id,'depreciaci.n acumulada'))))and exists(
  select 1 from opening_balance_runs r join asset a on a.subsidiary_id=r.subsidiary_id left join asset_revaluation v on v.asset_id=a.asset_id and v.revaluation_date<=r.opening_date left join asset_impairment i on i.asset_id=a.asset_id and i.assessment_date<=r.opening_date where r.id=rid and(v.revaluation_id is not null or i.impairment_id is not null)
 )then raise exception 'Existen activos con revaluaciones o deterioros anteriores a la apertura. Esta carga debe revisarse antes de conciliar el auxiliar.';end if;
 return opening_balance_preview(rid);
end$$;

comment on function public.opening_balance_validate_before_opening_pending(jsonb)is
 'Valida el Mayor inicial: centro de costos obligatorio para Ingreso/Costo y departamento obligatorio para Gasto.';
