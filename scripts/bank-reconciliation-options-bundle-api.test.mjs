import assert from'node:assert/strict';
import{test,beforeEach,afterEach,after}from'node:test';
import{accountingReportOptions,invalidateAccountingReportOptionsCache}from'../dist/modules/reports/accounting-reports.service.js';
import{primeRoleAccessCache,invalidateRoleAccessCaches}from'../dist/modules/security-catalogs/role-access-matrix.module.js';
import{setupBankReconciliationOptionsBundle,applyBankReconciliationOptionsBundle,assumeSecurityUser}from'./fixtures/setup-bank-reconciliation-options-bundle.mjs';

const origin='https://bundle-integration.example.invalid',key='synthetic-public',auth='Bearer synthetic-bundle-editor',reader='Bearer synthetic-bundle-reader';
const original={fetch:globalThis.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY};
const grants={isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}]};
beforeEach(async()=>{process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;invalidateRoleAccessCaches();invalidateAccountingReportOptionsCache();for(const token of[auth,reader])await primeRoleAccessCache(token,grants);});
afterEach(()=>{globalThis.fetch=original.fetch;invalidateRoleAccessCaches();invalidateAccountingReportOptionsCache();});
after(()=>{for(const[name,field]of[['SUPABASE_URL','url'],['SUPABASE_ANON_KEY','key']])if(original[field]===undefined)delete process.env[name];else process.env[name]=original[field];});

function bridge(db,token){let reads=0;globalThis.fetch=async(url,init)=>{assert.equal(String(url),origin+'/rest/v1/rpc/accounting_report_options_bundle');assert.equal(init.method,'POST');const headers=new Headers(init.headers);assert.equal(headers.get('Authorization'),token);assert.equal(headers.get('apikey'),key);assert.deepEqual(JSON.parse(init.body),{});reads++;const result=await db.query('select public.accounting_report_options_bundle() bundle');return Response.json(result.rows[0].bundle);};return()=>reads;}

test('the actual Node options loader receives bank capabilities and closing metadata from the real SQL bundle after migration',async t=>{
 const fixture=await setupBankReconciliationOptionsBundle({apply:false});t.after(()=>fixture.db.close());const{db}=fixture;await assumeSecurityUser(db);const reads=bridge(db,auth);
 const before=await accountingReportOptions(auth);assert.equal(before.bankOptions.closingContextVersion,undefined);assert.equal(before.bankOptions.reconciliations.find(r=>r.id===fixture.openDrafts[0].reconciliationId)._actions?.canDeleteDraft,undefined);
 await applyBankReconciliationOptionsBundle(db);await assumeSecurityUser(db);invalidateAccountingReportOptionsCache();const after=await accountingReportOptions(auth);
 assert.equal(after.bankOptions.closingContextVersion,1);for(const row of fixture.openDrafts)assert.equal(after.bankOptions.reconciliations.find(r=>r.id===row.reconciliationId)._actions.canDeleteDraft,true);assert.equal(after.bankOptions.reconciliations.find(r=>r.id===fixture.closedId)._actions.canDeleteDraft,false);
 const nonBank=payload=>Object.fromEntries(Object.entries(payload).filter(([key])=>key!=='bankOptions'));assert.deepEqual(nonBank(after),nonBank(before));assert.deepEqual(after.bankOptions.accounts,before.bankOptions.accounts);
 assert.deepEqual(await accountingReportOptions(auth),after);assert.equal(reads(),2,'Only the invalidated bundle is reloaded; metadata remains intact in the cache');
});

test('the same real bundle keeps deletion unavailable to a role without delete permission through the Node response',async t=>{
 const fixture=await setupBankReconciliationOptionsBundle();t.after(()=>fixture.db.close());await assumeSecurityUser(fixture.db,1,3,1);const reads=bridge(fixture.db,reader),options=await accountingReportOptions(reader);
 assert.equal(options.bankOptions.closingContextVersion,1);assert.ok(options.bankOptions.reconciliations.length>0);for(const row of options.bankOptions.reconciliations)assert.equal(row._actions.canDeleteDraft,false);assert.equal(reads(),1);
});
