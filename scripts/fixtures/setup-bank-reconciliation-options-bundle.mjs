import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setupBankReconciliationEmptyMonthClose,seedEmptyMonthBaseline} from './setup-bank-reconciliation-empty-month-close.mjs';
import {seedBankReconciliationDraft} from './setup-bank-reconciliation-draft-delete.mjs';
import {assumeSecurityUser} from './isolated-bank-statement-security.mjs';
export {assumeSecurityUser,assumeSqlRole,deniedSql} from './isolated-bank-statement-security.mjs';

export const bankReconciliationOptionsBundleMigration='20261109171529_preserve_bank_reconciliation_options_capabilities.sql';
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8').then(source=>source.replace(/\r\n/g,'\n'));
export async function applyBankReconciliationOptionsBundle(db){
 await db.exec('reset role;begin');try{await db.exec(await read(bankReconciliationOptionsBundleMigration));await db.exec('commit');}catch(error){await db.exec('rollback');delete error.query;throw error;}
}
const query=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0]?.d;

/** The actual options bundle, reconstructed unchanged from its original source,
 * C04 private-call rewrite and November report guard. All banking functions,
 * A06/session/device boundaries, source tables, audit and report math are real.
 * The five UNRELATED catalog segments below are deliberately bounded JSON-only
 * stubs. They never supply bankOptions, capabilities or closing evidence.
 */
export async function setupBankReconciliationOptionsBundle({apply=true}={}){
 const fixture=await setupBankReconciliationEmptyMonthClose();const {db}=fixture;
 try{
  await db.exec('reset role');
  const catalogs={
   accounting_report_options:{fixtureCatalog:'bounded-base-options',subsidiaries:[{id:1,name:'Synthetic bundle company',currencyId:1}],currencies:[{id:1,code:'CRC',symbol:'₡'}],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[]},
   income_statement_dimension_links:{fixtureDimensions:'bounded-dimensions'},
   general_journal_options:{fixtureCatalog:'bounded-journal',canReverse:false,modules:[]},
   pending_invoice_control_options:{fixtureCatalog:'bounded-pending-invoices',customers:[]},
   aging_report_options:{fixtureCatalog:'bounded-aging'}
  };
  for(const[name,payload]of Object.entries(catalogs)){
   assert.equal(await query(db,'select to_regprocedure($1)::text d',[name+'()']),null,'Bounded non-banking catalog must not replace a real function');
   const literal=JSON.stringify(payload).replaceAll("'","''");
   await db.exec('create function public.'+name+"()returns jsonb language sql stable set search_path=pg_catalog as $$select '"+literal+"'::jsonb$$;revoke all on function public."+name+'()from public,anon,authenticated,service_role');
  }
  // Preserve the unrelated pending-invoice permission wrapper as published,
  // using its actual three shared authorization helpers rather than a stub.
  await db.exec('create schema asset_posting_private;create schema pending_invoice_private;revoke all on schema asset_posting_private,pending_invoice_private from public,anon,authenticated,service_role');
  const asset=await read('20261031132735_secure_asset_proposals_depreciation.sql'),pending=await read('20261101071436_secure_pending_invoice_operations.sql');
  for(const name of['asset_posting_private.identity','asset_posting_private.access','asset_posting_private.allowed','pending_invoice_private.allowed']){
   const source=name.startsWith('asset_')?asset:pending,escaped=name.replaceAll('.','\\.');const found=source.match(new RegExp('create function '+escaped+'\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;','i'))?.[0];assert.ok(found);await db.exec(found);
  }
  await db.exec('revoke all on function asset_posting_private.identity(),asset_posting_private.access(text,text),asset_posting_private.allowed(text,text),pending_invoice_private.allowed(text,text)from public,anon,authenticated,service_role');
  const original=await read('20261029210000_accounting_report_options_bundle.sql'),source=original.match(/as \$\$([\s\S]*?)\$\$;/i)?.[1];assert.ok(source);
  const needle='public.bank_reconciliation_options()';assert.equal(source.split(needle).length,2);
  const protectedBody=source.replace(needle,"case when reconciliation_private.allowed('reports:accounting-reports','view') then reconciliation_private.bank_reconciliation_options() else '{}'::jsonb end").replace("coalesce(public.pending_invoice_control_options(),'{}'::jsonb)","coalesce(case when pending_invoice_private.allowed('reports:accounting-reports','view')then public.pending_invoice_control_options()else '{}'::jsonb end,'{}'::jsonb)");
  // PostgreSQL trim(text) removes spaces, not the source's leading LF.
  const body="begin perform report_template_private.enter('reports:accounting-reports','view'); return ("+protectedBody.replace(/^ +| +$/g,'').replace(/;\s*$/,'')+');end';
  await db.exec('create or replace function public.accounting_report_options_bundle()returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $bundle$'+body+'$bundle$;revoke all on function public.accounting_report_options_bundle()from public,anon,authenticated,service_role;grant execute on function public.accounting_report_options_bundle()to authenticated');
  assert.equal(await query(db,"select md5(prosrc)d from pg_proc where oid='public.accounting_report_options_bundle()'::regprocedure"),'724724c6cdf49d5ab28e066b53f1d000','Exact deployed bundle before the repair');
  await db.exec("insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed,is_inactive,period_name)values(13,1,'2027-01-01','2027-01-31',false,false,'Synthetic January 2027'),(14,1,'2027-02-01','2027-02-28',false,false,'Synthetic February 2027')");
  await assumeSecurityUser(db);await seedEmptyMonthBaseline(db);await assumeSecurityUser(db);
  // A genuine synthetic close through the existing exact-statement engine.
  const closedId=await query(db,"select public.close_bank_reconciliation(2,'2026-09-30',0)d");
  const openDrafts=[];
  for(const[cutoff,period]of[['2026-10-31',10],['2026-11-30',11],['2026-12-31',12],['2027-01-31',13],['2027-02-28',14]])openDrafts.push(await seedBankReconciliationDraft(db,{bank:2,cutoff,period}));
  const foreign=await seedBankReconciliationDraft(db,{bank:3,cutoff:'2026-11-30',period:21});
  const selection={bankAccountId:2,cutoff:'2026-10-31',reconciliationId:openDrafts[0].reconciliationId,subsidiaryId:1,fiscalPeriodId:10};
  await assumeSecurityUser(db);const beforeAllowed=await query(db,'select public.accounting_report_options_bundle()d');
  if(apply){await applyBankReconciliationOptionsBundle(db);await assumeSecurityUser(db);}
  return{...fixture,catalogs,beforeAllowed,selection,openDrafts,closedId,foreign};
 }catch(error){await db.close();throw error;}
}

/** Shared by API/browser integrations: no caller inserts bankOptions fields.
 * Both before/after bundles and preview/report evidence are returned by real
 * guarded RPCs over this entirely synthetic local database.
 */
export async function generateReconciliationOptionsBundleFixtures(){
 const fixture=await setupBankReconciliationOptionsBundle({apply:false});const {db,selection,beforeAllowed}=fixture;
 try{
  await applyBankReconciliationOptionsBundle(db);await assumeSecurityUser(db);
  const allowed=await query(db,'select public.accounting_report_options_bundle()d');
  const report=await query(db,'select public.run_bank_reconciliation_report($1)d',[{bankAccountId:selection.bankAccountId,dateFrom:'2026-10-01',dateTo:selection.cutoff,bankView:'WORKSPACE',page:1,pageSize:50}]);
  const preview=await query(db,'select public.preview_bank_reconciliation_draft_delete($1,$2,$3)d',[selection.bankAccountId,selection.cutoff,selection.reconciliationId]);
  await assumeSecurityUser(db,1,3);const denied=await query(db,'select public.accounting_report_options_bundle()d');
  return{beforeAllowed,before:beforeAllowed,allowed,denied,report,preview,selection,openReconciliationIds:fixture.openDrafts.map(row=>row.reconciliationId),closedReconciliationId:fixture.closedId};
 }finally{await db.close();}
}
