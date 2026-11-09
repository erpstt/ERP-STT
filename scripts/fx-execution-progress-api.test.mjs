import '../dist/modules/security-catalogs/role-access-matrix.module.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {primeRoleAccessCache} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {fxRevaluation} from '../dist/modules/accounting-catalogs/fx-revaluation.service.js';

const auth='Bearer synthetic-fx-progress-creator';
const payload={runId:27,fingerprint:'synthetic-fx-snapshot-fingerprint'};
const uncertain=/confirmar la respuesta.*Consulte el estado/;
const privateMessage='PRIVATE SQL table, account, token and user details';
async function fixture(t,respond){
 const originalFetch=globalThis.fetch,previous={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_ANON_KEY:process.env.SUPABASE_ANON_KEY};
 process.env.SUPABASE_URL='http://127.0.0.1:18999';process.env.SUPABASE_ANON_KEY='synthetic-public-fx-key';
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'accounting:fx-revaluation',canView:true,canCreate:true,canEdit:false,canDelete:false}]});
 const calls=[];
 globalThis.fetch=async(input,init)=>{const call={url:new URL(String(input)),method:init.method,headers:new Headers(init.headers),body:JSON.parse(init.body)};calls.push(call);return respond(call);};
 t.after(()=>{globalThis.fetch=originalFetch;for(const[name,value]of Object.entries(previous))if(value===undefined)delete process.env[name];else process.env[name]=value;});
 return calls;
}
test('execution and exact readback retain the caller identity and never substitute privileged credentials',async t=>{
 const posted={run_id:27,status:'CONTABILIZADO',journal_id:900,reversal_journal_id:901};
 const calls=await fixture(t,call=>Response.json(call.url.pathname.endsWith('fx_report')?{runs:[posted]}:posted));
 assert.deepEqual(await fxRevaluation(auth,'execute',payload),posted);
 assert.deepEqual(await fxRevaluation(auth,'report',{runId:27}),{runs:[posted]});
 assert.deepEqual(calls.map(call=>call.url.pathname),['/rest/v1/rpc/fx_execute','/rest/v1/rpc/fx_report']);
 assert.ok(calls.every(call=>call.method==='POST'&&call.headers.get('authorization')===auth&&call.headers.get('apikey')==='synthetic-public-fx-key'));
 assert.deepEqual(calls.map(call=>call.body),[{p_payload:payload},{p_payload:{runId:27}}]);
});
test('unexpected database failures expose only a bounded support code, without raw SQL or private details',async t=>{
 let code='23502';const calls=await fixture(t,()=>Response.json({code,message:privateMessage,details:privateMessage,hint:privateMessage},{status:400}));
 for(code of ['23502','42703','42883','PGRST202'])await assert.rejects(()=>fxRevaluation(auth,'execute',payload),error=>error.status===500&&error.message.includes('FX-'+code)&&!error.message.includes(privateMessage));
 code='PRIVATE SQL ERROR';await assert.rejects(()=>fxRevaluation(auth,'execute',payload),error=>error.status===500&&!error.message.includes('PRIVATE')&&!error.message.includes('Referencia'));
 assert.equal(calls.length,5);
});
test('known permission, stale-preview and field failures remain distinct and sanitized',async t=>{
 let sample;await fixture(t,()=>Response.json({code:sample.code,message:privateMessage},{status:sample.http}));
 for(sample of [{code:'PGRST301',http:401,status:401},{code:'42501',http:400,status:403},{code:'55000',http:400,status:409},{code:'P0001',http:400,status:409},{code:'23505',http:409,status:409},{code:'22023',http:400,status:400}]){
  await assert.rejects(()=>fxRevaluation(auth,'execute',payload),error=>error.status===sample.status&&!error.message.includes(privateMessage));
 }
});
test('malformed or empty successful upstream responses are unconfirmed, never treated as posted',async t=>{
 let body;const calls=await fixture(t,()=>new Response(body,{status:200}));
 for(body of ['<html>'+privateMessage+'</html>','','null','[]','42'])await assert.rejects(()=>fxRevaluation(auth,'execute',payload),error=>error.status===502&&uncertain.test(error.message)&&!error.message.includes(privateMessage));
 assert.equal(calls.length,5,'No execution is retried automatically.');
});
test('transport loss and response-body loss preserve the uncertainty without retrying a write',async t=>{
 let bodyLost=false;const calls=await fixture(t,()=>{
  if(!bodyLost)throw Error(privateMessage);
  return{ok:true,status:200,text:async()=>{throw Error(privateMessage);}};
 });
 await assert.rejects(()=>fxRevaluation(auth,'execute',payload),error=>error.status===503&&uncertain.test(error.message)&&!error.message.includes(privateMessage));
 bodyLost=true;
 await assert.rejects(()=>fxRevaluation(auth,'execute',payload),error=>error.status===503&&uncertain.test(error.message)&&!error.message.includes(privateMessage));
 assert.equal(calls.length,2);
});
test('database cancellation and gateway outages direct recovery toward an exact status lookup',async t=>{
 let sample;const calls=await fixture(t,()=>Response.json({code:sample.code,message:privateMessage},{status:sample.http}));
 for(sample of [{code:'57014',http:500,status:504},{code:'PGRST003',http:504,status:504},{code:'PGRST000',http:503,status:503},{code:'08006',http:500,status:503},{code:'',http:502,status:502}])await assert.rejects(()=>fxRevaluation(auth,'execute',payload),error=>error.status===sample.status&&uncertain.test(error.message)&&!error.message.includes(privateMessage));
 assert.equal(calls.length,5);
});
