import{readFile}from'node:fs/promises';import{setupSessionBoundarySecurity}from'./setup-session-boundary-security.mjs';
export const migration='20261101203445_secure_exchange_rate_boundary.sql',activation='20261101203902_activate_exchange_rate_boundary_after_server.sql';
export async function setupRateSecurity(db){await setupSessionBoundarySecurity(db);await installRateSecurity(db);}
export async function installRateSecurity(db){
 await db.exec(`alter table currencies add column if not exists name text;update currencies set name=currency_code;insert into currencies(currency_id,currency_code,name)values(3,'COP','Synthetic COP');
 create table subsidiary_currencies(subsidiary_id bigint,currency_id bigint,is_primary boolean default true,primary key(subsidiary_id,currency_id));insert into subsidiary_currencies select subsidiary_id,currency_id,true from subsidiaries;
 insert into subsidiaries(subsidiary_id,name,is_active,currency_id)values(5,'Foreign COP company',true,3);insert into subsidiary_currencies values(5,3,true);
 create table fiscal_years(fiscal_year_id bigint primary key,is_closed boolean default false);insert into fiscal_years values(1,false);
 alter table fiscal_periods add column if not exists start_date date,add column if not exists fiscal_year_id bigint references fiscal_years,add column if not exists gl_closed boolean default false,add column if not exists is_inactive boolean default false,add column if not exists period_name text;
 update fiscal_periods set start_date='2026-10-01',fiscal_year_id=1,is_closed=false,period_name='Synthetic October';
 insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,fiscal_year_id,is_closed)values(5,5,'2026-10-01','2026-10-31',1,false);
 create table exchange_rates(exchange_rate_id bigint generated always as identity primary key,from_currency_id bigint references currencies,to_currency_id bigint references currencies,effective_date date,spot_rate numeric,unique(from_currency_id,to_currency_id,effective_date));
 insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(1,2,'2026-10-01',500),(1,2,'2026-10-31',600),(1,3,'2026-10-01',4000);
 alter table consolidated_exchange_rates add column rate_id bigint generated always as identity primary key,add column fiscal_period_id bigint references fiscal_periods,add column is_locked boolean default false,add column locked_at timestamptz,add column locked_by bigint;
 update consolidated_exchange_rates set fiscal_period_id=1;insert into consolidated_exchange_rates(holding_subsidiary_id,source_subsidiary_id,period,from_currency_id,to_currency_id,closing_rate,average_rate,historical_rate,fiscal_period_id)values(1,5,'2026-10',3,1,9,9,9,5);
 create unique index rate_period_pair on consolidated_exchange_rates(from_currency_id,to_currency_id,fiscal_period_id);
 insert into permissions(code,module,description,is_operational)values('consolidation:rates:manage','Consolidation','Synthetic manage',true),('consolidation:rates:lock','Consolidation','Synthetic lock',true);
 insert into role_permissions(role_id,permission_id)select 1,permission_id from permissions where code like'consolidation:rates:%';
 insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values(1,'configuration:exchange-rates',true,true,true,true),(1,'configuration:consolidated-exchange-rates',true,true,true,true),(3,'configuration:exchange-rates',true,false,false,false),(3,'configuration:consolidated-exchange-rates',true,false,false,false);
 set check_function_bodies=off;`);
 await db.exec(await readFile(new URL('./rate-original-functions.sql',import.meta.url),'utf8'));
 await db.exec(`set check_function_bodies=on;create trigger validate_consolidated_exchange_rate_trigger before insert or update or delete on consolidated_exchange_rates for each row execute function validate_consolidated_exchange_rate();create trigger auto_consolidated_rates_from_spot after insert or update of spot_rate,effective_date on exchange_rates for each row execute function auto_sync_consolidated_rates();create trigger auto_consolidated_rates_from_period after insert or update of start_date,end_date on fiscal_periods for each row execute function auto_sync_consolidated_rates();grant all on exchange_rates,consolidated_exchange_rates to anon,authenticated,service_role;`);
 for(const name of[migration,activation])await db.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
}
