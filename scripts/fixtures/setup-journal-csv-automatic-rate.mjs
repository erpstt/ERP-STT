import{readFile}from'node:fs/promises';
import{setupCheckCsvAutomaticRate,applyCheckCsvAutomaticRate}from'./setup-check-csv-automatic-rate.mjs';
const read=p=>readFile(new URL(p,import.meta.url),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
export const depositCsvAutomaticRateMigration='20261107014639_automate_deposit_csv_exchange_rates.sql';
export const journalCsvAutomaticRateMigration='20261107014747_automate_journal_csv_exchange_rates.sql';
export async function applyCsvRateMigration(db,name){await db.exec('begin');try{await db.exec(await read('../../supabase/migrations/'+name));await db.exec('commit');}catch(e){await db.exec('rollback');delete e.query;throw e;}}
export async function setupJournalCsvAutomaticRate(db){
 await setupCheckCsvAutomaticRate(db);await applyCheckCsvAutomaticRate(db);
 // Canonicalize published function sources on Windows clones, preserving the
 // strict production source guards. This never changes production SQL.
 for(const signature of['public.import_journal_csv_before_automatic_service_month(jsonb,boolean,bigint)','public.import_journal_csv_before_lookup_cache(jsonb,boolean,bigint)','journal_entry_private.import_journal_csv(jsonb,boolean,bigint)','public.import_journal_csv(jsonb,boolean,bigint)']){
  const source=(await db.query('select pg_get_functiondef($1::regprocedure)definition',[signature])).rows[0].definition;
  await db.exec(source.replace(/\r\n/g,'\n'));
 }
 await db.exec("insert into role_access_matrix values(1,'accounting:journals',true,true,true,true),(2,'accounting:journals',true,true,false,false),(3,'accounting:journals',true,false,false,false)");
}
export const applyDepositCsvAutomaticRate=db=>applyCsvRateMigration(db,depositCsvAutomaticRateMigration);
export const applyJournalCsvAutomaticRate=db=>applyCsvRateMigration(db,journalCsvAutomaticRateMigration);
