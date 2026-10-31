-- Synthetic schema and seed data for in-memory PostgreSQL only.
create table public.asset_category(
 category_id bigint generated always as identity primary key,
 category_name text,
 useful_life_months integer,
 depreciation_method text,
 asset_account_id bigint,
 depreciation_account_id bigint,
 depreciation_expense_account_id bigint,
 category_code text,
 subsidiary_id bigint,
 residual_value_percentage numeric,
 is_active boolean,
 description text,
 created_by_id character varying,
 created_by_email character varying,
 created_by_name character varying,
 actor_type character varying,
 actor_source character varying,
 execution_context_id character varying,
 updated_by_id character varying,
 updated_by_email character varying,
 updated_by_name character varying,
 updated_actor_type character varying,
 updated_actor_source character varying,
 updated_execution_context_id character varying
);
create table public.asset(
 asset_id bigint generated always as identity primary key,
 asset_number text,
 asset_name text,
 category_id bigint,
 subsidiary_id bigint,
 location_id bigint,
 currency_id bigint,
 purchase_date date,
 purchase_cost numeric,
 description text,
 serial_number text,
 exchange_rate numeric,
 in_service_date date,
 department_id bigint,
 cost_center_id bigint,
 class_id bigint,
 status text,
 created_by_id character varying,
 created_by_email character varying,
 created_by_name character varying,
 actor_type character varying,
 actor_source character varying,
 execution_context_id character varying,
 updated_by_id character varying,
 updated_by_email character varying,
 updated_by_name character varying,
 updated_actor_type character varying,
 updated_actor_source character varying,
 updated_execution_context_id character varying,
 opening_run_id bigint,
 is_opening_balance boolean,
 opening_reversed_at timestamp with time zone
);
create table public.asset_depreciation(
 depreciation_id bigint generated always as identity primary key,
 depreciation_date date,
 asset_id bigint,
 fiscal_period_id bigint,
 gl_impact_id bigint,
 depreciation_amount numeric,
 accumulated_depreciation numeric,
 created_by_id character varying,
 created_by_email character varying,
 created_by_name character varying,
 actor_type character varying,
 actor_source character varying,
 execution_context_id character varying,
 updated_by_id character varying,
 updated_by_email character varying,
 updated_by_name character varying,
 updated_actor_type character varying,
 updated_actor_source character varying,
 updated_execution_context_id character varying,
 opening_run_id bigint,
 is_opening_balance boolean,
 depreciated_months integer
);
create table public.fixed_asset_proposal_allocation(
 proposal_id bigint,
 asset_id bigint,
 amount_local numeric,
 amount_foreign numeric,
 created_by_id character varying,
 created_by_email character varying,
 created_by_name character varying,
 actor_type character varying,
 actor_source character varying,
 execution_context_id character varying,
 updated_by_id character varying,
 updated_by_email character varying,
 updated_by_name character varying,
 updated_actor_type character varying,
 updated_actor_source character varying,
 updated_execution_context_id character varying
);
alter table asset alter column status set default 'ACTIVO',alter column is_opening_balance set default false;
alter table asset_depreciation alter column is_opening_balance set default false;
create unique index asset_depreciation_regular_period_idx on asset_depreciation(asset_id,fiscal_period_id) where not is_opening_balance;
alter table fixed_asset_proposal_allocation add primary key(proposal_id,asset_id);
alter table journal add column asset_proposal_internal boolean default false,add column is_opening_balance boolean default false;
alter table journal_line add column es_activo_fijo boolean default false;
alter table locations add column subsidiary_id bigint default 1;
alter table departments add column subsidiary_id bigint;
alter table classes add column subsidiary_id bigint;
alter table cost_centers add column is_inactive boolean default false;
alter table fiscal_periods add column period_name text default 'Synthetic period';
alter table currencies add column name text default 'Synthetic currency';
alter table gl_impact add column gl_impact_id bigint generated always as identity primary key;
create table accounting_books(accounting_book_id bigint primary key,subsidiary_id bigint,is_primary boolean,is_active boolean);
insert into accounting_books values(1,1,true,true);
create table opening_balance_runs(id bigint primary key,opening_date date);
insert into subsidiary_currencies values(1,1),(2,2);
insert into chart_accounts(account_id,account_number,account_name,category,accepts_entries) values(201,'1500','Synthetic PPE','Activo',true),(202,'1590','Synthetic accumulated','Activo',true),(203,'5100','Synthetic expense','Gasto',true);
insert into account_subsidiaries values(201,1,true),(202,1,true),(203,1,true);
insert into asset_category(category_name,category_code,subsidiary_id,useful_life_months,residual_value_percentage,depreciation_method,asset_account_id,depreciation_account_id,depreciation_expense_account_id,is_active) values('Straight','CAT1',1,12,0,'Línea Recta',201,202,203,true),('Years','CAT2',1,24,0,'Suma de los Dígitos de los Años',201,202,203,true),('Foreign','CAT3',2,12,0,'Línea Recta',201,202,203,true);
insert into asset(asset_number,asset_name,category_id,subsidiary_id,location_id,currency_id,purchase_date,in_service_date,purchase_cost,exchange_rate,status,is_opening_balance) values('A1','Synthetic one',1,1,1,1,'2026-10-01','2026-10-01',1200,1,'ACTIVO',false),('A2','Synthetic years',2,1,1,1,'2026-10-01','2026-10-01',2400,1,'ACTIVO',false),('A3','Synthetic foreign',3,2,1,2,'2026-10-01','2026-10-01',1200,1,'ACTIVO',false);
grant all on asset,asset_category,asset_depreciation,fixed_asset_proposal_allocation to anon,authenticated,service_role;
alter table asset_depreciation enable row level security;
create policy legacy_all on asset_depreciation for all to authenticated using(true) with check(true);
create function account_belongs_to_group(bigint,text) returns boolean language sql as $$select $1=201 and $2 like 'propiedad%'$$;

