import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {bankReconciliationAction} from '../dist/modules/reports/accounting-reports.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const originalFetch=globalThis.fetch,originalUrl=process.env.SUPABASE_URL,originalKey=process.env.SUPABASE_ANON_KEY;
const origin='https://bulk-unmatch.example.invalid',auth='Bearer synthetic-bulk-unmatch',key='synthetic-public-key';
const preview={p_bank_account_id:17,p_cutoff:'2026-10-31'};
const input={...preview,p_statement_id:71,p_expected_fingerprint:'a'.repeat(64),p_expected_count:3};
let calls;
beforeEach(async()=>{
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;calls=[];invalidateRoleAccessCaches();
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'banking:bank-reconciliations',canView:true,canEdit:true}]});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({success:true,unmatchedCount:3});};
});
afterEach(()=>{globalThis.fetch=originalFetch;invalidateRoleAccessCaches();});
after(()=>{if(originalUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=originalUrl;if(originalKey===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=originalKey;});

test('bulk preview and confirmation forward only the exact server scope and snapshot under the caller identity',async()=>{
 for(const[action,body,name]of[['unmatch-all-preview',preview,'preview_bank_reconciliation_unmatch_all'],['unmatch-all',input,'unmatch_all_bank_reconciliation']]){
  const source=structuredClone(body);await bankReconciliationAction(auth,action,source);assert.deepEqual(source,body);
  const call=calls.at(-1),headers=new Headers(call.init.headers);assert.equal(call.url,origin+'/rest/v1/rpc/'+name);assert.equal(call.init.method,'POST');assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),key);assert.deepEqual(JSON.parse(call.init.body),body);
 }
 assert.equal(calls.length,2);
});

test('bulk actions require edit before validating a body or reaching the provider',async()=>{
 for(const action of['unmatch-all-preview','unmatch-all'])await assert.rejects(bankReconciliationAction('',action,null),error=>error.status===401);
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'banking:bank-reconciliations',canView:true,canEdit:false,canCreate:true,canDelete:true}]});
 for(const action of['unmatch-all-preview','unmatch-all'])await assert.rejects(bankReconciliationAction(auth,action,null),error=>error.status===403);
 assert.equal(calls.length,0);
});

test('bulk preview rejects arbitrary targets, amounts and client-selected match IDs',async()=>{
 for(const body of[null,[],true,{...preview,p_bank_account_id:'17'},{...preview,p_bank_account_id:0},{...preview,p_cutoff:'2026-02-30'},{...preview,p_cutoff:'0000-01-01'},{...preview,p_cutoff:'2026-10-31T00:00:00Z'},{...preview,p_statement_id:39},{...preview,p_match_ids:[1,2]},{...preview,amount:100},{...preview,p_reconciliation_id:71}])await assert.rejects(bankReconciliationAction(auth,'unmatch-all-preview',body),error=>error.status===400);
 assert.equal(calls.length,0);
});

test('bulk confirmation requires a safe exact statement, positive integer count and lowercase SHA256 fingerprint',async()=>{
 for(const patch of[{p_statement_id:0},{p_statement_id:'71'},{p_statement_id:1.5},{p_statement_id:Number.MAX_SAFE_INTEGER+1},{p_expected_count:0},{p_expected_count:1.2},{p_expected_count:2_147_483_648},{p_expected_count:'3'},{p_expected_fingerprint:null},{p_expected_fingerprint:'a'.repeat(32)},{p_expected_fingerprint:'A'.repeat(64)},{p_expected_fingerprint:'g'.repeat(64)},{p_reconciliation_id:71},{p_match_ids:[1,2,3]},{actor:'forged'},{scope:'STATEMENT'}])await assert.rejects(bankReconciliationAction(auth,'unmatch-all',{...input,...patch}),error=>error.status===400);
 assert.equal(calls.length,0);
});

test('stale, protected and permission errors stay fixed and do not disclose SQL or replay a batch',async()=>{
 for(const[code,status,expected]of[['PBU01',400,409],['55000',400,409],['42501',400,403],['PBU01',403,403]]){
  let count=0;globalThis.fetch=async()=>{count++;return Response.json({code,message:'synthetic private SQL detail'},{status});};
  await assert.rejects(bankReconciliationAction(auth,'unmatch-all',input),error=>error.status===expected&&!error.message.includes('private SQL'));assert.equal(count,1);
 }
});

test('preview can report a blocked or empty reconciliation without performing a mutation',async()=>{
 const result={scope:'BANK_STATEMENT',bankAccountId:17,cutoff:'2026-10-31',statementId:71,matchCount:0,canUnmatch:false,blockedReason:'El extracto no tiene punteos para deshacer.'};
 globalThis.fetch=async(url)=>{assert.equal(String(url),origin+'/rest/v1/rpc/preview_bank_reconciliation_unmatch_all');return Response.json(result);};
 assert.deepEqual(await bankReconciliationAction(auth,'unmatch-all-preview',preview),result);
});
