import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isolatedRoleTemplateDatabase} from './isolated-role-template-security.mjs';
export {assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql} from './isolated-role-template-security.mjs';

export const payablesAgingInvoiceTypeMigration='20261108164803_group_payables_aging_by_invoice_type.sql';
export const agingBaselineMd5={
 'public.run_aging_report(text,jsonb)':'eaa776fe3e7f29d0fc30ea19d4ddaae6',
 'public.run_aging_report_before_consolidation(text,jsonb)':'d3626155da1114ede7e8f11fce00d35b',
 'public.run_aging_report_before_original_currency_reconciliation(text,jsonb)':'388489e9c216ac1afa6bdd25a774e78a',
 'public.aging_original_currency_breakdown(text,jsonb,boolean)':'0abd497ac1e8cdb040926d40f09a0f03',
 'report_delivery_private.run_aging_report(text,jsonb)':'c2e5030a3104e26660bf3b254e58bedb',
 'report_delivery_private.run_aging_report_before_consolidation(text,jsonb)':'d2a74a23cc333ca6339f35be19531213',
 'report_delivery_private.run_aging_report_before_original_currency_reconciliation(text,jsonb)':'388489e9c216ac1afa6bdd25a774e78a',
};
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
const sha=s=>createHash('sha256').update(s).digest('hex');
function definition(sql,name){
 const escaped=name.replaceAll('.','\\.');
 const matches=[...sql.matchAll(new RegExp('create(?: or replace)? function '+escaped+'\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;','gi'))];
 if(matches.length!==1)throw Error('Expected one real aging definition: '+name);
 return matches[0][0];
}

// Structural financial data is synthetic. All seven aging calculations are the
// actual published bodies, reconstructed from committed migrations and checked
// against their production LF prosrc fingerprints. No report math is mocked.
async function installAgingCalculations(db){
 const manifest=[];
 const install=async(file,name)=>{const sql=definition(await read(file),name);await db.exec(sql);manifest.push({file,name,sha256:sha(sql)});};
 const currency='20261023141000_aging_original_currency_reconciliation.sql';
 for(const name of ['public.run_aging_report_before_original_currency_reconciliation','public.aging_original_currency_breakdown','public.run_aging_report_before_consolidation'])await install(currency,name);
 const consolidated='20260922040000_consolidated_operational_reports.sql';
 for(const name of ['public.operational_usd_closing_rate','public.run_aging_report'])await install(consolidated,name);
 const secure='20261103032056_secure_financial_reports_pdf_templates.sql';
 await db.exec('create schema report_template_private;revoke all on schema report_template_private from public,anon,authenticated,service_role');
 await install(secure,'report_template_private.enter');
 // The unchanged A05 PL/pgSQL outer-guard transform, limited to this entry.
 await db.exec(`do $$declare f record;src text;guard text;begin
  select p.oid,p.prosrc,p.provolatile into strict f from pg_proc p where p.oid='public.run_aging_report(text,jsonb)'::regprocedure;
  guard:=format('perform report_template_private.enter(%L,%L);','reports:accounting-reports','view');
  src:='begin '||guard||E'\n'||trim(f.prosrc)||case when right(trim(f.prosrc),1)=';'then ''else ';'end||E'\nend';
  execute format('create or replace function public.run_aging_report(p_kind text,p_filters jsonb default %L::jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as %L','{}',src);
 end$$;`);
 // Actual Nov3 delivery clone transform. It strips only the guarded public
 // entry and redirects its internal aging dependencies into the private schema.
 await db.exec(String.raw`create schema report_delivery_private;
 revoke all on schema report_delivery_private from public,anon,authenticated,service_role;
 do $copy$declare item record;f record;src text;directives text;prefix text:=E'begin perform report_template_private.enter(''reports:accounting-reports'',''view'');\n';name text;
 names text[]:=array['run_aging_report','run_aging_report_before_consolidation','run_aging_report_before_original_currency_reconciliation'];begin
  for item in select *from(values('run_aging_report(text,jsonb)',true),('run_aging_report_before_consolidation(text,jsonb)',false),('run_aging_report_before_original_currency_reconciliation(text,jsonb)',false))v(signature,guarded)loop
   select p.oid,p.proname,p.prosrc,p.provolatile,l.lanname into strict f from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure('public.'||item.signature);
   src:=f.prosrc;
   if item.guarded then
    directives:=substring(src from E'^((?:[[:space:]]*#[^\n]+\n)+)');
    if directives is not null then src:=substr(src,length(directives)+1);end if;
    if left(src,length(prefix))<>prefix or right(src,4)<>E'\nend'then raise exception 'Unexpected guarded aging source';end if;
    src:=coalesce(directives,'')||left(substr(src,length(prefix)+1),length(substr(src,length(prefix)+1))-4);
   end if;
   foreach name in array names loop
    src:=regexp_replace(src,'(^|[^a-zA-Z0-9_.])(?:public[.])?'||name||'([[:space:]]*[(])',E'\\1report_delivery_private.'||name||E'\\2','g');
   end loop;
   execute format('create function report_delivery_private.%s returns %s language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as %L',
    (select proname||'('||pg_get_function_arguments(oid)||')'from pg_proc where oid=f.oid),pg_get_function_result(f.oid),src);
  end loop;
 end$copy$;
 revoke all on all functions in schema report_template_private from public,anon,authenticated,service_role;
 revoke all on all functions in schema report_delivery_private from public,anon,authenticated,service_role;
 revoke all on function public.run_aging_report_before_original_currency_reconciliation(text,jsonb),public.aging_original_currency_breakdown(text,jsonb,boolean),public.run_aging_report_before_consolidation(text,jsonb),public.run_aging_report(text,jsonb),public.operational_usd_closing_rate(bigint,date)from public,anon,authenticated,service_role;
 grant execute on function public.run_aging_report(text,jsonb),public.operational_usd_closing_rate(bigint,date)to authenticated;`);
 for(const[signature,expected]of Object.entries(agingBaselineMd5)){
  const row=(await db.query('select md5(prosrc)source_md5 from pg_proc where oid=$1::regprocedure',[signature])).rows[0];
  if(row?.source_md5!==expected)throw Error('Aging fixture source differs from reviewed baseline: '+signature+' '+row?.source_md5);
 }
 return manifest;
}

async function structures(db){
 await db.exec(`
 create function auth.role()returns text language sql stable as $$select auth.jwt()->>'role'$$;
 alter table currencies add column name text,add column symbol text;
 update currencies set name=case currency_id when 1 then'Synthetic US dollar'else'Synthetic colon'end,symbol=case currency_id when 1 then'USD'else'CRC'end;
 alter table chart_accounts add column nature text;
 alter table account_group add column nature text;
 alter table gl_impact add column gl_impact_id bigint generated by default as identity,
  add column transaction_id bigint,add column accounting_book_id bigint,add column debit_fx numeric(24,6)default 0,
  add column credit_fx numeric(24,6)default 0,add column original_currency_id bigint,add column opening_balance_line_id bigint;
 create table public.suppliers(supplier_id bigint primary key,supplier_number text,tax_id text,company_name text,supplier_category text);
 create table public.customers(customer_id bigint primary key,customer_number text,tax_id text,company_name text,sales_representative_id bigint);
 create table public.employees(employee_id bigint primary key,first_name text,last_name text);
 create table public."transaction"(transaction_id bigint primary key,subsidiary_id bigint,tran_number text,tran_date date,currency_id bigint,exchange_rate numeric(24,10),supplier_id bigint,customer_id bigint);
 create table public.journal(journal_id bigint primary key,transaction_id bigint,subsidiary_id bigint,journal_number text,journal_date date);
 create table public.journal_line(journal_line_id bigint primary key,journal_id bigint,account_id bigint,supplier_id bigint,customer_id bigint,cost_center_id bigint,opening_balance_line_id bigint);
 create table public.supplier_invoice(invoice_id bigint primary key,invoice_number text,invoice_type text,supplier_id bigint,subsidiary_id bigint,transaction_id bigint,journal_id bigint,invoice_date date,due_date date,currency_id bigint,exchange_rate numeric(24,10),total_amount numeric(24,6),payable_amount numeric(24,6),withholding_total numeric(24,6)default 0,payable_account_id bigint,is_opening_balance boolean default false,opening_run_id bigint,opening_balance_line_id bigint);
 create table public.invoice(invoice_id bigint primary key,invoice_number text,customer_id bigint,subsidiary_id bigint,transaction_id bigint,journal_id bigint,invoice_date date,due_date date,currency_id bigint,exchange_rate numeric(24,10),total_amount numeric(24,6),receivable_amount numeric(24,6),withholding_total numeric(24,6)default 0,opening_balance_line_id bigint);
 create table public.supplier_payment(payment_id bigint primary key,payment_number text,supplier_id bigint,transaction_id bigint,currency_id bigint,exchange_rate numeric(24,10),amount_paid numeric(24,6));
 create table public.customer_payment(payment_id bigint primary key,payment_number text,customer_id bigint,transaction_id bigint,currency_id bigint,exchange_rate numeric(24,10),amount_received numeric(24,6));
 create table public.supplier_payment_application(application_id bigint generated by default as identity primary key,payment_id bigint,invoice_id bigint,application_date date,amount numeric(24,6));
 create table public.customer_payment_application(application_id bigint generated by default as identity primary key,payment_id bigint,invoice_id bigint,application_date date,amount numeric(24,6));
 create table public.supplier_credit_note(cn_id bigint primary key,cn_number text,invoice_id bigint,transaction_id bigint,currency_id bigint,exchange_rate numeric(24,10),amount numeric(24,6));
 create table public.supplier_debit_note(dn_id bigint primary key,dn_number text,invoice_id bigint,transaction_id bigint,currency_id bigint,exchange_rate numeric(24,10),amount numeric(24,6));
 create table public.credit_note(cn_id bigint primary key,cn_number text,invoice_id bigint,transaction_id bigint,currency_id bigint,exchange_rate numeric(24,10),amount numeric(24,6));
 create table public.debit_note(dn_id bigint primary key,dn_number text,invoice_id bigint,transaction_id bigint,currency_id bigint,exchange_rate numeric(24,10),amount numeric(24,6));
 create table public.exchange_rates(exchange_rate_id bigint primary key,from_currency_id bigint,to_currency_id bigint,effective_date date,spot_rate numeric(24,10));
 insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values
 (1,'reports:accounting-reports',true,false,false,false),(3,'reports:accounting-reports',true,false,false,false);
 update subsidiaries set name='STT Group Latin American'where subsidiary_id=1;
 insert into account_group(group_id,category,nature)values(30,'Pasivo','Acreedora'),(40,'Activo','Deudora');
 insert into chart_accounts(account_id,account_number,account_name,category,account_group_id,nature)values
 (301,'211001','Synthetic cuentas por pagar','Pasivo',30,'Acreedora'),(302,'211003','Synthetic cuentas por pagar Expense','Pasivo',30,'Acreedora'),(303,'211004','Synthetic cuentas por pagar Caja Chica','Pasivo',30,'Acreedora'),(401,'111001','Synthetic cuentas por cobrar','Activo',40,'Deudora');
 insert into exchange_rates values(1,2,1,'2026-10-31',0.00625);
 `);
 // Direct table reads/writes by clients are not part of the report contract.
 for(const table of ['suppliers','customers','employees','transaction','journal','journal_line','supplier_invoice','invoice','supplier_payment','customer_payment','supplier_payment_application','customer_payment_application','supplier_credit_note','supplier_debit_note','credit_note','debit_note','exchange_rates','gl_impact']){
  await db.exec(`alter table public."${table}" enable row level security;revoke all on table public."${table}" from public,anon,authenticated,service_role`);
 }
}

/** Entirely synthetic AP/AR read model. IDs are stable for exact assertions. */
export async function seedPayablesAgingInvoiceTypes(db){
 await db.exec('reset role');
 await db.exec(`
 insert into suppliers values(10,'SYN-10','SYN-TAX-10','Synthetic five-type supplier','SYNTHETIC'),(20,'SYN-20','SYN-TAX-20','Synthetic advance-only supplier','SYNTHETIC'),(30,'SYN-30','SYN-TAX-30','Synthetic foreign subsidiary supplier','SYNTHETIC');
 insert into customers values(50,'SYN-50','SYN-TAX-50','Synthetic AR customer',null);
 insert into supplier_invoice(invoice_id,invoice_number,invoice_type,supplier_id,subsidiary_id,transaction_id,journal_id,invoice_date,due_date,currency_id,exchange_rate,total_amount,payable_amount,payable_account_id)values
 (101,'SYN-STANDARD','Factura estándar',10,1,1101,10101,'2026-10-01','2026-10-15',1,1,100,100,301),
 (102,'SYN-EXPENSE','Factura Expense',10,1,1102,10102,'2026-10-01','2026-10-15',1,1,200,200,302),
 (103,'SYN-CARD','Factura Tarjeta',10,1,1103,10103,'2026-10-01','2026-10-15',2,160,100,100,301),
 (104,'SYN-PETTY','Factura Caja Chica',10,1,1104,10104,'2026-10-01','2026-10-15',1,1,400,400,303),
 (105,'SYN-FIXED','Factura Activos Fijos',10,1,1105,10105,'2026-10-01','2026-10-15',1,1,500,500,301),
 (106,'SYN-UNKNOWN','Legacy synthetic type',10,1,1106,10106,'2026-10-01','2026-10-15',1,1,60,60,301),
 (107,'SYN-NULL',null,10,1,1107,10107,'2026-10-01','2026-10-15',1,1,70,70,301),
 (108,'SYN-PAID','Factura Tarjeta',10,1,1108,10108,'2026-10-01','2026-10-15',1,1,25,25,301),
 (301,'SYN-SID2','Factura Tarjeta',30,2,1301,10301,'2026-10-01','2026-10-15',2,1,90,90,301);
 insert into "transaction" select transaction_id,subsidiary_id,'SYN-TX-'||invoice_id,invoice_date,currency_id,exchange_rate,supplier_id,null from supplier_invoice;
 insert into journal select journal_id,transaction_id,subsidiary_id,'SYN-JOURNAL-'||invoice_id,invoice_date from supplier_invoice;
 insert into journal_line select invoice_id,journal_id,payable_account_id,supplier_id,null,case when invoice_id=102 then 42 else 41 end,null from supplier_invoice;
 insert into gl_impact(subsidiary_id,account_id,posting_date,debit_amount,credit_amount,transaction_id,accounting_book_id,debit_fx,credit_fx,original_currency_id)select subsidiary_id,payable_account_id,invoice_date,0,total_amount*exchange_rate,transaction_id,1,0,total_amount,currency_id from supplier_invoice;
 insert into journal values(10900,1900,1,'SYN-SHARED-OPENING','2026-09-30');
 insert into "transaction"values(1900,1,'SYN-OPENING-TX','2026-09-30',1,1,null,null);
 insert into supplier_invoice(invoice_id,invoice_number,invoice_type,supplier_id,subsidiary_id,transaction_id,journal_id,invoice_date,due_date,currency_id,exchange_rate,total_amount,payable_amount,payable_account_id,is_opening_balance,opening_run_id,opening_balance_line_id)values
 (201,'SYN-OPEN-STANDARD','Factura estándar',10,1,null,10900,'2026-08-01','2026-08-31',2,150,80,80,301,true,1,501),
 (202,'SYN-OPEN-EXPENSE','Factura Expense',10,1,null,10900,'2026-08-02','2026-09-01',2,140,20,20,302,true,1,502);
 insert into journal_line values(201,10900,301,10,null,41,501),(202,10900,302,10,null,42,502);
 insert into gl_impact(subsidiary_id,account_id,posting_date,debit_amount,credit_amount,transaction_id,accounting_book_id,debit_fx,credit_fx,original_currency_id,opening_balance_line_id)values
 (1,301,'2026-09-30',0,12000,1900,1,0,80,2,501),(1,302,'2026-09-30',0,2800,1900,1,0,20,2,502);
 insert into "transaction"values
 (2001,1,'SYN-PAY-1','2026-10-20',1,1,10,null),(2002,1,'SYN-PAY-2','2026-10-20',1,1,20,null),
 (2003,1,'SYN-PAY-FX','2026-10-20',2,170,10,null),(2004,1,'SYN-PAY-PAID','2026-10-20',1,1,10,null),
 (3001,1,'SYN-CREDIT','2026-10-20',1,1,10,null),(3002,1,'SYN-DEBIT','2026-10-20',1,1,10,null),
 (3003,1,'SYN-CREDIT-FX','2026-10-20',2,165,10,null),(3004,1,'SYN-DEBIT-FX','2026-10-20',2,167,10,null);
 insert into supplier_payment values(1,'SYN-PAY-1',10,2001,1,1,50),(2,'SYN-PAY-ONLY-ADVANCE',20,2002,1,1,40),(3,'SYN-PAY-FX',10,2003,2,170,25),(4,'SYN-PAID',10,2004,1,1,25);
 insert into supplier_payment_application(payment_id,invoice_id,application_date,amount)values(1,101,'2026-10-20',10),(1,102,'2026-10-20',10),(3,103,'2026-10-20',20),(4,108,'2026-10-20',25);
 insert into supplier_credit_note values(1,'SYN-CREDIT',101,3001,1,1,10),(2,'SYN-CREDIT-FX',103,3003,2,165,5);
 insert into supplier_debit_note values(1,'SYN-DEBIT',101,3002,1,1,5),(2,'SYN-DEBIT-FX',103,3004,2,167,3);
 insert into invoice values(501,'SYN-AR',50,1,1501,10501,'2026-10-01','2026-10-15',1,1,100,100,0,null);
 insert into "transaction"values(1501,1,'SYN-AR-TX','2026-10-01',1,1,null,50);
 insert into journal values(10501,1501,1,'SYN-AR-JOURNAL','2026-10-01');
 insert into journal_line values(501,10501,401,null,50,41,null);
 insert into gl_impact(subsidiary_id,account_id,posting_date,debit_amount,credit_amount,transaction_id,accounting_book_id,debit_fx,credit_fx,original_currency_id)values(1,401,'2026-10-01',100,0,1501,1,100,0,1);
 `);
 return{supplierId:10,advanceOnlySupplierId:20,foreignSupplierId:30,customerId:50,invoiceIds:{STANDARD:101,EXPENSE:102,CARD:103,PETTY_CASH:104,FIXED_ASSET:105,OTHER:[106,107]},fullyPaidInvoiceId:108,openingInvoiceIds:[201,202],sharedOpeningJournalId:10900,localCurrencyId:1,foreignCurrencyId:2};
}

export async function applyPayablesAgingInvoiceType(db){
 await db.exec('begin');try{await db.exec(await read(payablesAgingInvoiceTypeMigration));await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}
/** Optional deterministic page/volume seed; the report bodies stay unchanged. */
export async function seedAdditionalPayableInvoices(db,{count=1000,supplierId=10,subsidiaryId=1,currencyId=1,rate=1,amount=1}={}){
 if(!Number.isSafeInteger(count)||count<1||count>10000||![supplierId,subsidiaryId,currencyId].every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isFinite(rate)||rate<=0||!Number.isFinite(amount)||amount<=0)throw Error('Invalid synthetic paging seed');
 await db.exec('reset role');
 await db.query(`insert into supplier_invoice(invoice_id,invoice_number,invoice_type,supplier_id,subsidiary_id,transaction_id,journal_id,invoice_date,due_date,currency_id,exchange_rate,total_amount,payable_amount,payable_account_id)
 select 10000+n,'SYN-VOLUME-'||n,(array['Factura estándar','Factura Expense','Factura Tarjeta','Factura Caja Chica','Factura Activos Fijos'])[1+(n-1)%5],$2,$3,20000+n,30000+n,'2026-10-01','2026-10-15',$4,$5,$6,$6,301 from generate_series(1,$1)n`,[count,supplierId,subsidiaryId,currencyId,rate,amount]);
 await db.exec(`insert into "transaction" select transaction_id,subsidiary_id,'SYN-VOLUME-TX-'||invoice_id,invoice_date,currency_id,exchange_rate,supplier_id,null from supplier_invoice where invoice_id>=10001;
 insert into journal select journal_id,transaction_id,subsidiary_id,'SYN-VOLUME-JOURNAL-'||invoice_id,invoice_date from supplier_invoice where invoice_id>=10001;
 insert into journal_line select invoice_id,journal_id,payable_account_id,supplier_id,null,41,null from supplier_invoice where invoice_id>=10001;
 insert into gl_impact(subsidiary_id,account_id,posting_date,debit_amount,credit_amount,transaction_id,accounting_book_id,debit_fx,credit_fx,original_currency_id)select subsidiary_id,payable_account_id,invoice_date,0,total_amount*exchange_rate,transaction_id,1,0,total_amount,currency_id from supplier_invoice where invoice_id>=10001;`);
 return{firstInvoiceId:10001,lastInvoiceId:10000+count,count};
}
export async function setupPayablesAgingInvoiceType({apply=true,seed=true}={}){
 const db=await isolatedRoleTemplateDatabase();
 try{
  await structures(db);
  const manifest=await installAgingCalculations(db);
  const ids=seed?await seedPayablesAgingInvoiceTypes(db):null;
  if(apply)await applyPayablesAgingInvoiceType(db);
  return{db,manifest,ids};
 }catch(error){await db.close();throw error;}
}
