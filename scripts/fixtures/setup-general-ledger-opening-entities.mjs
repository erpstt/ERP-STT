import {readFile} from 'node:fs/promises';

export const ledgerEntityMigration='20261104145646_fix_opening_general_ledger_entity_resolution.sql';
const read=async path=>(await readFile(new URL(path,import.meta.url),'utf8')).replaceAll('\r\n','\n');
const extract=(sql,signature)=>{
 const start=sql.indexOf('create or replace function public.'+signature),end=sql.indexOf('end$$;',start);
 if(start<0||end<0)throw Error('Missing synthetic ledger source');
 return sql.slice(start,end+7);
};

export async function setupGeneralLedgerOpeningEntities(db){
 await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create schema auth;create schema report_template_private;create schema report_delivery_private;
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('fixture.uid',true),'')::uuid$$;
 create function app_user_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.user',true),'')::bigint$$;
 create function app_active_role_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.role',true),'')::bigint$$;
 create function active_subsidiary_id()returns bigint language sql stable as $$select nullif(current_setting('fixture.sid',true),'')::bigint$$;
 create table users(user_id bigint primary key,is_active boolean);insert into users values(1,true),(2,true);
 create table user_roles(user_id bigint,role_id bigint);insert into user_roles values(1,10),(1,20),(2,10);
 create table user_subsidiaries(user_id bigint,subsidiary_id bigint);insert into user_subsidiaries values(1,1),(2,2);
 create table role_access_matrix(role_id bigint,resource_key text,can_view boolean);
 insert into role_access_matrix values(10,'reports:accounting-reports',true);
 create function security_assert_role_access(r text,a text)returns void language plpgsql stable security definer as $$begin
  if not exists(select 1 from role_access_matrix where role_id=app_active_role_id()and resource_key=r and can_view and a='view')
  then raise exception using errcode='42501';end if;end$$;
 create table subsidiaries(subsidiary_id bigint primary key,name text);insert into subsidiaries values(1,'Synthetic company'),(2,'Foreign company');
 create table account_group(group_id bigint primary key,nature text,category text);insert into account_group values(1,'Acreedora','Pasivo'),(2,'Deudora','Activo');
 create table chart_accounts(account_id bigint primary key,account_number text,account_name text,nature text,account_group_id bigint,category text,cash_flow_activity text);
 insert into chart_accounts values(1,'216002','Synthetic opening liability','Acreedora',1,'Pasivo',null),(2,'110001','Synthetic offset','Deudora',2,'Activo',null);
 create table transaction_types(transaction_type_id bigint primary key,code text,name text);insert into transaction_types values(1,'ASI_DIA','Synthetic opening');
 create table "transaction"(transaction_id bigint primary key,tran_number text,transaction_type_id bigint,customer_id bigint,supplier_id bigint);
 insert into "transaction" values(100,'SYN-OPENING-1',1,null,null);
 create table journal(journal_id bigint primary key,transaction_id bigint,journal_number text,subsidiary_id bigint,memo text,is_opening_balance boolean);
 insert into journal values(100,100,'SYN-OPENING-1',1,'Synthetic opening',true);
 create table customers(customer_id bigint primary key,company_name text);insert into customers values(31,'Synthetic customer A'),(32,'Synthetic customer B'),(33,'Synthetic customer C');
 create table suppliers(supplier_id bigint primary key,company_name text);insert into suppliers values(81,'Synthetic supplier');
 create table employees(employee_id bigint primary key,first_name text,last_name text);insert into employees values(91,'Synthetic','Employee');
 create table entity_subsidiaries(customer_id bigint,subsidiary_id bigint);insert into entity_subsidiaries values(31,1),(32,1),(33,1);
 create table cost_centers(cost_center_id bigint primary key,code text,subsidiary_id bigint,customer_id bigint,cost_center_type text,is_inactive boolean default false);
 insert into cost_centers(cost_center_id,code,subsidiary_id,customer_id,cost_center_type)values
 (69,'EQUU-0001',1,31,'CLIENTE'),(70,'EQUU-0002',1,31,'CLIENTE'),
 (59,'GLOB-0001',1,32,'CLIENTE'),(60,'GLOB-0002',1,32,'CLIENTE'),(62,'GLOB-0003',1,32,'CLIENTE'),(63,'GLOB-0004',1,32,'CLIENTE'),(64,'GLOB-0005',1,32,'CLIENTE'),(65,'ZTE-0001',1,33,'CLIENTE');
 create table opening_balance_runs(id bigint primary key,journal_id bigint,subsidiary_id bigint,status text);
 insert into opening_balance_runs values(10,100,1,'POSTED');
 create table opening_balance_lines(id bigint primary key,run_id bigint,source_type text,account_id bigint,cost_center_id bigint);
 create table journal_line(journal_line_id bigint primary key,journal_id bigint,account_id bigint,entity_type text,customer_id bigint,supplier_id bigint,employee_id bigint,
  cost_center_id bigint,note text,opening_balance_line_id bigint,financial_creditor_id bigint,related_company_id bigint,tax_agency_id bigint,other_name_id bigint,
  debit numeric default 0,credit numeric default 0,debit_fx numeric default 0,credit_fx numeric default 0,department_id bigint,class_id bigint,location_id bigint);
 create table gl_impact(gl_impact_id bigint primary key,transaction_id bigint,account_id bigint,subsidiary_id bigint,fiscal_period_id bigint,accounting_book_id bigint,
  debit_amount numeric,credit_amount numeric,debit_fx numeric,credit_fx numeric,posting_date date,original_currency_id bigint,opening_balance_line_id bigint);
 insert into opening_balance_lines select n,10,'GL',1,(array[69,70,59,60,62,63,64,65,null,null,null]::bigint[])[n]from generate_series(1,11)n;
 insert into journal_line(journal_line_id,journal_id,account_id,cost_center_id,note,opening_balance_line_id,credit,credit_fx)
 select id,100,account_id,cost_center_id,'Synthetic line '||id,id,100,20 from opening_balance_lines;
 -- Reverse GL identifiers relative to source lines: neither row ordering nor
 -- equal amounts can replace the explicit opening trace.
 insert into gl_impact select 100-id,100,account_id,1,1,1,0,100,0,20,'2026-09-30',2,id from opening_balance_lines;
 insert into opening_balance_lines values(12,10,'GL',2,null);
 insert into journal_line(journal_line_id,journal_id,account_id,opening_balance_line_id,debit,debit_fx)values(12,100,2,12,1100,220);
 insert into gl_impact values(100,100,2,1,1,1,1100,0,220,0,'2026-09-30',2,12);
 `);
 const protection=await read('../../supabase/migrations/20261103032056_secure_financial_reports_pdf_templates.sql');
 const guardStart=protection.indexOf('create function report_template_private.enter'),guardEnd=protection.indexOf('end$$;',guardStart);
 await db.exec(protection.slice(guardStart,guardEnd+7));
 const original=extract(await read('../../supabase/migrations/20260828140000_accounting_reports.sql'),'run_accounting_report(');
 await db.exec(original.replace('public.run_accounting_report(', 'public.run_accounting_report_before_intercompany_loans('));
 await db.exec(original.replace('public.run_accounting_report(', 'public.synthetic_baseline_ledger('));
 await db.exec(original.replace('public.run_accounting_report(', 'report_delivery_private.run_accounting_report_before_intercompany_loans(').replace('set search_path=public as','set search_path=pg_catalog,public,pg_temp as'));
 await db.exec(`
 revoke all on function public.run_accounting_report_before_intercompany_loans(text,jsonb)from public,anon,authenticated,service_role;
 revoke all on function public.synthetic_baseline_ledger(text,jsonb)from public,anon,authenticated,service_role;
 grant execute on function public.run_accounting_report_before_intercompany_loans(text,jsonb)to service_role;
 revoke all on all functions in schema report_delivery_private from public,anon,authenticated,service_role;
 create function public.run_accounting_report(p_report text,p_filters jsonb default'{}')returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin
  perform report_template_private.enter('reports:accounting-reports','view');
  return public.run_accounting_report_before_intercompany_loans(p_report,p_filters);end$$;
 revoke all on function public.run_accounting_report(text,jsonb)from public,anon,service_role;
 grant execute on function public.run_accounting_report(text,jsonb)to authenticated;
 `);
}

export async function applyLedgerEntityMigration(db){
 await db.exec('begin');
 try{await db.exec(await read('../../supabase/migrations/'+ledgerEntityMigration));await db.exec('commit');}
 catch(error){await db.exec('rollback');throw error;}
}
