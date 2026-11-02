import {readFile} from 'node:fs/promises';
import {loadLegacyJournalFunctions} from './load-legacy-journal-functions.mjs';
export const journalFormMigration='20261102193533_optimize_manual_journal_form_loading.sql';
const read=name=>readFile(new URL(name,import.meta.url),'utf8');
export async function setupJournalFormLoading(db){
 await db.exec(await read('./consolidation-security.sql'));
 await db.exec(await read('./bank-transfer-security.sql'));
 await db.exec(await read('../../supabase/migrations/20260902090000_bank_account_transfers.sql'));
 await db.exec('begin');await db.exec(await read('../../supabase/migrations/20261031015835_secure_bank_transfers.sql'));await db.exec('commit');
 await db.exec(await read('./manual-journal-security.sql'));
 const dims=await read('../journal-csv-test-fixture.sql');await db.exec(dims.slice(dims.indexOf('create table customers')));
 await db.exec(`alter table cost_centers add column is_inactive boolean default false;
  alter table employees add column is_active boolean default true;
  alter table subsidiaries add column country_id bigint;
  alter table currencies add column name text;
  alter table fiscal_periods add column period_name text;
  alter table exchange_rates add column exchange_rate_id bigint generated always as identity;
  alter table related_companies add column country_id bigint;
  create table tax_types(tax_type_id bigint primary key,asset_account_id bigint,liability_account_id bigint);
  create table tax_codes(tax_code_id bigint primary key,code_name text,rate_percentage numeric,tax_type_id bigint,subsidiary_id bigint,country_id bigint);
  create table journal_support(support_id bigint primary key,journal_id bigint,support_type text,display_name text,support_url text,
    file_name text,mime_type text,file_size bigint,file_data text);
  update subsidiaries set country_id=1 where subsidiary_id=1;
  update currencies set name=currency_code;
  update fiscal_periods set period_name='Synthetic October';
  insert into subsidiary_currencies values(1,2);
  insert into tax_types values(1,101,102),(2,104,104);
  insert into tax_codes values(1,'Synthetic tax',13,1,1,1),(2,'Foreign tax',15,2,2,2);
  insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-10',0.002),(1,2,'2026-10-10',500);
  insert into employees(employee_id,first_name,last_name,subsidiary_id,is_active)values(11,'Foreign','Employee',2,true);
  insert into suppliers(supplier_id,company_name)values(11,'Foreign supplier');
  insert into entity_subsidiaries values(null,11,2);
  alter table suppliers drop column is_inactive;
  alter table customers drop column is_inactive;
  alter table suppliers add column payment_iban text;
  update suppliers set payment_iban='SECRET BANK DATA';
  alter table employees add column email text;
  update employees set email='private@example.invalid';`);
 await loadLegacyJournalFunctions(db);
 await db.exec('begin');await db.exec(await read('../../supabase/migrations/20261031022533_secure_manual_journals.sql'));await db.exec('commit');
 const acl=(await db.query(`select p.oid,p.proname,p.proacl::text,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='journal_entry_private' order by p.oid`)).rows;
 await db.exec('begin');await db.exec(await read('../../supabase/migrations/'+journalFormMigration));await db.exec('commit');
 return{acl};
}
