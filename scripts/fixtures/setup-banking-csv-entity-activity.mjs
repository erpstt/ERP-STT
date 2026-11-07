import {readFile} from 'node:fs/promises';
import {setupCheckCsvAutomaticRate,applyCheckCsvAutomaticRate} from './setup-check-csv-automatic-rate.mjs';
export const bankingCsvEntityActivityMigration='20261107005440_fix_banking_csv_optional_entity_activity.sql';
export const bankingCsvEntityActivitySql=()=>readFile(new URL('../../supabase/migrations/'+bankingCsvEntityActivityMigration,import.meta.url),'utf8').then(sql=>sql.replace(/\r\n/g,'\n'));

// Synthetic PGlite only. Published customer/supplier masters have no inactive
// column; the shared historical fixture otherwise invents one for both tables.
export async function setupBankingCsvEntityActivity(db){
 await setupCheckCsvAutomaticRate(db);await applyCheckCsvAutomaticRate(db);
 await db.exec('alter table public.customers drop column is_inactive;alter table public.suppliers drop column is_inactive');
}
export async function applyBankingCsvEntityActivity(db){
 await db.exec('begin');try{await db.exec(await bankingCsvEntityActivitySql());await db.exec('commit');}catch(error){await db.exec('rollback');delete error.query;throw error;}
}
