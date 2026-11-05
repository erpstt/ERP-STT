import{readFile}from'node:fs/promises';
import{loadLegacyJournalFunctions}from'./load-legacy-journal-functions.mjs';
const read=async name=>(await readFile(new URL(name,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
async function migration(db,name){await db.exec('begin');try{await db.exec(await read('../../supabase/migrations/'+name));await db.exec('commit');}catch(error){await db.exec('rollback');delete error.query;throw error;}}
async function definition(db,file,name){const source=await read('../../supabase/migrations/'+file);const pattern=new RegExp('create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?'+name+'\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;','i');const sql=source.match(pattern)?.[0];if(!sql)throw Error('Missing published banking function '+name);await db.exec(sql);}

// In-memory only. Financial writers and synchronization are published engine
// definitions. Synthetic numbering/identity data never leave this database.
export async function setupBankingCsvImport(db){
 for(const name of['consolidation-security.sql','bank-transfer-security.sql','manual-journal-security.sql'])await db.exec(await read('./'+name));
 const dims=await read('../journal-csv-test-fixture.sql');await db.exec(dims.slice(dims.indexOf('create table customers')));
 await db.exec('alter table cost_centers add column is_inactive boolean default false;alter table employees add column is_active boolean default true');
 await loadLegacyJournalFunctions(db);
 await migration(db,'20261031022533_secure_manual_journals.sql');
 await db.exec(await read('./bank-deposit-security.sql'));
 await db.exec('insert into location_subsidiaries values(2,2);alter table fiscal_periods add column period_name text;');
 await migration(db,'20260902090000_bank_account_transfers.sql');
 await migration(db,'20261031015835_secure_bank_transfers.sql');
 await db.exec(await read('./bank-account-security.sql'));
 await migration(db,'20261031031441_secure_bank_account_writes.sql');
 await migration(db,'20260902130000_bank_deposit_transaction.sql');
 await migration(db,'20260902150000_manage_bank_deposits.sql');
 await migration(db,'20261031024434_secure_bank_deposits.sql');
 await migration(db,'20261103190154_bank_deposit_period_references.sql');
 await migration(db,'20261103192814_bank_deposit_shared_locations.sql');
 await db.exec(await read('./bank-check-security.sql'));
 await migration(db,'20260903100000_bank_checks_transfers_transaction.sql');
 await migration(db,'20260903110000_bank_check_periods.sql');
 await db.exec('alter function save_bank_check_transfer(jsonb,bigint)rename to save_bank_check_transfer_without_tax_agency;alter table bank_check_line add column tax_agency_id bigint;alter table journal_line add column tax_agency_id bigint');
 const taxSource=await read('../../supabase/migrations/20261027090000_tax_agency_payment_requests.sql');const taxWrapper=taxSource.match(/create or replace function public\.save_bank_check_transfer\([\s\S]*?\$\$[\s\S]*?\$\$;/i)?.[0];if(!taxWrapper)throw Error('Missing real tax-agency bank writer');await db.exec(taxWrapper);
 for(const resource of['banking:bank-checks','banking:bank-deposits','banking:bank-transfers']){await db.query('delete from role_access_matrix where resource_key=$1',[resource]);await db.query('insert into role_access_matrix values(1,$1,true,true,true,true),(2,$1,true,true,false,false),(3,$1,true,false,false,false)',[resource]);}
 await migration(db,'20261031114542_secure_bank_checks.sql');
 await db.exec(`alter table customers add column tax_id text;update customers set tax_id='SYN-CUSTOMER-'||customer_id;
 alter table suppliers add column tax_id text;update suppliers set tax_id='SYN-SUPPLIER-'||supplier_id;
 alter table employees add column employee_number text;update employees set employee_number='SYN-EMPLOYEE-'||employee_id;
 alter table tax_agencies add column agency_name text,add column tax_id text;update tax_agencies set agency_name='Synthetic agency '||tax_agency_id,tax_id='SYN-AGENCY-'||tax_agency_id;
 alter table payment_methods add column method_name text,add column method_code text;update payment_methods set method_name='Synthetic transfer',method_code='TRANSFERENCIA';
 alter table cost_centers add column code text;update cost_centers set code='SYN-CC-'||cost_center_id;
 alter table journal add column pending_period_type text,add column pending_origin_journal_id bigint,
 add column pending_initial_local numeric,add column pending_initial_foreign numeric,add column pending_reversed_local numeric,add column pending_reversed_foreign numeric,add column pending_balance_local numeric,add column pending_balance_foreign numeric,add column reversal_status text;
 alter table public."transaction"add unique(tran_number);
 alter table gl_impact add column gl_impact_id bigint generated always as identity primary key,add column original_currency_id bigint,add column opening_balance_line_id bigint;
 alter table gl_impact add constraint gl_impact_transaction_id_fkey foreign key(transaction_id)references public."transaction"(transaction_id)on delete cascade;
 alter table journal_line add column original_currency_id bigint,add column historical_exchange_rate numeric(24,10);
 alter table journal_line alter column debit type numeric(24,6),alter column credit type numeric(24,6),alter column debit_fx type numeric(24,6),alter column credit_fx type numeric(24,6);
 alter table gl_impact alter column debit_amount type numeric(24,6),alter column credit_amount type numeric(24,6),alter column debit_fx type numeric(24,6),alter column credit_fx type numeric(24,6);
 create table accounting_books(accounting_book_id bigint primary key,subsidiary_id bigint,is_primary boolean,is_active boolean);insert into accounting_books values(1,1,true,true),(2,2,true,true);
 create table tax_types(tax_type_id bigint primary key,asset_account_id bigint,liability_account_id bigint);
 create table tax_codes(tax_code_id bigint primary key,tax_type_id bigint,rate_percentage numeric);
 insert into chart_accounts(account_id,account_number,account_name,category,currency_id)values(105,'111005','Synthetic foreign bank','Activo',2);
 insert into account_subsidiaries values(105,1,true);
 insert into bank_account(bank_account_id,account_number,bank_id,subsidiary_id,currency_id,account_id,balance,is_credit_card,country_id)overriding system value values(5,'SYN-FOREIGN',1,1,2,105,1000,false,1);
 insert into subsidiary_currencies values(1,1),(1,2);
 insert into locations(location_id,name,subsidiary_id)values(3,'Synthetic shared location',2),(4,'Synthetic unassigned location',null);insert into location_subsidiaries values(3,1);
 alter table bank_transaction rename column bank_transaction_id to bank_tran_id;`);
 await definition(db,'20261021120000_pending_invoice_annual_reclassification.sql','sync_journal_transaction');
 await definition(db,'20260911124500_prevent_withholding_double_posting.sql','sync_journal_gl_impacts');
 await definition(db,'20261026194500_optimize_journal_csv_lookups.sql','sync_journal_gl_impacts_trigger');
 await definition(db,'20260903130000_fix_transfer_gl_balance.sql','normalize_bank_transfer_journal_line');
 await db.exec(`create trigger journal_transaction_sync before insert or update on journal for each row execute function sync_journal_transaction();
 create trigger normalize_bank_transfer_journal_line_trigger before insert on journal_line for each row execute function normalize_bank_transfer_journal_line();
 create trigger journal_line_gl_impact_sync after insert or update or delete on journal_line for each row execute function sync_journal_gl_impacts_trigger();`);
}
