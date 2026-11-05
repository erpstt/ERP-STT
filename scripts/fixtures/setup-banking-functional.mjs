import {readFile} from 'node:fs/promises';
import {setupBankingCsvImport} from './setup-banking-csv-import.mjs';
const read=async p=>(await readFile(new URL(p,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
export async function applyBankingMigration(db,name){
 await db.exec('begin');try{await db.exec(await read('../../supabase/migrations/'+name));await db.exec('commit');}catch(error){await db.exec('rollback');delete error.query;throw error;}
}
export async function setupBankingFunctional(db){
 await setupBankingCsvImport(db);
 const authorization=await read('../../supabase/migrations/20261026112000_harden_user_catalog_rls.sql');
 const oracle=authorization.match(/create or replace function public\.security_resource_allowed\([\s\S]*?\$\$[\s\S]*?\$\$;/i)?.[0];
 if(!oracle)throw Error('Missing real resource-access oracle');
 // The published retirement patch removes this branch from the same oracle.
 await db.exec(oracle.replace("access.resource_key='legacy:all'",' false '));
 // Extend the real checks/deposits/transfer stack with the published fee engines.
 // The original fee fixture repeats schema already installed by checks; retain
 // only its reconciliation/statement structures and synthetic records.
 const fee=await read('bank-fee-security.sql');
 await db.exec("update chart_accounts set account_name='Comisiones bancarias sinteticas' where account_id=103;alter table transaction_types add unique(abbreviation)");
 await db.exec(fee.slice(fee.indexOf('alter table bank_reconciliation add column')));
 await db.exec('alter table bank_reconciliation add column fiscal_period_id bigint;alter table bank_reconciliation_match add column match_id bigint generated always as identity primary key');
 const source=await read('../../supabase/migrations/20260916160000_reuse_bank_reconciliation_period.sql');
 const ensure=source.match(/create or replace function public\.ensure_open_bank_reconciliation\([\s\S]*?\$\$[\s\S]*?\$\$;/i)?.[0];
 if(!ensure)throw Error('Missing real reconciliation-period function');await db.exec('drop function public.ensure_open_bank_reconciliation(bigint,date)');await db.exec(ensure);
 for(const file of['20260903180000_bank_fees_transaction.sql','20260903190000_fix_bank_fee_options.sql','20260903200000_manage_bank_fees.sql','20261027200000_bank_reconciliation_statement_fees.sql'])await db.exec(await read('../../supabase/migrations/'+file));
 await db.query("insert into role_access_matrix values(1,'banking:bank-fees',true,true,true,true),(2,'banking:bank-fees',true,true,false,false),(3,'banking:bank-fees',true,false,false,false)");
 await applyBankingMigration(db,'20261031121106_secure_bank_fees.sql');
}
