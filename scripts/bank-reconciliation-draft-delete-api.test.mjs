import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {bankReconciliationAction,accountingReportOptions,invalidateAccountingReportOptionsCache} from '../dist/modules/reports/accounting-reports.service.js';
import {bankReconciliationDraftDeleteAction} from '../dist/modules/reports/bank-reconciliation-draft-delete.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const auth='Bearer synthetic-draft-delete',otherAuth='Bearer synthetic-draft-reader',origin='https://draft-delete.example.invalid',key='synthetic-public';
const original={fetch:globalThis.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY};
const preview={p_bank_account_id:17,p_cutoff:'2026-11-03',p_reconciliation_id:9},confirm={...preview,p_expected_fingerprint:'a'.repeat(64)};
const snapshot={reconciliationId:9,bankAccountId:17,cutoff:preview.p_cutoff,fiscalPeriodId:11,subsidiaryId:24,status:'ABIERTA',matchCount:0,canDelete:true,blockedReason:null,fingerprint:confirm.p_expected_fingerprint,bankName:'Synthetic bank',accountNumber:'SYN-USD-17',currencyCode:'USD',periodName:'Synthetic November'};
const deleted={success:true,deleted:true,reconciliationId:9,bankAccountId:17,cutoff:preview.p_cutoff,fiscalPeriodId:11};
const grant=(view=true,remove=true)=>({isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:view,canCreate:false,canEdit:false,canDelete:false},{resourceKey:'banking:bank-reconciliations',canView:true,canCreate:false,canEdit:false,canDelete:remove}]});
let calls,optionReads,mode;
beforeEach(async()=>{
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;calls=[];optionReads=0;mode='ok';invalidateRoleAccessCaches();invalidateAccountingReportOptionsCache();
 await primeRoleAccessCache(auth,grant());await primeRoleAccessCache(otherAuth,grant(true,false));
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});const name=new URL(url).pathname.split('/').at(-1);
  if(name==='accounting_report_options_bundle')return Response.json({version:++optionReads});
  if(name==='preview_bank_reconciliation_draft_delete')return Response.json(snapshot);
  if(mode==='ambiguous')throw Error('PRIVATE transport detail');
  return Response.json(deleted);
 };
});
afterEach(()=>{globalThis.fetch=original.fetch;invalidateRoleAccessCaches();invalidateAccountingReportOptionsCache();});
after(()=>{for(const[name,field]of[['SUPABASE_URL','url'],['SUPABASE_ANON_KEY','key']])if(original[field]===undefined)delete process.env[name];else process.env[name]=original[field];});

test('both draft actions require report view AND banking delete before validating or querying',async()=>{
 for(const action of['draft-delete-preview','draft-delete'])await assert.rejects(bankReconciliationAction('',action,null),e=>e.status===401);
 for(const rights of[grant(false,true),grant(true,false),{isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:true},{resourceKey:'banking:bank-reconciliations',canView:true,canCreate:true,canEdit:true,canDelete:false}]}]){
  await primeRoleAccessCache(auth,rights);for(const action of['draft-delete-preview','draft-delete'])await assert.rejects(bankReconciliationAction(auth,action,null),e=>e.status===403);
 }
 assert.equal(calls.length,0);
});

test('preview and delete forward the exact history row, owner cutoff and proof under the caller identity',async()=>{
 for(const[action,body,rpc,expected]of[['draft-delete-preview',preview,'preview_bank_reconciliation_draft_delete',snapshot],['draft-delete',confirm,'delete_bank_reconciliation_draft',deleted]]){
  const input=structuredClone(body);assert.deepEqual(await bankReconciliationAction(auth,action,input),expected);assert.deepEqual(input,body);
  const call=calls.at(-1),headers=new Headers(call.init.headers);assert.equal(call.url,origin+'/rest/v1/rpc/'+rpc);assert.equal(call.init.method,'POST');assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),key);assert.deepEqual(JSON.parse(call.init.body),body);
 }
 assert.equal(calls.length,2);
});

test('strict own fields, safe numeric IDs, calendar dates and lowercase proof reject forged scope and cascades',async()=>{
 for(const[action,base]of[['draft-delete-preview',preview],['draft-delete',confirm]]){
  const invalid=[null,[],true,Object.create(base),...[{p_bank_account_id:'17'},{p_reconciliation_id:0},{p_reconciliation_id:1.5},{p_reconciliation_id:Number.MAX_SAFE_INTEGER+1},{p_bank_account_id:true},{p_cutoff:'2026-02-30'},{p_cutoff:'0000-01-01'},{p_cutoff:'2026-11-03T00:00:00Z'},{p_cutoff:'03/11/2026'},{p_cutoff:'infinity'},{p_fiscal_period_id:11},{p_subsidiary_id:24},{p_match_ids:[1]},{cascade:true},{actor:'forged'}].map(patch=>({...base,...patch}))];
  if(action==='draft-delete')invalid.push(...[null,'A'.repeat(64),'a'.repeat(63),'g'.repeat(64),false].map(hash=>({...base,p_expected_fingerprint:hash})));
  else invalid.push({...base,p_expected_fingerprint:'a'.repeat(64)});
  for(const input of invalid)await assert.rejects(bankReconciliationAction(auth,action,input),e=>e.status===400);
 }
 assert.equal(calls.length,0);
});

test('stale, permission, validation and server errors are safe and every POST is attempted only once',async()=>{
 for(const[http,code,status]of[[401,'42501',401],[403,'42501',403],[400,'42501',403],[400,'PBD01',409],[400,'55000',409],[409,'40001',409],[503,'55P03',409],[400,'22023',400],[500,'XX000',502]]){
  let attempts=0;globalThis.fetch=async()=>{attempts++;return Response.json({code,message:'PRIVATE SQL/actor detail',details:'PRIVATE row'},{status:http});};
  await assert.rejects(bankReconciliationAction(auth,'draft-delete',confirm),e=>e.status===status&&!/PRIVATE|XX000|PBD01/.test(e.message));assert.equal(attempts,1);
 }
});

test('unknown or contradictory responses never acknowledge a different or nonempty draft; private extras are projected out',async()=>{
 for(const response of[null,[],{}, {...snapshot,reconciliationId:10},{...snapshot,bankAccountId:18},{...snapshot,cutoff:'2026-10-31'},{...snapshot,status:'CERRADA'},{...snapshot,matchCount:1},{...snapshot,fingerprint:'bad'},{...snapshot,blockedReason:'HAS_MATCHES'},{...snapshot,bankName:null}]){
  globalThis.fetch=async()=>Response.json(response);await assert.rejects(bankReconciliationDraftDeleteAction(auth,'preview',preview),e=>e.status===502);
 }
 for(const response of[{...deleted,reconciliationId:10},{...deleted,deleted:false}]){globalThis.fetch=async()=>Response.json(response);await assert.rejects(bankReconciliationDraftDeleteAction(auth,'delete',confirm),e=>e.status===502);}
 globalThis.fetch=async()=>new Response('PRIVATE invalid JSON');await assert.rejects(bankReconciliationDraftDeleteAction(auth,'delete',confirm),e=>e.status===502&&!e.message.includes('PRIVATE'));
 globalThis.fetch=async()=>Response.json({...snapshot,privateDebug:'PRIVATE'});assert.deepEqual(await bankReconciliationDraftDeleteAction(auth,'preview',preview),snapshot);
 globalThis.fetch=async()=>Response.json({...snapshot,status:'CERRADA',matchCount:3,canDelete:false,blockedReason:'NOT_OPEN'});assert.equal((await bankReconciliationDraftDeleteAction(auth,'preview',preview)).canDelete,false);
});

test('successful and ambiguous authorized deletes invalidate every cached history; previews and invalid requests do not',async()=>{
 for(const token of[auth,otherAuth]){await accountingReportOptions(token);await accountingReportOptions(token);}assert.equal(optionReads,2);
 await bankReconciliationAction(auth,'draft-delete-preview',preview);for(const token of[auth,otherAuth])await accountingReportOptions(token);assert.equal(optionReads,2);
 await assert.rejects(bankReconciliationAction(auth,'draft-delete',{...confirm,cascade:true}),e=>e.status===400);await accountingReportOptions(auth);assert.equal(optionReads,2);
 await bankReconciliationAction(auth,'draft-delete',confirm);for(const token of[auth,otherAuth])await accountingReportOptions(token);assert.equal(optionReads,4);
 mode='ambiguous';const before=calls.length;await assert.rejects(bankReconciliationAction(auth,'draft-delete',confirm),e=>e.status===503&&!e.message.includes('PRIVATE'));assert.equal(calls.length,before+1);
 for(const token of[auth,otherAuth])await accountingReportOptions(token);assert.equal(optionReads,6);
});

test('the real HTTP routes preserve the compact envelope and cannot be reached by readers or edit-only roles',{timeout:30000},async t=>{
 globalThis.fetch=original.fetch;const queries=[];
 const stub=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const token=req.headers.authorization||'',allowed=token==='Bearer draft-http-deleter',view=token!=='Bearer draft-http-blind';
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:grant(view,allowed||token==='Bearer draft-http-blind')}));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');queries.push({path:req.url,auth:token,key:req.headers.apikey,body});res.end(JSON.stringify(req.url.endsWith('/preview_bank_reconciliation_draft_delete')?snapshot:deleted));
 });await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{stub.closeAllConnections();stub.close(resolve);}));
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:key,SUPABASE_SERVICE_ROLE_KEY:'synthetic-server',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());
 const server=`http://127.0.0.1:${port}`;let ready=false;for(let n=0;n<100;n++){try{if((await original.fetch(server+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready);
 for(const[action,body,rpc,expected]of[['draft-delete-preview',preview,'preview_bank_reconciliation_draft_delete',snapshot],['draft-delete',confirm,'delete_bank_reconciliation_draft',deleted]]){
  const post=(token,input)=>original.fetch(server+'/api/reports/accounting/bank-reconciliation/'+action,{method:'POST',headers:{...(token?{Authorization:token}:{}),'X-Device-Token':'synthetic-draft-device','Content-Type':'application/json'},body:JSON.stringify(input)});
  const initial=queries.length;for(const[token,status]of[['',401],['Bearer draft-http-reader',403],['Bearer draft-http-editor',403],['Bearer draft-http-blind',403]])assert.equal((await post(token,body)).status,status);assert.equal(queries.length,initial);
  assert.equal((await post('Bearer draft-http-deleter',{...body,cascade:true})).status,400);assert.equal(queries.length,initial);
  const response=await post('Bearer draft-http-deleter',body);assert.equal(response.status,200);assert.deepEqual(await response.json(),{result:expected});assert.deepEqual(queries.at(-1),{path:'/rest/v1/rpc/'+rpc,auth:'Bearer draft-http-deleter',key,body});
 }
});
