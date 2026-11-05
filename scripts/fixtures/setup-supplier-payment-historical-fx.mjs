import {readFile} from 'node:fs/promises';
import {setupSupplierPaymentSecurity} from './setup-supplier-payment-security.mjs';
export const supplierPaymentHistoricalFxMigration='20261105170828_correct_supplier_payment_historical_fx_settlement.sql';
export const fxTargets=['supplier_payment_private.apply_supplier_payment_payable_accounts(bigint,numeric)','supplier_payment_private.available(bigint,bigint)','supplier_payment_private.lock_source(bigint)','supplier_payment_private.save_supplier_payment_without_withholding(jsonb,bigint)','public.validate_supplier_payment_application_payable()','supplier_payment_private.supplier_payment_options()'];
export async function setupSupplierPaymentHistoricalFx(db){
 await setupSupplierPaymentSecurity(db);
 await db.exec(`alter table journal add column if not exists is_opening_balance boolean default false,add column if not exists fx_revaluation_run_id bigint;
 alter table journal_line add column if not exists historical_exchange_rate numeric(24,10),add column if not exists original_currency_id bigint,add column if not exists opening_balance_line_id bigint;
 alter table gl_impact add column if not exists original_currency_id bigint,add column if not exists opening_balance_line_id bigint;
 alter table journal_line alter column debit type numeric(24,6),alter column credit type numeric(24,6),alter column debit_fx type numeric(24,6),alter column credit_fx type numeric(24,6);
 alter table gl_impact alter column debit_amount type numeric(24,6),alter column credit_amount type numeric(24,6),alter column debit_fx type numeric(24,6),alter column credit_fx type numeric(24,6);
 insert into subsidiary_currencies(subsidiary_id,currency_id)select 1,2 where not exists(select 1 from subsidiary_currencies where subsidiary_id=1 and currency_id=2);
 update bank_account set currency_id=2,balance=100000 where bank_account_id=2;
 insert into chart_accounts(account_id,account_number,account_name,category,accepts_entries)values(701,'422001','Synthetic realized gain','Ingreso',true),(702,'632001','Synthetic realized loss','Gasto',true);
 insert into account_subsidiaries values(701,1,true),(702,1,true);`);
 // The production row trigger is intentionally active throughout these tests.
 const triggerSource=await readFile(new URL('../../supabase/migrations/20261026194500_optimize_journal_csv_lookups.sql',import.meta.url),'utf8');
 const trigger=triggerSource.match(/create or replace function public\.sync_journal_gl_impacts_trigger\(\)[\s\S]*?\$\$;/)?.[0];
 if(!trigger)throw Error('Missing real journal GL synchronization trigger');await db.exec(trigger);
 await db.exec('create trigger journal_line_gl_impact_sync after insert or update or delete on journal_line for each row execute function sync_journal_gl_impacts_trigger()');
 // Git's Windows CRLF checkout must not change production LF body guards.
 for(const target of fxTargets){const definition=(await db.query('select pg_get_functiondef($1::regprocedure)d',[target])).rows[0].d;await db.exec(definition.replace(/\r\n/g,'\n'));}
}
export async function applySupplierPaymentHistoricalFx(db){
 const sql=(await readFile(new URL('../../supabase/migrations/'+supplierPaymentHistoricalFxMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 await db.exec('begin');try{await db.exec(sql);await db.exec('commit');}catch(error){await db.exec('rollback');delete error.query;throw error;}
}
