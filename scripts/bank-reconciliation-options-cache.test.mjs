import assert from'node:assert/strict';
import{test,beforeEach,afterEach,after}from'node:test';
import{accountingReportOptions,bankReconciliationAction,invalidateAccountingReportOptionsCache}from'../dist/modules/reports/accounting-reports.service.js';
import{primeRoleAccessCache,invalidateRoleAccessCaches}from'../dist/modules/security-catalogs/role-access-matrix.module.js';

const originalFetch=globalThis.fetch,originalUrl=process.env.SUPABASE_URL,originalKey=process.env.SUPABASE_ANON_KEY;
const origin='https://reconciliation-options-cache.example.invalid',publicKey='synthetic-cache-public';
function bearer(session){return'Bearer header.'+Buffer.from(JSON.stringify({sub:'synthetic-cache-user',session_id:session})).toString('base64url')+'.signature';}
const first=bearer('synthetic-session-a'),second=bearer('synthetic-session-b'),sessions=[first,second];
const grants=['reports:accounting-reports','banking:bank-reconciliations','banking:bank-statements'].map(resourceKey=>({resourceKey,canView:true,canCreate:true,canEdit:true,canDelete:false}));
const requests={
 import:{name:'import_bank_statement',input:{p_bank_account_id:17,p_statement_date:'2026-10-31',p_file_name:'synthetic.csv',p_opening_balance:100,p_closing_balance:105,p_lines:[{date:'2026-10-31',amount:5,reference:'SYN'}]},result:{imported:1}},
 auto:{name:'auto_match_bank_reconciliation',input:{p_bank_account_id:17,p_cutoff:'2026-10-31'},result:2},
 match:{name:'match_bank_transaction',input:{p_bank_tran_id:31,p_statement_line_id:41,p_cutoff:'2026-10-31'},result:true},
 close:{name:'close_bank_reconciliation',input:{p_bank_account_id:17,p_cutoff:'2026-10-31'},result:{id:71,status:'CERRADA',date:'2026-10-31'}}
};
beforeEach(async()=>{
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=publicKey;
 invalidateAccountingReportOptionsCache();invalidateRoleAccessCaches();
 for(const auth of sessions)await primeRoleAccessCache(auth,{isAdmin:false,grants});
});
afterEach(()=>{globalThis.fetch=originalFetch;invalidateAccountingReportOptionsCache();invalidateRoleAccessCaches();});
after(()=>{if(originalUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=originalUrl;if(originalKey===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=originalKey;});
function backend({action='close',fail=false,onOptions}={}){
 let revision=1,status='ABIERTA';const calls=[],reads=new Map();
 const bundle=()=>({bankOptions:{revision,reconciliations:[{id:71,bankAccountId:17,date:'2026-10-31',status}]}});
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)),headers=new Headers(init.headers),auth=headers.get('authorization'),body=JSON.parse(init.body);
  assert.equal(url.origin,origin);assert.equal(init.method,'POST');assert.equal(headers.get('apikey'),publicKey);assert.ok(sessions.includes(auth),'Each read/write keeps the caller JWT');
  calls.push({path:url.pathname,auth,body});
  if(url.pathname==='/rest/v1/rpc/accounting_report_options_bundle'){
   reads.set(auth,(reads.get(auth)??0)+1);assert.deepEqual(body,{});const value=bundle();
   return onOptions?.({auth,value,readCount:reads.get(auth)})??Response.json(value);
  }
  const expected=action==='close-report'?{name:'bank_reconciliation_close_report',input:{p_bank_account_id:17,p_cutoff:'2026-10-31'},result:{status:'CERRADA',report:'synthetic-read-only'}}:requests[action];
  assert.equal(url.pathname,'/rest/v1/rpc/'+expected.name);assert.deepEqual(body,expected.input);assert.equal(auth,first);
  if(fail)return Response.json({code:'55000',message:'Synthetic protected period'},{status:400});
  if(action!=='close-report'){revision++;if(action==='close')status='CERRADA';}
  return Response.json(expected.result);
 };
 return{calls,reads,bundle};
}
async function warm(backend){
 for(const auth of sessions){const value=await accountingReportOptions(auth);assert.equal(value.bankOptions.reconciliations[0].status,'ABIERTA');await accountingReportOptions(auth);assert.equal(backend.reads.get(auth),1,'Options really remain cached before mutation');}
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

test('a successful close replaces hot ABIERTA history with CERRADA for two sessions and preserves RPC result/payload',async()=>{
 const stub=backend();await warm(stub);const input=structuredClone(requests.close.input),result=await bankReconciliationAction(first,'close',input);
 assert.deepEqual(result,requests.close.result);assert.deepEqual(input,requests.close.input);
 for(const auth of sessions){const fresh=await accountingReportOptions(auth);assert.equal(fresh.bankOptions.reconciliations[0].status,'CERRADA');assert.equal(fresh.bankOptions.revision,2);assert.equal(stub.reads.get(auth),2);await accountingReportOptions(auth);assert.equal(stub.reads.get(auth),2,'Fresh options remain cached');}
 assert.equal(stub.calls.filter(call=>call.path.endsWith('/close_bank_reconciliation')).length,1);
});

test('successful import, automatic and manual matching invalidate only after their protected RPC succeeds',async()=>{
 for(const action of['import','auto','match']){
  invalidateAccountingReportOptionsCache();const stub=backend({action});await warm(stub);
  const input=structuredClone(requests[action].input);assert.deepEqual(await bankReconciliationAction(first,action,input),requests[action].result);assert.deepEqual(input,requests[action].input);
  for(const auth of sessions){assert.equal((await accountingReportOptions(auth)).bankOptions.revision,2);assert.equal(stub.reads.get(auth),2);}
 }
});

test('reading a close report preserves hot options for every session',async()=>{
 const stub=backend({action:'close-report'});await warm(stub);
 const input={p_bank_account_id:17,p_cutoff:'2026-10-31'};assert.deepEqual(await bankReconciliationAction(first,'close-report',input),{status:'CERRADA',report:'synthetic-read-only'});
 for(const auth of sessions){assert.equal((await accountingReportOptions(auth)).bankOptions.revision,1);assert.equal(stub.reads.get(auth),1);}
});

test('a rejected close RPC leaves both option caches intact',async()=>{
 const stub=backend({fail:true});await warm(stub);
 await assert.rejects(bankReconciliationAction(first,'close',requests.close.input),error=>error.status===409);
 for(const auth of sessions){assert.equal((await accountingReportOptions(auth)).bankOptions.reconciliations[0].status,'ABIERTA');assert.equal(stub.reads.get(auth),1);}
 assert.equal(stub.calls.filter(call=>call.path.endsWith('/close_bank_reconciliation')).length,1);
});

test('denied mutation cannot reach a provider or invalidate already authorized reads',async()=>{
 const stub=backend();await warm(stub);await primeRoleAccessCache(first,{isAdmin:false,grants:grants.map(grant=>({...grant,canEdit:false}))});
 await assert.rejects(bankReconciliationAction(first,'close',requests.close.input),error=>error.status===403);
 for(const auth of sessions){assert.equal((await accountingReportOptions(auth)).bankOptions.revision,1);assert.equal(stub.reads.get(auth),1);}
 assert.equal(stub.calls.filter(call=>call.path.endsWith('/close_bank_reconciliation')).length,0);
});

test('an older in-flight options read cannot repopulate the cache after close invalidates it',async()=>{
 const started=deferred(),release=deferred();const stub=backend({onOptions:({auth,value,readCount})=>{
  if(auth===first&&readCount===1){started.resolve();return release.promise.then(()=>Response.json(value));}
 }});
 await accountingReportOptions(second);const stale=accountingReportOptions(first);await started.promise;
 try{
  await bankReconciliationAction(first,'close',requests.close.input);
  const freshRead=accountingReportOptions(first);release.resolve();const current=await freshRead;assert.equal(current.bankOptions.reconciliations[0].status,'CERRADA');
 }finally{release.resolve();}
 assert.equal((await stale).bankOptions.reconciliations[0].status,'ABIERTA','The original caller may finish with its pre-close snapshot');
 for(const auth of sessions){assert.equal((await accountingReportOptions(auth)).bankOptions.reconciliations[0].status,'CERRADA');assert.equal(stub.reads.get(auth),2,'Only the new post-close snapshot may remain cached');}
});
