import {readFile} from 'node:fs/promises';
import {setupSupplierPaymentHistoricalFx,applySupplierPaymentHistoricalFx} from './setup-supplier-payment-historical-fx.mjs';
import {installAccessAdminSecurity} from './setup-access-admin-security.mjs';
import {installSessionBoundarySecurity} from './setup-session-boundary-security.mjs';
import {assumeSecurityUser} from './isolated-role-template-security.mjs';
export {assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,authId,authSession,hash} from './isolated-role-template-security.mjs';

export const supplierAdvancesReportMigration='20261108200055_add_supplier_advances_ledger_report.sql';
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
function definition(sql,name){
 const escaped=name.replaceAll('.','\\.');
 const match=sql.match(new RegExp('create(?: or replace)? function '+escaped+'\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;','i'));
 if(!match)throw Error('Missing actual supplier-advance fixture dependency: '+name);return match[0];
}
async function installCurrentReportSecurity(db){
 // Current session/device registration and A06 oracles, on synthetic identities.
 // Keep the protected invoice/payment/GL engines installed by the source fixture.
 await installAccessAdminSecurity(db);
 await installSessionBoundarySecurity(db);
 const reviewed=(await readFile(new URL('./legacy-authorization-functions.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 const activation=await read('20261102014321_activate_legacy_authorization_retirement_after_server.sql');
 for(const name of ['security_assert_role_access','security_resource_allowed']){
  const marker='CREATE OR REPLACE FUNCTION public.'+name+'(',start=reviewed.indexOf(marker),end=reviewed.indexOf('$function$;',start);
  if(start<0||end<0)throw Error('Missing unchanged A06 oracle');await db.exec(reviewed.slice(start,end+11));
  const patch=[...activation.matchAll(/do \$patch\$[\s\S]*?end\$patch\$;/g)].map(m=>m[0]).filter(s=>s.includes("oid='public."+name+"(text,text)'::regprocedure"));
  if(patch.length!==1)throw Error('Missing unchanged A06 activation');await db.exec(patch[0]);
 }
 await db.exec("delete from role_access_matrix where resource_key='legacy:all';alter table role_access_matrix add constraint no_legacy_authorization check(resource_key<>'legacy:all')");
 await db.exec('create schema report_template_private;revoke all on schema report_template_private from public,anon,authenticated,service_role');
 await db.exec(definition(await read('20261103032056_secure_financial_reports_pdf_templates.sql'),'report_template_private.enter'));
 await db.exec("revoke all on all functions in schema report_template_private from public,anon,authenticated,service_role;insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)values(1,'reports:accounting-reports',true,false,false,false),(3,'reports:accounting-reports',true,false,false,false)on conflict(role_id,resource_key)do update set can_view=true;delete from role_access_matrix where role_id=2 and resource_key='reports:accounting-reports'");
}

export async function setupSupplierAdvancesReport(db){
 await setupSupplierPaymentHistoricalFx(db);
 await applySupplierPaymentHistoricalFx(db);
 await installCurrentReportSecurity(db);
 await db.exec(`
 alter table journal add column if not exists pending_period_type text,add column if not exists pending_origin_journal_id bigint,
  add column if not exists pending_initial_local numeric,add column if not exists pending_initial_foreign numeric,
  add column if not exists pending_reversed_local numeric,add column if not exists pending_reversed_foreign numeric,
  add column if not exists pending_balance_local numeric,add column if not exists pending_balance_foreign numeric,add column if not exists reversal_status text;
 create unique index fixture_advance_transaction_number on public."transaction"(tran_number);
 alter table suppliers add column if not exists supplier_number text;
 alter table journal_line add column if not exists tax_agency_id bigint,add column if not exists other_name_id bigint;
 update suppliers set supplier_number='SYN-SUP-'||supplier_id;
 insert into suppliers(supplier_id,company_name,is_inactive,supplier_number)values(20,'Synthetic second advance supplier',false,'SYN-SUP-20'),(30,'Synthetic historical supplier',true,'SYN-SUP-30');
 insert into entity_subsidiaries(supplier_id,subsidiary_id)values(20,1),(30,1),(10,2);
 update currencies set currency_code=case currency_id when 1 then'JMD'when 2 then'USD'else currency_code end;
 alter table accounting_books add column if not exists book_name text;
 update accounting_books set book_name='Synthetic book '||accounting_book_id;
 insert into accounting_books(accounting_book_id,subsidiary_id,is_primary,is_active,book_name)values(10,1,false,true,'Synthetic secondary book');
 insert into account_group(group_id,group_name,category)values(600,'Gastos Pagados por Anticipado','Activo');
 insert into chart_accounts(account_id,account_number,account_name,category,accepts_entries,account_group_id)values(601,'115004','Synthetic supplier advances','Activo',true,600),(602,'118001','Synthetic unrelated prepaid expense','Activo',true,600);
 insert into account_subsidiaries values(601,1,true),(601,2,true),(602,1,true);
 insert into subsidiary_currencies(subsidiary_id,currency_id)select 1,1 where not exists(select 1 from subsidiary_currencies where subsidiary_id=1 and currency_id=1);
 create table if not exists opening_balance_runs(id bigint primary key,subsidiary_id bigint,journal_id bigint,status text,opening_date date);
 alter table opening_balance_runs add column if not exists subsidiary_id bigint,add column if not exists journal_id bigint,add column if not exists status text,add column if not exists opening_date date;
 create table if not exists opening_balance_lines(id bigint primary key,run_id bigint,source_type text,row_number integer,account_id bigint,currency_id bigint,local_debit numeric(24,6),local_credit numeric(24,6),foreign_amount numeric(24,6),historical_rate numeric(24,10),document_number text,issue_date date,due_date date,note text,raw_data jsonb);
 alter table opening_balance_lines add column if not exists run_id bigint,add column if not exists source_type text,add column if not exists row_number integer,add column if not exists account_id bigint,add column if not exists currency_id bigint,add column if not exists local_debit numeric(24,6),add column if not exists local_credit numeric(24,6),add column if not exists foreign_amount numeric(24,6),add column if not exists historical_rate numeric(24,10),add column if not exists document_number text,add column if not exists issue_date date,add column if not exists due_date date,add column if not exists note text,add column if not exists raw_data jsonb;
 `);
 await db.exec(definition(await read('20261021120000_pending_invoice_annual_reclassification.sql'),'public.sync_journal_transaction'));
 await db.exec('create trigger journal_transaction_sync before insert or update on journal for each row execute function sync_journal_transaction()');
 await assumeSecurityUser(db);
 return{accountId:601,otherAdvanceAccountId:602,supplierIds:[10,20,30],localCurrencyId:1,foreignCurrencyId:2,bookIds:[1,10]};
}
export async function applySupplierAdvancesReport(db){
 await db.exec('reset role;begin');try{await db.exec(await read(supplierAdvancesReportMigration));await db.exec('commit');}catch(error){await db.exec('rollback');throw error;}
}

/** A real ordinary journal and its real synchronization; debit is native. */
export async function seedSupplierAdvanceSource(db,{amount=100,rate=150,currencyId=2,supplierId=10,date='2026-10-01',accountId=601,note='Synthetic advance source'}={}){
 await assumeSecurityUser(db);
 const journalId=(await db.query('select create_journal_entry($1)id',[{journal_type:'Asiento de Diario General',journal_date:date,subsidiary_id:1,currency_id:currencyId,exchange_rate:rate,fiscal_period_id:10,memo:note,location_id:1,lines:[{account_id:accountId,debit:amount,credit:0,entity_type:'Proveedor',entity_id:supplierId,note},{account_id:101,debit:0,credit:amount,entity_type:'Ninguna',note:'Synthetic balanced counterpart'}]}])).rows[0].id;
 await db.exec('reset role');
 const row=(await db.query('select l.journal_line_id,j.transaction_id,j.journal_id from journal_line l join journal j using(journal_id)where l.journal_id=$1 and l.account_id=$2',[journalId,accountId])).rows[0];
 await assumeSecurityUser(db);return{sourceLineId:row.journal_line_id,journalId:row.journal_id,transactionId:row.transaction_id,amount,rate,currencyId,supplierId,date,accountId};
}

/** A real invoice/payment engine posts advance retirement at its source rate. */
export async function seedSupplierAdvanceApplication(db,source,{amount=30,paymentRate=170,date='2026-10-31',invoiceAmount=amount,invoiceRate=160}={}){
 await assumeSecurityUser(db);
 const invoice=(await db.query('select save_supplier_invoice($1,null)r',[{invoice_number:'SYN-ADV-APPLICATION-'+source.sourceLineId+'-'+amount,invoice_type:'Factura estándar',supplier_id:source.supplierId,payment_term_id:1,invoice_date:date,fiscal_period_id:10,currency_id:source.currencyId,exchange_rate:source.currencyId===1?1:invoiceRate,memo:'Synthetic advance reporting invoice',lines:[{account_id:203,quantity:1,unit_price:invoiceAmount,tax_rate:0,department_id:21}]}])).rows[0].r;
 const payment=(await db.query('select save_supplier_payment_with_advances($1,null)r',[{supplier_id:source.supplierId,account_id:source.currencyId===1?1:2,date,period_id:10,location_id:1,rate:source.currencyId===1?1:paymentRate,reference:'SYN-ADV-REPORT',memo:'Synthetic exact advance application',applications:[{invoice_id:invoice.invoiceId,amount:invoiceAmount}],advances:[{advanceLineId:source.sourceLineId,amount}]}])).rows[0].r;
 return{invoice,payment};
}

/** Multiple real manual lines exercise the report's multiset proof, not order. */
export async function seedSupplierAdvanceManualLines(db,{lines=[{supplierId:10,debit:10},{supplierId:20,debit:10}],rate=1,currencyId=1,date='2026-10-01',note='Synthetic multi-line advance journal'}={}){
 const nativeLines=lines.map(line=>({account_id:601,debit:line.debit??0,credit:line.credit??0,entity_type:line.supplierId?'Proveedor':'Ninguna',...(line.supplierId?{entity_id:line.supplierId}:{}),note:line.note??note}));
 const difference=lines.reduce((sum,line)=>sum+(line.debit??0)-(line.credit??0),0);
 if(difference)nativeLines.push({account_id:101,debit:Math.max(-difference,0),credit:Math.max(difference,0),entity_type:'Ninguna',note:'Synthetic balanced counterpart'});
 await assumeSecurityUser(db);
 const journalId=(await db.query('select create_journal_entry($1)id',[{journal_type:'Asiento de Diario General',journal_date:date,subsidiary_id:1,currency_id:currencyId,exchange_rate:rate,fiscal_period_id:10,memo:note,location_id:1,lines:nativeLines}])).rows[0].id;
 await db.exec('reset role');
 const journal=(await db.query('select journal_id,transaction_id from journal where journal_id=$1',[journalId])).rows[0];
 const sourceLines=(await db.query('select journal_line_id,supplier_id,debit,credit from journal_line where journal_id=$1 and account_id=601 order by journal_line_id',[journalId])).rows;
 const glRows=(await db.query('select gl_impact_id from gl_impact where transaction_id=$1 and account_id=601 order by gl_impact_id',[journal.transaction_id])).rows;
 await assumeSecurityUser(db);return{journalId,transactionId:journal.transaction_id,sourceLines,glIds:glRows.map(r=>r.gl_impact_id)};
}

/** Faithful persisted opening shape: base header, native amounts per line,
 * shared journal/run, and optional legacy NULL GL transaction. This is a
 * synthetic stored-state fixture, not a substitute opening importer engine. */
export async function seedSupplierAdvanceOpening(db,{date='2026-09-30',glTransactionNull=true,glCurrencyNull=false,items=[{supplierId:10,amount:80,rate:150,currencyId:2},{supplierId:20,amount:80,rate:140,currencyId:2},{supplierId:30,amount:5,rate:1,currencyId:1}]}={}){
 await db.exec('reset role');
 const runId=Number((await db.query('select coalesce(max(id),0)+1 id from opening_balance_runs')).rows[0].id);
 const journal=(await db.query(`insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,is_opening_balance,asset_proposal_internal)
 values($1,$2,1,1,10,1,'Synthetic shared supplier advance opening','APERTURA',0,0,'CONTABILIZADO',true,true)returning journal_id,transaction_id`,['SYN-ADV-OPENING-'+runId,date])).rows[0];
 await db.query("insert into opening_balance_runs(id,subsidiary_id,journal_id,status,opening_date)values($1,1,$2,'POSTED',$3)",[runId,journal.journal_id,date]);
 const previous=(await db.query("select current_setting('nexo.defer_journal_gl_sync',true)value")).rows[0].value;
 const entries=[];await db.query("select set_config('nexo.defer_journal_gl_sync','on',false)");
 try{
  for(let index=0;index<items.length;index++){
   const item=items[index],lineId=Number((await db.query('select coalesce(max(id),0)+1 id from opening_balance_lines')).rows[0].id),document='SYN-OPEN-ADV-'+runId+'-'+(index+1);
   await db.query(`insert into opening_balance_lines(id,run_id,source_type,row_number,account_id,currency_id,local_debit,local_credit,foreign_amount,historical_rate,document_number,issue_date,note,raw_data)
    values($1,$2,'GL',$3,601,$4,round($5::numeric*$6::numeric,6),0,$5,$6,$7,$8,'Synthetic exact opening source','{}')`,[lineId,runId,index+1,item.currencyId,item.amount,item.rate,document,date]);
   const line=(await db.query(`insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,entity_type,supplier_id,note,historical_exchange_rate,original_currency_id,opening_balance_line_id)
    values($1,601,round($2::numeric*$3::numeric,6),0,$2,0,'Proveedor',$4,'Synthetic exact opening source',$3,$5,$6)returning journal_line_id`,[journal.journal_id,item.amount,item.rate,item.supplierId,item.currencyId,lineId])).rows[0];
   const gl=(await db.query(`insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id)
    values($1,601,1,10,1,round($2::numeric*$3::numeric,6),0,$2,0,$4,$5,$6)returning gl_impact_id`,[glTransactionNull?null:journal.transaction_id,item.amount,item.rate,date,glCurrencyNull?null:item.currencyId,lineId])).rows[0];
   entries.push({...item,documentNumber:document,openingLineId:lineId,journalLineId:line.journal_line_id,glId:gl.gl_impact_id});
  }
  const total=(await db.query('select sum(local_debit)::text amount from opening_balance_lines where run_id=$1',[runId])).rows[0].amount;
  await db.query("insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,note)values($1,101,0,$2,0,$2,'Synthetic balanced opening counterpart')",[journal.journal_id,total]);
  await db.query('insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id)values($1,101,1,10,1,0,$2,0,$2,$3,1)',[journal.transaction_id,total,date]);
  await db.query('update journal set total_debit=$1,total_credit=$1 where journal_id=$2',[total,journal.journal_id]);
 }finally{await db.query("select set_config('nexo.defer_journal_gl_sync',$1,false)",[previous??'']);}
 await assumeSecurityUser(db);return{runId,journalId:journal.journal_id,transactionId:journal.transaction_id,entries};
}

/** Explicit orphan GL state, retained by a ledger-first report. */
export async function seedUnattributedSupplierAdvance(db,{local=3,native=null,currencyId=null,date='2026-10-01',bookId=1,subsidiaryId=1,count=1}={}){
 if(!Number.isSafeInteger(count)||count<1||count>10000)throw Error('Invalid synthetic orphan GL count');
 await db.exec('reset role');
 const rows=(await db.query(`insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id)
  select null,601,$1,10,$2,greatest($3::numeric,0),greatest(-$3::numeric,0),case when $4::numeric is null then null else greatest($4::numeric,0)end,case when $4::numeric is null then null else greatest(-$4::numeric,0)end,$5,$6 from generate_series(1,$7)returning gl_impact_id`,[subsidiaryId,bookId,local,native,date,currencyId,count])).rows;
 await assumeSecurityUser(db);return rows.map(row=>row.gl_impact_id);
}

/** Actual protected manual reversal; return its real date. Assert against saved
 * GL, never an assumed zero: this composed fixture also has row-sync triggers. */
export async function seedSupplierAdvanceReversal(db,source){
 await assumeSecurityUser(db,1,2);
 const id=(await db.query('select reverse_journal_entry($1)id',[source.journalId])).rows[0].id;
 await db.exec('reset role');
 const row=(await db.query('select journal_id,transaction_id,journal_date from journal where journal_id=$1',[id])).rows[0];
 await assumeSecurityUser(db);return{journalId:row.journal_id,transactionId:row.transaction_id,date:row.journal_date};
}

/** Synthetic persisted reversal state for an as-of read oracle. Copies stored
 * GL and swaps sides exactly; this deliberately does not claim a writer test. */
export async function seedSupplierAdvanceStoredReversal(db,source,{date='2026-11-01'}={}){
 await db.exec('reset role');
 const previous=(await db.query("select current_setting('nexo.defer_journal_gl_sync',true)value")).rows[0].value;
 await db.query("select set_config('nexo.defer_journal_gl_sync','on',false)");
 let row;
 try{
  row=(await db.query(`insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,reversed_from_journal_id)
   select 'SYN-STORED-REV-'||journal_id,$2,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,'Synthetic persisted reversal oracle','Reversión',total_credit,total_debit,'CONTABILIZADO',journal_id from journal where journal_id=$1 returning journal_id,transaction_id`,[source.journalId,date])).rows[0];
  await db.query(`insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,note,entity_type,supplier_id,historical_exchange_rate,original_currency_id)
   select $1,account_id,credit,debit,credit_fx,debit_fx,'Synthetic persisted reverse: '||coalesce(note,''),entity_type,supplier_id,historical_exchange_rate,original_currency_id from journal_line where journal_id=$2`,[row.journal_id,source.journalId]);
  await db.query(`insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id)
   select $1,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,credit_amount,debit_amount,credit_fx,debit_fx,$3,original_currency_id,opening_balance_line_id from gl_impact where transaction_id=$2`,[row.transaction_id,source.transactionId,date]);
  await db.query("update journal set status='ANULADO'where journal_id=$1",[source.journalId]);
 }finally{await db.query("select set_config('nexo.defer_journal_gl_sync',$1,false)",[previous??'']);}
 await assumeSecurityUser(db);return{journalId:row.journal_id,transactionId:row.transaction_id,date};
}
