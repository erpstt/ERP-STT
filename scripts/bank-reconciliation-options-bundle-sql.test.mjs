import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {setupBankReconciliationOptionsBundle,applyBankReconciliationOptionsBundle,bankReconciliationOptionsBundleMigration,assumeSecurityUser,assumeSqlRole,deniedSql} from './fixtures/setup-bank-reconciliation-options-bundle.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();

let fixture,db,beforeFunctions,beforeTables,beforeAcl,beforePublicOptions,source;
const q=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.d;
const bundle=()=>q('select public.accounting_report_options_bundle()d');
const options=()=>q('select public.bank_reconciliation_options()d');
const inventory=()=>q("select jsonb_agg(jsonb_build_object('id',oid,'signature',oid::regprocedure::text,'owner',proowner,'acl',proacl::text,'config',proconfig,'definer',prosecdef,'volatility',provolatile,'source',prosrc)order by oid)d from pg_proc where pronamespace in('public'::regnamespace,'reconciliation_private'::regnamespace,'report_template_private'::regnamespace,'asset_posting_private'::regnamespace,'pending_invoice_private'::regnamespace)");
const acl=()=>q("select jsonb_agg(jsonb_build_array(oid,relowner,relacl::text,relrowsecurity,relforcerowsecurity)order by oid)d from pg_class where relnamespace='public'::regnamespace and relkind in('r','p')");
async function tableRows(name){assert.match(name,/^[a-z_]+$/);return q('select coalesce(jsonb_agg(to_jsonb(r)order by to_jsonb(r)::text),\'[]\')d from public."'+name+'"r');}
async function allTables(){const names=(await db.query("select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in('r','p')order by c.relname")).rows,result={};for(const{name,relname}of names)result[name||relname]=await tableRows(name||relname);return result;}
async function owner(fn){await db.exec('reset role');const result=await fn();await assumeSecurityUser(db);return result;}
async function tx(t){await db.exec('reset role;begin');t.after(async()=>{try{await db.exec('rollback');}finally{await db.exec('reset role');}});await assumeSecurityUser(db);}
const withoutBank=({bankOptions,...rest})=>rest;

before(async()=>{
 fixture=await setupBankReconciliationOptionsBundle({apply:false});db=fixture.db;
 beforePublicOptions=await options();await db.exec('reset role');beforeFunctions=await inventory();beforeTables=await allTables();beforeAcl=await acl();
 source=(await readFile(new URL('../supabase/migrations/'+bankReconciliationOptionsBundleMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 await applyBankReconciliationOptionsBundle(db);
});
after(()=>db?.close());

test('one exact guarded bundle call changes while all existing OIDs, attributes, non-banking functions, table boundaries and stored rows remain intact',async t=>{
 await tx(t);await db.exec('reset role');const afterFunctions=await inventory();assert.equal(afterFunctions.length,beforeFunctions.length);const byId=new Map(afterFunctions.map(fn=>[fn.id,fn]));
 for(const old of beforeFunctions){const current=byId.get(old.id);assert.ok(current);if(old.signature==='accounting_report_options_bundle()'){
  const {source:oldBody,...oldAttrs}=old,{source:newBody,...newAttrs}=current;assert.deepEqual(newAttrs,oldAttrs);const needle='then reconciliation_private.bank_reconciliation_options()';assert.equal(oldBody.split(needle).length,2);assert.equal(newBody,oldBody.replace(needle,'then public.bank_reconciliation_options()'));
 }else assert.deepEqual(current,old);}
 assert.deepEqual(await acl(),beforeAcl);assert.deepEqual(await allTables(),beforeTables);
 const permissions=(await db.query("select prosecdef,provolatile,proconfig,has_function_privilege('anon',oid,'execute')anon,has_function_privilege('authenticated',oid,'execute')authenticated,has_function_privilege('service_role',oid,'execute')service from pg_proc where oid='public.accounting_report_options_bundle()'::regprocedure")).rows[0];assert.equal(permissions.prosecdef,true);assert.equal(permissions.provolatile,'s');assert.equal(permissions.authenticated,true);assert.equal(permissions.anon,false);assert.equal(permissions.service,false);assert.ok(permissions.proconfig.includes('search_path=pg_catalog, public, pg_temp'));
});

test('the actual pre-fix bundle loses capabilities present in the public wrapper; the repaired bundle preserves that complete guarded result and every other catalog segment',async t=>{
 await tx(t);const before=fixture.beforeAllowed;assert.equal(before.bankOptions.closingContextVersion,undefined);assert.ok(before.bankOptions.reconciliations.every(row=>row._actions===undefined));assert.equal(beforePublicOptions.closingContextVersion,1);assert.equal(beforePublicOptions.reconciliations.find(row=>row.id===fixture.selection.reconciliationId)._actions.canDeleteDraft,true);
 const current=await bundle();assert.deepEqual(current.bankOptions,await options());assert.deepEqual(current.bankOptions,beforePublicOptions);assert.deepEqual(withoutBank(current),withoutBank(before));
 assert.equal(current.fixtureCatalog,'bounded-base-options');assert.equal(current.fixtureDimensions,'bounded-dimensions');assert.equal(current.journalOptions.fixtureCatalog,'bounded-journal');assert.equal(current.pendingInvoiceOptions.fixtureCatalog,'bounded-pending-invoices');assert.equal(current.agingOptions.fixtureCatalog,'bounded-aging');
});

test('five genuine open drafts retain true capabilities, a closed predecessor stays false, reader rows stay false and foreign records remain outside the active subsidiary',async t=>{
 await tx(t);let current=await bundle();const ids=fixture.openDrafts.map(row=>row.reconciliationId).sort((a,b)=>a-b),open=current.bankOptions.reconciliations.filter(row=>row.status==='ABIERTA');assert.deepEqual(open.map(row=>row.id).sort((a,b)=>a-b),ids);assert.ok(open.every(row=>row._actions.canDeleteDraft===true));assert.equal(current.bankOptions.reconciliations.find(row=>row.id===fixture.closedId)._actions.canDeleteDraft,false);assert.ok(current.bankOptions.reconciliations.every(row=>row.id!==fixture.foreign.reconciliationId));
 await assumeSecurityUser(db,1,3);current=await bundle();assert.equal(current.bankOptions.closingContextVersion,1);assert.equal(current.bankOptions.reconciliations.length,6);assert.ok(current.bankOptions.reconciliations.every(row=>row._actions.canDeleteDraft===false));
 await deniedSql(db,'select public.preview_bank_reconciliation_draft_delete($1,$2,$3)',[fixture.selection.bankAccountId,fixture.selection.cutoff,fixture.selection.reconciliationId]);
});

test('the same options RPC carries the closing marker and real no-movement evidence while its selected draft can be previewed without financial changes',async t=>{
 await tx(t);const selected=fixture.selection,current=await bundle();assert.equal(current.bankOptions.closingContextVersion,1);
 const before=await owner(()=>allTables());const report=await q('select public.run_bank_reconciliation_report($1)d',[{bankAccountId:selected.bankAccountId,dateFrom:'2026-10-01',dateTo:selected.cutoff,bankView:'WORKSPACE',page:1,pageSize:50}]);assert.equal(report.reconciliation.status,'ABIERTA');assert.equal(report.closingContext.canClose,true);assert.equal(report.closingContext.mode,'NO_MOVEMENTS');assert.equal(report.closingContext.sourceDate,'2026-09-30');assert.equal(report.closingContext.subsidiaryId,selected.subsidiaryId);assert.equal(report.summary.statementBalance,5399.02);assert.equal(report.summary.bookBalance,5399.02);assert.equal(report.summary.difference,0);
 const preview=await q('select public.preview_bank_reconciliation_draft_delete($1,$2,$3)d',[selected.bankAccountId,selected.cutoff,selected.reconciliationId]);assert.equal(preview.canDelete,true);assert.equal(preview.matchCount,0);assert.equal(preview.reconciliationId,selected.reconciliationId);assert.equal(preview.subsidiaryId,selected.subsidiaryId);assert.match(preview.fingerprint,/^[a-f0-9]{64}$/);assert.deepEqual(await owner(()=>allTables()),before);
});

test('the real report/A06 guards deny anonymous, service, missing report rights and inactive identities; changing the active company never exposes the old company history',async t=>{
 await tx(t);for(const role of['anon','service_role']){await assumeSqlRole(db,role);await deniedSql(db,'select public.accounting_report_options_bundle()');}
 await assumeSecurityUser(db,2,4);await deniedSql(db,'select public.accounting_report_options_bundle()');await assumeSecurityUser(db);
 await deniedSql(db,'select reconciliation_private.annotate_draft_delete_options(\'{}\')');
 await assumeSecurityUser(db,1,1,2);const foreign=await bundle();assert.ok(foreign.bankOptions.accounts.every(row=>row.subsidiaryId===2));assert.deepEqual(foreign.bankOptions.reconciliations.map(row=>row.id),[fixture.foreign.reconciliationId]);
 await assumeSecurityUser(db);await db.exec('reset role;update users set is_active=false where user_id=1;set role authenticated');await deniedSql(db,'select public.accounting_report_options_bundle()');
});

test('a repeated migration rejects source drift before any partial rewrite or row change',async t=>{
 await tx(t);await db.exec('reset role');const before=await inventory(),tables=await allTables();await db.exec('savepoint guard_probe');try{await assert.rejects(()=>db.exec(source),error=>error.code==='P0001');}finally{await db.exec('rollback to savepoint guard_probe;release savepoint guard_probe');}assert.deepEqual(await inventory(),before);assert.deepEqual(await allTables(),tables);
});
