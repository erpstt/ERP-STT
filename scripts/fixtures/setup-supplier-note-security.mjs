import {readFile} from 'node:fs/promises';
import {setupSupplierInvoiceSecurity} from './setup-supplier-invoice-security.mjs';
export async function setupSupplierNoteSecurity(db){
 await setupSupplierInvoiceSecurity(db);
 await db.exec(`alter table financial_creditors add primary key(financial_creditor_id);alter table related_companies add primary key(related_company_id);drop table supplier_credit_note;drop table supplier_debit_note;
 create table supplier_credit_note(cn_id bigint generated always as identity primary key,cn_number text not null,transaction_id bigint,supplier_id bigint,invoice_id bigint,amount numeric(24,6));
 create table supplier_debit_note(dn_id bigint generated always as identity primary key,dn_number text not null,transaction_id bigint,supplier_id bigint,invoice_id bigint,amount numeric(24,6));
 insert into transaction_types values(10,'NC_PRO','Nota crédito'),(11,'ND_PRO','Nota débito');`);
 await db.exec(await readFile(new URL('../../supabase/migrations/20260830120000_supplier_notes_workflow.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20260909201000_supplier_credit_note_available_balance.sql',import.meta.url),'utf8'));
 const routing=await readFile(new URL('../../supabase/migrations/20261020110000_supplier_invoice_payable_account_routing.sql',import.meta.url),'utf8');
 await db.exec('alter function save_supplier_note(text,jsonb,bigint) rename to save_supplier_note_before_payable_routing');
 const writer=routing.match(/create or replace function public\.save_supplier_note\([\s\S]*?\$\$;/i);if(!writer)throw Error('Missing original note writer');await db.exec(writer[0]);
 // Real balance trigger, not a synthetic balance implementation.
 const balanceSql=await readFile(new URL('../../supabase/migrations/20260909200000_credit_note_pending_balance.sql',import.meta.url),'utf8');
 const trigger=balanceSql.match(/create or replace function (?:public\.)?validate_supplier_credit_note_balance\([\s\S]*?\$\$;/i)?.[0];if(!trigger)throw Error('Missing original balance trigger');
 await db.exec(trigger);await db.exec('create trigger validate_note before insert or update of invoice_id,amount on supplier_credit_note for each row execute function validate_supplier_credit_note_balance()');
 for(const resource of ['purchasing:supplier-credit-notes','purchasing:supplier-debit-notes'])await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(2,$1,true,true,true,true),(3,$1,true,false,false,false)',[resource]);
 await db.exec('begin');await db.exec(await readFile(new URL('../../supabase/migrations/20261031155129_secure_supplier_notes.sql',import.meta.url),'utf8'));await db.exec('commit');
}
