-- Opening fixed-asset auxiliary. Values are reconciled with the opening GL and
-- create subledger cards without posting cost or accumulated depreciation twice.

-- Some legacy categories predate the automatic code. The old trigger preserved
-- NULL on UPDATE, so redefine it before the backfill and keep codes immutable
-- once assigned.
create or replace function assign_asset_category_code()returns trigger language plpgsql set search_path=public,pg_temp as $$
declare next_number bigint;
begin
 if tg_op='UPDATE'and nullif(trim(old.category_code),'')is not null then
  new.category_code:=old.category_code;
  return new;
 end if;
 if nullif(trim(new.category_code),'')is null or upper(trim(new.category_code))='AUTO'then
  if tg_op='UPDATE'then
   new.category_code:='CAT-LEG-'||lpad(new.category_id::text,6,'0');
  else
   perform pg_advisory_xact_lock(hashtextextended('asset-category-'||new.subsidiary_id,0));
   select coalesce(max(case when category_code~'^CAT-ACT-[0-9]+$'then substring(category_code from'[0-9]+$')::bigint end),0)+1 into next_number from asset_category where subsidiary_id=new.subsidiary_id;
   new.category_code:='CAT-ACT-'||lpad(next_number::text,6,'0');
  end if;
 end if;
 return new;
end$$;
do $$
begin
 if exists(select 1 from asset_category legacy join asset_category used on used.subsidiary_id=legacy.subsidiary_id and upper(used.category_code)=upper('CAT-LEG-'||lpad(legacy.category_id::text,6,'0'))where nullif(trim(legacy.category_code),'')is null and used.category_id<>legacy.category_id)then
  raise exception 'No se pudieron completar los códigos legacy de categorías de activos porque un código CAT-LEG ya está en uso.';
 end if;
end$$;
update asset_category set category_code='CAT-LEG-'||lpad(category_id::text,6,'0')where nullif(trim(category_code),'')is null;
alter table asset_category alter column category_code set not null;

-- Non-depreciable categories do not need an expense account. These constraints
-- also preserve the separation between every account that is actually present.
alter table asset_category drop constraint if exists asset_category_expense_account_required;
alter table asset_category add constraint asset_category_expense_account_required check(depreciation_method='No Depreciable'or depreciation_expense_account_id is not null)not valid;
alter table asset_category drop constraint if exists asset_category_distinct_accounts;
alter table asset_category add constraint asset_category_distinct_accounts check(asset_account_id<>depreciation_account_id and(depreciation_expense_account_id is null or(asset_account_id<>depreciation_expense_account_id and depreciation_account_id<>depreciation_expense_account_id)))not valid;

create or replace function protect_used_asset_category_accounting()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from asset where category_id=old.category_id)and(
  new.asset_account_id is distinct from old.asset_account_id or
  new.depreciation_account_id is distinct from old.depreciation_account_id or
  new.depreciation_expense_account_id is distinct from old.depreciation_expense_account_id or
  new.depreciation_method is distinct from old.depreciation_method or
  new.useful_life_months is distinct from old.useful_life_months or
  new.residual_value_percentage is distinct from old.residual_value_percentage
 )then
  raise exception 'No se puede cambiar la definición contable o de depreciación de una categoría que ya tiene activos asociados. Cree una categoría nueva.';
 end if;
 return new;
end$$;
drop trigger if exists protect_used_asset_category_accounting_trigger on asset_category;
create trigger protect_used_asset_category_accounting_trigger before update of asset_account_id,depreciation_account_id,depreciation_expense_account_id,depreciation_method,useful_life_months,residual_value_percentage on asset_category for each row execute function protect_used_asset_category_accounting();

create or replace function validate_asset_category_account_groups()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not account_belongs_to_group(new.asset_account_id,'propiedad.*planta.*equipo')then raise exception 'La cuenta de activo debe pertenecer al grupo Propiedad, Planta y Equipo.';end if;
 if not account_belongs_to_group(new.depreciation_account_id,'depreciaci.n acumulada')then raise exception 'La cuenta de depreciación debe pertenecer al grupo Depreciación Acumulada.';end if;
 if new.depreciation_method<>'No Depreciable'and new.depreciation_expense_account_id is null then raise exception 'La cuenta de gasto es obligatoria para categorías depreciables.';end if;
 if new.depreciation_expense_account_id is not null and not account_belongs_to_group(new.depreciation_expense_account_id,'depreciaci.n y amortizaci.n')then raise exception 'La cuenta de gasto debe pertenecer al grupo Depreciación y Amortización.';end if;
 return new;
end$$;
drop trigger if exists validate_asset_category_account_groups_trigger on asset_category;
create trigger validate_asset_category_account_groups_trigger before insert or update of asset_account_id,depreciation_account_id,depreciation_expense_account_id,depreciation_method on asset_category for each row execute function validate_asset_category_account_groups();

create or replace function asset_category_report(p_filters jsonb default'{}')returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',c.category_id,'code',c.category_code,'name',c.category_name,'description',c.description,'usefulLife',c.useful_life_months,'method',c.depreciation_method,'residual',c.residual_value_percentage,'active',c.is_active,'assetAccountId',c.asset_account_id,'assetAccount',aa.account_number||' · '||aa.account_name,'depreciationAccountId',c.depreciation_account_id,'depreciationAccount',da.account_number||' · '||da.account_name,'expenseAccountId',c.depreciation_expense_account_id,'expenseAccount',case when ea.account_id is null then 'No aplica'else ea.account_number||' · '||ea.account_name end,'assets',coalesce(x.total,0))order by c.category_name),'[]'))from asset_category c join chart_accounts aa on aa.account_id=c.asset_account_id join chart_accounts da on da.account_id=c.depreciation_account_id left join chart_accounts ea on ea.account_id=c.depreciation_expense_account_id left join lateral(select count(*)total from asset where category_id=c.category_id)x on true where c.subsidiary_id=active_subsidiary_id()and(coalesce(nullif(p_filters->>'search',''),'')=''or concat_ws(' ',c.category_code,c.category_name,c.description)ilike'%'||(p_filters->>'search')||'%')and(coalesce(p_filters->>'status','ALL')='ALL'or c.is_active=(p_filters->>'status'='ACTIVE'))
$$;

create or replace function save_asset_category(p_payload jsonb,p_category_id bigint default null)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();id bigint:=p_category_id;a bigint:=nullif(p_payload->>'asset_account_id','')::bigint;d bigint:=nullif(p_payload->>'depreciation_account_id','')::bigint;e bigint:=nullif(p_payload->>'expense_account_id','')::bigint;life integer:=coalesce(nullif(p_payload->>'useful_life_months','')::integer,1);method text:=p_payload->>'method';
begin
 if nullif(trim(p_payload->>'code'),'')is null or nullif(trim(p_payload->>'name'),'')is null then raise exception 'Código y nombre son obligatorios.';end if;
 if method not in('Línea Recta','Suma de los Dígitos de los Años','No Depreciable')then raise exception 'Método de depreciación inválido.';end if;
 if a is null or d is null then raise exception 'Las cuentas de activo y depreciación acumulada son obligatorias.';end if;
 if method<>'No Depreciable'and e is null then raise exception 'La cuenta de gasto es obligatoria para categorías depreciables.';end if;
 if method<>'No Depreciable'and life<=0 then raise exception 'La vida útil debe ser mayor que cero.';end if;
 if a=d or(e is not null and(a=e or d=e))then raise exception 'Las cuentas contables seleccionadas deben ser diferentes.';end if;
 if exists(select 1 from unnest(array[a,d,e])u(account_id)where u.account_id is not null and not exists(select 1 from account_subsidiaries x join chart_accounts ca using(account_id)where x.account_id=u.account_id and x.subsidiary_id=sid and x.is_active and ca.accepts_entries and not ca.is_inactive))then raise exception 'Una cuenta no está disponible para la subsidiaria.';end if;
 if id is null then
  insert into asset_category(category_code,category_name,description,subsidiary_id,useful_life_months,depreciation_method,residual_value_percentage,asset_account_id,depreciation_account_id,depreciation_expense_account_id,is_active)values(upper(trim(p_payload->>'code')),trim(p_payload->>'name'),p_payload->>'description',sid,case when method='No Depreciable'then 1 else life end,method,coalesce(nullif(p_payload->>'residual','')::numeric,0),a,d,e,coalesce((p_payload->>'active')::boolean,true))returning category_id into id;
 else
  update asset_category set category_code=upper(trim(p_payload->>'code')),category_name=trim(p_payload->>'name'),description=p_payload->>'description',useful_life_months=case when method='No Depreciable'then 1 else life end,depreciation_method=method,residual_value_percentage=coalesce(nullif(p_payload->>'residual','')::numeric,0),asset_account_id=a,depreciation_account_id=d,depreciation_expense_account_id=e,is_active=coalesce((p_payload->>'active')::boolean,true)where category_id=id and subsidiary_id=sid;
  if not found then raise exception 'Categoría no encontrada.';end if;
 end if;
 return jsonb_build_object('id',id,'message','Categoría guardada correctamente.');
end$$;

drop trigger if exists protect_depreciated_asset_values_trigger on asset;
update asset set in_service_date=purchase_date where in_service_date is null;
create trigger protect_depreciated_asset_values_trigger before update on asset for each row execute function protect_depreciated_asset_values();
alter table asset alter column in_service_date set not null;

alter table asset
  add column if not exists opening_run_id bigint references opening_balance_runs,
  add column if not exists is_opening_balance boolean not null default false,
  add column if not exists opening_reversed_at timestamptz;

alter table asset_depreciation
  add column if not exists opening_run_id bigint references opening_balance_runs,
  add column if not exists is_opening_balance boolean not null default false,
  add column if not exists depreciated_months integer not null default 1 check(depreciated_months>=0);

do $$
begin
 if not exists(select 1 from pg_constraint where conrelid='asset'::regclass and conname='asset_opening_balance_consistency')then
  alter table asset add constraint asset_opening_balance_consistency check(is_opening_balance=(opening_run_id is not null));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='asset'::regclass and conname='asset_opening_reversal_consistency')then
  alter table asset add constraint asset_opening_reversal_consistency check(opening_reversed_at is null or is_opening_balance);
 end if;
 if not exists(select 1 from pg_constraint where conrelid='asset_depreciation'::regclass and conname='asset_depreciation_opening_consistency')then
  alter table asset_depreciation add constraint asset_depreciation_opening_consistency check(is_opening_balance=(opening_run_id is not null));
 end if;
end$$;

create or replace function validate_opening_asset_link()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.opening_run_id is not null and not exists(select 1 from opening_balance_runs r where r.id=new.opening_run_id and r.subsidiary_id=new.subsidiary_id)then
  raise exception 'El activo inicial y su lote de apertura deben pertenecer a la misma subsidiaria.';
 end if;
 return new;
end$$;
drop trigger if exists validate_opening_asset_link_trigger on asset;
create trigger validate_opening_asset_link_trigger before insert or update of opening_run_id,is_opening_balance,subsidiary_id on asset for each row execute function validate_opening_asset_link();

create or replace function validate_opening_depreciation_link()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.opening_run_id is not null and not exists(select 1 from asset a where a.asset_id=new.asset_id and a.opening_run_id=new.opening_run_id and a.is_opening_balance)then
  raise exception 'La depreciación histórica debe usar el mismo lote de apertura de la ficha del activo.';
 end if;
 return new;
end$$;
drop trigger if exists validate_opening_depreciation_link_trigger on asset_depreciation;
create trigger validate_opening_depreciation_link_trigger before insert or update of opening_run_id,is_opening_balance,asset_id on asset_depreciation for each row execute function validate_opening_depreciation_link();

-- Protección de cada ficha de saldo inicial y de su trazabilidad contable.
create or replace function protect_opening_fixed_asset_values()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 -- Una ficha de saldo inicial conserva importes y vínculo con la apertura.
 if coalesce(current_setting('app.opening_balance_internal',true),'')='1'then
  if tg_op='DELETE'then return old;else return new;end if;
 end if;
 if tg_op='INSERT'then
  if coalesce(new.is_opening_balance,false)or new.opening_run_id is not null then raise exception 'Las fichas iniciales solo pueden crearse desde la apertura de Carga de Saldos Iniciales.';end if;
  return new;
 elsif tg_op='DELETE'then
  if coalesce(old.is_opening_balance,false)or old.opening_run_id is not null then raise exception 'Las fichas iniciales solo pueden eliminarse al reversar la apertura contable.';end if;
  return old;
 end if;
 if(coalesce(old.is_opening_balance,false)or old.opening_run_id is not null or coalesce(new.is_opening_balance,false)or new.opening_run_id is not null)and(
  new.opening_run_id is distinct from old.opening_run_id or
  new.is_opening_balance is distinct from old.is_opening_balance or
  new.purchase_cost is distinct from old.purchase_cost or
  new.category_id is distinct from old.category_id or
  new.subsidiary_id is distinct from old.subsidiary_id or
  new.currency_id is distinct from old.currency_id or
  new.exchange_rate is distinct from old.exchange_rate or
  new.purchase_date is distinct from old.purchase_date or
   new.in_service_date is distinct from old.in_service_date or
   new.opening_reversed_at is distinct from old.opening_reversed_at or
   (old.opening_reversed_at is not null and new.status is distinct from old.status)
 )then raise exception 'No se pueden modificar la trazabilidad ni los valores contables de una ficha de saldo inicial de apertura.';end if;
 return new;
end$$;
drop trigger if exists protect_opening_fixed_asset_values_trigger on asset;
drop trigger if exists protect_00_opening_fixed_asset_values_trigger on asset;
create trigger protect_00_opening_fixed_asset_values_trigger before insert or update or delete on asset for each row execute function protect_opening_fixed_asset_values();

-- Protección de la depreciación histórica asociada al saldo inicial.
create or replace function protect_opening_asset_depreciation()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 -- La fila histórica de saldo inicial es inmutable fuera del flujo de apertura.
 if coalesce(current_setting('app.opening_balance_internal',true),'')='1'then
  if tg_op='DELETE'then return old;else return new;end if;
 end if;
 if exists(select 1 from asset a where a.asset_id=case when tg_op='INSERT'then new.asset_id else old.asset_id end and a.opening_reversed_at is not null)then
  raise exception 'La depreciación histórica pertenece a una apertura reversada y es inmutable.';
 end if;
 if tg_op='INSERT'then
  if coalesce(new.is_opening_balance,false)or new.opening_run_id is not null then raise exception 'La depreciación histórica solo puede crearse desde la apertura contable.';end if;
  return new;
 elsif tg_op='DELETE'then
  if coalesce(old.is_opening_balance,false)or old.opening_run_id is not null then raise exception 'La depreciación histórica solo puede eliminarse al reversar la apertura contable.';end if;
  return old;
 end if;
 if coalesce(old.is_opening_balance,false)or old.opening_run_id is not null or coalesce(new.is_opening_balance,false)or new.opening_run_id is not null then
  raise exception 'La depreciación histórica del saldo inicial de apertura es inmutable.';
 end if;
 return new;
end$$;
drop trigger if exists protect_opening_asset_depreciation_trigger on asset_depreciation;
create trigger protect_opening_asset_depreciation_trigger before insert or update or delete on asset_depreciation for each row execute function protect_opening_asset_depreciation();

create or replace function validate_fixed_asset_local_currency()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare local_currency bigint;selected_cost_type text;selected_department bigint;
begin
 select currency_id into local_currency from subsidiaries where subsidiary_id=new.subsidiary_id;
 if new.currency_id<>local_currency then raise exception 'Los activos fijos solo pueden registrarse en la moneda local de la subsidiaria.';end if;
 new.exchange_rate:=1;
 if new.department_id is not null and not exists(select 1 from departments d left join department_subsidiaries ds using(department_id)where d.department_id=new.department_id and(d.subsidiary_id=new.subsidiary_id or ds.subsidiary_id=new.subsidiary_id)and not d.is_inactive)then raise exception 'El departamento no pertenece a la subsidiaria.';end if;
 if new.cost_center_id is not null then
  select cc.cost_center_type,cu.department_id into selected_cost_type,selected_department from cost_centers cc left join customers cu using(customer_id)where cc.cost_center_id=new.cost_center_id and cc.subsidiary_id=new.subsidiary_id and not cc.is_inactive;
  if selected_cost_type is null then raise exception 'El centro de costos no pertenece a la subsidiaria.';end if;
  if selected_cost_type='CLIENTE'and(new.department_id is null or new.department_id is distinct from selected_department)then raise exception 'El centro de costos no corresponde al departamento seleccionado.';end if;
 end if;
 return new;
end$$;

-- El saldo acumulado inicial es historia del auxiliar; no representa la
-- depreciación contabilizada del mes de apertura.
do $$
declare constraint_name text;
begin
 for constraint_name in
  select conname from pg_constraint
  where conrelid='asset_depreciation'::regclass and contype='u'
    and pg_get_constraintdef(oid)like'UNIQUE (asset_id, fiscal_period_id)%'
 loop execute format('alter table asset_depreciation drop constraint %I',constraint_name);end loop;
end$$;
create unique index if not exists asset_depreciation_regular_period_idx
 on asset_depreciation(asset_id,fiscal_period_id)where not is_opening_balance;
create unique index if not exists asset_depreciation_opening_asset_idx
 on asset_depreciation(asset_id,opening_run_id)where is_opening_balance and opening_run_id is not null;

do $$
declare constraint_name text;
begin
 for constraint_name in
  select conname from pg_constraint where conrelid='opening_balance_runs'::regclass and contype='u'and pg_get_constraintdef(oid)like'UNIQUE (subsidiary_id)%'
 loop execute format('alter table opening_balance_runs drop constraint %I',constraint_name);end loop;
end$$;
create unique index if not exists one_active_opening_per_subsidiary on opening_balance_runs(subsidiary_id)where status<>'REVERSED';

do $$
declare constraint_name text;
begin
 for constraint_name in
  select conname from pg_constraint
  where conrelid='asset'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (asset_number)'
 loop execute format('alter table asset drop constraint %I',constraint_name);end loop;
end$$;
do $$
declare duplicate_codes text;
begin
 select string_agg(subsidiary_id||' / '||normalized_number,', 'order by subsidiary_id,normalized_number)into duplicate_codes
 from(select subsidiary_id,upper(asset_number)normalized_number from asset group by subsidiary_id,upper(asset_number)having count(*)>1)x;
 if duplicate_codes is not null then raise exception 'No se puede habilitar la numeración de activos por subsidiaria: existen códigos duplicados sin distinguir mayúsculas (%).',duplicate_codes;end if;
end$$;
drop index if exists asset_subsidiary_number_idx;
create unique index asset_subsidiary_number_idx on asset(subsidiary_id,upper(asset_number))where opening_reversed_at is null;
create index if not exists asset_opening_run_idx on asset(opening_run_id)where opening_run_id is not null;
create index if not exists asset_depreciation_opening_run_idx on asset_depreciation(opening_run_id)where opening_run_id is not null;

create table if not exists opening_fixed_asset_lines(
 id bigint generated always as identity primary key,
 run_id bigint not null references opening_balance_runs on delete cascade,
 row_number integer not null,
 asset_number text not null default 'AUTO',
 asset_name text not null,
 description text,
 serial_number text,
 category_id bigint not null references asset_category,
 category_asset_account_id bigint not null references chart_accounts,
 category_depreciation_account_id bigint not null references chart_accounts,
 category_expense_account_id bigint references chart_accounts,
 category_useful_life_months integer not null,
 category_depreciation_method text not null,
 category_residual_value_percentage numeric(9,6)not null,
 location_id bigint not null references locations,
 currency_id bigint not null references currencies,
 purchase_date date not null,
 in_service_date date not null,
 purchase_cost numeric(24,6)not null check(purchase_cost>0),
 accumulated_depreciation numeric(24,6)not null default 0 check(accumulated_depreciation>=0),
 book_value_control numeric(24,6)not null check(book_value_control>=0),
 depreciated_months integer not null default 0 check(depreciated_months>=0),
 department_id bigint references departments,
 cost_center_id bigint references cost_centers,
 class_id bigint references classes,
 status text not null default'ACTIVO'check(status in('ACTIVO','INACTIVO')),
 note text,
 raw_data jsonb not null default'{}',
 created_asset_id bigint references asset on delete set null,
 unique(run_id,row_number)
);
create unique index if not exists opening_fixed_asset_number_idx on opening_fixed_asset_lines(run_id,upper(asset_number))where upper(asset_number)<>'AUTO';
create index if not exists opening_fixed_asset_run_idx on opening_fixed_asset_lines(run_id);
alter table opening_fixed_asset_lines enable row level security;
drop policy if exists opening_fixed_asset_read on opening_fixed_asset_lines;
create policy opening_fixed_asset_read on opening_fixed_asset_lines for select to authenticated using(exists(select 1 from opening_balance_runs r where r.id=run_id and r.subsidiary_id=active_subsidiary_id()));
grant select on opening_fixed_asset_lines to authenticated;

create or replace function opening_balance_assert_access(p_action text)
returns bigint language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();uid bigint:=app_user_id();
begin
 perform security_assert_role_access('accounting:opening-balances',p_action);
 if sid is null or uid is null or not exists(select 1 from user_subsidiaries where user_id=uid and subsidiary_id=sid)then
  raise exception using errcode='42501',message='Seleccione una subsidiaria autorizada para administrar la apertura.';
 end if;
 return sid;
end$$;

create or replace function opening_balance_options()returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=opening_balance_assert_access('view');result jsonb;
begin
 select jsonb_build_object(
  'canCreate',app_is_admin()or exists(select 1 from role_access_matrix m where m.role_id=app_active_role_id()and(m.resource_key='legacy:all'or(m.resource_key='accounting:opening-balances'and m.can_create))),
  'canReverse',app_is_admin()or exists(select 1 from role_access_matrix m where m.role_id=app_active_role_id()and(m.resource_key='legacy:all'or(m.resource_key='accounting:opening-balances'and m.can_delete))),
  'subsidiary',jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currencyId',s.currency_id,'currency',cu.currency_code),
  'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.account_id,'number',a.account_number,'name',a.account_name,'category',a.category)order by a.account_number)from chart_accounts a join account_subsidiaries x using(account_id)where x.subsidiary_id=s.subsidiary_id and x.is_active and a.account_number='319999'and a.accepts_entries and not a.is_inactive),'[]'),
  'assetCategories',coalesce((select jsonb_agg(jsonb_build_object('code',category_code,'name',category_name,'life',useful_life_months,'method',depreciation_method)order by category_code)from asset_category where subsidiary_id=s.subsidiary_id and is_active),'[]'),
  'run',(select to_jsonb(r)from opening_balance_runs r where r.subsidiary_id=s.subsidiary_id and r.status<>'REVERSED'order by r.id desc limit 1)
 )into result from subsidiaries s join currencies cu using(currency_id)where s.subsidiary_id=sid;
 return result;
end$$;

create or replace function opening_fixed_asset_stage(p_run_id bigint,p_assets jsonb)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare
 run_row opening_balance_runs%rowtype;item jsonb;source_row integer;category_row asset_category%rowtype;
 location_key bigint;department_key bigint;cost_key bigint;class_key bigint;local_currency bigint;local_code text;cost_type text;cost_department bigint;
 cost_value numeric;accumulated_value numeric;book_value numeric;months_value integer;purchase_value date;service_value date;status_value text;number_value text;count_rows integer:=0;
begin
 select * into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'La apertura no pertenece a la subsidiaria activa.';end if;
 if exists(select 1 from opening_fixed_asset_lines where run_id=p_run_id and created_asset_id is not null)then raise exception 'El auxiliar de activos fijos ya fue cargado para esta apertura.';end if;
 delete from opening_fixed_asset_lines where run_id=p_run_id;
 select s.currency_id,c.currency_code into local_currency,local_code from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=run_row.subsidiary_id;
 for item in select value from jsonb_array_elements(coalesce(p_assets,'[]'::jsonb))loop
  source_row:=coalesce(nullif(item->>'sourceRow','')::integer,count_rows+2);count_rows:=count_rows+1;
  begin
   cost_value:=nullif(item->>'cost','')::numeric;
   accumulated_value:=coalesce(nullif(item->>'accumulatedDepreciation','')::numeric,0);
   months_value:=coalesce(nullif(item->>'depreciatedMonths','')::integer,0);
   purchase_value:=nullif(item->>'purchaseDate','')::date;
   service_value:=nullif(item->>'serviceDate','')::date;
  exception when others then raise exception 'Activos Fijos fila %: revise fechas, importes y meses depreciados.',source_row;end;
  number_value:=coalesce(nullif(upper(trim(item->>'assetNumber')),''),'AUTO');
  status_value:=upper(coalesce(nullif(trim(item->>'status'),''),'ACTIVO'));
  if nullif(trim(item->>'name'),'')is null then raise exception 'Activos Fijos fila %: el nombre es obligatorio.',source_row;end if;
  select * into category_row from asset_category where subsidiary_id=run_row.subsidiary_id and upper(category_code)=upper(trim(item->>'categoryCode'))and is_active limit 1;
  if category_row.category_id is null then raise exception 'Activos Fijos fila %: la categoría % no existe o está inactiva.',source_row,coalesce(item->>'categoryCode','');end if;
  if category_row.depreciation_method<>'No Depreciable'and(category_row.depreciation_expense_account_id is null or not exists(select 1 from chart_accounts a join account_subsidiaries x using(account_id)where a.account_id=category_row.depreciation_expense_account_id and x.subsidiary_id=run_row.subsidiary_id and x.is_active and a.accepts_entries and not a.is_inactive))then raise exception 'Activos Fijos fila %: la categoría % no tiene una cuenta de gasto de depreciación activa.',source_row,category_row.category_code;end if;
  select l.location_id into location_key from locations l left join location_subsidiaries ls using(location_id)where(l.subsidiary_id=run_row.subsidiary_id or ls.subsidiary_id=run_row.subsidiary_id)and(lower(l.name)=lower(trim(item->>'location'))or l.location_id::text=trim(item->>'location'))order by(l.subsidiary_id=run_row.subsidiary_id)desc limit 1;
  if location_key is null then raise exception 'Activos Fijos fila %: la ubicación % no pertenece a la subsidiaria.',source_row,coalesce(item->>'location','');end if;
  department_key:=null;
  if nullif(trim(item->>'department'),'')is not null then
   select d.department_id into department_key from departments d left join department_subsidiaries ds using(department_id)where(d.subsidiary_id=run_row.subsidiary_id or ds.subsidiary_id=run_row.subsidiary_id)and not d.is_inactive and lower(d.name)=lower(trim(item->>'department'))and(nullif(trim(item->>'departmentType'),'')is null or lower(d.type)=lower(trim(item->>'departmentType')))limit 1;
   if department_key is null then raise exception 'Activos Fijos fila %: el departamento % no está disponible.',source_row,item->>'department';end if;
  end if;
  cost_key:=null;
  if nullif(trim(item->>'costCenter'),'')is not null then
   select cc.cost_center_id,cc.cost_center_type,cu.department_id into cost_key,cost_type,cost_department from cost_centers cc left join customers cu using(customer_id)where cc.subsidiary_id=run_row.subsidiary_id and not cc.is_inactive and(lower(cc.code)=lower(trim(item->>'costCenter'))or lower(cc.name)=lower(trim(item->>'costCenter')))limit 1;
   if cost_key is null then raise exception 'Activos Fijos fila %: el centro de costos % no está disponible.',source_row,item->>'costCenter';end if;
   if cost_type='CLIENTE'and department_key is null then department_key:=cost_department;end if;
   if cost_type='CLIENTE'and(department_key is null or department_key is distinct from cost_department)then raise exception 'Activos Fijos fila %: el centro de costos no corresponde al departamento.',source_row;end if;
  end if;
  class_key:=null;
  if nullif(trim(item->>'className'),'')is not null then
   select c.class_id into class_key from classes c left join class_subsidiaries cs using(class_id)where(c.subsidiary_id=run_row.subsidiary_id or cs.subsidiary_id=run_row.subsidiary_id)and not c.is_inactive and lower(c.name)=lower(trim(item->>'className'))limit 1;
   if class_key is null then raise exception 'Activos Fijos fila %: la clase % no está disponible.',source_row,item->>'className';end if;
  elsif cost_key is not null then select class_id into class_key from cost_centers where cost_center_id=cost_key;end if;
  if upper(coalesce(item->>'currency',''))<>upper(local_code)then raise exception 'Activos Fijos fila %: la moneda debe ser la moneda funcional %.',source_row,local_code;end if;
  if cost_value is null or cost_value<=0 then raise exception 'Activos Fijos fila %: el costo histórico debe ser mayor que cero.',source_row;end if;
  if accumulated_value<0 or accumulated_value>cost_value then raise exception 'Activos Fijos fila %: la depreciación acumulada debe estar entre cero y el costo histórico.',source_row;end if;
  if purchase_value is null or service_value is null or purchase_value>service_value or service_value>run_row.opening_date then raise exception 'Activos Fijos fila %: las fechas deben cumplir compra ≤ servicio ≤ apertura.',source_row;end if;
  if status_value not in('ACTIVO','INACTIVO')then raise exception 'Activos Fijos fila %: el estado debe ser ACTIVO o INACTIVO.',source_row;end if;
  if category_row.depreciation_method='No Depreciable'and(accumulated_value<>0 or months_value<>0)then raise exception 'Activos Fijos fila %: una categoría no depreciable debe tener depreciación y meses en cero.',source_row;end if;
  if category_row.depreciation_method<>'No Depreciable'and(months_value<0 or months_value>category_row.useful_life_months)then raise exception 'Activos Fijos fila %: los meses depreciados deben estar entre 0 y %.',source_row,category_row.useful_life_months;end if;
  if category_row.depreciation_method<>'No Depreciable'and months_value>(extract(year from age(run_row.opening_date,service_value))::integer*12+extract(month from age(run_row.opening_date,service_value))::integer+1)then raise exception 'Activos Fijos fila %: los meses depreciados superan los meses transcurridos desde la fecha de servicio.',source_row;end if;
  if accumulated_value>round(cost_value*(1-category_row.residual_value_percentage/100),6)+.005 then raise exception 'Activos Fijos fila %: la depreciación supera la base depreciable de la categoría.',source_row;end if;
  if accumulated_value>0 and months_value=0 then raise exception 'Activos Fijos fila %: indique los meses consumidos para la depreciación acumulada.',source_row;end if;
  if category_row.depreciation_method<>'No Depreciable'and months_value=category_row.useful_life_months and accumulated_value<round(cost_value*(1-category_row.residual_value_percentage/100),6)-.005 then raise exception 'Activos Fijos fila %: agotó la vida útil, pero conserva depreciación pendiente.',source_row;end if;
  book_value:=cost_value-accumulated_value;
  if nullif(item->>'bookValue','')is not null and abs((item->>'bookValue')::numeric-book_value)>.005 then raise exception 'Activos Fijos fila %: el valor en libros debe ser costo menos depreciación acumulada (%).',source_row,book_value;end if;
  if number_value<>'AUTO'and exists(select 1 from asset where subsidiary_id=run_row.subsidiary_id and opening_reversed_at is null and upper(asset_number)=number_value)then raise exception 'Activos Fijos fila %: el código % ya existe. No lo incluya nuevamente; la conciliación reconoce automáticamente las fichas existentes a la fecha de apertura.',source_row,number_value;end if;
  if number_value<>'AUTO'and exists(select 1 from opening_fixed_asset_lines where run_id=p_run_id and upper(asset_number)=number_value)then raise exception 'Activos Fijos fila %: el código % está repetido dentro del archivo.',source_row,number_value;end if;
  if nullif(trim(item->>'serial'),'')is not null and(exists(select 1 from asset where subsidiary_id=run_row.subsidiary_id and opening_reversed_at is null and lower(serial_number)=lower(trim(item->>'serial')))or exists(select 1 from opening_fixed_asset_lines where run_id=p_run_id and lower(serial_number)=lower(trim(item->>'serial'))))then raise exception 'Activos Fijos fila %: el número de serie % está duplicado.',source_row,item->>'serial';end if;
  insert into opening_fixed_asset_lines(run_id,row_number,asset_number,asset_name,description,serial_number,category_id,category_asset_account_id,category_depreciation_account_id,category_expense_account_id,category_useful_life_months,category_depreciation_method,category_residual_value_percentage,location_id,currency_id,purchase_date,in_service_date,purchase_cost,accumulated_depreciation,book_value_control,depreciated_months,department_id,cost_center_id,class_id,status,note,raw_data)
  values(p_run_id,source_row,number_value,trim(item->>'name'),nullif(trim(item->>'description'),''),nullif(trim(item->>'serial'),''),category_row.category_id,category_row.asset_account_id,category_row.depreciation_account_id,category_row.depreciation_expense_account_id,category_row.useful_life_months,category_row.depreciation_method,category_row.residual_value_percentage,location_key,local_currency,purchase_value,service_value,cost_value,accumulated_value,book_value,months_value,department_key,cost_key,class_key,status_value,nullif(trim(item->>'note'),''),item);
 end loop;
 return count_rows;
end$$;

create or replace function opening_fixed_asset_reconciliation(p_run_id bigint)
returns jsonb language sql stable security definer set search_path=public as $$
with run as(
 select id,subsidiary_id,opening_date,status,journal_id from opening_balance_runs where id=p_run_id and subsidiary_id=active_subsidiary_id()
),staged as(
 select 'Costo histórico'::text type,c.asset_account_id account_id,sum(f.purchase_cost)staged
 from opening_fixed_asset_lines f join asset_category c using(category_id)where f.run_id=p_run_id group by c.asset_account_id
 union all
 select 'Depreciación acumulada',c.depreciation_account_id,sum(f.accumulated_depreciation)
 from opening_fixed_asset_lines f join asset_category c using(category_id)where f.run_id=p_run_id group by c.depreciation_account_id
),existing as(
 select 'Costo histórico'::text type,c.asset_account_id account_id,sum(a.purchase_cost*a.exchange_rate)existing
 from run r join asset a on a.subsidiary_id=r.subsidiary_id and a.opening_run_id is distinct from r.id
 join asset_category c using(category_id)
 where a.purchase_date<=r.opening_date and a.opening_reversed_at is null
  and not exists(select 1 from asset_disposal d where d.asset_id=a.asset_id and d.disposal_date<=r.opening_date)
 group by c.asset_account_id
 union all
 select 'Depreciación acumulada',c.depreciation_account_id,sum(d.depreciation_amount*a.exchange_rate)
 from run r join asset a on a.subsidiary_id=r.subsidiary_id and a.opening_run_id is distinct from r.id
 join asset_category c using(category_id)join asset_depreciation d using(asset_id)
 where a.purchase_date<=r.opening_date and a.opening_reversed_at is null and d.depreciation_date<=r.opening_date
  and not exists(select 1 from asset_disposal z where z.asset_id=a.asset_id and z.disposal_date<=r.opening_date)
 group by c.depreciation_account_id
),ledger_values as(
 select l.account_id,l.local_debit debit,l.local_credit credit
 from run r join opening_balance_lines l on l.run_id=r.id where r.status<>'POSTED'
 union all
 select g.account_id,g.debit_amount,g.credit_amount
 from run r join journal j on j.journal_id=r.journal_id join gl_impact g on g.transaction_id=j.transaction_id join accounting_books b using(accounting_book_id)where r.status='POSTED'and b.is_primary and b.is_active
),ledger_accounts as(
 select distinct
  case when exists(select 1 from asset_category c where c.subsidiary_id=r.subsidiary_id and c.depreciation_account_id=l.account_id)
    or account_belongs_to_group(l.account_id,'depreciaci.n acumulada')or a.account_name~*'depreciaci.n acumulada'
   then 'Depreciación acumulada'else 'Costo histórico'end type,l.account_id
 from run r cross join ledger_values l join chart_accounts a using(account_id)
 where fixed_asset_ppe_account(l.account_id)
  or exists(select 1 from asset_category c where c.subsidiary_id=r.subsidiary_id and(c.asset_account_id=l.account_id or c.depreciation_account_id=l.account_id))
  or account_belongs_to_group(l.account_id,'depreciaci.n acumulada')or a.account_name~*'depreciaci.n acumulada'
),keys as(
 select type,account_id from staged union select type,account_id from existing union select type,account_id from ledger_accounts
),amounts as(
 select k.type,k.account_id,coalesce(e.existing,0)existing,coalesce(s.staged,0)staged,
  case when k.type='Costo histórico'then coalesce(sum(l.debit-l.credit),0)else coalesce(sum(l.credit-l.debit),0)end ledger
 from keys k left join existing e using(type,account_id)left join staged s using(type,account_id)
 left join ledger_values l on l.account_id=k.account_id
 group by k.type,k.account_id,e.existing,s.staged
)
select coalesce(jsonb_agg(jsonb_build_object(
 'type',x.type,'accountId',x.account_id,'accountNumber',c.account_number,'accountName',c.account_name,
 'ledger',x.ledger,'existing',x.existing,'staged',x.staged,'auxiliary',x.existing+x.staged,
 'difference',x.ledger-x.existing-x.staged
)order by x.type,c.account_number),'[]'::jsonb)from amounts x join chart_accounts c using(account_id)
$$;

create or replace function opening_balance_stage(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare rid bigint;item jsonb;row_number_value integer;rate numeric;account_key bigint;currency_key bigint;debit numeric;credit numeric;sid bigint:=active_subsidiary_id();
begin
 if sid is null then raise exception 'Seleccione una subsidiaria activa.';end if;
 if nullif(p->>'openingDate','')is null then raise exception 'Indique la fecha de apertura.';end if;
 if(p->>'openingDate')::date>current_date then raise exception 'La fecha de apertura no puede ser futura.';end if;
 if p->>'loadType'not in('FISCAL_YEAR','MID_YEAR')then raise exception 'Seleccione un tipo de carga válido.';end if;
 if exists(select 1 from opening_balance_runs where subsidiary_id=sid and status='POSTED')then raise exception 'Ya existe una apertura contabilizada para esta subsidiaria.';end if;
 delete from opening_balance_runs where subsidiary_id=sid and status in('DRAFT','VALIDATED');
 insert into opening_balance_runs(subsidiary_id,opening_date,load_type,transition_account_id,created_by)values(sid,(p->>'openingDate')::date,p->>'loadType',(p->>'transitionAccountId')::bigint,app_user_id())returning id into rid;
 for item in select value from jsonb_array_elements(coalesce(p->'rows','[]'::jsonb))loop
  row_number_value:=coalesce(nullif(item->>'sourceRow','')::integer,1+(select count(*)from opening_balance_lines where run_id=rid and source_type=item->>'sourceType'));
  select a.account_id into account_key from chart_accounts a join account_subsidiaries s using(account_id)where a.account_number=item->>'account'and s.subsidiary_id=sid and s.is_active and a.accepts_entries and not a.is_inactive limit 1;
  select currency_id into currency_key from currencies where upper(currency_code)=upper(item->>'currency')limit 1;
  if account_key is null then raise exception '% fila %: la cuenta % no está habilitada para la subsidiaria.',item->>'sourceType',row_number_value,coalesce(item->>'account','');end if;
  if currency_key is null then raise exception '% fila %: la moneda % no existe.',item->>'sourceType',row_number_value,coalesce(item->>'currency','');end if;
  rate:=opening_balance_rate(currency_key,(p->>'openingDate')::date);
  begin debit:=coalesce(nullif(item->>'debit','')::numeric,0)*rate;credit:=coalesce(nullif(item->>'credit','')::numeric,0)*rate;exception when others then raise exception '% fila %: revise el importe.',item->>'sourceType',row_number_value;end;
  if(debit>0)=(credit>0)then raise exception '% fila %: indique únicamente débito o crédito.',item->>'sourceType',row_number_value;end if;
  insert into opening_balance_lines(run_id,source_type,row_number,account_id,document_number,issue_date,due_date,currency_id,historical_rate,foreign_amount,local_debit,local_credit,project_code,note,raw_data)
  values(rid,item->>'sourceType',row_number_value,account_key,nullif(item->>'documentNumber',''),nullif(item->>'issueDate','')::date,nullif(item->>'dueDate','')::date,currency_key,rate,greatest(coalesce(nullif(item->>'debit','')::numeric,0),coalesce(nullif(item->>'credit','')::numeric,0)),debit,credit,nullif(item->>'project',''),nullif(item->>'note',''),item);
 end loop;
 return(select jsonb_build_object('runId',rid,'rows',count(*),'debit',coalesce(sum(local_debit),0),'credit',coalesce(sum(local_credit),0),'difference',coalesce(sum(local_debit-local_credit),0))from opening_balance_lines where run_id=rid);
end$$;

create or replace function opening_balance_validate(p jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare output jsonb;rid bigint;line record;existing opening_balance_runs%rowtype;asset_count integer;sid bigint;
begin
 sid:=opening_balance_assert_access('create');
 if coalesce(p->>'expectedSubsidiaryId','')<>sid::text then raise exception 'La empresa activa cambió desde que abrió la carga. Recargue la pantalla y seleccione nuevamente los archivos.';end if;
 select * into existing from opening_balance_runs where subsidiary_id=active_subsidiary_id()and status<>'REVERSED'order by id desc limit 1;
 if existing.status='POSTED'then
  if jsonb_array_length(coalesce(p->'rows','[]'::jsonb))>0 then raise exception 'La apertura ya está contabilizada. Solo puede agregar el auxiliar de activos fijos pendiente.';end if;
  if jsonb_array_length(coalesce(p->'assets','[]'::jsonb))=0 then raise exception 'Seleccione la plantilla del auxiliar de activos fijos.';end if;
  rid:=existing.id;asset_count:=opening_fixed_asset_stage(rid,p->'assets');
 else
  output:=opening_balance_stage(p);rid:=(output->>'runId')::bigint;
  for line in select l.*,a.category from opening_balance_lines l join chart_accounts a using(account_id)where l.run_id=rid loop
   update opening_balance_lines set cost_center_id=(select cost_center_id from cost_centers where subsidiary_id=active_subsidiary_id()and(code=line.raw_data->>'costCenter'or lower(name)=lower(line.raw_data->>'costCenter'))limit 1),location_id=(select l.location_id from locations l left join location_subsidiaries ls using(location_id)where(l.subsidiary_id=active_subsidiary_id()or ls.subsidiary_id=active_subsidiary_id())and(lower(l.name)=lower(line.raw_data->>'location')or l.location_id::text=line.raw_data->>'location')limit 1)where id=line.id;
   if(select load_type from opening_balance_runs where id=rid)='FISCAL_YEAR'and coalesce(line.category,'')in('Ingreso','Ingresos','Gasto','Gastos','Costo','Costos')then raise exception 'Fila %: las cuentas de resultados solo se permiten en apertura a mitad de período.',line.row_number;end if;
   if coalesce(line.category,'')in('Ingreso','Ingresos','Gasto','Gastos','Costo','Costos')and(coalesce(line.raw_data->>'costCenter','')=''or coalesce(line.raw_data->>'location','')='')then raise exception 'Fila %: centro de costo y sucursal son obligatorios para cuentas de resultados.',line.row_number;end if;
   if coalesce(line.raw_data->>'costCenter','')<>''and not exists(select 1 from cost_centers where subsidiary_id=active_subsidiary_id()and(code=line.raw_data->>'costCenter'or lower(name)=lower(line.raw_data->>'costCenter')))then raise exception 'Fila %: centro de costo inválido.',line.row_number;end if;
   if line.source_type='AR'and not exists(select 1 from customers c where c.tax_id=line.raw_data->>'entityTaxId'and(c.primary_subsidiary_id=active_subsidiary_id()or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=active_subsidiary_id())))then raise exception 'CxC fila %: cliente % no encontrado.',line.row_number,line.raw_data->>'entityTaxId';end if;
   if line.source_type='AP'and not exists(select 1 from suppliers s where s.tax_id=line.raw_data->>'entityTaxId'and(s.primary_subsidiary_id=active_subsidiary_id()or exists(select 1 from entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=active_subsidiary_id())))then raise exception 'CxP fila %: proveedor % no encontrado.',line.row_number,line.raw_data->>'entityTaxId';end if;
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

create or replace function opening_balance_preview(p_run_id bigint)returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 perform opening_balance_assert_access('view');
 select jsonb_build_object(
 'run',to_jsonb(r),
 'rows',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'sourceType',l.source_type,'row',l.row_number,'account',a.account_number||' · '||a.account_name,'document',l.document_number,'currency',c.currency_code,'rate',l.historical_rate,'foreignAmount',l.foreign_amount,'debit',l.local_debit,'credit',l.local_credit,'costCenter',cc.code,'location',lo.name,'project',l.project_code,'note',l.note)order by l.source_type,l.row_number)from opening_balance_lines l join chart_accounts a on a.account_id=l.account_id join currencies c on c.currency_id=l.currency_id left join cost_centers cc on cc.cost_center_id=l.cost_center_id left join locations lo on lo.location_id=l.location_id where l.run_id=r.id),'[]'::jsonb),
 'summary',(select jsonb_build_object('debit',coalesce(sum(local_debit),0),'credit',coalesce(sum(local_credit),0),'difference',coalesce(sum(local_debit-local_credit),0),'count',count(*))from opening_balance_lines where run_id=r.id),
 'assets',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'row',f.row_number,'number',f.asset_number,'name',f.asset_name,'serial',f.serial_number,'categoryCode',c.category_code,'category',c.category_name,'location',l.name,'purchaseDate',f.purchase_date,'serviceDate',f.in_service_date,'cost',f.purchase_cost,'accumulated',f.accumulated_depreciation,'bookValue',f.book_value_control,'depreciatedMonths',f.depreciated_months,'department',d.name,'costCenter',cc.code||' · '||cc.name,'className',cl.name,'status',f.status,'created',f.created_asset_id is not null)order by f.row_number)from opening_fixed_asset_lines f join asset_category c on c.category_id=f.category_id join locations l on l.location_id=f.location_id left join departments d on d.department_id=f.department_id left join cost_centers cc on cc.cost_center_id=f.cost_center_id left join classes cl on cl.class_id=f.class_id where f.run_id=r.id),'[]'::jsonb),
 'assetReconciliation',opening_fixed_asset_reconciliation(r.id),
 'assetSummary',(select jsonb_build_object('count',count(*),'cost',coalesce(sum(purchase_cost),0),'accumulated',coalesce(sum(accumulated_depreciation),0),'bookValue',coalesce(sum(book_value_control),0),'pending',count(*)filter(where created_asset_id is null),'created',count(*)filter(where created_asset_id is not null),'balanced',coalesce((select bool_and(abs((x->>'difference')::numeric)<=.005)from jsonb_array_elements(opening_fixed_asset_reconciliation(r.id))x),true))from opening_fixed_asset_lines where run_id=r.id)
 )into result from opening_balance_runs r where r.id=p_run_id and r.subsidiary_id=active_subsidiary_id();
 return result;
end$$;

create or replace function opening_fixed_asset_create(p_run_id bigint,p_period_id bigint)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare staged opening_fixed_asset_lines%rowtype;asset_key bigint;created_number text;created_count integer:=0;reconciliation jsonb;
begin
 if exists(select 1 from opening_fixed_asset_lines f join opening_balance_runs r on r.id=f.run_id join asset_category c using(category_id)where f.run_id=p_run_id and(not c.is_active or c.asset_account_id is distinct from f.category_asset_account_id or c.depreciation_account_id is distinct from f.category_depreciation_account_id or c.depreciation_expense_account_id is distinct from f.category_expense_account_id or c.useful_life_months is distinct from f.category_useful_life_months or c.depreciation_method is distinct from f.category_depreciation_method or c.residual_value_percentage is distinct from f.category_residual_value_percentage or not exists(select 1 from chart_accounts a join account_subsidiaries x using(account_id)where a.account_id=c.asset_account_id and x.subsidiary_id=r.subsidiary_id and x.is_active and a.accepts_entries and not a.is_inactive)or not exists(select 1 from chart_accounts a join account_subsidiaries x using(account_id)where a.account_id=c.depreciation_account_id and x.subsidiary_id=r.subsidiary_id and x.is_active and a.accepts_entries and not a.is_inactive)or(c.depreciation_method<>'No Depreciable'and(c.depreciation_expense_account_id is null or not exists(select 1 from chart_accounts a join account_subsidiaries x using(account_id)where a.account_id=c.depreciation_expense_account_id and x.subsidiary_id=r.subsidiary_id and x.is_active and a.accepts_entries and not a.is_inactive)))))then
  raise exception 'Una categoría de activos cambió después de la validación. Valide nuevamente el archivo antes de contabilizar.';
 end if;
 reconciliation:=opening_fixed_asset_reconciliation(p_run_id);
 if exists(select 1 from jsonb_array_elements(reconciliation)x where abs((x->>'difference')::numeric)>.005)then raise exception 'El auxiliar de activos fijos no coincide con el Libro Mayor. Corrija las cuentas marcadas con diferencia.';end if;
 for staged in select * from opening_fixed_asset_lines where run_id=p_run_id and created_asset_id is null order by row_number for update loop
  insert into asset(asset_number,asset_name,description,serial_number,category_id,subsidiary_id,location_id,currency_id,purchase_date,in_service_date,purchase_cost,exchange_rate,department_id,cost_center_id,class_id,status,opening_run_id,is_opening_balance)
  select staged.asset_number,staged.asset_name,staged.description,staged.serial_number,staged.category_id,r.subsidiary_id,staged.location_id,staged.currency_id,staged.purchase_date,staged.in_service_date,staged.purchase_cost,1,staged.department_id,staged.cost_center_id,staged.class_id,staged.status,p_run_id,true from opening_balance_runs r where r.id=p_run_id returning asset_id,asset_number into asset_key,created_number;
  if staged.accumulated_depreciation>0 or staged.depreciated_months>0 then
   insert into asset_depreciation(depreciation_date,asset_id,fiscal_period_id,gl_impact_id,depreciation_amount,accumulated_depreciation,opening_run_id,is_opening_balance,depreciated_months)
   select r.opening_date,asset_key,p_period_id,null,staged.accumulated_depreciation,staged.accumulated_depreciation,p_run_id,true,staged.depreciated_months from opening_balance_runs r where r.id=p_run_id;
  end if;
  update opening_fixed_asset_lines set created_asset_id=asset_key,asset_number=created_number where id=staged.id;
  created_count:=created_count+1;
 end loop;
 return created_count;
end$$;

create or replace function opening_balance_post(p_run_id bigint)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare run_row opening_balance_runs%rowtype;line opening_balance_lines%rowtype;period_key bigint;base_currency bigint;book_key bigint;journal_key bigint;journal_number_value text;difference_value numeric;customer_key bigint;supplier_key bigint;assets_created integer:=0;reconciliation jsonb;
begin
 perform opening_balance_assert_access('create');
 select * into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=active_subsidiary_id()for update;
 if run_row.id is null then raise exception 'Lote no disponible.';end if;
 if(select count(*)from accounting_books where subsidiary_id=run_row.subsidiary_id and is_primary and is_active)<>1 then raise exception 'Configure un único libro contable principal activo antes de contabilizar la apertura.';end if;
 reconciliation:=opening_fixed_asset_reconciliation(run_row.id);
 if exists(select 1 from jsonb_array_elements(reconciliation)x where abs((x->>'difference')::numeric)>.005)then raise exception 'El auxiliar de activos fijos no coincide con el Libro Mayor. Corrija la conciliación antes de continuar.';end if;
 if run_row.status='POSTED'then
  if not exists(select 1 from opening_fixed_asset_lines where run_id=run_row.id and created_asset_id is null)then raise exception 'No hay fichas de activos pendientes de cargar.';end if;
  select fiscal_period_id into period_key from journal where journal_id=run_row.journal_id;
  perform set_config('app.opening_balance_internal','1',true);
  assets_created:=opening_fixed_asset_create(run_row.id,period_key);
  perform set_config('app.opening_balance_internal','',true);
  return jsonb_build_object('runId',run_row.id,'journalId',run_row.journal_id,'journalNumber',(select journal_number from journal where journal_id=run_row.journal_id),'assetsOnly',true,'assetsCreated',assets_created);
 end if;
 if run_row.status<>'VALIDATED'then raise exception 'Valide nuevamente el lote antes de contabilizar.';end if;
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
 select journal_number_value,run_row.opening_date,run_row.subsidiary_id,base_currency,period_key,1,'Carga de saldos iniciales','APERTURA',coalesce(sum(local_debit),0),coalesce(sum(local_credit),0),'CONTABILIZADO',app_user_id(),true,true from opening_balance_lines where run_id=run_row.id returning journal_id into journal_key;
 for line in select * from opening_balance_lines where run_id=run_row.id order by id loop
  customer_key:=null;supplier_key:=null;
  if line.source_type='AR'then
   select customer_id into customer_key from customers c where c.tax_id=line.raw_data->>'entityTaxId'and(c.primary_subsidiary_id=run_row.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=run_row.subsidiary_id))limit 1;
   if customer_key is null then raise exception 'Fila % CxC: cliente no encontrado.',line.row_number;end if;
   if line.document_number is null or line.issue_date is null or line.due_date is null then raise exception 'Fila % CxC: complete documento, emisión y vencimiento.',line.row_number;end if;
   if exists(select 1 from invoice where invoice_number=line.document_number and customer_id=customer_key)then raise exception 'La factura CxC % ya existe.',line.document_number;end if;
   insert into invoice(invoice_number,customer_id,subsidiary_id,due_date,total_amount,invoice_date,fiscal_period_id,currency_id,exchange_rate,memo,journal_id,location_id,opening_run_id,is_opening_balance)values(line.document_number,customer_key,run_row.subsidiary_id,line.due_date,line.foreign_amount,line.issue_date,period_key,line.currency_id,line.historical_rate,coalesce(line.note,'Saldo inicial CxC'),journal_key,line.location_id,run_row.id,true);
  elsif line.source_type='AP'then
   select supplier_id into supplier_key from suppliers s where s.tax_id=line.raw_data->>'entityTaxId'and(s.primary_subsidiary_id=run_row.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.supplier_id=s.supplier_id and e.subsidiary_id=run_row.subsidiary_id))limit 1;
   if supplier_key is null then raise exception 'Fila % CxP: proveedor no encontrado.',line.row_number;end if;
   if line.document_number is null or line.issue_date is null or line.due_date is null then raise exception 'Fila % CxP: complete documento, emisión y vencimiento.',line.row_number;end if;
   if exists(select 1 from supplier_invoice where invoice_number=line.document_number and supplier_id=supplier_key)then raise exception 'La factura CxP % ya existe.',line.document_number;end if;
   insert into supplier_invoice(invoice_number,supplier_id,subsidiary_id,due_date,total_amount,invoice_date,fiscal_period_id,currency_id,exchange_rate,memo,journal_id,location_id,opening_run_id,is_opening_balance)values(line.document_number,supplier_key,run_row.subsidiary_id,line.due_date,line.foreign_amount,line.issue_date,period_key,line.currency_id,line.historical_rate,coalesce(line.note,'Saldo inicial CxP'),journal_key,line.location_id,run_row.id,true);
  end if;
  insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,location_id,cost_center_id,note,entity_type,customer_id,supplier_id,historical_exchange_rate,original_currency_id,opening_balance_line_id)
  values(journal_key,line.account_id,line.local_debit,line.local_credit,case when line.local_debit>0 then line.foreign_amount else 0 end,case when line.local_credit>0 then line.foreign_amount else 0 end,line.location_id,line.cost_center_id,coalesce(line.note,'Saldo inicial'),case line.source_type when'AR'then'Cliente'when'AP'then'Proveedor'end,customer_key,supplier_key,line.historical_rate,line.currency_id,line.id);
 end loop;
 assets_created:=opening_fixed_asset_create(run_row.id,period_key);
 delete from gl_impact where transaction_id=(select transaction_id from journal where journal_id=journal_key);
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date)
 select j.transaction_id,l.account_id,j.subsidiary_id,j.fiscal_period_id,book_key,l.debit,l.credit,l.debit_fx,l.credit_fx,j.journal_date
 from journal j join journal_line l using(journal_id)where j.journal_id=journal_key;
 if not exists(select 1 from journal j join gl_impact g on g.transaction_id=j.transaction_id join accounting_books b using(accounting_book_id)where j.journal_id=journal_key and b.is_primary and b.is_active)then raise exception 'No fue posible registrar el asiento de apertura en el libro principal activo.';end if;
 update opening_balance_runs set status='POSTED',journal_id=journal_key,posted_at=now()where id=run_row.id;
 perform set_config('app.asset_proposal_internal','',true);perform set_config('app.opening_balance_internal','',true);
 return jsonb_build_object('runId',run_row.id,'journalId',journal_key,'journalNumber',journal_number_value,'assetsOnly',false,'assetsCreated',assets_created);
end$$;

create or replace function opening_balance_reverse(p_run_id bigint)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare run_row opening_balance_runs%rowtype;reversal_key bigint;reversal_number text;reversal_period_key bigint;
begin
 perform opening_balance_assert_access('delete');
 select * into run_row from opening_balance_runs where id=p_run_id and subsidiary_id=active_subsidiary_id()and status='POSTED'for update;
 if run_row.id is null then raise exception 'Apertura contabilizada no encontrada.';end if;
 if exists(select 1 from customer_payment_application a join invoice i using(invoice_id)where i.opening_run_id=run_row.id)or exists(select 1 from supplier_payment_application a join supplier_invoice i using(invoice_id)where i.opening_run_id=run_row.id)then raise exception 'No se puede reversar: existen cobros o pagos aplicados a documentos iniciales.';end if;
 if exists(select 1 from asset_depreciation where opening_run_id=run_row.id and not is_opening_balance)or exists(select 1 from asset_depreciation d join asset a using(asset_id)where a.opening_run_id=run_row.id and not d.is_opening_balance)or exists(select 1 from asset_transfer t join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_disposal d join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_maintenance m join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_revaluation v join asset a using(asset_id)where a.opening_run_id=run_row.id)or exists(select 1 from asset_impairment i join asset a using(asset_id)where a.opening_run_id=run_row.id)then raise exception 'No se puede reversar: un activo inicial tiene depreciaciones u operaciones posteriores.';end if;
 if exists(select 1 from jsonb_array_elements(opening_fixed_asset_reconciliation(run_row.id))x where abs(coalesce((x->>'existing')::numeric,0))>.005)then raise exception 'No se puede reversar: el saldo PPE de apertura está conciliado con fichas de activos preexistentes. Revise y relacione esas fichas antes de reversar.';end if;
 select fiscal_period_id into reversal_period_key from fiscal_periods where subsidiary_id=run_row.subsidiary_id and run_row.opening_date between start_date and end_date and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)limit 1;
 if reversal_period_key is null then raise exception 'No se puede reversar la apertura porque su período contable original está cerrado. Reabra ese período antes de continuar.';end if;
 reversal_number:='REV-'||(select journal_number from journal where journal_id=run_row.journal_id);
 perform set_config('app.asset_proposal_internal','1',true);perform set_config('app.opening_balance_internal','1',true);
 insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,created_by,reversed_from_journal_id,asset_proposal_internal)
 select reversal_number,run_row.opening_date,subsidiary_id,currency_id,reversal_period_key,1,'Reversión de apertura','Reversión',total_credit,total_debit,'CONTABILIZADO',app_user_id(),journal_id,true from journal where journal_id=run_row.journal_id returning journal_id into reversal_key;
 insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,cost_center_id,note,entity_type,customer_id,supplier_id,historical_exchange_rate,original_currency_id,opening_balance_line_id)
 select reversal_key,account_id,credit,debit,credit_fx,debit_fx,department_id,class_id,location_id,cost_center_id,'Reversión de apertura',entity_type,customer_id,supplier_id,historical_exchange_rate,original_currency_id,opening_balance_line_id from journal_line where journal_id=run_row.journal_id;
 delete from gl_impact where transaction_id=(select transaction_id from journal where journal_id=reversal_key);
 insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date)
 select reversal.transaction_id,original.account_id,original.subsidiary_id,reversal_period_key,original.accounting_book_id,original.credit_amount,original.debit_amount,original.credit_fx,original.debit_fx,run_row.opening_date
 from journal source join gl_impact original on original.transaction_id=source.transaction_id cross join journal reversal
 where source.journal_id=run_row.journal_id and reversal.journal_id=reversal_key;
 if not exists(select 1 from journal j join gl_impact g on g.transaction_id=j.transaction_id where j.journal_id=reversal_key)then raise exception 'No fue posible registrar los impactos de la reversión en el libro original.';end if;
 delete from invoice where opening_run_id=run_row.id;
 delete from supplier_invoice where opening_run_id=run_row.id;
 update asset set opening_reversed_at=run_row.opening_date::timestamp,status='INACTIVO'where opening_run_id=run_row.id and is_opening_balance;
 update opening_balance_runs set status='REVERSED',reversed_at=now()where id=run_row.id;
 perform set_config('app.asset_proposal_internal','',true);perform set_config('app.opening_balance_internal','',true);
 return jsonb_build_object('reversalJournalId',reversal_key,'number',reversal_number);
end$$;

create or replace function protect_opening_journal_mutation()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare protected_record boolean:=false;
begin
 if coalesce(current_setting('app.opening_balance_internal',true),'')='1'then
  if tg_op='DELETE'then return old;else return new;end if;
 end if;
 if tg_table_name='journal'then
  if tg_op='INSERT'then
   protected_record:=coalesce(new.is_opening_balance,false)or exists(select 1 from journal target left join journal origin on origin.journal_id=target.reversed_from_journal_id where target.journal_id=new.reversed_from_journal_id and(target.is_opening_balance or origin.is_opening_balance));
  elsif tg_op='DELETE'then
   protected_record:=coalesce(old.is_opening_balance,false)or(old.reversed_from_journal_id is not null and exists(select 1 from journal origin where origin.journal_id=old.reversed_from_journal_id and origin.is_opening_balance));
  else
   protected_record:=coalesce(old.is_opening_balance,false)or coalesce(new.is_opening_balance,false)or exists(select 1 from journal target left join journal origin on origin.journal_id=target.reversed_from_journal_id where target.journal_id in(old.reversed_from_journal_id,new.reversed_from_journal_id)and(target.is_opening_balance or origin.is_opening_balance));
  end if;
 elsif tg_table_name='journal_line'then
  if tg_op='INSERT'then
   select exists(select 1 from journal target left join journal origin on origin.journal_id=target.reversed_from_journal_id where target.journal_id=new.journal_id and(target.is_opening_balance or origin.is_opening_balance))into protected_record;
  elsif tg_op='DELETE'then
   select exists(select 1 from journal target left join journal origin on origin.journal_id=target.reversed_from_journal_id where target.journal_id=old.journal_id and(target.is_opening_balance or origin.is_opening_balance))into protected_record;
  else
   select exists(select 1 from journal target left join journal origin on origin.journal_id=target.reversed_from_journal_id where target.journal_id in(old.journal_id,new.journal_id)and(target.is_opening_balance or origin.is_opening_balance))into protected_record;
  end if;
 elsif tg_table_name='gl_impact'then
  if tg_op='INSERT'then
   select exists(select 1 from journal target left join journal origin on origin.journal_id=target.reversed_from_journal_id where target.transaction_id=new.transaction_id and(target.is_opening_balance or origin.is_opening_balance))into protected_record;
  elsif tg_op='DELETE'then
   select exists(select 1 from journal target left join journal origin on origin.journal_id=target.reversed_from_journal_id where target.transaction_id=old.transaction_id and(target.is_opening_balance or origin.is_opening_balance))into protected_record;
  else
   select exists(select 1 from journal target left join journal origin on origin.journal_id=target.reversed_from_journal_id where target.transaction_id in(old.transaction_id,new.transaction_id)and(target.is_opening_balance or origin.is_opening_balance))into protected_record;
  end if;
 elsif tg_table_name='transaction'then
  if tg_op='DELETE'then
   select exists(select 1 from journal target left join journal origin on origin.journal_id=target.reversed_from_journal_id where target.transaction_id=old.transaction_id and(target.is_opening_balance or origin.is_opening_balance))into protected_record;
  else
   select exists(select 1 from journal target left join journal origin on origin.journal_id=target.reversed_from_journal_id where target.transaction_id in(old.transaction_id,new.transaction_id)and(target.is_opening_balance or origin.is_opening_balance))into protected_record;
  end if;
 end if;
 if protected_record then raise exception 'Los asientos de apertura solo pueden modificarse o reversarse desde Carga de Saldos Iniciales.';end if;
 if tg_op='DELETE'then return old;else return new;end if;
end$$;
drop trigger if exists protect_opening_journal_record on journal;
drop trigger if exists a_protect_opening_journal_record on journal;
create trigger a_protect_opening_journal_record before insert or update or delete on journal for each row execute function protect_opening_journal_mutation();
drop trigger if exists protect_opening_journal_lines on journal_line;
drop trigger if exists a_protect_opening_journal_lines on journal_line;
create trigger a_protect_opening_journal_lines before insert or update or delete on journal_line for each row execute function protect_opening_journal_mutation();
drop trigger if exists protect_opening_gl_impacts on gl_impact;
drop trigger if exists a_protect_opening_gl_impacts on gl_impact;
create trigger a_protect_opening_gl_impacts before insert or update or delete on gl_impact for each row execute function protect_opening_journal_mutation();
drop trigger if exists protect_opening_transactions on "transaction";
drop trigger if exists a_protect_opening_transactions on "transaction";
create trigger a_protect_opening_transactions before update or delete on "transaction" for each row execute function protect_opening_journal_mutation();

-- Opening journals represent balances already supported by the imported
-- auxiliary and must never create capitalization proposals.
create or replace function prevent_before_opening_lock()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare row_data jsonb:=to_jsonb(new);movement_date date;sid bigint;opening_entry boolean;
begin
 if coalesce(current_setting('app.opening_balance_internal',true),'')='1'then return new;end if;
 movement_date:=case tg_table_name when'journal'then nullif(row_data->>'journal_date','')::date when'invoice'then nullif(row_data->>'invoice_date','')::date when'supplier_invoice'then nullif(row_data->>'invoice_date','')::date when'purchase_document'then nullif(row_data->>'document_date','')::date when'sales_document'then nullif(row_data->>'document_date','')::date end;
 sid:=nullif(row_data->>'subsidiary_id','')::bigint;opening_entry:=coalesce(nullif(row_data->>'is_opening_balance','')::boolean,false);
 if not opening_entry and movement_date is not null and sid is not null and exists(select 1 from opening_balance_runs where subsidiary_id=sid and status='POSTED'and movement_date<=opening_date)then raise exception 'La fecha está bloqueada por la contabilización de saldos iniciales.';end if;
 return new;
end$$;

create or replace function opening_date_hard_lock()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare row_data jsonb:=to_jsonb(new);movement_date date;sid bigint;
begin
 if coalesce(current_setting('app.opening_balance_internal',true),'')='1'then return new;end if;
 movement_date:=case tg_table_name when'transaction'then nullif(row_data->>'tran_date','')::date when'invoice'then nullif(row_data->>'invoice_date','')::date when'supplier_invoice'then nullif(row_data->>'invoice_date','')::date when'purchase_document'then nullif(row_data->>'document_date','')::date when'sales_document'then nullif(row_data->>'document_date','')::date end;
 sid:=nullif(row_data->>'subsidiary_id','')::bigint;
 if movement_date is not null and sid is not null and exists(select 1 from opening_balance_runs where subsidiary_id=sid and status='POSTED'and movement_date<=opening_date)then raise exception 'La fecha % está bloqueada por la apertura contable. Registre el movimiento después de la fecha de apertura.',movement_date;end if;
 return new;
end$$;

create or replace function capture_fixed_asset_journal_line(p_line bigint)returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare row_data record;
begin
 select l.*,j.subsidiary_id,j.currency_id,j.exchange_rate,j.journal_number,j.journal_date,j.memo,j.transaction_id,j.status journal_status,j.asset_proposal_internal,j.is_opening_balance,
 coalesce(s.company_name,c.company_name,nullif(concat_ws(' ',e.first_name,e.last_name),''))supplier_name,i.invoice_number
 into row_data from journal_line l join journal j using(journal_id)left join suppliers s on s.supplier_id=l.supplier_id left join customers c on c.customer_id=l.customer_id left join employees e on e.employee_id=l.employee_id left join supplier_invoice i on i.journal_id=j.journal_id where l.journal_line_id=p_line;
 if not found then return;end if;
 if row_data.journal_status<>'CONTABILIZADO'or row_data.asset_proposal_internal or row_data.is_opening_balance or coalesce(current_setting('app.asset_proposal_internal',true),'')='1'or row_data.debit<=0 or not(row_data.es_activo_fijo or fixed_asset_ppe_account(row_data.account_id))then
  delete from activos_fijos_propuestas where journal_line_id=p_line and status='PENDIENTE';return;
 end if;
 insert into activos_fijos_propuestas(subsidiary_id,journal_line_id,transaction_id,account_id,currency_id,source_number,source_date,description,supplier_id,third_party,invoice_number,department_id,cost_center_id,class_id,amount_local,amount_foreign)
 values(row_data.subsidiary_id,p_line,row_data.transaction_id,row_data.account_id,row_data.currency_id,row_data.journal_number,row_data.journal_date,coalesce(nullif(row_data.note,''),row_data.memo),row_data.supplier_id,coalesce(row_data.supplier_name,row_data.entity_type,'Sin tercero'),row_data.invoice_number,row_data.department_id,row_data.cost_center_id,row_data.class_id,round(row_data.debit*row_data.exchange_rate,6),row_data.debit)
 on conflict(journal_line_id)do update set account_id=excluded.account_id,currency_id=excluded.currency_id,source_date=excluded.source_date,source_number=excluded.source_number,description=excluded.description,supplier_id=excluded.supplier_id,third_party=excluded.third_party,invoice_number=excluded.invoice_number,department_id=excluded.department_id,cost_center_id=excluded.cost_center_id,class_id=excluded.class_id,amount_local=excluded.amount_local,amount_foreign=excluded.amount_foreign where activos_fijos_propuestas.status='PENDIENTE';
end$$;

create or replace function capture_fixed_asset_gl_trigger()returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare transaction_row record;
begin
 if coalesce(current_setting('app.asset_proposal_internal',true),'')='1'or exists(select 1 from journal j where j.transaction_id=new.transaction_id and(j.asset_proposal_internal or j.is_opening_balance or exists(select 1 from journal_line l where l.journal_id=j.journal_id and l.account_id=new.account_id and round(l.debit*j.exchange_rate,6)=new.debit_amount and round(l.credit*j.exchange_rate,6)=new.credit_amount)))then return new;end if;
 if new.debit_amount<=0 or not fixed_asset_ppe_account(new.account_id)or not exists(select 1 from accounting_books where accounting_book_id=new.accounting_book_id and is_primary and is_active)then delete from activos_fijos_propuestas where gl_impact_id=new.gl_impact_id and status='PENDIENTE';return new;end if;
 select tr.*,s.company_name into transaction_row from "transaction"tr left join suppliers s using(supplier_id)where tr.transaction_id=new.transaction_id;
 insert into activos_fijos_propuestas(subsidiary_id,gl_impact_id,transaction_id,account_id,currency_id,source_number,source_date,description,supplier_id,third_party,amount_local,amount_foreign)
 values(new.subsidiary_id,new.gl_impact_id,new.transaction_id,new.account_id,transaction_row.currency_id,transaction_row.tran_number,new.posting_date,'Movimiento directo del mayor',transaction_row.supplier_id,coalesce(transaction_row.company_name,'Sin tercero'),new.debit_amount,new.debit_fx)
 on conflict(gl_impact_id)do update set account_id=excluded.account_id,currency_id=excluded.currency_id,source_date=excluded.source_date,amount_local=excluded.amount_local,amount_foreign=excluded.amount_foreign where activos_fijos_propuestas.status='PENDIENTE';return new;
end$$;

delete from activos_fijos_propuestas p using journal j where p.transaction_id=j.transaction_id and j.is_opening_balance and p.status='PENDIENTE';

create or replace function fixed_asset_period_depreciation(p_cost numeric,p_residual_percentage numeric,p_life_months integer,p_method text,p_consumed_months integer,p_accumulated numeric)
returns numeric language plpgsql immutable set search_path=public,pg_temp as $$
declare depreciable numeric:=greatest(p_cost-p_cost*coalesce(p_residual_percentage,0)/100,0);remaining numeric;life_years integer;current_year integer;months_in_year integer;period_amount numeric;month_index integer;month_year integer;month_year_months integer;current_weight numeric;remaining_weight numeric:=0;
begin
 remaining:=greatest(depreciable-coalesce(p_accumulated,0),0);
 if p_method='No Depreciable'or p_life_months<=0 or coalesce(p_consumed_months,0)>=p_life_months or remaining<=0 then return 0;end if;
 if p_method='Suma de los Dígitos de los Años'then
  life_years:=ceil(p_life_months/12.0)::integer;
  current_year:=floor(coalesce(p_consumed_months,0)/12.0)::integer+1;
  months_in_year:=least(12,p_life_months-(current_year-1)*12);
  current_weight:=(life_years-current_year+1)::numeric/greatest(months_in_year,1);
  for month_index in coalesce(p_consumed_months,0)..p_life_months-1 loop
   month_year:=floor(month_index/12.0)::integer+1;
   month_year_months:=least(12,p_life_months-(month_year-1)*12);
   remaining_weight:=remaining_weight+(life_years-month_year+1)::numeric/greatest(month_year_months,1);
  end loop;
  period_amount:=remaining*current_weight/nullif(remaining_weight,0);
 else
  period_amount:=remaining/greatest(p_life_months-coalesce(p_consumed_months,0),1);
 end if;
 return greatest(least(round(period_amount,6),remaining),0);
end$$;

create or replace function fixed_asset_report(p_filters jsonb default'{}')returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',a.asset_id,'number',a.asset_number,'name',a.asset_name,'description',a.description,'serial',a.serial_number,'categoryId',a.category_id,'category',c.category_name,'locationId',a.location_id,'location',l.name,'currencyId',a.currency_id,'currency',cu.currency_code,'purchaseDate',a.purchase_date,'serviceDate',a.in_service_date,'cost',a.purchase_cost,'rate',a.exchange_rate,'departmentId',a.department_id,'costCenterId',a.cost_center_id,'classId',a.class_id,'status',a.status,'accumulated',coalesce(d.accumulated,0),'bookValue',greatest(a.purchase_cost-coalesce(d.accumulated,0),0))order by a.asset_number),'[]'::jsonb))
from asset a join asset_category c using(category_id)join locations l using(location_id)join currencies cu using(currency_id)left join lateral(select sum(depreciation_amount)accumulated from asset_depreciation where asset_id=a.asset_id)d on true
where a.subsidiary_id=active_subsidiary_id()and a.opening_reversed_at is null and(coalesce(p_filters->>'status','ALL')='ALL'or a.status=p_filters->>'status')and(coalesce(p_filters->>'categoryId','')=''or a.category_id=(p_filters->>'categoryId')::bigint)and(coalesce(p_filters->>'search','')=''or concat_ws(' ',a.asset_number,a.asset_name,a.serial_number,a.description,c.category_name)ilike'%'||(p_filters->>'search')||'%')
$$;

create or replace function fixed_asset_depreciation_preview(p_date date)returns jsonb language sql stable security definer set search_path=public as $$
with period as(select * from fiscal_periods where subsidiary_id=active_subsidiary_id()and p_date between start_date and end_date limit 1),items as(
 select a.asset_id,a.asset_number,a.asset_name,c.category_name,c.depreciation_method,c.useful_life_months,a.purchase_cost,a.exchange_rate,
 coalesce(sum(ad.depreciation_amount),0)accumulated,coalesce(sum(ad.depreciated_months),0)months_consumed,
 fixed_asset_period_depreciation(a.purchase_cost,c.residual_value_percentage,c.useful_life_months,c.depreciation_method,coalesce(sum(ad.depreciated_months),0)::integer,coalesce(sum(ad.depreciation_amount),0))amount,
 exists(select 1 from asset_depreciation x,period p where x.asset_id=a.asset_id and x.fiscal_period_id=p.fiscal_period_id and not x.is_opening_balance)processed
 from asset a join asset_category c using(category_id)left join asset_depreciation ad using(asset_id)
 where a.subsidiary_id=active_subsidiary_id()and a.opening_reversed_at is null and a.status='ACTIVO'and a.in_service_date<=p_date and c.depreciation_method<>'No Depreciable'
  and(not a.is_opening_balance or p_date>(select r.opening_date from opening_balance_runs r where r.id=a.opening_run_id))
 group by a.asset_id,c.category_id
)
select jsonb_build_object('period',(select jsonb_build_object('id',fiscal_period_id,'name',period_name,'closed',is_closed)from period),'rows',coalesce((select jsonb_agg(jsonb_build_object('id',asset_id,'number',asset_number,'name',asset_name,'category',category_name,'method',depreciation_method,'cost',purchase_cost,'accumulated',accumulated,'monthsConsumed',months_consumed,'amount',amount,'processed',processed)order by asset_number)from items),'[]'::jsonb))
$$;

create or replace function run_fixed_asset_depreciation(p_date date,p_asset_ids jsonb)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();period_key bigint;currency_key bigint;asset_key bigint;record_value record;amount_value numeric;journal_key bigint;impact_key bigint;processed_count integer:=0;
begin
 select fiscal_period_id into period_key from fiscal_periods where subsidiary_id=sid and p_date between start_date and end_date and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)limit 1;
 if period_key is null then raise exception 'No existe un período contable abierto para la fecha.';end if;
 select currency_id into currency_key from subsidiaries where subsidiary_id=sid;
 for asset_key in select value::bigint from jsonb_array_elements_text(p_asset_ids)as selected(value)loop
  select a.*,c.useful_life_months,c.residual_value_percentage,c.depreciation_method,c.depreciation_account_id,c.depreciation_expense_account_id,
  coalesce((select sum(depreciation_amount)from asset_depreciation where asset_id=a.asset_id),0)accumulated,
  coalesce((select sum(depreciated_months)from asset_depreciation where asset_id=a.asset_id),0)months
  into record_value from asset a join asset_category c using(category_id)where a.asset_id=asset_key and a.subsidiary_id=sid and a.opening_reversed_at is null and a.status='ACTIVO'and a.in_service_date<=p_date
   and(not a.is_opening_balance or p_date>(select r.opening_date from opening_balance_runs r where r.id=a.opening_run_id));
  if record_value.asset_id is null or record_value.depreciation_method='No Depreciable'then continue;end if;
  if exists(select 1 from asset_depreciation where asset_id=asset_key and fiscal_period_id=period_key and not is_opening_balance)then continue;end if;
  amount_value:=fixed_asset_period_depreciation(record_value.purchase_cost,record_value.residual_value_percentage,record_value.useful_life_months,record_value.depreciation_method,record_value.months::integer,record_value.accumulated);
  if amount_value<=0 then continue;end if;
  select create_journal_entry(jsonb_build_object('journal_date',p_date,'currency_id',currency_key,'fiscal_period_id',period_key,'exchange_rate',1,'journal_type','Estándar','memo','Depreciación '||record_value.asset_number||' · '||record_value.asset_name,'lines',jsonb_build_array(jsonb_build_object('account_id',record_value.depreciation_expense_account_id,'debit',amount_value*record_value.exchange_rate,'credit',0,'note','Depreciación '||record_value.asset_number,'department_id',record_value.department_id,'cost_center_id',record_value.cost_center_id,'class_id',record_value.class_id),jsonb_build_object('account_id',record_value.depreciation_account_id,'debit',0,'credit',amount_value*record_value.exchange_rate,'note','Depreciación acumulada '||record_value.asset_number,'department_id',record_value.department_id,'cost_center_id',record_value.cost_center_id,'class_id',record_value.class_id))))into journal_key;
  perform sync_journal_gl_impacts(journal_key);
  select min(g.gl_impact_id)into impact_key from journal j join gl_impact g on g.transaction_id=j.transaction_id where j.journal_id=journal_key;
  insert into asset_depreciation(depreciation_date,asset_id,fiscal_period_id,gl_impact_id,depreciation_amount,accumulated_depreciation,depreciated_months,is_opening_balance)values(p_date,asset_key,period_key,impact_key,amount_value,record_value.accumulated+amount_value,1,false);
  processed_count:=processed_count+1;
 end loop;
 return jsonb_build_object('processed',processed_count,'message',processed_count||' depreciación(es) contabilizada(s) correctamente.');
end$$;

create or replace function fixed_asset_detail(p_asset_id bigint)returns jsonb language sql stable security definer set search_path=public as $$
with recursive header as(
 select a.*,c.category_code,c.category_name,c.useful_life_months,c.depreciation_method,c.residual_value_percentage,l.name location_name,cu.currency_code,d.name department_name,cc.name cost_center_name,cl.name class_name
 from asset a join asset_category c using(category_id)join locations l using(location_id)join currencies cu using(currency_id)left join departments d on d.department_id=a.department_id left join cost_centers cc on cc.cost_center_id=a.cost_center_id left join classes cl on cl.class_id=a.class_id
 where a.asset_id=p_asset_id and a.subsidiary_id=active_subsidiary_id()
),posted as(
 select d.depreciation_date month_date,d.depreciation_date,d.depreciation_amount,d.accumulated_depreciation,d.is_opening_balance,d.depreciated_months,
 sum(d.depreciated_months)over(order by d.depreciation_date,d.depreciation_id)month_number
 from asset_depreciation d where d.asset_id=p_asset_id
),base as(
 select h.*,coalesce((select sum(depreciation_amount)from asset_depreciation where asset_id=h.asset_id),0)accumulated,
 coalesce((select sum(depreciated_months)from asset_depreciation where asset_id=h.asset_id),0)months_consumed,
 coalesce((select max(depreciation_date)from asset_depreciation where asset_id=h.asset_id),(date_trunc('month',h.in_service_date)-interval'1 month')::date)last_date
 from header h
),future(n,month_date,scheduled,projected_accumulated)as(
 select 1,(date_trunc('month',b.last_date)+interval'1 month')::date,x.amount,b.accumulated+x.amount
 from base b cross join lateral(select fixed_asset_period_depreciation(b.purchase_cost,b.residual_value_percentage,b.useful_life_months,b.depreciation_method,b.months_consumed::integer,b.accumulated)amount)x
 where b.opening_reversed_at is null and b.depreciation_method<>'No Depreciable'and b.months_consumed<b.useful_life_months and x.amount>0
 union all
 select f.n+1,(date_trunc('month',b.last_date)+((f.n+1)||' months')::interval)::date,x.amount,f.projected_accumulated+x.amount
 from future f cross join base b cross join lateral(select fixed_asset_period_depreciation(b.purchase_cost,b.residual_value_percentage,b.useful_life_months,b.depreciation_method,(b.months_consumed+f.n)::integer,f.projected_accumulated)amount)x
 where f.n<b.useful_life_months-b.months_consumed and x.amount>0
),schedule as(
 select p.month_number::integer month_no,p.month_date,to_char(p.month_date,'YYYY-MM')period,p.depreciation_date date,p.depreciation_amount amount,p.accumulated_depreciation accumulated,greatest(h.purchase_cost-p.accumulated_depreciation,0)book_value,'CONTABILIZADA'::text status,p.is_opening_balance opening from posted p cross join header h
 union all
 select (b.months_consumed+f.n)::integer,f.month_date,to_char(f.month_date,'YYYY-MM'),null::date,f.scheduled,f.projected_accumulated,greatest(b.purchase_cost-f.projected_accumulated,0),'PROYECTADA',false from future f cross join base b
)
select jsonb_build_object(
 'asset',(select jsonb_build_object('id',asset_id,'number',asset_number,'name',asset_name,'description',description,'serial',serial_number,'category',category_code||' · '||category_name,'method',depreciation_method,'life',useful_life_months,'residual',residual_value_percentage,'location',location_name,'currency',currency_code,'purchaseDate',purchase_date,'serviceDate',in_service_date,'cost',purchase_cost,'department',department_name,'costCenter',cost_center_name,'class',class_name,'status',status,'hasDepreciations',exists(select 1 from asset_depreciation where asset_id=p_asset_id),'openingBalance',is_opening_balance,'openingReversedAt',opening_reversed_at)from header),
 'schedule',coalesce((select jsonb_agg(jsonb_build_object('month',month_no,'period',case when opening then period||' · Saldo inicial'else period end,'date',date,'amount',amount,'accumulated',accumulated,'bookValue',book_value,'status',status,'opening',opening)order by month_date,status desc)from schedule),'[]'::jsonb)
)
$$;

create or replace function fixed_asset_account_reconciliation(p_subsidiary_id bigint,p_date date)returns jsonb language sql stable security definer set search_path=public as $$
with account_keys as(
 select 'COSTO'::text kind,asset_account_id account_id from asset_category where subsidiary_id=p_subsidiary_id
 union
 select 'DEPRECIACION',depreciation_account_id from asset_category where subsidiary_id=p_subsidiary_id
),labels as(
 select k.kind,k.account_id,string_agg(distinct c.category_name,', 'order by c.category_name)categories
 from account_keys k join asset_category c on c.subsidiary_id=p_subsidiary_id and((k.kind='COSTO'and c.asset_account_id=k.account_id)or(k.kind='DEPRECIACION'and c.depreciation_account_id=k.account_id))
 group by k.kind,k.account_id
),amounts as(
 select l.*,a.account_number||' · '||a.account_name account_label,
   case when l.kind='COSTO'then coalesce((select sum(x.purchase_cost*x.exchange_rate)from asset x join asset_category c using(category_id)left join opening_balance_runs r on r.id=x.opening_run_id where x.subsidiary_id=p_subsidiary_id and c.asset_account_id=l.account_id and(case when x.is_opening_balance then r.opening_date else x.purchase_date end)<=p_date and(x.opening_reversed_at is null or p_date<x.opening_reversed_at::date)and not exists(select 1 from asset_disposal z where z.asset_id=x.asset_id and z.disposal_date<=p_date)),0)
    else coalesce((select sum(d.depreciation_amount*x.exchange_rate)from asset_depreciation d join asset x using(asset_id)join asset_category c using(category_id)left join opening_balance_runs r on r.id=x.opening_run_id where x.subsidiary_id=p_subsidiary_id and c.depreciation_account_id=l.account_id and(case when x.is_opening_balance then r.opening_date else x.purchase_date end)<=p_date and(x.opening_reversed_at is null or p_date<x.opening_reversed_at::date)and d.depreciation_date<=p_date and not exists(select 1 from asset_disposal z where z.asset_id=x.asset_id and z.disposal_date<=p_date)),0)end register_amount,
  case when l.kind='COSTO'then coalesce((select sum(g.debit_amount-g.credit_amount)from gl_impact g join accounting_books b using(accounting_book_id)where g.subsidiary_id=p_subsidiary_id and g.account_id=l.account_id and g.posting_date<=p_date and b.is_primary and b.is_active),0)
   else coalesce((select sum(g.credit_amount-g.debit_amount)from gl_impact g join accounting_books b using(accounting_book_id)where g.subsidiary_id=p_subsidiary_id and g.account_id=l.account_id and g.posting_date<=p_date and b.is_primary and b.is_active),0)end ledger_amount
 from labels l join chart_accounts a using(account_id)
)
select coalesce(jsonb_agg(jsonb_build_object(
 'category',categories,
 'assetAccount',case when kind='COSTO'then account_label else '—'end,
 'depreciationAccount',case when kind='DEPRECIACION'then account_label else '—'end,
 'registerCost',case when kind='COSTO'then register_amount else 0 end,
 'ledgerCost',case when kind='COSTO'then ledger_amount else 0 end,
 'costDifference',case when kind='COSTO'then register_amount-ledger_amount else 0 end,
 'registerDepreciation',case when kind='DEPRECIACION'then register_amount else 0 end,
 'ledgerDepreciation',case when kind='DEPRECIACION'then ledger_amount else 0 end,
 'depreciationDifference',case when kind='DEPRECIACION'then register_amount-ledger_amount else 0 end
 )order by kind,account_label),'[]'::jsonb)from amounts
$$;

create or replace function fixed_asset_analytics(p_filters jsonb default'{}')returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sid bigint:=active_subsidiary_id();date_from date:=coalesce(nullif(p_filters->>'from','')::date,date_trunc('year',current_date)::date);date_to date:=coalesce(nullif(p_filters->>'to','')::date,current_date);asset_key bigint:=nullif(p_filters->>'assetId','')::bigint;result jsonb;
begin
 select jsonb_build_object(
 'subsidiary',(select jsonb_build_object('id',s.subsidiary_id,'name',s.name,'currency',c.currency_code)from subsidiaries s join currencies c using(currency_id)where s.subsidiary_id=sid),
 'assets',coalesce((select jsonb_agg(jsonb_build_object('id',a.asset_id,'number',a.asset_number,'name',a.asset_name,'category',ac.category_name,'location',l.name,'purchaseDate',a.purchase_date,'serviceDate',a.in_service_date,'cost',a.purchase_cost,'status',a.status,'accumulated',coalesce(dep.accumulated,0),'periodDepreciation',coalesce(dep.period_amount,0),'bookValue',greatest(a.purchase_cost-coalesce(dep.accumulated,0)-coalesce(imp.loss,0),0),'impairment',coalesce(imp.loss,0),'openingBalance',a.is_opening_balance,'openingReversedAt',a.opening_reversed_at)order by a.asset_number)from asset a join asset_category ac using(category_id)join locations l using(location_id)left join opening_balance_runs obr on obr.id=a.opening_run_id left join lateral(select sum(depreciation_amount)filter(where depreciation_date<=date_to)accumulated,sum(depreciation_amount)filter(where depreciation_date between date_from and date_to and not is_opening_balance)period_amount from asset_depreciation where asset_id=a.asset_id)dep on true left join lateral(select sum(impairment_loss)filter(where assessment_date<=date_to)loss from asset_impairment where asset_id=a.asset_id)imp on true where a.subsidiary_id=sid and(case when a.is_opening_balance then obr.opening_date else a.purchase_date end)<=date_to and(a.opening_reversed_at is null or date_to<a.opening_reversed_at::date)and(asset_key is null or a.asset_id=asset_key)),'[]'::jsonb),
 'depreciations',coalesce((select jsonb_agg(jsonb_build_object('id',d.depreciation_id,'assetId',a.asset_id,'number',a.asset_number,'asset',a.asset_name,'category',c.category_name,'date',d.depreciation_date,'period',p.period_name,'amount',d.depreciation_amount,'accumulated',d.accumulated_depreciation,'journalId',j.journal_id)order by d.depreciation_date,a.asset_number)from asset_depreciation d join asset a using(asset_id)join asset_category c using(category_id)join fiscal_periods p using(fiscal_period_id)left join gl_impact g on g.gl_impact_id=d.gl_impact_id left join journal j on j.transaction_id=g.transaction_id where a.subsidiary_id=sid and not d.is_opening_balance and d.depreciation_date between date_from and date_to and(asset_key is null or a.asset_id=asset_key)),'[]'::jsonb),
 'movements',coalesce((select jsonb_agg(x order by x->>'date',x->>'number')from(select jsonb_build_object('type',case when a.is_opening_balance then'SALDO INICIAL'else'ALTA'end,'date',case when a.is_opening_balance then r.opening_date else a.purchase_date end,'number',a.asset_number,'asset',a.asset_name,'amount',a.purchase_cost,'note',case when a.is_opening_balance then'Activo importado con la apertura'else'Alta del activo'end)x from asset a left join opening_balance_runs r on r.id=a.opening_run_id where a.subsidiary_id=sid and(case when a.is_opening_balance then r.opening_date else a.purchase_date end)between date_from and date_to union all select jsonb_build_object('type','REVERSIÓN DE APERTURA','date',a.opening_reversed_at::date,'number',a.asset_number,'asset',a.asset_name,'amount',-a.purchase_cost,'note','Reversión del activo importado con la apertura')from asset a where a.subsidiary_id=sid and a.opening_reversed_at::date between date_from and date_to union all select jsonb_build_object('type','BAJA','date',d.disposal_date,'number',a.asset_number,'asset',a.asset_name,'amount',d.sale_amount,'note',d.disposal_type)from asset_disposal d join asset a using(asset_id)where a.subsidiary_id=sid and d.disposal_date between date_from and date_to union all select jsonb_build_object('type','REVALUACIÓN','date',r.revaluation_date,'number',a.asset_number,'asset',a.asset_name,'amount',r.revaluation_amount,'note',r.note)from asset_revaluation r join asset a using(asset_id)where a.subsidiary_id=sid and r.revaluation_date between date_from and date_to)x),'[]'::jsonb),
 'reconciliation',fixed_asset_account_reconciliation(sid,date_to),
 'projection',coalesce((select jsonb_agg(jsonb_build_object('assetId',q.asset_id,'number',q.asset_number,'asset',q.asset_name,'category',q.category_name,'monthly',fixed_asset_period_depreciation(q.purchase_cost,q.residual_value_percentage,q.useful_life_months,q.depreciation_method,q.months_consumed::integer,q.accumulated),'remaining',q.remaining,'remainingMonths',q.remaining_months,'projectedEnd',(date_trunc('month',q.last_date)+(q.remaining_months||' months')::interval)::date)order by q.asset_number)from(select a.asset_id,a.asset_number,a.asset_name,a.purchase_cost,c.category_name,c.residual_value_percentage,c.useful_life_months,c.depreciation_method,coalesce(d.accumulated,0)accumulated,coalesce(d.months,0)months_consumed,greatest(a.purchase_cost-a.purchase_cost*c.residual_value_percentage/100-coalesce(d.accumulated,0),0)remaining,greatest(c.useful_life_months-coalesce(d.months,0),0)remaining_months,coalesce(d.last_date,a.in_service_date)last_date from asset a join asset_category c using(category_id)left join lateral(select sum(depreciation_amount)accumulated,sum(depreciated_months)months,max(depreciation_date)last_date from asset_depreciation where asset_id=a.asset_id)d on true where a.subsidiary_id=sid and a.opening_reversed_at is null and a.status='ACTIVO'and c.depreciation_method<>'No Depreciable')q),'[]'::jsonb),
 'impairments',coalesce((select jsonb_agg(jsonb_build_object('date',i.assessment_date,'number',a.asset_number,'asset',a.asset_name,'carryingAmount',i.carrying_amount,'recoverableAmount',i.recoverable_amount,'loss',i.impairment_loss,'note',i.note)order by i.assessment_date desc)from asset_impairment i join asset a using(asset_id)where a.subsidiary_id=sid and i.assessment_date between date_from and date_to),'[]'::jsonb),
 'disposals',coalesce((select jsonb_agg(jsonb_build_object('date',d.disposal_date,'number',a.asset_number,'asset',a.asset_name,'type',d.disposal_type,'saleAmount',d.sale_amount,'gainLoss',d.gain_loss_amount)order by d.disposal_date desc)from asset_disposal d join asset a using(asset_id)where a.subsidiary_id=sid and d.disposal_date between date_from and date_to),'[]'::jsonb),
 'assetOptions',coalesce((select jsonb_agg(jsonb_build_object('id',asset_id,'number',asset_number,'name',asset_name)order by asset_number)from asset where subsidiary_id=sid and opening_reversed_at is null),'[]'::jsonb)
 )into result;return result;
end$$;

revoke all on function opening_fixed_asset_stage(bigint,jsonb),opening_fixed_asset_create(bigint,bigint),opening_fixed_asset_reconciliation(bigint)from public,anon,authenticated;
revoke all on function opening_balance_assert_access(text),opening_balance_rate(bigint,date),opening_balance_stage(jsonb)from public,anon,authenticated;
revoke all on function assign_asset_category_code(),protect_used_asset_category_accounting(),validate_asset_category_account_groups(),validate_opening_asset_link(),validate_opening_depreciation_link(),protect_opening_fixed_asset_values(),protect_opening_asset_depreciation(),validate_fixed_asset_local_currency(),protect_opening_journal_mutation(),fixed_asset_period_depreciation(numeric,numeric,integer,text,integer,numeric),fixed_asset_account_reconciliation(bigint,date)from public,anon,authenticated;
revoke all on function opening_balance_options(),opening_balance_validate(jsonb),opening_balance_preview(bigint),opening_balance_post(bigint),opening_balance_reverse(bigint)from public,anon;
grant execute on function opening_balance_options(),opening_balance_validate(jsonb),opening_balance_preview(bigint),opening_balance_post(bigint),opening_balance_reverse(bigint)to authenticated;
grant execute on function fixed_asset_depreciation_preview(date),run_fixed_asset_depreciation(date,jsonb),fixed_asset_detail(bigint),fixed_asset_analytics(jsonb)to authenticated;
notify pgrst,'reload schema';
