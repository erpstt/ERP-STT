import {readFile} from 'node:fs/promises';
import {setupSupplierAdvancesReport,applySupplierAdvancesReport} from './setup-supplier-advances-report.mjs';
import {assumeSecurityUser} from './isolated-role-template-security.mjs';
export {assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,authId,authSession,hash} from './isolated-role-template-security.mjs';
export {seedSupplierAdvanceSource,seedSupplierAdvanceApplication,seedSupplierAdvanceManualLines,seedSupplierAdvanceOpening,seedSupplierAdvanceStoredReversal,seedUnattributedSupplierAdvance} from './setup-supplier-advances-report.mjs';

const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8').then(source=>source.replace(/\r\n/g,'\n'));
export const supplierAdvancesPendingMigration='20261108232745_report_unapplied_supplier_advances_by_source.sql';
const eligibilityTargets=[
 ['supplier_payment_private.supplier_available_advances()','2edd73e26ceb39e8f12d6228110b6c9e'],
 ['supplier_payment_private.prepare(jsonb,bigint,bigint)','6a8c0c90fd9bd201588d6c4a2c2a570b'],
 ['supplier_payment_private.save_supplier_payment_with_advances_base(jsonb,bigint)','d53643b5ec53ecc3c96c575d9347688a'],
];
async function migration(db,name){await db.exec('reset role;begin');try{await db.exec(await read(name));await db.exec('commit');}catch(error){await db.exec('rollback');delete error.query;throw error;}}

/** All masters/actors are synthetic and live only in PGlite. The published
 * invoice/payment/historical-FX engines and current A06 guards are real.
 * No opening importer or existing shared fixture is modified.
 */
export async function setupSupplierAdvancesPending(db){
 const ids=await setupSupplierAdvancesReport(db);await applySupplierAdvancesReport(db);await db.exec('reset role');
 // The shared engine fixture predates this published optional-activity guard.
 // Install exactly its reviewed literals, not a hand-written source surrogate.
 const source=await read('20261102180607_payment_request_beneficiary_bank_accounts.sql');
 const patch=source.match(/'supplier_payment_private\.prepare\(jsonb,bigint,bigint\)',\s*\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$/);
 if(!patch)throw Error('Missing published preparation compatibility');
 const definition=(await db.query("select pg_get_functiondef('supplier_payment_private.prepare(jsonb,bigint,bigint)'::regprocedure)d")).rows[0].d.replace(/\r\n/g,'\n');
 if(definition.split(patch[1]).length!==2)throw Error('Unexpected preparation compatibility fixture source');
 await db.exec(definition.replace(patch[1],patch[2]));
 for(const [signature]of eligibilityTargets){const d=(await db.query('select pg_get_functiondef($1::regprocedure)d',[signature])).rows[0].d;await db.exec(d.replace(/\r\n/g,'\n'));}
 await migration(db,'20261108220513_allow_supplier_account_115004_advances.sql');
 for(const [signature,expected]of eligibilityTargets){const actual=(await db.query('select md5(prosrc)hash from pg_proc where oid=$1::regprocedure',[signature])).rows[0].hash;if(actual!==expected)throw Error('Published 115004-only source mismatch: '+signature);}
 await assumeSecurityUser(db);return ids;
}

export async function applySupplierAdvancesPending(db,migrationName=supplierAdvancesPendingMigration){
 if(typeof migrationName!=='string'||!/^\d{14}_\w+\.sql$/.test(migrationName))throw Error('Provide the reviewed pending-advance migration');
 await migration(db,migrationName);
}

/** One real payment may consume several advance sources but stores its 115004
 * local credit aggregated by account. Return the application IDs for exact
 * source/order assertions; never invent a source-to-individual-invoice split.
 */
export async function seedSupplierAdvancesPendingPayment(db,{sources,date='2026-10-31',paymentRate=170,invoiceRate=160,cashAmount=0,note='Synthetic pending-advance application'}={}){
 if(!Array.isArray(sources)||sources.length===0)throw Error('Provide synthetic advance sources and native applied amounts');
 const supplierId=sources[0].supplierId,currencyId=sources[0].currencyId;
 if(sources.some(source=>source.supplierId!==supplierId||source.currencyId!==currencyId||!Number.isFinite(Number(source.appliedAmount))||Number(source.appliedAmount)<=0))throw Error('Synthetic applications require one supplier/currency and positive amounts');
 const amount=sources.reduce((total,source)=>total+Number(source.appliedAmount),Number(cashAmount));
 await assumeSecurityUser(db);const number=(await db.query("select nextval('synthetic_transfer_number')id")).rows[0].id;
 const invoice=(await db.query('select save_supplier_invoice($1,null)r',[{invoice_number:'SYN-PENDING-INV-'+number,invoice_type:'Factura estándar',supplier_id:supplierId,payment_term_id:1,invoice_date:date,fiscal_period_id:10,currency_id:currencyId,exchange_rate:currencyId===1?1:invoiceRate,memo:note,lines:[{account_id:203,quantity:1,unit_price:amount,tax_rate:0,department_id:21}]}])).rows[0].r;
 const payment=(await db.query('select save_supplier_payment_with_advances($1,null)r',[{supplier_id:supplierId,account_id:currencyId===1?1:2,date,period_id:10,location_id:1,rate:currencyId===1?1:paymentRate,reference:'SYN-PENDING-PAY-'+number,memo:note,applications:[{invoice_id:invoice.invoiceId,amount}],advances:sources.map(source=>({advanceLineId:source.sourceLineId,amount:source.appliedAmount}))}])).rows[0].r;
 await db.exec('reset role');
 const applications=(await db.query('select application_id,payment_id,source_journal_line_id,amount,applied_at from supplier_advance_application where payment_id=$1 order by application_id',[payment.id])).rows;
 const header=(await db.query('select transaction_id,journal_id,payment_date from supplier_payment where payment_id=$1',[payment.id])).rows[0];
 const gl=(await db.query('select *from gl_impact where transaction_id=$1 and account_id=601 order by gl_impact_id',[header.transaction_id])).rows;
 await assumeSecurityUser(db);return{invoice,payment,applications,transactionId:header.transaction_id,journalId:header.journal_id,date:header.payment_date,gl};
}

/** Persisted opening reversal read oracle. Unlike a transaction-only copy,
 * this includes the original GL rows whose legacy transaction FK is NULL.
 * It is synthetic historical state, never an opening/reversal writer test.
 */
export async function seedSupplierAdvancesPendingOpeningReversal(db,source,{date='2026-11-01'}={}){
 await db.exec('reset role');const previous=(await db.query("select current_setting('nexo.defer_journal_gl_sync',true)value")).rows[0].value;
 await db.query("select set_config('nexo.defer_journal_gl_sync','on',false)");let reverse;
 try{
  reverse=(await db.query(`insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,reversed_from_journal_id)
   select 'SYN-PENDING-OPEN-REV-'||journal_id,$2,subsidiary_id,currency_id,fiscal_period_id,1,'Synthetic persisted opening reversal','Reversión',total_credit,total_debit,'CONTABILIZADO',journal_id from journal where journal_id=$1 returning journal_id,transaction_id`,[source.journalId,date])).rows[0];
  await db.query(`insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,note,entity_type,supplier_id,original_currency_id,historical_exchange_rate,opening_balance_line_id)
   select $1,account_id,credit,debit,credit_fx,debit_fx,'Synthetic pending opening reversal',entity_type,supplier_id,original_currency_id,historical_exchange_rate,opening_balance_line_id from journal_line where journal_id=$2`,[reverse.journal_id,source.journalId]);
  await db.query(`insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id)
   select $1,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,credit_amount,debit_amount,credit_fx,debit_fx,$2,original_currency_id,opening_balance_line_id from gl_impact where transaction_id=$3 or gl_impact_id=any($4::bigint[])`,[reverse.transaction_id,date,source.transactionId,source.entries.map(entry=>entry.glId)]);
  await db.query("update journal set status='ANULADO'where journal_id=$1",[source.journalId]);
  await db.query("update opening_balance_runs set status='REVERSED'where id=$1",[source.runId]);
 }finally{await db.query("select set_config('nexo.defer_journal_gl_sync',$1,false)",[previous??'']);}
 await assumeSecurityUser(db);return{journalId:reverse.journal_id,transactionId:reverse.transaction_id,date};
}
