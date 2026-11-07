import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {bankReconciliationAction,accountingReportOptions,invalidateAccountingReportOptionsCache} from '../dist/modules/reports/accounting-reports.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const originalFetch=globalThis.fetch,originalUrl=process.env.SUPABASE_URL,originalKey=process.env.SUPABASE_ANON_KEY;
const origin='https://classic-unmatch.example.invalid',auth='Bearer synthetic-classic-unmatch',key='synthetic-public-key';
const input={p_bank_account_id:17,p_cutoff:'2026-11-03',p_match_id:51};
const grants=[{resourceKey:'banking:bank-reconciliations',canView:true,canEdit:true},{resourceKey:'reports:accounting-reports',canView:true}];
let calls;
beforeEach(async()=>{
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;
 calls=[];invalidateRoleAccessCaches();invalidateAccountingReportOptionsCache();
 await primeRoleAccessCache(auth,{isAdmin:false,grants});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({success:true,matchId:51});};
});
afterEach(()=>{globalThis.fetch=originalFetch;invalidateRoleAccessCaches();invalidateAccountingReportOptionsCache();});
after(()=>{if(originalUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=originalUrl;if(originalKey===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=originalKey;});

test('unmatch forwards only the exact owning bank, cutoff and match with caller authorization',async()=>{
 const source=structuredClone(input);assert.deepEqual(await bankReconciliationAction(auth,'unmatch',source),{success:true,matchId:51});
 assert.deepEqual(source,input);assert.equal(calls.length,1);
 const call=calls[0],headers=new Headers(call.init.headers);
 assert.equal(call.url,origin+'/rest/v1/rpc/unmatch_bank_reconciliation');assert.equal(call.init.method,'POST');
 assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),key);assert.deepEqual(JSON.parse(call.init.body),input);
});

test('anonymous and read-only users cannot invoke the provider',async()=>{
 await assert.rejects(bankReconciliationAction('','unmatch',input),error=>error.status===401);
 await primeRoleAccessCache(auth,{isAdmin:false,grants:grants.map(grant=>({...grant,canEdit:false}))});
 await assert.rejects(bankReconciliationAction(auth,'unmatch',input),error=>error.status===403);assert.equal(calls.length,0);
});

test('invalid, unsafe or unexpected identities and dates cannot reach the provider',async()=>{
 for(const body of[null,[],true])await assert.rejects(bankReconciliationAction(auth,'unmatch',body),error=>error.status===400);
 for(const patch of[{p_bank_account_id:0},{p_bank_account_id:'17'},{p_match_id:-1},{p_match_id:1.5},{p_match_id:Number.MAX_SAFE_INTEGER+1},{p_cutoff:'2026-02-30'},{p_cutoff:'0000-01-01'},{p_cutoff:'2026-11-03T00:00:00Z'},{p_cutoff:null},{p_statement_line_id:99},{status:'PENDIENTE'}]){
  await assert.rejects(bankReconciliationAction(auth,'unmatch',{...input,...patch}),error=>error.status===400,JSON.stringify(patch));
 }
 assert.equal(calls.length,0);
});

test('stale match conflicts use a fixed actionable message and never disclose SQL details',async()=>{
 globalThis.fetch=async()=>Response.json({code:'PBU01',message:'synthetic private SQL detail'},{status:400});
 await assert.rejects(bankReconciliationAction(auth,'unmatch',input),error=>{
  assert.equal(error.status,409);assert.match(error.message,/punteo cambió|ya no está disponible/);assert.doesNotMatch(error.message,/private SQL/);return true;
 });
});

test('closed-period and forbidden responses retain protection and safe error messages',async()=>{
 for(const [code,status,expected]of[['55000',400,409],['42501',400,403],['PBU01',403,403]]){
  globalThis.fetch=async()=>Response.json({code,message:'synthetic private SQL detail'},{status});
  await assert.rejects(bankReconciliationAction(auth,'unmatch',input),error=>error.status===expected&&!error.message.includes('private SQL'));
 }
});

test('a rejected unmatch does not invalidate a previously authorized options snapshot',async()=>{
 let reads=0;globalThis.fetch=async(url)=>{
  if(String(url).endsWith('/accounting_report_options_bundle')){reads++;return Response.json({bankOptions:{revision:reads}});}
  return Response.json({code:'PBU01',message:'stale'},{status:400});
 };
 await accountingReportOptions(auth);await assert.rejects(bankReconciliationAction(auth,'unmatch',input),error=>error.status===409);
 assert.deepEqual(await accountingReportOptions(auth),{bankOptions:{revision:1}});assert.equal(reads,1);
});
