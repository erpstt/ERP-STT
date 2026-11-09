import {readFile} from 'node:fs/promises';
import {setupFxExecutionProgress,applyFxExecutionBatch,fxExecutionPayload,seedFxExecutionExposure} from './setup-fx-execution-progress.mjs';
export {assumeSecurityUser,deniedSql} from './setup-fx-execution-progress.mjs';
export {fxExecutionPayload,seedFxExecutionExposure};
export const fxBankTransferMigration='20261109225034_normalize_fx_bank_transfer_exposure.sql';
export async function applyFxBankTransferNormalization(db){await db.exec('reset role;begin');try{await db.exec((await readFile(new URL('../../supabase/migrations/'+fxBankTransferMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n'));await db.exec('commit');}catch(error){await db.exec('rollback');delete error.query;throw error;}}
export async function setupFxBankTransferNormalization({apply=true}={}){
 const result=await setupFxExecutionProgress(),{db}=result;
 try{
  await applyFxExecutionBatch(db);await db.exec(`
   alter table bank_transfer add column subsidiary_id bigint,add column journal_id bigint,add column source_amount numeric(24,6),add column source_base_amount numeric(24,6),add column source_base_rate numeric(24,10),add column destination_amount numeric(24,6),add column destination_base_amount numeric(24,6),add column destination_base_rate numeric(24,10),add column commission_amount numeric(24,6)default 0,add column status text default 'APROBADA';
   insert into account_group(group_id,group_code,group_name,category,nature,pending_fx_revaluation)values
    (98001,'111','Synthetic bank asset group','Activo','Deudora',true),
    (98002,'223','Synthetic payroll liability group','Pasivo','Acreedora',true);
   update chart_accounts set account_group_id=98001,pending_fx_revaluation=true where account_id=2601;
   insert into chart_accounts(account_id,account_number,account_name,account_group_id,category,accepts_entries,is_inactive,pending_fx_revaluation,nature,financial_statement)values
    (2701,'111991','Synthetic local bank',98001,'Activo',true,false,false,'Deudora','Balance General'),
    (2702,'632991','Synthetic transfer fee',null,'Gasto',true,false,false,'Deudora','Estado de Resultados'),
    (2703,'223991','Synthetic payroll liability',98002,'Pasivo',true,false,true,'Acreedora','Balance General');
   insert into account_subsidiaries values(2701,1,true),(2702,1,true),(2703,1,true);
   insert into bank_account(bank_account_id,account_number,subsidiary_id,currency_id,account_id,balance)values(9101,'SYN-USD-BANK',1,2,2601,0),(9102,'SYN-LOCAL-BANK',1,1,2701,0);
  `);
  if(apply)await applyFxBankTransferNormalization(db);return result;
 }catch(error){await db.close();delete error.query;throw error;}
}
/** Literal persisted source fixtures, not a substitute bank-transfer writer.
 * All prepare/execute/fingerprint/posting operations use the real FX engines. */
export async function seedStoredFxLedger(db,{accountId=2601,native='300',local='45000',date='2026-09-30',currencyId=2,bookId=1,sid=1,journalType='Asiento de Diario General',reversedFrom=null}={}){
 await db.exec('reset role');
 const transaction=(await db.query(`insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount)values('SYN-STORED-FX-'||(select coalesce(max(transaction_id),0)+1 from "transaction"),$1,1,$2,1,1,10,0)returning transaction_id`,[date,sid])).rows[0].transaction_id;
 const journal=(await db.query(`insert into journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status,location_id,reversed_from_journal_id)values('SYN-STORED-'||$1::bigint,$2,$1::bigint,$3,1,10,1,'Synthetic stored FX source',$4,0,0,'CONTABILIZADO',1,$5)returning journal_id`,[transaction,date,sid,journalType,reversedFrom])).rows[0].journal_id;
 const gl=(await db.query(`insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id)values($1,$2,$3,10,$4,greatest($5::numeric,0),greatest(-$5::numeric,0),greatest($6::numeric,0),greatest(-$6::numeric,0),$7,$8)returning gl_impact_id`,[transaction,accountId,sid,bookId,local,native,date,currencyId])).rows[0].gl_impact_id;
 return {transactionId:transaction,journalId:journal,glId:gl,accountId,bookId,date};
}
export async function seedStoredFxTransfer(db,{source='70',rate='151',date='2026-10-09',fee='0',incoming=false,bookId=1}={}){
 await db.exec('reset role');
 const value=(await db.query('select $1::numeric+$3::numeric native,round($1::numeric*$2::numeric,6) principal_local,round(($1::numeric+$3::numeric)*$2::numeric,6)local',[source,rate,fee])).rows[0];
 // The raw native columns intentionally contain local amounts, as in the
 // historical local-currency transfer journal that exposed the production bug.
 const row=await seedStoredFxLedger(db,{native:incoming?value.local:'-'+value.local,local:incoming?value.local:'-'+value.local,date,currencyId:null,bookId,journalType:'Transferencia bancaria'});
 const transfer=(await db.query(`insert into bank_transfer(transfer_number,from_account_id,to_account_id,transaction_id,amount,transfer_date,subsidiary_id,journal_id,source_amount,source_base_amount,source_base_rate,destination_amount,destination_base_amount,destination_base_rate,commission_amount)values('SYN-TRANSFER-'||$1::bigint,$2,$3,$1::bigint,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13)returning transfer_id`,[
  row.transactionId,incoming?9102:9101,incoming?9101:9102,source,date,row.journalId,
  incoming?value.local:source,incoming?value.local:value.principal_local,incoming?'1':rate,
  incoming?value.native:value.principal_local,incoming?value.local:value.principal_local,incoming?rate:'1',incoming?'0':fee,
 ])).rows[0].transfer_id;
 await db.query(`insert into bank_transaction(bank_account_id,transaction_id,amount,tran_date,value_date,tran_type,reference_number)values($1,$2,$3,$4,$4,'TRF_BAN','SYN-TRANSFER'),($5,$2,$6,$4,$4,'TRF_BAN','SYN-TRANSFER')`,[
  incoming?9102:9101,row.transactionId,incoming?'-'+value.local:'-'+value.native,date,incoming?9101:9102,incoming?value.native:value.principal_local,
 ]);
 return {...row,transferId:transfer,principalNative:source,sourceRate:rate,local:value.local,native:value.native,incoming};
}
export async function seedStoredFxTransferReversal(db,source,{date='2026-11-01'}={}){
 await db.exec('reset role');
 const row=await seedStoredFxLedger(db,{native:source.incoming?'-'+source.local:source.local,local:source.incoming?'-'+source.local:source.local,date,currencyId:null,bookId:source.bookId,journalType:'Anulación de Transferencia bancaria',reversedFrom:source.journalId});
 await db.query("update bank_transfer set status='ANULADA'where transfer_id=$1",[source.transferId]);return row;
}
