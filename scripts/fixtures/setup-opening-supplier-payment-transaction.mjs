import {readFile} from 'node:fs/promises';
import {setupSupplierPaymentHistoricalFx,applySupplierPaymentHistoricalFx} from './setup-supplier-payment-historical-fx.mjs';
export const openingSupplierTransactionMigration='20261105172835_resolve_opening_supplier_invoice_transaction_from_journal.sql';
export async function setupOpeningSupplierPaymentTransaction(db){
 await setupSupplierPaymentHistoricalFx(db);await applySupplierPaymentHistoricalFx(db);
 // Use the published importer's actual invoice INSERT, including its omission
 // of transaction_id. This prevents recreating the old, nonrepresentative seed.
 const source=await readFile(new URL('../../supabase/migrations/20261012160000_opening_balance_fx_dimensions.sql',import.meta.url),'utf8');
 const insert=source.match(/insert into supplier_invoice\(invoice_number,supplier_id,[\s\S]*?opening_balance_line_id,is_opening_balance\)[\s\S]*?values\([\s\S]*?true\);/i)?.[0];
 if(!insert||/\btransaction_id\b/.test(insert))throw Error('The reviewed opening-import projection changed');
 await db.exec(`create function pg_temp.import_opening_invoice_fixture(p_journal bigint,p_key bigint,p_currency bigint,p_rate numeric,p_amount numeric)returns bigint language plpgsql as $$
 declare line record;run_row record;journal_key bigint:=p_journal;supplier_key bigint:=10;period_key bigint:=10;result bigint;
 begin
  select 'SYN-IMPORT-'||p_key document_number,'2026-10-31'::date due_date,p_amount foreign_amount,'2026-10-31'::date issue_date,p_currency currency_id,p_rate historical_rate,'Synthetic actual import projection'::text note,1::bigint location_id,p_key id into line;
  select 1::bigint subsidiary_id,1::bigint id into run_row;
  ${insert}
  select invoice_id into result from public.supplier_invoice where journal_id=p_journal and opening_balance_line_id=p_key;
  return result;
 end$$;`);
}
export async function applyOpeningSupplierTransaction(db){
 const sql=(await readFile(new URL('../../supabase/migrations/'+openingSupplierTransactionMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 await db.exec(sql);
}
export async function seedImportedOpening(db,{currencyId=1,rate=1,amount=100}={}){
 await db.exec('reset role');
 const transaction=(await db.query(`insert into public."transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,total_amount)values('SYN-SHARED-OPENING','2026-10-31',2,1,1,1,10,$1::numeric*$2::numeric)returning transaction_id`,[amount+20,rate])).rows[0].transaction_id;
 const journal=(await db.query("insert into public.journal(journal_number,journal_date,transaction_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,status,is_opening_balance)values('SYN-SHARED-OPENING','2026-10-31',$1,1,1,1,10,'CONTABILIZADO',true)returning journal_id",[transaction])).rows[0].journal_id;
 for(const[key,native]of[[42,amount],[43,20]]){
  await db.query(`insert into public.journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx,entity_type,supplier_id,historical_exchange_rate,original_currency_id,opening_balance_line_id)
   values($1,301,0,$2::numeric*$3::numeric,0,$2,'Proveedor',10,$3,$4,$5),($1,203,$2::numeric*$3::numeric,0,$2,0,'Proveedor',10,$3,$4,$5+100)`,[journal,native,rate,currencyId,key]);
 }
 // This is the importer's definitive GL projection; its ordinary row trigger
 // also ran above, as it does for the other real financial-engine fixtures.
 await db.query('delete from public.gl_impact where transaction_id=$1',[transaction]);
 await db.query(`insert into public.gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id,opening_balance_line_id)
  select j.transaction_id,l.account_id,j.subsidiary_id,j.fiscal_period_id,1,l.debit,l.credit,l.debit_fx,l.credit_fx,j.journal_date,l.original_currency_id,l.opening_balance_line_id from public.journal j join public.journal_line l using(journal_id)where j.journal_id=$1`,[journal]);
 const invoices=[];for(const[key,native]of[[42,amount],[43,20]]){
  const id=(await db.query('select pg_temp.import_opening_invoice_fixture($1,$2,$3,$4,$5)id',[journal,key,currencyId,rate,native])).rows[0].id;
  // The published reconciliation wrapper establishes this account snapshot;
  // use the real existing resolver before taking immutable-history snapshots.
  await db.query('select public.ensure_supplier_invoice_payable_account($1)',[id]);invoices.push(id);
 }
 return {invoiceId:invoices[0],otherInvoiceId:invoices[1],journalId:journal,transactionId:transaction,currencyId,amount,rate,bankId:currencyId===1?1:2};
}
