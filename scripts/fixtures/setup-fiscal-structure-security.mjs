import{readFile}from'node:fs/promises';import{setupFinancialEntityMasterSecurity}from'./setup-financial-entity-master-security.mjs';
export const migration='20261101164103_secure_fiscal_structure.sql';
export async function setupFiscalStructureSecurity(db){await setupFinancialEntityMasterSecurity(db);await db.exec(await readFile(new URL('./fiscal-structure-tables.sql',import.meta.url),'utf8'));
 await db.exec(`alter table subsidiaries add column if not exists fiscal_calendar_id bigint;
 do $$declare t text;k text;begin for t,k in select *from(values('fiscal_years','fiscal_year_id'),('fiscal_calendars','fiscal_calendar_id'),('fiscal_periods','fiscal_period_id'))v loop
 if not exists(select 1 from pg_attribute where attrelid=('public.'||t)::regclass and attname=k and attidentity<>'')then execute format('alter table public.%I alter column %I drop default',t,k);execute format('alter table public.%I alter column %I set not null',t,k);execute format('alter table public.%I alter column %I add generated always as identity(start with 9000)',t,k);end if;if not exists(select 1 from pg_constraint where conrelid=('public.'||t)::regclass and contype='p')then execute format('alter table public.%I add primary key(%I)',t,k);end if;execute format('select setval(%L,greatest(9000,coalesce((select max(%I)from public.%I),0)+1),false)',pg_get_serial_sequence('public.'||t,k),k,t);end loop;end$$;
 alter table fiscal_years alter column is_closed set default false;alter table fiscal_periods alter column is_closed set default false,alter column checklist_completed set default false,alter column ap_closed set default false,alter column ar_closed set default false,alter column gl_closed set default false,alter column is_inactive set default false;
 alter table fiscal_calendars add constraint fixture_calendar_year_fk foreign key(fiscal_year_id)references fiscal_years(fiscal_year_id)not valid;
 alter table fiscal_periods add constraint fixture_period_year_fk foreign key(fiscal_year_id)references fiscal_years(fiscal_year_id)not valid;
 alter table subsidiaries add constraint fixture_sub_calendar_fk foreign key(fiscal_calendar_id)references fiscal_calendars(fiscal_calendar_id)not valid;
 alter table supplier_invoice add constraint fixture_invoice_period_fk foreign key(fiscal_period_id)references fiscal_periods(fiscal_period_id)not valid;
 create table fixture_period_usage(fiscal_period_id bigint references fiscal_periods(fiscal_period_id));
 create table fixture_period_sync(period_id bigint);
 create function fixture_record_period_sync()returns trigger language plpgsql as $$begin insert into fixture_period_sync values(new.fiscal_period_id);return new;end$$;
 create trigger fixture_period_sync after insert or update of start_date,end_date on fiscal_periods for each row execute function fixture_record_period_sync();
 insert into permissions(code)values('CONF_PERIODOS_FISCALES_CERRAR')on conflict(code)do nothing;insert into role_permissions select 1,permission_id from permissions where code='CONF_PERIODOS_FISCALES_CERRAR'on conflict do nothing;
 `);await db.exec(await readFile(new URL('./fiscal-period-original-validator.sql',import.meta.url),'utf8'));await db.exec('create trigger fixture_period_validate before insert or update on fiscal_periods for each row execute function validate_accounting_period()');
 for(const k of['fiscal-years','fiscal-calendars','accounting-periods']){await db.query('delete from role_access_matrix where role_id in(1,3)and resource_key=$1',['organization:'+k]);await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(3,$1,true,false,false,false)',['organization:'+k]);}
 await db.exec('begin');await db.exec(await readFile(new URL('../../supabase/migrations/'+migration,import.meta.url),'utf8'));await db.exec('commit');}
