import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupGeneralLedgerOriginalCurrency,applyLedgerOriginalCurrencyMigration} from './setup-general-ledger-original-currency.mjs';
export const generalLedgerExportMigration='20261109202937_add_complete_general_ledger_export_snapshot.sql';
const read=name=>readFile(new URL(name,import.meta.url),'utf8');
export async function assumeGeneralLedgerUser(db,{user=1,role=10,sid=1}={}) {
 await db.exec('reset role');
 for(const[key,value]of Object.entries({'fixture.uid':'00000000-0000-0000-0000-00000000000'+user,'fixture.user':user,'fixture.role':role,'fixture.sid':sid}))await db.query('select set_config($1,$2,false)',[key,String(value)]);
 await db.exec('set role authenticated');
}
export async function applyGeneralLedgerExport(db) {
 await db.exec('reset role;begin');
 try{await db.exec((await read('../../supabase/migrations/'+generalLedgerExportMigration)).replace(/\r\n/g,'\n'));await db.exec('commit');}
 catch(error){await db.exec('rollback');delete error.query;throw error;}
}
/** Published function sources, synthetic stored GL rows and the existing isolated
 * report permission harness. No .env, production session or financial RPC. */
export async function setupGeneralLedgerExport({apply=true}={}) {
 const db=new PGlite();try{
  await setupGeneralLedgerOriginalCurrency(db);await applyLedgerOriginalCurrencyMigration(db);
  await db.exec(`
   alter table currencies add column name text;update currencies set name=currency_code;
   create table accounting_books(accounting_book_id bigint primary key,subsidiary_id bigint,book_name text);
   insert into accounting_books values(1,1,'Synthetic primary book'),(10,1,'Synthetic secondary book'),(2,2,'Foreign private book');
   alter table journal add column journal_date date default '2026-09-30',add column journal_type text default 'Asiento de Diario';
   create table bank_account(bank_account_id bigint primary key,subsidiary_id bigint,account_id bigint,currency_id bigint);
   create table bank_transfer(journal_id bigint,transaction_id bigint,subsidiary_id bigint,from_account_id bigint,to_account_id bigint,
    source_amount numeric,source_base_amount numeric,commission_amount numeric,source_base_rate numeric,
    destination_amount numeric,destination_base_amount numeric,destination_base_rate numeric);
   create table bank_transaction(transaction_id bigint,bank_account_id bigint,tran_type text,amount numeric);
   revoke all on schema report_delivery_private from public,anon,authenticated,service_role;
  `);
  await db.exec(await read('./general-ledger-export-current-functions.sql'));
  await db.exec(`revoke all on all functions in schema report_delivery_private from public,anon,authenticated,service_role;
   revoke all on function public.run_accounting_report_before_intercompany_commercial(text,jsonb)from public,anon,authenticated,service_role;
   revoke all on function public.run_accounting_report_before_intercompany_loans(text,jsonb)from public,anon,authenticated,service_role;
   revoke all on function public.run_accounting_report(text,jsonb)from public,anon,authenticated,service_role;
   grant execute on function public.run_accounting_report(text,jsonb)to authenticated;
  `);
  const expected={
   'public.run_accounting_report(text,jsonb)':'49cc0831bffdd2eb2d24728faaa6b816',
   'public.run_accounting_report_before_intercompany_commercial(text,jsonb)':'fa9aa5c18c8993d4bb497b76d3ab4ebd',
   'public.run_accounting_report_before_intercompany_loans(text,jsonb)':'63c4bc948586aa92bddacda13a0ff909',
   'report_delivery_private.run_accounting_report(text,jsonb)':'e3983615e7de9ed565c50ac3d1a7d294',
   'report_delivery_private.run_accounting_report_before_intercompany_commercial(text,jsonb)':'02148d4531886eff25c8caef8ae569d5',
   'report_delivery_private.run_accounting_report_before_intercompany_loans(text,jsonb)':'63c4bc948586aa92bddacda13a0ff909',
   'report_template_private.enter(text,text)':'91fc047935f066b30e29a30452fed82b',
  };
  for(const[signature,hash]of Object.entries(expected))assert.equal((await db.query('select md5(prosrc)hash from pg_proc where oid=$1::regprocedure',[signature])).rows[0]?.hash,hash,signature);
  if(apply)await applyGeneralLedgerExport(db);
  await assumeGeneralLedgerUser(db);return{db,expected};
 }catch(error){await db.close();delete error.query;throw error;}
}
export async function seedGeneralLedgerExportVolume(db,{count=1200,book=1}={}) {
 await db.exec('reset role');
 await db.query(`insert into gl_impact(gl_impact_id,transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id)
 select 10000+n,200,1,1,1,$2,0,5,0,1,'2026-09-30',2 from generate_series(1,$1::int)n`,[count,book]);
}
