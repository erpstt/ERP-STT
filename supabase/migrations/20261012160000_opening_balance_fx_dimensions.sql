-- Opening balances: explicit local/original amounts, complete analytical
-- dimensions and exact foreign-currency traceability per opening line.

alter table public.opening_balance_lines
  add column if not exists department_id bigint references public.departments(department_id),
  add column if not exists class_id bigint references public.classes(class_id),
  add column if not exists financial_creditor_id bigint references public.financial_creditors(financial_creditor_id),
  add column if not exists related_company_id bigint references public.related_companies(related_company_id);

alter table public.gl_impact
  add column if not exists original_currency_id bigint references public.currencies(currency_id),
  add column if not exists opening_balance_line_id bigint references public.opening_balance_lines(id);

alter table public.invoice
  add column if not exists opening_balance_line_id bigint references public.opening_balance_lines(id);

alter table public.supplier_invoice
  add column if not exists opening_balance_line_id bigint references public.opening_balance_lines(id);

create index if not exists opening_balance_lines_dimensions_idx
  on public.opening_balance_lines(run_id,department_id,cost_center_id,class_id);
create index if not exists gl_impact_original_currency_idx
  on public.gl_impact(subsidiary_id,original_currency_id,posting_date,account_id)
  where original_currency_id is not null;
create index if not exists gl_impact_opening_line_idx
  on public.gl_impact(opening_balance_line_id)
  where opening_balance_line_id is not null;
create unique index if not exists invoice_opening_line_idx
  on public.invoice(opening_balance_line_id)
  where opening_balance_line_id is not null;
create unique index if not exists supplier_invoice_opening_line_idx
  on public.supplier_invoice(opening_balance_line_id)
  where opening_balance_line_id is not null;

-- Resolve a dimension only inside the subsidiary of the opening. Values may
-- be supplied as ID:123, a catalog code, an identification, or an exact name.
create or replace function public.opening_balance_dimension_id(
  p_kind text,
  p_value text,
  p_subsidiary_id bigint
) returns bigint
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
  value_text text:=nullif(btrim(p_value),'');
  explicit_id bigint;
  matches integer:=0;
  result_id bigint;
  label text;
begin
  if value_text is null then return null;end if;
  if value_text~*'^ID:[0-9]+$'then explicit_id:=substring(value_text from 4)::bigint;end if;

  case p_kind
   when 'department' then
    label:='Departamento';
    select count(distinct d.department_id),min(d.department_id)into matches,result_id
    from departments d
    where(d.subsidiary_id=p_subsidiary_id or exists(select 1 from department_subsidiaries x where x.department_id=d.department_id and x.subsidiary_id=p_subsidiary_id))
      and not d.is_inactive
      and(case when explicit_id is not null then d.department_id=explicit_id else lower(d.name)=lower(value_text)end);
   when 'costCenter' then
    label:='Centro de costos';
    select count(*),min(c.cost_center_id)into matches,result_id
    from cost_centers c
    where c.subsidiary_id=p_subsidiary_id and not c.is_inactive
      and(case when explicit_id is not null then c.cost_center_id=explicit_id else lower(c.code)=lower(value_text)or lower(c.name)=lower(value_text)end);
   when 'class' then
    label:='Clase';
    select count(distinct c.class_id),min(c.class_id)into matches,result_id
    from classes c
    where(c.subsidiary_id=p_subsidiary_id or exists(select 1 from class_subsidiaries x where x.class_id=c.class_id and x.subsidiary_id=p_subsidiary_id))
      and not c.is_inactive
      and(case when explicit_id is not null then c.class_id=explicit_id else lower(c.name)=lower(value_text)end);
   when 'financialCreditor' then
    label:='Acreedor financiero';
    select count(distinct c.financial_creditor_id),min(c.financial_creditor_id)into matches,result_id
    from financial_creditors c
    where(c.subsidiary_id=p_subsidiary_id or exists(select 1 from financial_creditor_subsidiaries x where x.financial_creditor_id=c.financial_creditor_id and x.subsidiary_id=p_subsidiary_id))
      and not c.is_inactive
      and(case when explicit_id is not null then c.financial_creditor_id=explicit_id else lower(c.code)=lower(value_text)or lower(c.name)=lower(value_text)or lower(c.identification)=lower(value_text)end);
   when 'relatedCompany' then
    label:='Compañía relacionada';
    select count(distinct c.related_company_id),min(c.related_company_id)into matches,result_id
    from related_companies c
    where(c.subsidiary_id=p_subsidiary_id or exists(select 1 from related_company_subsidiaries x where x.related_company_id=c.related_company_id and x.subsidiary_id=p_subsidiary_id))
      and not c.is_inactive
      and(case when explicit_id is not null then c.related_company_id=explicit_id else lower(c.code)=lower(value_text)or lower(c.name)=lower(value_text)or lower(c.identification)=lower(value_text)end);
   when 'location' then
    label:='Ubicación / sucursal';
    select count(distinct l.location_id),min(l.location_id)into matches,result_id
    from locations l
    where(l.subsidiary_id=p_subsidiary_id or exists(select 1 from location_subsidiaries x where x.location_id=l.location_id and x.subsidiary_id=p_subsidiary_id))
      and(case when explicit_id is not null then l.location_id=explicit_id else lower(l.name)=lower(value_text)end);
   else raise exception 'Dimensión de apertura no permitida: %.',p_kind;
  end case;

  if matches<>1 then
   raise exception '% "%" no existe, está inactivo, no pertenece a la subsidiaria o es ambiguo. Use código, nombre exacto o ID:identificador.',label,value_text;
  end if;
  return result_id;
end$$;
revoke all on function public.opening_balance_dimension_id(text,text,bigint)from public,anon,authenticated;

create or replace function public.opening_balance_stage(p jsonb)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
 rid bigint;item jsonb;row_number_value integer;account_key bigint;currency_key bigint;
 local_currency bigint;local_debit_value numeric;local_credit_value numeric;
 original_debit_value numeric;original_credit_value numeric;rate numeric;
 department_key bigint;cost_center_key bigint;class_key bigint;creditor_key bigint;related_key bigint;location_key bigint;
 cost_center_type_value text;cost_center_department bigint;cost_center_class bigint;
 sid bigint:=active_subsidiary_id();source_kind text;
begin
 if sid is null then raise exception 'Seleccione una subsidiaria activa.';end if;
 if nullif(p->>'openingDate','')is null then raise exception 'Indique la fecha de apertura.';end if;
 if(p->>'openingDate')::date>current_date then raise exception 'La fecha de apertura no puede ser futura.';end if;
 if p->>'loadType'not in('FISCAL_YEAR','MID_YEAR')then raise exception 'Seleccione un tipo de carga válido.';end if;
 if exists(select 1 from opening_balance_runs where subsidiary_id=sid and status='POSTED')then raise exception 'Ya existe una apertura contabilizada para esta subsidiaria.';end if;
 select currency_id into local_currency from subsidiaries where subsidiary_id=sid;
 delete from opening_balance_runs where subsidiary_id=sid and status in('DRAFT','VALIDATED');
 insert into opening_balance_runs(subsidiary_id,opening_date,load_type,transition_account_id,created_by)
 values(sid,(p->>'openingDate')::date,p->>'loadType',(p->>'transitionAccountId')::bigint,app_user_id())returning id into rid;

 for item in select value from jsonb_array_elements(coalesce(p->'rows','[]'::jsonb))loop
  source_kind:=item->>'sourceType';
  row_number_value:=coalesce(nullif(item->>'sourceRow','')::integer,1+(select count(*)from opening_balance_lines where run_id=rid and source_type=source_kind));
  if source_kind not in('GL','AR','AP')then raise exception 'Fila %: tipo de origen inválido.',row_number_value;end if;
  select a.account_id into account_key from chart_accounts a join account_subsidiaries s using(account_id)
   where a.account_number=item->>'account'and s.subsidiary_id=sid and s.is_active and a.accepts_entries and not a.is_inactive limit 1;
  select c.currency_id into currency_key from currencies c where upper(c.currency_code)=upper(item->>'currency')
   and(c.currency_id=local_currency or exists(select 1 from subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=c.currency_id))limit 1;
  if account_key is null then raise exception '% fila %: la cuenta % no está habilitada para la subsidiaria.',source_kind,row_number_value,coalesce(item->>'account','');end if;
  if currency_key is null then raise exception '% fila %: la moneda % no está habilitada para la subsidiaria.',source_kind,row_number_value,coalesce(item->>'currency','');end if;

  begin
   if source_kind='GL'then
    local_debit_value:=coalesce(nullif(item->>'debit','')::numeric,0);
    local_credit_value:=coalesce(nullif(item->>'credit','')::numeric,0);
    original_debit_value:=coalesce(nullif(item->>'debitFx','')::numeric,case when currency_key=local_currency then local_debit_value else 0 end);
    original_credit_value:=coalesce(nullif(item->>'creditFx','')::numeric,case when currency_key=local_currency then local_credit_value else 0 end);
    if local_debit_value<0 or local_credit_value<0 or original_debit_value<0 or original_credit_value<0 then raise exception 'los importes no pueden ser negativos';end if;
    if(local_debit_value>0)=(local_credit_value>0)then raise exception 'indique únicamente débito o crédito en moneda local';end if;
    if(original_debit_value>0)=(original_credit_value>0)then raise exception 'indique únicamente débito o crédito en moneda original';end if;
    if(local_debit_value>0)<>(original_debit_value>0)then raise exception 'el débito/crédito local y original deben estar en el mismo lado';end if;
    if currency_key=local_currency and abs(greatest(original_debit_value,original_credit_value)-greatest(local_debit_value,local_credit_value))>.000001 then raise exception 'para la moneda local, el importe original debe coincidir con el importe local';end if;
    rate:=greatest(local_debit_value,local_credit_value)/nullif(greatest(original_debit_value,original_credit_value),0);
   else
    -- CxC/CxP retain their existing template contract: debit/credit is the
    -- pending amount in the document currency and is converted at opening.
    original_debit_value:=coalesce(nullif(item->>'debit','')::numeric,0);
    original_credit_value:=coalesce(nullif(item->>'credit','')::numeric,0);
    if original_debit_value<0 or original_credit_value<0 then raise exception 'los importes no pueden ser negativos';end if;
    if(original_debit_value>0)=(original_credit_value>0)then raise exception 'indique únicamente débito o crédito';end if;
    rate:=opening_balance_rate(currency_key,(p->>'openingDate')::date);
    local_debit_value:=original_debit_value*rate;
    local_credit_value:=original_credit_value*rate;
   end if;
  exception when invalid_text_representation or numeric_value_out_of_range or division_by_zero then
   raise exception '% fila %: revise los importes locales y originales.',source_kind,row_number_value;
  end;
  if rate is null or rate<=0 then raise exception '% fila %: la equivalencia local/original debe producir una tasa histórica positiva.',source_kind,row_number_value;end if;

  department_key:=opening_balance_dimension_id('department',item->>'department',sid);
  cost_center_key:=opening_balance_dimension_id('costCenter',item->>'costCenter',sid);
  class_key:=opening_balance_dimension_id('class',item->>'className',sid);
  creditor_key:=opening_balance_dimension_id('financialCreditor',item->>'financialCreditor',sid);
  related_key:=opening_balance_dimension_id('relatedCompany',item->>'relatedCompany',sid);
  location_key:=opening_balance_dimension_id('location',item->>'location',sid);

  -- Keep the analytical hierarchy coherent. Client cost centers inherit their
  -- customer's department; a cost center with a configured class also owns
  -- that class. Internal centers may be combined with an explicit department.
  if cost_center_key is not null then
   select cc.cost_center_type,cu.department_id,cc.class_id
    into cost_center_type_value,cost_center_department,cost_center_class
   from cost_centers cc left join customers cu using(customer_id)
   where cc.cost_center_id=cost_center_key;
   if cost_center_type_value='CLIENTE'then
    if department_key is null then department_key:=cost_center_department;end if;
    if department_key is null or department_key is distinct from cost_center_department then
     raise exception '% fila %: el centro de costos no corresponde al departamento.',source_kind,row_number_value;
    end if;
   end if;
   if cost_center_class is not null then
    if class_key is not null and class_key is distinct from cost_center_class then
     raise exception '% fila %: la clase no corresponde al centro de costos.',source_kind,row_number_value;
    end if;
    class_key:=cost_center_class;
   elsif class_key is not null then
    raise exception '% fila %: el centro de costos seleccionado no tiene asignada la clase indicada.',source_kind,row_number_value;
   end if;
  elsif class_key is not null then
   raise exception '% fila %: indique un centro de costos para asignar la clase.',source_kind,row_number_value;
  end if;

  insert into opening_balance_lines(
   run_id,source_type,row_number,account_id,document_number,issue_date,due_date,currency_id,historical_rate,foreign_amount,
   local_debit,local_credit,department_id,cost_center_id,class_id,financial_creditor_id,related_company_id,location_id,project_code,note,raw_data
  )values(
   rid,source_kind,row_number_value,account_key,nullif(item->>'documentNumber',''),nullif(item->>'issueDate','')::date,nullif(item->>'dueDate','')::date,
   currency_key,rate,greatest(original_debit_value,original_credit_value),local_debit_value,local_credit_value,
   department_key,cost_center_key,class_key,creditor_key,related_key,location_key,null,nullif(item->>'note',''),item-'project'
  );
 end loop;
 return(select jsonb_build_object('runId',rid,'rows',count(*),'debit',coalesce(sum(local_debit),0),'credit',coalesce(sum(local_credit),0),'difference',coalesce(sum(local_debit-local_credit),0))from opening_balance_lines where run_id=rid);
end$$;

create or replace function public.opening_balance_validate(p jsonb)returns jsonb
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
   if(select load_type from opening_balance_runs where id=rid)='FISCAL_YEAR'and coalesce(line.category,'')in('Ingreso','Ingresos','Gasto','Gastos','Costo','Costos')then raise exception 'Fila %: las cuentas de resultados solo se permiten en apertura a mitad de período.',line.row_number;end if;
   if coalesce(line.category,'')in('Ingreso','Ingresos','Gasto','Gastos','Costo','Costos')and line.cost_center_id is null then raise exception 'Fila %: el centro de costos es obligatorio para cuentas de resultados.',line.row_number;end if;
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

create or replace function public.opening_balance_preview(p_run_id bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 perform opening_balance_assert_access('view');
 select jsonb_build_object(
  'run',to_jsonb(r),
  'rows',coalesce((select jsonb_agg(jsonb_build_object(
   'id',l.id,'sourceType',l.source_type,'row',l.row_number,'account',a.account_number||' · '||a.account_name,'document',l.document_number,
   'currency',c.currency_code,'rate',l.historical_rate,'foreignAmount',l.foreign_amount,
   'debitFx',case when l.local_debit>0 then l.foreign_amount else 0 end,'creditFx',case when l.local_credit>0 then l.foreign_amount else 0 end,
   'debit',l.local_debit,'credit',l.local_credit,'department',d.name,'costCenter',case when cc.cost_center_id is null then null else cc.code||' · '||cc.name end,
   'className',cl.name,'financialCreditor',fc.name,'relatedCompany',rc.name,'location',lo.name,'note',l.note
  )order by l.source_type,l.row_number)
  from opening_balance_lines l join chart_accounts a on a.account_id=l.account_id join currencies c on c.currency_id=l.currency_id
  left join departments d on d.department_id=l.department_id left join cost_centers cc on cc.cost_center_id=l.cost_center_id
  left join classes cl on cl.class_id=l.class_id left join financial_creditors fc on fc.financial_creditor_id=l.financial_creditor_id
  left join related_companies rc on rc.related_company_id=l.related_company_id left join locations lo on lo.location_id=l.location_id
  where l.run_id=r.id),'[]'::jsonb),
  'summary',(select jsonb_build_object('debit',coalesce(sum(local_debit),0),'credit',coalesce(sum(local_credit),0),'difference',coalesce(sum(local_debit-local_credit),0),'count',count(*))from opening_balance_lines where run_id=r.id),
  'assets',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'row',f.row_number,'number',f.asset_number,'name',f.asset_name,'serial',f.serial_number,'categoryCode',c.category_code,'category',c.category_name,'location',l.name,'purchaseDate',f.purchase_date,'serviceDate',f.in_service_date,'cost',f.purchase_cost,'accumulated',f.accumulated_depreciation,'bookValue',f.book_value_control,'depreciatedMonths',f.depreciated_months,'department',d.name,'costCenter',cc.code||' · '||cc.name,'className',cl.name,'status',f.status,'created',f.created_asset_id is not null)order by f.row_number)from opening_fixed_asset_lines f join asset_category c on c.category_id=f.category_id join locations l on l.location_id=f.location_id left join departments d on d.department_id=f.department_id left join cost_centers cc on cc.cost_center_id=f.cost_center_id left join classes cl on cl.class_id=f.class_id where f.run_id=r.id),'[]'::jsonb),
  'assetReconciliation',opening_fixed_asset_reconciliation(r.id),
  'assetSummary',(select jsonb_build_object('count',count(*),'cost',coalesce(sum(purchase_cost),0),'accumulated',coalesce(sum(accumulated_depreciation),0),'bookValue',coalesce(sum(book_value_control),0),'pending',count(*)filter(where created_asset_id is null),'created',count(*)filter(where created_asset_id is not null),'balanced',coalesce((select bool_and(abs((x->>'difference')::numeric)<=.005)from jsonb_array_elements(opening_fixed_asset_reconciliation(r.id))x),true))from opening_fixed_asset_lines where run_id=r.id)
 )into result from opening_balance_runs r where r.id=p_run_id and r.subsidiary_id=active_subsidiary_id();
 return result;
end$$;

create or replace function public.opening_balance_post(p_run_id bigint)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare run_row opening_balance_runs%rowtype;line opening_balance_lines%rowtype;period_key bigint;base_currency bigint;book_key bigint;journal_key bigint;journal_transaction_key bigint;journal_number_value text;difference_value numeric;customer_key bigint;supplier_key bigint;sid bigint;assets_created integer:=0;reconciliation jsonb;
begin
 sid:=opening_balance_assert_access('create');
 perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
 select * into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=sid for update;
 if run_row.id is null then raise exception 'Lote no disponible.';end if;
 if(select count(*)from accounting_books where subsidiary_id=run_row.subsidiary_id and is_primary and is_active)<>1 then raise exception 'Configure un único libro contable principal activo antes de contabilizar la apertura.';end if;
 reconciliation:=opening_fixed_asset_reconciliation(run_row.id);
 if exists(select 1 from jsonb_array_elements(reconciliation)x where abs((x->>'difference')::numeric)>.005)then raise exception 'El auxiliar de activos fijos no coincide con el Libro Mayor. Corrija la conciliación antes de continuar.';end if;
 if run_row.status='POSTED'then
  if not exists(select 1 from opening_fixed_asset_lines where run_id=run_row.id and created_asset_id is null)then raise exception 'No hay fichas de activos pendientes de cargar.';end if;
  select fiscal_period_id into period_key from journal where journal_id=run_row.journal_id;
  perform set_config('app.opening_balance_internal','1',true);assets_created:=opening_fixed_asset_create(run_row.id,period_key);perform set_config('app.opening_balance_internal','',true);
  return jsonb_build_object('runId',run_row.id,'journalId',run_row.journal_id,'journalNumber',(select journal_number from journal where journal_id=run_row.journal_id),'assetsOnly',true,'assetsCreated',assets_created);
 end if;
 if run_row.status<>'VALIDATED'then raise exception 'Valide nuevamente el lote antes de contabilizar.';end if;
 if exists(
  select 1
  from opening_balance_lines l
  left join departments d on d.department_id=l.department_id
  left join cost_centers cc on cc.cost_center_id=l.cost_center_id
  left join customers center_owner on center_owner.customer_id=cc.customer_id
  left join classes cl on cl.class_id=l.class_id
  left join financial_creditors fc on fc.financial_creditor_id=l.financial_creditor_id
  left join related_companies rc on rc.related_company_id=l.related_company_id
  left join locations lo on lo.location_id=l.location_id
  where l.run_id=run_row.id and(
   l.department_id is not null and(d.department_id is null or d.is_inactive or not(d.subsidiary_id=run_row.subsidiary_id or exists(select 1 from department_subsidiaries x where x.department_id=d.department_id and x.subsidiary_id=run_row.subsidiary_id)))
   or l.cost_center_id is not null and(cc.cost_center_id is null or cc.is_inactive or cc.subsidiary_id<>run_row.subsidiary_id)
   or l.class_id is not null and(cl.class_id is null or cl.is_inactive or not(cl.subsidiary_id=run_row.subsidiary_id or exists(select 1 from class_subsidiaries x where x.class_id=cl.class_id and x.subsidiary_id=run_row.subsidiary_id)))
   or l.financial_creditor_id is not null and(fc.financial_creditor_id is null or fc.is_inactive or not(fc.subsidiary_id=run_row.subsidiary_id or exists(select 1 from financial_creditor_subsidiaries x where x.financial_creditor_id=fc.financial_creditor_id and x.subsidiary_id=run_row.subsidiary_id)))
   or l.related_company_id is not null and(rc.related_company_id is null or rc.is_inactive or not(rc.subsidiary_id=run_row.subsidiary_id or exists(select 1 from related_company_subsidiaries x where x.related_company_id=rc.related_company_id and x.subsidiary_id=run_row.subsidiary_id)))
   or l.location_id is not null and(lo.location_id is null or not(lo.subsidiary_id=run_row.subsidiary_id or exists(select 1 from location_subsidiaries x where x.location_id=lo.location_id and x.subsidiary_id=run_row.subsidiary_id)))
   or l.cost_center_id is null and l.class_id is not null
   or l.cost_center_id is not null and l.class_id is distinct from cc.class_id
   or l.cost_center_id is not null and cc.cost_center_type='CLIENTE'and l.department_id is distinct from center_owner.department_id
   or l.source_type='AR'and exists(
    select 1 from customers customer
    where customer.tax_id=l.raw_data->>'entityTaxId'
     and(customer.primary_subsidiary_id=run_row.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.customer_id=customer.customer_id and e.subsidiary_id=run_row.subsidiary_id))
     and(
      exists(select 1 from departments customer_department left join department_subsidiaries ds using(department_id)
       where customer_department.department_id=customer.department_id and not customer_department.is_inactive
        and(customer_department.subsidiary_id=run_row.subsidiary_id or ds.subsidiary_id=run_row.subsidiary_id))
       and l.department_id is distinct from customer.department_id
      or cc.customer_id is not null and cc.customer_id is distinct from customer.customer_id
     )
   )
  )
 )then raise exception 'Las dimensiones cambiaron desde la validación. Valide nuevamente el lote antes de contabilizar.';end if;
 if exists(
  select 1 from fx_revaluation_runs x
  where x.subsidiary_id=run_row.subsidiary_id and x.status='CONTABILIZADO'and x.closing_date>=run_row.opening_date
   and exists(select 1 from opening_balance_lines l where l.run_id=run_row.id and l.currency_id=x.currency_id)
 )then
  raise exception 'No se puede contabilizar la apertura: existen revaluaciones de moneda contabilizadas desde la fecha de apertura. Anule primero esas revaluaciones.';
 end if;
 select coalesce(sum(local_debit-local_credit),0)into difference_value from opening_balance_lines where run_id=run_row.id;
 if abs(difference_value)>.005 then raise exception 'La apertura no cuadra. Diferencia: %.',difference_value;end if;
 select fiscal_period_id into period_key from fiscal_periods where subsidiary_id=run_row.subsidiary_id and run_row.opening_date between start_date and end_date and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)limit 1;
 if period_key is null then raise exception 'No existe un período contable abierto para la fecha de apertura.';end if;
 select currency_id into base_currency from subsidiaries where subsidiary_id=run_row.subsidiary_id;
 select accounting_book_id into book_key from accounting_books where subsidiary_id=run_row.subsidiary_id and is_primary and is_active;
 journal_number_value:='ASI-APERTURA-'||run_row.subsidiary_id||'-'||to_char(run_row.opening_date,'YYYYMMDD');
 if exists(select 1 from journal where journal_number=journal_number_value)then journal_number_value:=journal_number_value||'-'||run_row.id;end if;
 perform set_config('app.asset_proposal_internal','1',true);perform set_config('app.opening_balance_internal','1',true);
 insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by,is_opening_balance,asset_proposal_internal)
 select journal_number_value,run_row.opening_date,run_row.subsidiary_id,base_currency,period_key,1,'Carga de saldos iniciales','APERTURA',coalesce(sum(local_debit),0),coalesce(sum(local_credit),0),'CONTABILIZADO',app_user_id(),true,true from opening_balance_lines where run_id=run_row.id returning journal_id,transaction_id into journal_key,journal_transaction_key;
 for line in select * from opening_balance_lines where run_id=run_row.id order by id loop
  customer_key:=null;supplier_key:=null;
  if line.source_type='AR'then
   select customer_id into customer_key from customers c where c.tax_id=line.raw_data->>'entityTaxId'and(c.primary_subsidiary_id=run_row.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=run_row.subsidiary_id))limit 1;
   if customer_key is null then raise exception 'Fila % CxC: cliente no encontrado.',line.row_number;end if;
   if line.document_number is null or line.issue_date is null or line.due_date is null then raise exception 'Fila % CxC: complete documento, emisión y vencimiento.',line.row_number;end if;
   if exists(select 1 from invoice where invoice_number=line.document_number and customer_id=customer_key)then raise exception 'La factura CxC % ya existe.',line.document_number;end if;
    insert into invoice(invoice_number,customer_id,subsidiary_id,due_date,total_amount,invoice_date,fiscal_period_id,currency_id,exchange_rate,memo,journal_id,location_id,opening_run_id,opening_balance_line_id,is_opening_balance)
    values(line.document_number,customer_key,run_row.subsidiary_id,line.due_date,line.foreign_amount,line.issue_date,period_key,line.currency_id,line.historical_rate,coalesce(line.note,'Saldo inicial CxC'),journal_key,line.location_id,run_row.id,line.id,true);
  elsif line.source_type='AP'then
   select supplier_id into supplier_key from suppliers s where s.tax_id=line.raw_data->>'entityTaxId'and(s.primary_subsidiary_id=run_row.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=run_row.subsidiary_id))limit 1;
   if supplier_key is null then raise exception 'Fila % CxP: proveedor no encontrado.',line.row_number;end if;
   if line.document_number is null or line.issue_date is null or line.due_date is null then raise exception 'Fila % CxP: complete documento, emisión y vencimiento.',line.row_number;end if;
   if exists(select 1 from supplier_invoice where invoice_number=line.document_number and supplier_id=supplier_key)then raise exception 'La factura CxP % ya existe.',line.document_number;end if;
    insert into supplier_invoice(invoice_number,supplier_id,subsidiary_id,due_date,total_amount,invoice_date,fiscal_period_id,currency_id,exchange_rate,memo,journal_id,location_id,opening_run_id,opening_balance_line_id,is_opening_balance)
    values(line.document_number,supplier_key,run_row.subsidiary_id,line.due_date,line.foreign_amount,line.issue_date,period_key,line.currency_id,line.historical_rate,coalesce(line.note,'Saldo inicial CxP'),journal_key,line.location_id,run_row.id,line.id,true);
  end if;
  insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,cost_center_id,financial_creditor_id,related_company_id,note,entity_type,customer_id,supplier_id,historical_exchange_rate,original_currency_id,opening_balance_line_id)
  values(journal_key,line.account_id,line.local_debit,line.local_credit,case when line.local_debit>0 then line.foreign_amount else 0 end,case when line.local_credit>0 then line.foreign_amount else 0 end,line.department_id,line.class_id,line.location_id,line.cost_center_id,line.financial_creditor_id,line.related_company_id,coalesce(line.note,'Saldo inicial'),case line.source_type when'AR'then'Cliente'when'AP'then'Proveedor'end,customer_key,supplier_key,line.historical_rate,line.currency_id,line.id);
 end loop;
 assets_created:=opening_fixed_asset_create(run_row.id,period_key);
 delete from gl_impact where transaction_id=journal_transaction_key;
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id)
 select j.transaction_id,l.account_id,j.subsidiary_id,j.fiscal_period_id,book_key,l.debit,l.credit,l.debit_fx,l.credit_fx,j.journal_date,l.original_currency_id,l.opening_balance_line_id
 from journal j join journal_line l using(journal_id)where j.journal_id=journal_key;
 if not exists(select 1 from journal j join gl_impact g on g.transaction_id=j.transaction_id join accounting_books b using(accounting_book_id)where j.journal_id=journal_key and b.is_primary and b.is_active)then raise exception 'No fue posible registrar el asiento de apertura en el libro principal activo.';end if;
 update opening_balance_runs set status='POSTED',journal_id=journal_key,posted_at=now()where id=run_row.id;
 perform set_config('app.asset_proposal_internal','',true);perform set_config('app.opening_balance_internal','',true);
 return jsonb_build_object('runId',run_row.id,'journalId',journal_key,'journalNumber',journal_number_value,'assetsOnly',false,'assetsCreated',assets_created);
end$$;

create or replace function public.opening_balance_reverse(p_run_id bigint)returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare run_row opening_balance_runs%rowtype;reversal_key bigint;reversal_number text;reversal_period_key bigint;sid bigint;
begin
 sid:=opening_balance_assert_access('delete');
 perform pg_advisory_xact_lock(hashtextextended('fx-subsidiary:'||sid,0));
 select * into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=sid and status='POSTED'for update;
 if run_row.id is null then raise exception 'Apertura contabilizada no encontrada.';end if;
 if exists(select 1 from customer_payment_application a join invoice i using(invoice_id)where i.opening_run_id=run_row.id)or exists(select 1 from supplier_payment_application a join supplier_invoice i using(invoice_id)where i.opening_run_id=run_row.id)then raise exception 'No se puede reversar: existen cobros o pagos aplicados a documentos iniciales.';end if;
 if exists(
  select 1 from fx_revaluation_runs x
  where x.subsidiary_id=run_row.subsidiary_id and x.status='CONTABILIZADO'and x.closing_date>=run_row.opening_date
   and exists(select 1 from opening_balance_lines l where l.run_id=run_row.id and l.currency_id=x.currency_id)
 )then
  raise exception 'No se puede reversar: existen revaluaciones de moneda contabilizadas desde la fecha de apertura. Anule primero esas revaluaciones.';
 end if;
 if exists(select 1 from asset_depreciation where opening_run_id=run_row.id and not is_opening_balance)or exists(select 1 from asset_depreciation d join asset a using(asset_id)where a.opening_run_id=run_row.id and not d.is_opening_balance)or exists(select 1 from asset_transfer t join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_disposal d join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_maintenance m join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_revaluation v join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_impairment i join asset a using(asset_id)where a.opening_run_id=run_row.id)then raise exception 'No se puede reversar: un activo inicial tiene depreciaciones u operaciones posteriores.';end if;
 if exists(select 1 from jsonb_array_elements(opening_fixed_asset_reconciliation(run_row.id))x where abs(coalesce((x->>'existing')::numeric,0))>.005)then raise exception 'No se puede reversar: el saldo PPE de apertura está conciliado con fichas de activos preexistentes. Revise y relacione esas fichas antes de reversar.';end if;
 select fiscal_period_id into reversal_period_key from fiscal_periods where subsidiary_id=run_row.subsidiary_id and run_row.opening_date between start_date and end_date and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)limit 1;
 if reversal_period_key is null then raise exception 'No se puede reversar la apertura porque su período contable original está cerrado. Reabra ese período antes de continuar.';end if;
 reversal_number:='REV-'||(select journal_number from journal where journal_id=run_row.journal_id);
 perform set_config('app.asset_proposal_internal','1',true);perform set_config('app.opening_balance_internal','1',true);
 insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by,reversed_from_journal_id,asset_proposal_internal)
 select reversal_number,run_row.opening_date,subsidiary_id,currency_id,reversal_period_key,1,'Reversión de apertura','Reversión',total_credit,total_debit,'CONTABILIZADO',app_user_id(),journal_id,true from journal where journal_id=run_row.journal_id returning journal_id into reversal_key;
 insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,cost_center_id,financial_creditor_id,related_company_id,note,entity_type,customer_id,supplier_id,historical_exchange_rate,original_currency_id,opening_balance_line_id)
 select reversal_key,account_id,credit,debit,credit_fx,debit_fx,department_id,class_id,location_id,cost_center_id,financial_creditor_id,related_company_id,'Reversión de apertura',entity_type,customer_id,supplier_id,historical_exchange_rate,original_currency_id,opening_balance_line_id from journal_line where journal_id=run_row.journal_id;
 delete from gl_impact where transaction_id=(select transaction_id from journal where journal_id=reversal_key);
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id)
 select reversal.transaction_id,original.account_id,original.subsidiary_id,reversal_period_key,original.accounting_book_id,original.credit_amount,original.debit_amount,original.credit_fx,original.debit_fx,run_row.opening_date,original.original_currency_id,original.opening_balance_line_id
 from journal source join gl_impact original on original.transaction_id=source.transaction_id cross join journal reversal
 where source.journal_id=run_row.journal_id and reversal.journal_id=reversal_key;
 if not exists(select 1 from journal j join gl_impact g on g.transaction_id=j.transaction_id where j.journal_id=reversal_key)then raise exception 'No fue posible registrar los impactos de la reversión en el libro original.';end if;
 delete from invoice where opening_run_id=run_row.id;delete from supplier_invoice where opening_run_id=run_row.id;
 update asset set opening_reversed_at=run_row.opening_date::timestamp,status='INACTIVO'where opening_run_id=run_row.id and is_opening_balance;
 update opening_balance_runs set status='REVERSED',reversed_at=now()where id=run_row.id;
 perform set_config('app.asset_proposal_internal','',true);perform set_config('app.opening_balance_internal','',true);
 return jsonb_build_object('reversalJournalId',reversal_key,'number',reversal_number);
end$$;

-- Link openings already posted before this migration without changing amounts.
do $$
begin
 perform set_config('app.opening_balance_internal','1',true);
  update invoice i set opening_balance_line_id=l.id
  from opening_balance_lines l join opening_balance_runs r on r.id=l.run_id
  join journal_line jl on jl.journal_id=r.journal_id and jl.opening_balance_line_id=l.id
  where i.opening_run_id=l.run_id and l.source_type='AR'and i.invoice_number=l.document_number
   and jl.customer_id=i.customer_id and i.opening_balance_line_id is null;
  update supplier_invoice i set opening_balance_line_id=l.id
  from opening_balance_lines l join opening_balance_runs r on r.id=l.run_id
  join journal_line jl on jl.journal_id=r.journal_id and jl.opening_balance_line_id=l.id
  where i.opening_run_id=l.run_id and l.source_type='AP'and i.invoice_number=l.document_number
   and jl.supplier_id=i.supplier_id and i.opening_balance_line_id is null;
  if exists(select 1 from invoice where is_opening_balance and opening_run_id is not null and opening_balance_line_id is null)then
   raise exception 'No fue posible vincular una factura CxC inicial con su línea exacta de apertura.';
  end if;
  if exists(select 1 from supplier_invoice where is_opening_balance and opening_run_id is not null and opening_balance_line_id is null)then
   raise exception 'No fue posible vincular una factura CxP inicial con su línea exacta de apertura.';
  end if;

 -- Reversals created by the first opening workflow copied only amounts. Match
 -- repeated lines deterministically and restore the original-currency snapshot,
 -- exact opening line and analytical dimensions before repairing the ledger.
 with source_lines as(
  select reversal.journal_id reversal_journal_id,source_line.*,
   row_number()over(
    partition by reversal.journal_id,source_line.account_id,source_line.credit,source_line.debit,source_line.credit_fx,source_line.debit_fx
    order by source_line.journal_line_id
   )sequence
  from journal reversal join journal source on source.journal_id=reversal.reversed_from_journal_id
  join journal_line source_line on source_line.journal_id=source.journal_id
  where source.is_opening_balance and source_line.opening_balance_line_id is not null
 ),reversal_lines as(
  select reversal_line.journal_line_id,reversal_line.journal_id reversal_journal_id,reversal_line.account_id,
   reversal_line.debit,reversal_line.credit,reversal_line.debit_fx,reversal_line.credit_fx,
   row_number()over(
    partition by reversal_line.journal_id,reversal_line.account_id,reversal_line.debit,reversal_line.credit,reversal_line.debit_fx,reversal_line.credit_fx
    order by reversal_line.journal_line_id
   )sequence
  from journal reversal join journal source on source.journal_id=reversal.reversed_from_journal_id
  join journal_line reversal_line on reversal_line.journal_id=reversal.journal_id
  where source.is_opening_balance
 ),pairs as(
  select reverse_line.journal_line_id,source_line.historical_exchange_rate,source_line.original_currency_id,
   source_line.opening_balance_line_id,source_line.department_id,source_line.class_id,source_line.location_id,
   source_line.cost_center_id,source_line.financial_creditor_id,source_line.related_company_id
  from reversal_lines reverse_line join source_lines source_line
   on source_line.reversal_journal_id=reverse_line.reversal_journal_id
   and source_line.account_id=reverse_line.account_id
   and source_line.credit=reverse_line.debit and source_line.debit=reverse_line.credit
   and source_line.credit_fx=reverse_line.debit_fx and source_line.debit_fx=reverse_line.credit_fx
   and source_line.sequence=reverse_line.sequence
 )
 update journal_line l set
  historical_exchange_rate=p.historical_exchange_rate,original_currency_id=p.original_currency_id,
  opening_balance_line_id=p.opening_balance_line_id,department_id=p.department_id,class_id=p.class_id,
  location_id=p.location_id,cost_center_id=p.cost_center_id,financial_creditor_id=p.financial_creditor_id,
  related_company_id=p.related_company_id
 from pairs p where l.journal_line_id=p.journal_line_id
  and(l.opening_balance_line_id is null or l.original_currency_id is null);

 with lines as(
  select j.transaction_id,l.account_id,l.debit,l.credit,l.debit_fx,l.credit_fx,l.opening_balance_line_id,l.original_currency_id,
   row_number()over(partition by j.transaction_id,l.account_id,l.debit,l.credit order by l.journal_line_id)sequence
  from journal_line l join journal j using(journal_id)where l.opening_balance_line_id is not null
 ),impacts as(
  select g.gl_impact_id,g.transaction_id,g.account_id,g.debit_amount debit,g.credit_amount credit,g.debit_fx,g.credit_fx,
   row_number()over(partition by g.transaction_id,g.account_id,g.debit_amount,g.credit_amount order by g.gl_impact_id)sequence
  from gl_impact g join journal j on j.transaction_id=g.transaction_id
  where j.is_opening_balance or j.reversed_from_journal_id is not null and exists(select 1 from journal source where source.journal_id=j.reversed_from_journal_id and source.is_opening_balance)
 )
 update gl_impact g set debit_fx=l.debit_fx,credit_fx=l.credit_fx,original_currency_id=l.original_currency_id,opening_balance_line_id=l.opening_balance_line_id
 from impacts i join lines l using(transaction_id,account_id,debit,credit,sequence)where g.gl_impact_id=i.gl_impact_id;
 perform set_config('app.opening_balance_internal','',true);
end$$;

create or replace function public.fx_options()returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=fx_assert_access();result jsonb;
begin
 select jsonb_build_object(
  'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id,'currency',c.currency_code),
  'settings',(select to_jsonb(x)from fx_revaluation_settings x where subsidiary_id=sid),
  'currencies',coalesce((select jsonb_agg(jsonb_build_object('id',cu.currency_id,'code',cu.currency_code,'name',cu.name)order by cu.currency_code)
   from currencies cu where cu.currency_id<>s.currency_id and(
    exists(select 1 from subsidiary_currencies sc where sc.subsidiary_id=sid and sc.currency_id=cu.currency_id)
    or exists(select 1 from "transaction"t where t.subsidiary_id=sid and t.currency_id=cu.currency_id)
    or exists(select 1 from gl_impact g where g.subsidiary_id=sid and g.original_currency_id=cu.currency_id)
   )),'[]'),
  'periods',coalesce((select jsonb_agg(jsonb_build_object('id',fiscal_period_id,'name',period_name,'start',start_date,'end',end_date,'closed',is_closed or coalesce(gl_closed,false)or coalesce(is_inactive,false))order by start_date desc)from fiscal_periods where subsidiary_id=sid),'[]'),
  'rates',coalesce((select jsonb_agg(jsonb_build_object('currencyId',from_currency_id,'date',effective_date,'rate',spot_rate)order by effective_date desc)from exchange_rates where to_currency_id=s.currency_id),'[]'),
  'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',a.category,'eligible',a.pending_fx_revaluation)order by a.account_number)from chart_accounts a join account_subsidiaries sc using(account_id)where sc.subsidiary_id=sid and sc.is_active and a.accepts_entries and not a.is_inactive),'[]')
 )into result from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=sid;
 return result;
end$$;

create or replace function public.fx_exposures(p_date date,p_currency bigint)returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=fx_assert_access();book bigint;result jsonb;
begin
 select accounting_book_id into book from accounting_books where subsidiary_id=sid and is_primary and is_active order by accounting_book_id limit 1;
 if book is null then raise exception 'Configure un libro contable principal activo.';end if;
 if(select count(*)from accounting_books where subsidiary_id=sid and is_primary and is_active)<>1 then raise exception 'Debe existir un único libro principal activo.';end if;
 if p_currency=(select currency_id from subsidiaries where subsidiary_id=sid)then raise exception 'Seleccione una moneda extranjera.';end if;
 with eligible as(
  select a.* from chart_accounts a join account_subsidiaries s using(account_id)
  where s.subsidiary_id=sid and s.is_active and a.pending_fx_revaluation and a.category in('Activo','Pasivo')and not a.is_inactive and a.accepts_entries
 ),ledger as(
  select g.*,coalesce(g.original_currency_id,t.currency_id)effective_currency_id
  from gl_impact g join "transaction"t using(transaction_id)join eligible a using(account_id)
  where g.subsidiary_id=sid and t.subsidiary_id=sid and g.accounting_book_id=book and g.posting_date<=p_date
   and coalesce(g.original_currency_id,t.currency_id)=p_currency
   and not exists(select 1 from journal j where j.transaction_id=t.transaction_id and j.fx_revaluation_run_id is not null)
   and not exists(
    select 1 from opening_balance_runs r join journal source on source.journal_id=r.journal_id
    left join journal reversal on reversal.reversed_from_journal_id=source.journal_id
    where r.status='REVERSED'and reversal.journal_date<=p_date
     and(source.transaction_id=t.transaction_id or reversal.transaction_id=t.transaction_id)
   )
 ),documents as(
  select 'AR:'||i.invoice_id source_key,'CxC'::text source_type,i.invoice_id,i.invoice_number document,i.customer_id entity_id,c.company_name party,
   coalesce(i.transaction_id,j.transaction_id)transaction_id,i.currency_id,'Activo'::text category,i.opening_balance_line_id
  from invoice i join customers c using(customer_id)left join opening_balance_runs r on r.id=i.opening_run_id left join journal j on j.journal_id=r.journal_id
  where i.subsidiary_id=sid and i.currency_id=p_currency and i.invoice_date<=p_date
  union all
  select 'AP:'||i.invoice_id,'CxP',i.invoice_id,i.invoice_number,i.supplier_id,s.company_name,
   coalesce(i.transaction_id,j.transaction_id),i.currency_id,'Pasivo',i.opening_balance_line_id
  from supplier_invoice i join suppliers s using(supplier_id)left join opening_balance_runs r on r.id=i.opening_run_id left join journal j on j.journal_id=r.journal_id
  where i.subsidiary_id=sid and i.currency_id=p_currency and i.invoice_date<=p_date
 ),mapping as(
  select d.source_key,d.transaction_id,d.opening_balance_line_id,1::numeric weight from documents d
  union all select d.source_key,n.transaction_id,null::bigint,1 from documents d join credit_note n on n.invoice_id=d.invoice_id and d.source_type='CxC'where n.note_date<=p_date
  union all select d.source_key,n.transaction_id,null::bigint,1 from documents d join debit_note n on n.invoice_id=d.invoice_id and d.source_type='CxC'where n.note_date<=p_date
  union all select d.source_key,n.transaction_id,null::bigint,1 from documents d join supplier_credit_note n on n.invoice_id=d.invoice_id and d.source_type='CxP'where n.note_date<=p_date
  union all select d.source_key,n.transaction_id,null::bigint,1 from documents d join supplier_debit_note n on n.invoice_id=d.invoice_id and d.source_type='CxP'where n.note_date<=p_date
  union all select d.source_key,p.transaction_id,null::bigint,a.amount/nullif((select sum(x.amount)from customer_payment_application x where x.payment_id=p.payment_id),0)
   from documents d join customer_payment_application a on a.invoice_id=d.invoice_id and d.source_type='CxC'join customer_payment p using(payment_id)where a.application_date<=p_date and p.payment_date<=p_date
  union all select d.source_key,p.transaction_id,null::bigint,a.amount/nullif((select sum(x.amount)from supplier_payment_application x where x.payment_id=p.payment_id),0)
   from documents d join supplier_payment_application a on a.invoice_id=d.invoice_id and d.source_type='CxP'join supplier_payment p using(payment_id)where a.application_date<=p_date and p.payment_date<=p_date
 ),doc_balances as(
  select d.source_key,d.source_type,d.document,d.party,d.entity_id,g.account_id,
   sum((g.debit_fx-g.credit_fx)*m.weight)fc,sum((g.debit_amount-g.credit_amount)*m.weight)local
  from documents d join mapping m using(source_key)join ledger g on g.transaction_id=m.transaction_id
   and(m.opening_balance_line_id is null and g.opening_balance_line_id is null or g.opening_balance_line_id=m.opening_balance_line_id)
  join eligible a on a.account_id=g.account_id and a.category=d.category
  where exists(select 1 from ledger original where original.transaction_id=d.transaction_id and original.account_id=g.account_id
   and(d.opening_balance_line_id is null and original.opening_balance_line_id is null or original.opening_balance_line_id=d.opening_balance_line_id))
  group by d.source_key,d.source_type,d.document,d.party,d.entity_id,g.account_id
 ),other_balances as(
  select 'GL:'||g.account_id source_key,'Mayor'::text source_type,''::text document,''::text party,null::bigint entity_id,g.account_id,
   sum(g.debit_fx-g.credit_fx)-coalesce((select sum(d.fc)from doc_balances d where d.account_id=g.account_id),0)fc,
   sum(g.debit_amount-g.credit_amount)-coalesce((select sum(d.local)from doc_balances d where d.account_id=g.account_id),0)local
  from ledger g group by g.account_id
 ),prior_adjustments as(
  select l.fx_source_key source_key,l.account_id,sum(l.debit-l.credit)local
  from journal_line l join journal j using(journal_id)join fx_revaluation_runs r on r.run_id=j.fx_revaluation_run_id
  where r.subsidiary_id=sid and r.currency_id=p_currency and j.journal_date<=p_date and l.fx_source_key is not null group by l.fx_source_key,l.account_id
 ),balances as(select * from doc_balances union all select * from other_balances)
 select coalesce(jsonb_agg(jsonb_build_object('sourceKey',b.source_key,'sourceType',b.source_type,'document',b.document,'party',b.party,'entityId',b.entity_id,
  'accountId',a.account_id,'accountNumber',a.account_number,'accountName',a.account_name,'category',a.category,
  'foreignBalance',round(b.fc*case when a.category='Pasivo'then-1 else 1 end,6),
  'bookValue',round((b.local+coalesce(p.local,0))*case when a.category='Pasivo'then-1 else 1 end,6))order by a.account_number,b.source_key),'[]')into result
 from balances b join eligible a using(account_id)left join prior_adjustments p on p.source_key=b.source_key and p.account_id=b.account_id where abs(b.fc)>.000001;
 if exists(select 1 from customer_payment_application a join customer_payment p using(payment_id)join invoice i using(invoice_id)where i.subsidiary_id=sid and i.currency_id=p_currency and p.currency_id<>i.currency_id and a.application_date<=p_date and p.payment_date<=p_date)
  or exists(select 1 from supplier_payment_application a join supplier_payment p using(payment_id)join supplier_invoice i using(invoice_id)where i.subsidiary_id=sid and i.currency_id=p_currency and p.currency_id<>i.currency_id and a.application_date<=p_date and p.payment_date<=p_date)then
  raise exception 'Existen aplicaciones de pago en otra moneda. Concilie su importe en la moneda de la factura antes de revaluar.';
 end if;
 return result;
end$$;

revoke all on function public.opening_balance_stage(jsonb),public.opening_balance_dimension_id(text,text,bigint),public.fx_exposures(date,bigint)from public,anon,authenticated;
revoke all on function public.opening_balance_validate(jsonb),public.opening_balance_preview(bigint),public.opening_balance_post(bigint),public.opening_balance_reverse(bigint)from public,anon;
grant execute on function public.opening_balance_validate(jsonb),public.opening_balance_preview(bigint),public.opening_balance_post(bigint),public.opening_balance_reverse(bigint)to authenticated;
notify pgrst,'reload schema';
