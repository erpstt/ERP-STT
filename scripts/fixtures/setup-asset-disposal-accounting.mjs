import {readFile} from 'node:fs/promises';
import {setupAssetOperationSecurity} from './setup-asset-operation-security.mjs';
export async function setupAssetDisposalAccounting(db){
 await setupAssetOperationSecurity(db);
 await db.exec(`alter table customers add primary key(customer_id);
 create table tax_types(tax_type_id bigint primary key,liability_account_id bigint);
 create table tax_codes(tax_code_id bigint primary key,code_name text,rate_percentage numeric,tax_type_id bigint,subsidiary_id bigint,is_withholding boolean,is_import_tax boolean);
 create table invoice(invoice_id bigint primary key,subsidiary_id bigint,invoice_number text);
 alter table exchange_rates add column exchange_rate_id bigint generated always as identity;
 alter table customers add column primary_subsidiary_id bigint;

 insert into customers(customer_id,company_name,primary_subsidiary_id) values(21,'Synthetic buyer',1),(22,'Foreign buyer',2);insert into entity_subsidiaries(customer_id,subsidiary_id) values(21,1),(22,2);
 insert into chart_accounts(account_id,account_number,account_name,category,accepts_entries) values(301,'6100','Disposal loss','Gasto',true),(302,'6101','Sale loss','Gasto',true),(303,'4100','Sale gain','Ingreso',true),(304,'1591','Impairment','Activo',true),(305,'2100','Tax payable','Pasivo',true);
 insert into account_subsidiaries values(301,1,true),(302,1,true),(303,1,true),(304,1,true),(305,1,true);
 insert into tax_types values(1,305);insert into tax_codes values(1,'Synthetic VAT',19,1,1,false,false);
 insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed,gl_closed,is_inactive) values(11,1,'2026-11-01','2026-11-30',false,false,false);`);
 await db.exec('begin');
 await db.exec(await readFile(new URL('../../supabase/migrations/20261119200000_asset_disposal_accounting.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261119221000_asset_disposal_followup_guards.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261119223000_enforce_asset_disposal_reversals.sql',import.meta.url),'utf8'));
 await db.exec('commit');
 await db.exec(`create function fixture_disposal_transaction() returns trigger language plpgsql as $$begin
 insert into public."transaction"(tran_number,tran_date,subsidiary_id,currency_id,exchange_rate,fiscal_period_id) values(new.journal_number,new.journal_date,new.subsidiary_id,new.currency_id,new.exchange_rate,new.fiscal_period_id) returning transaction_id into new.transaction_id;return new;end$$;
 create trigger fixture_disposal_transaction before insert on public.journal for each row execute function fixture_disposal_transaction();`);
 // Replace the older security fixture's no-op projector with the real base GL projection.
 await db.exec(`create or replace function public.sync_journal_gl_impacts(target_journal_id bigint) returns void language plpgsql as $$declare j public.journal;begin
 select * into j from public.journal where journal_id=target_journal_id;
 delete from public.gl_impact where transaction_id=j.transaction_id;
 insert into public.gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date)
 select j.transaction_id,l.account_id,j.subsidiary_id,j.fiscal_period_id,1,l.debit*j.exchange_rate,l.credit*j.exchange_rate,l.debit,l.credit,j.journal_date from public.journal_line l where l.journal_id=j.journal_id;
 end$$;`);
}
