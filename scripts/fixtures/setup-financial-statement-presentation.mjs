import {readFile} from 'node:fs/promises';
import {setupGeneralLedgerOriginalCurrency,applyLedgerOriginalCurrencyMigration} from './setup-general-ledger-original-currency.mjs';
export const financialStatementPresentationMigration='20261104170219_add_company_financial_statement_usd_presentation.sql';
const read=path=>readFile(new URL(path,import.meta.url),'utf8').then(source=>source.replace(/\r\n/g,'\n'));

export async function addPresentationJournal(db,{id,date,sid=1,rate=1,currency=1,status='CONTABILIZADO',lines}){
 await db.query('insert into "transaction"(transaction_id,tran_number,transaction_type_id,currency_id,exchange_rate)values($1,$2,1,$3,$4)',[id,'SYN-STATEMENT-'+id,currency,rate]);
 await db.query("insert into journal(journal_id,transaction_id,journal_number,subsidiary_id,memo,is_opening_balance,currency_id,exchange_rate,journal_type,journal_date,status)values($1,$1,$2,$3,$2,false,$4,$5,'Synthetic ordinary',$6,$7)",[id,'SYN-STATEMENT-'+id,sid,currency,rate,date,status]);
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  await db.query('insert into journal_line(journal_line_id,journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,class_id,location_id,cost_center_id,note)values($1,$2,$3,$4,$5,$4,$5,$6,$7,$8,$9,$10)',[id*100+i,id,line.account,line.debit||0,line.credit||0,line.department??null,line.class??null,line.location??null,line.cost??null,'Synthetic financial movement']);
 }
}

export async function setupFinancialStatementPresentation(db){
 await setupGeneralLedgerOriginalCurrency(db);await applyLedgerOriginalCurrencyMigration(db);
 await db.exec(`
 delete from journal_line;delete from gl_impact;
 delete from journal;delete from "transaction";delete from opening_balance_lines;delete from opening_balance_runs;
 delete from chart_accounts;delete from account_group;
 update currencies set currency_code='JMD'where currency_id=1;
 alter table subsidiaries add column is_active boolean default true;
 update subsidiaries set currency_id=2 where subsidiary_id=2;
 insert into subsidiaries values(99,'STT Group Latin American synthetic',2,true),(3,'Inaccessible synthetic company',1,true);
 insert into user_subsidiaries values(1,2);
 create table accounting_books(accounting_book_id bigint primary key,subsidiary_id bigint,is_primary boolean,is_active boolean);
 insert into accounting_books values(1,1,true,true),(2,2,true,true),(3,3,true,true),(4,1,false,true);
 alter table journal add column status text default'CONTABILIZADO',add column journal_type text default'Synthetic ordinary',add column journal_date date default'2026-02-28',add column fiscal_period_id bigint default 1;
 alter table journal_line add column tax_code_id bigint,add column tax_rate numeric;
 create table tax_codes(tax_code_id bigint,tax_type_id bigint,rate_percentage numeric);
 create table tax_types(tax_type_id bigint,asset_account_id bigint,liability_account_id bigint);
 create sequence synthetic_statement_gl_id start 10000;
 alter table gl_impact alter column gl_impact_id set default nextval('synthetic_statement_gl_id');
 create table departments(department_id bigint primary key,name text,type text);insert into departments values(10,'Synthetic operations','OPERATIVO'),(11,'Synthetic administration','ADMINISTRATIVO');
 create table classes(class_id bigint primary key,name text);insert into classes values(20,'Synthetic class A'),(21,'Synthetic class B');
 create table locations(location_id bigint primary key,name text);insert into locations values(30,'Synthetic location A'),(31,'Synthetic location B');
 alter table cost_centers add column name text;update cost_centers set name='Synthetic center '||cost_center_id;
 insert into cost_centers(cost_center_id,code,subsidiary_id,name)values(40,'SYN-40',1,'Synthetic center A'),(41,'SYN-41',1,'Synthetic center B');
 insert into account_group values(1,'Acreedora','Pasivo'),(2,'Deudora','Activo'),(3,'Deudora','Gasto'),(4,'Acreedora','Ingreso'),(5,'Acreedora','Patrimonio'),(6,'Deudora','Costo');
 insert into chart_accounts values(1,'110001','Synthetic cash','Deudora',2,'Activo',null),(2,'210001','Synthetic payable','Acreedora',1,'Pasivo',null),
 (3,'310001','Synthetic capital','Acreedora',5,'Patrimonio',null),(4,'410001','Synthetic revenue','Acreedora',4,'Ingreso',null),
 (5,'510001','Synthetic operating expense','Deudora',3,'Gasto',null),(6,'610001','Synthetic cost','Deudora',6,'Costo',null),
 (7,'320001','Resultado del ejercicio synthetic','Acreedora',5,'Patrimonio',null);
 create table consolidated_exchange_rates(rate_id bigint,holding_subsidiary_id bigint,source_subsidiary_id bigint,period text,from_currency_id bigint,to_currency_id bigint,closing_rate numeric,average_rate numeric,historical_rate numeric,is_locked boolean default true);
 insert into consolidated_exchange_rates values(1,99,1,'2026-01',1,2,.0065,.006,.005,true),(2,99,1,'2026-02',1,2,.00625,.005,.005,true);
 `);
 // Use the production synchronizer so ordinary native journal values are
 // converted to canonical local GL amounts by the actual header rate.
 const sync=await read('../../supabase/migrations/20260911124500_prevent_withholding_double_posting.sql');
 await db.exec(sync.slice(0,sync.indexOf('\ndo $$')));
 await db.exec(await read('../../supabase/migrations/20261023120000_optimize_opening_balance_post.sql'));
 await db.exec('create trigger journal_line_gl_impact_sync after insert or update or delete on journal_line for each row execute function sync_journal_gl_impacts_trigger()');
 const holding=await read('../../supabase/migrations/20260930153000_flexible_consolidation_holding.sql');
 await db.exec(holding.slice(holding.indexOf('create or replace function public.consolidation_holding_subsidiary_id()'),holding.indexOf('\ncreate or replace function public.validate_consolidated_exchange_rate()')));
 // Preserve the real legacy matrix, including its interactive permission guard.
 const matrix=await read('../../supabase/migrations/20260916140000_income_statement_accounting_period_columns.sql');
 await db.exec(matrix.slice(0,matrix.indexOf('revoke all')));
 await db.exec(`do $$declare src text;begin select prosrc into src from pg_proc where oid='public.run_income_statement_matrix(jsonb)'::regprocedure;
 execute format('create or replace function public.run_income_statement_matrix(p_filters jsonb default ''{}'')returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as %L',E'begin perform report_template_private.enter(''reports:accounting-reports'',''view'');\n'||src||E';\nend');end$$;
 revoke all on function public.run_income_statement_matrix(jsonb)from public,anon,service_role;grant execute on function public.run_income_statement_matrix(jsonb)to authenticated;
 create function report_delivery_private.run_accounting_report(p_report text,p_filters jsonb default'{}')returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$begin return report_delivery_private.run_accounting_report_before_intercompany_loans(p_report,p_filters);end$$;
 revoke all on function report_delivery_private.run_accounting_report(text,jsonb)from public,anon,authenticated,service_role;
 `);
 await addPresentationJournal(db,{id:1000,date:'2025-12-31',lines:[{account:1,debit:16000},{account:3,credit:16000}]});
 const a={department:10,class:20,location:30,cost:40},b={department:11,class:21,location:31,cost:41};
 await addPresentationJournal(db,{id:1001,date:'2026-01-20',lines:[{account:1,debit:600,...a},{account:4,credit:1000,...a},{account:5,debit:400,...a}]});
 // Native journal amounts * historic header rate = canonical local GL amounts.
 await addPresentationJournal(db,{id:1002,date:'2026-02-18',rate:160,currency:2,lines:[{account:1,debit:75,...b},{account:4,credit:100,...b},{account:5,debit:25,...b}]});
 await addPresentationJournal(db,{id:1003,date:'2026-02-18',sid:2,currency:2,lines:[{account:1,debit:50},{account:3,credit:50}]});
 await addPresentationJournal(db,{id:1004,date:'2026-02-18',sid:3,lines:[{account:1,debit:999999},{account:3,credit:999999}]});
}

export async function applyFinancialStatementPresentationMigration(db){
 await db.exec('begin');try{await db.exec(await read('../../supabase/migrations/'+financialStatementPresentationMigration));await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
