import {readFile} from 'node:fs/promises';
import {setupFxBankTransferNormalization,assumeSecurityUser,fxExecutionPayload} from './setup-fx-bank-transfer-normalization.mjs';
export {assumeSecurityUser,deniedSql,seedStoredFxLedger,seedStoredFxTransfer} from './setup-fx-bank-transfer-normalization.mjs';
export {assumeSqlRole} from './setup-fx-execution-progress.mjs';
export const fxZeroNativeMigration='20261110003357_retain_zero_native_fx_sources_with_prior_adjustments.sql';
export const fxZeroNativePayload=fxExecutionPayload;
export const readFxZeroNativeMigration=async()=>(await readFile(new URL('../../supabase/migrations/'+fxZeroNativeMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
export async function applyFxZeroNativeRevaluation(db){await db.exec(await readFxZeroNativeMigration());}
/** Synthetic A06 actor/session/device and the published journal/FX engines.
 * No .env, network connection, captured user rows or real authorization is used. */
export async function setupFxZeroNativeRevaluation({apply=true}={}){
 const result=await setupFxBankTransferNormalization(),{db}=result;
 try{
  await db.exec("reset role;insert into role_permissions(role_id,permission_id)select 1,permission_id from permissions where code='accounting:journal:reverse'on conflict do nothing");
  if(apply)await applyFxZeroNativeRevaluation(db);return result;
 }catch(error){await db.close();delete error.query;throw error;}
}
export async function prepareFxZeroNative(db){await assumeSecurityUser(db);return(await db.query('select public.fx_prepare($1)data',[fxExecutionPayload()])).rows[0].data;}
export async function executeFxZeroNative(db,run){await assumeSecurityUser(db);return(await db.query('select public.fx_execute($1)data',[{runId:run.run_id,fingerprint:run.fingerprint}])).rows[0].data;}
export async function cancelFxZeroNative(db,run){await assumeSecurityUser(db);return(await db.query('select public.fx_cancel($1)data',[{runId:run.run_id,reason:'Synthetic zero-native source regression'}])).rows[0].data;}
export async function fxZeroNativeJournal(db,{accountId=2601,amount=100,rate='150',credit=false,date='2026-10-01'}={}){
 await assumeSecurityUser(db);
 const payload={journal_type:'Asiento de Diario General',journal_date:date,subsidiary_id:1,currency_id:2,exchange_rate:rate,fiscal_period_id:10,location_id:1,memo:'Synthetic zero-native FX source',lines:[
  {account_id:accountId,debit:credit?0:amount,credit:credit?amount:0,entity_type:'Ninguna'},
  {account_id:2602,debit:credit?amount:0,credit:credit?0:amount,entity_type:'Ninguna'}]};
 const journalId=(await db.query('select public.create_journal_entry($1)id',[payload])).rows[0].id;await db.exec('reset role');
 const transactionId=(await db.query('select transaction_id from journal where journal_id=$1',[journalId])).rows[0].transaction_id;return{journalId,transactionId};
}
export async function seedFxZeroNativeCycle(db,{residual='100',cancel=false,accountId=2601,credit=false}={}){
 const original=await fxZeroNativeJournal(db,{accountId,credit}),run=await prepareFxZeroNative(db),posted=await executeFxZeroNative(db,run);await db.exec('reset role');
 const rate=(await db.query('select ((15000-$1::numeric)/100)::text rate',[residual])).rows[0].rate;
 const settlement=await fxZeroNativeJournal(db,{accountId,credit:!credit,date:'2026-10-20',rate});
 const cancelled=cancel?await cancelFxZeroNative(db,run):null;await db.exec('reset role');return{original,settlement,run,posted,cancelled};
}
/** Persisted document/application records are literal synthetic source facts;
 * all GL values come from the real journal writer, not a mock aging/FX engine. */
export async function linkFxZeroNativeDocument(db,{kind='AR',invoiceId=91001,amount=100,original,settlement,paymentId=92001,customerId=93001,supplierId=93002}={}){
 await db.exec('reset role');
 if(kind==='AR'){
  await db.query('insert into customers(customer_id,company_name)select $1,$2 where not exists(select 1 from customers where customer_id=$1)',[customerId,'Synthetic zero-native customer']);
  await db.query("insert into invoice(invoice_id,invoice_number,customer_id,transaction_id,currency_id,subsidiary_id,invoice_date)values($1,$2,$3,$4,2,1,'2026-10-01')",[invoiceId,'SYN-ZERO-AR-'+invoiceId,customerId,original.transactionId]);
  if(settlement){await db.query("insert into customer_payment(payment_id,transaction_id,payment_date,currency_id)select $1,$2,'2026-10-20'::date,2 where not exists(select 1 from customer_payment where payment_id=$1)",[paymentId,settlement.transactionId]);await db.query("insert into customer_payment_application(payment_id,invoice_id,amount,application_date)values($1,$2,$3,'2026-10-20')",[paymentId,invoiceId,amount]);}
 }else{
  await db.query('insert into suppliers(supplier_id,company_name)select $1,$2 where not exists(select 1 from suppliers where supplier_id=$1)',[supplierId,'Synthetic zero-native supplier']);
  await db.query("insert into supplier_invoice(invoice_id,invoice_number,supplier_id,transaction_id,currency_id,subsidiary_id,invoice_date,total_amount,payable_amount)overriding system value values($1,$2,$3,$4,2,1,'2026-10-01',$5,$5)",[invoiceId,'SYN-ZERO-AP-'+invoiceId,supplierId,original.transactionId,amount]);
  if(settlement){await db.query("insert into supplier_payment(payment_id,transaction_id,payment_date,currency_id)overriding system value select $1,$2,'2026-10-20'::date,2 where not exists(select 1 from supplier_payment where payment_id=$1)",[paymentId,settlement.transactionId]);await db.query("insert into supplier_payment_application(payment_id,invoice_id,amount,application_date)values($1,$2,$3,'2026-10-20')",[paymentId,invoiceId,amount]);}
 }
}
export async function seedFxWeightedZeroNative(db,{negative=false}={}){
 const first=await fxZeroNativeJournal(db,{amount:1,rate:'1'}),second=await fxZeroNativeJournal(db,{amount:4,rate:'1'});
 await linkFxZeroNativeDocument(db,{invoiceId:91011,amount:1,original:first});await linkFxZeroNativeDocument(db,{invoiceId:91012,amount:4,original:second});
 const run=await prepareFxZeroNative(db),posted=await executeFxZeroNative(db,run);
 const settlement=await fxZeroNativeJournal(db,{amount:5,rate:negative?'1.0049996':'0.9950004',credit:true,date:'2026-10-20'});await db.exec('reset role');
 await db.query("insert into customer_payment(payment_id,transaction_id,payment_date,currency_id)values(92011,$1,'2026-10-20',2)",[settlement.transactionId]);
 await db.exec("insert into customer_payment_application(payment_id,invoice_id,amount,application_date)values(92011,91011,1,'2026-10-20'),(92011,91012,4,'2026-10-20')");
 const cancelled=await cancelFxZeroNative(db,run);await db.exec('reset role');return{first,second,settlement,run,posted,cancelled,sourceKey:'AR:91011',rawBook:negative?'-0.0049996':'0.0049996'};
}
