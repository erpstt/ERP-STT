import{readFile}from'node:fs/promises';import{setupFiscalStructureSecurity}from'./setup-fiscal-structure-security.mjs';
export const migration='20261101173344_secure_companies_branches.sql';
export async function setupCompanyMasterSecurity(db){await setupFiscalStructureSecurity(db);await db.exec(await readFile(new URL('./company-master-tables.sql',import.meta.url),'utf8'));
 await db.exec(`create table if not exists timezones(timezone_id bigint primary key,name text,is_active boolean);insert into timezones values(1,'UTC',true)on conflict do nothing;
 insert into fiscal_years(fiscal_year_id,year_name,start_date,end_date,is_closed)overriding system value values(9500,'Synthetic base','2026-01-01','2026-12-31',false);
 insert into fiscal_calendars(fiscal_calendar_id,calendar_name,fiscal_year_id)overriding system value values(9500,'Synthetic base',9500);
 update subsidiaries set legal_name='Synthetic company '||subsidiary_id,tax_id='SYN-'||subsidiary_id,timezone_id=1,fiscal_calendar_id=9500,is_elimination=false,is_active=true,applies_income_autorent=false;
 do $$declare t text;k text;begin for t,k in select *from(values('subsidiaries','subsidiary_id'),('branches','branch_id'))v loop
 if not exists(select 1 from pg_attribute where attrelid=('public.'||t)::regclass and attname=k and attidentity<>'')then execute format('alter table public.%I alter column %I drop default',t,k);execute format('alter table public.%I alter column %I set not null',t,k);execute format('alter table public.%I alter column %I add generated always as identity(start with 10000)',t,k);end if;if not exists(select 1 from pg_constraint where conrelid=('public.'||t)::regclass and contype='p')then execute format('alter table public.%I add primary key(%I)',t,k);end if;execute format('select setval(%L,greatest(10000,coalesce((select max(%I)from public.%I),0)+1),false)',pg_get_serial_sequence('public.'||t,k),k,t);end loop;end$$;
 delete from subsidiary_currencies a using subsidiary_currencies b where a.ctid>b.ctid and a.subsidiary_id=b.subsidiary_id and a.currency_id=b.currency_id;
 update subsidiary_currencies c set is_primary=c.currency_id=s.currency_id from subsidiaries s where s.subsidiary_id=c.subsidiary_id;
 update account_subsidiaries a set is_active=(select bool_or(b.is_active)from account_subsidiaries b where b.account_id=a.account_id and b.subsidiary_id=a.subsidiary_id);
 delete from account_subsidiaries a using account_subsidiaries b where a.ctid>b.ctid and a.account_id=b.account_id and a.subsidiary_id=b.subsidiary_id;
 create unique index fixture_company_account_unique on account_subsidiaries(account_id,subsidiary_id);
 create unique index fixture_company_currency_unique on subsidiary_currencies(subsidiary_id,currency_id);
 alter table subsidiary_currencies add constraint fixture_currency_company_fk foreign key(subsidiary_id)references subsidiaries(subsidiary_id)not valid;
 alter table branches add constraint fixture_branch_company_fk foreign key(subsidiary_id)references subsidiaries(subsidiary_id)not valid;
 alter table subsidiaries add constraint fixture_company_parent_fk foreign key(parent_id)references subsidiaries(subsidiary_id)not valid;
 create table fixture_company_usage(subsidiary_id bigint references subsidiaries(subsidiary_id));
 `);await db.exec('set check_function_bodies=off');await db.exec(await readFile(new URL('./company-original-functions.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('./company-approver-validator.sql',import.meta.url),'utf8'));await db.exec('set check_function_bodies=on');
 await db.exec(`create view subsidiary_approver_options with(security_invoker=true)as select 'user:'||user_id approver_id,first_name name,is_active from users union all select 'employee:'||employee_id,first_name,is_active from employees;
 create trigger fixture_company_accounts after insert on subsidiaries for each row execute function link_all_accounts_to_new_subsidiary();
 create trigger fixture_company_up before insert or update of default_up_approver_id on subsidiaries for each row execute function validate_up_approver_assignment();
 create trigger fixture_company_admin before insert or update of administrative_approver on subsidiaries for each row execute function validate_subsidiary_approvers();
 create trigger fixture_company_supervisor before insert or update of tax_supervisor_user_id on subsidiaries for each row execute function validate_tax_supervisor();
 create trigger fixture_company_autorent before insert or update of country_id,applies_income_autorent,autorent_active_account_id,autorent_passive_account_id,autorent_percentage on subsidiaries for each row execute function validate_subsidiary_income_autorent();
 create trigger fixture_company_ensure_autorent before update of applies_income_autorent,autorent_active_account_id,autorent_passive_account_id,autorent_percentage on subsidiaries for each row when(new.applies_income_autorent)execute function ensure_subsidiary_income_autorent_accounts();
 `);for(const k of['subsidiaries','branches']){await db.query('delete from role_access_matrix where role_id in(1,3)and resource_key=$1',['organization:'+k]);await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(3,$1,true,false,false,false)',['organization:'+k]);}
 await db.exec('begin');await db.exec(await readFile(new URL('../../supabase/migrations/'+migration,import.meta.url),'utf8'));await db.exec('commit');}
