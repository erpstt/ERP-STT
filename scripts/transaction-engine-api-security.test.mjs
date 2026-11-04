import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {transactionEngineCatalogs,listTransactionEngineRows,createTransactionEngineRow,updateTransactionEngineRow,deleteTransactionEngineRow} from '../dist/modules/transaction-engine-catalogs/transaction-engine-catalogs.module.js';
test('direct services block every write before IO, including admin, and gate reads',async t=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected network');};t.after(()=>{globalThis.fetch=original;invalidateRoleAccessCaches();});
 for(const isAdmin of [false,true]){const auth='Bearer synthetic-engine-'+isAdmin;await primeRoleAccessCache(auth,{isAdmin,grants:[]});for(const c of transactionEngineCatalogs){for(const fn of [()=>createTransactionEngineRow(c,auth,{}),()=>updateTransactionEngineRow(c,auth,1,{}),()=>deleteTransactionEngineRow(c,auth,1)])await assert.rejects(fn(),e=>e.status===403);if(!isAdmin)await assert.rejects(listTransactionEngineRows(c,auth),e=>e.status===403);}}
 await assert.rejects(listTransactionEngineRows(transactionEngineCatalogs[0],''),e=>e.status===401);await assert.rejects(createTransactionEngineRow(transactionEngineCatalogs[0],'',{}),e=>e.status===401);assert.equal(calls,0);
});
test('HTTP catalogs allow explicit read only, keep user JWT and mask SQL denial',{timeout:60000},async t=>{
 const calls=[];const upstream=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer p78-','')||'denied';
  if(req.url==='/rest/v1/rpc/assert_request_access')return res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:role==='denied'?[]:[{resourceKey:role==='lines'?'transaction-engine:transaction-lines':role==='unrelated'?'inventory:products':'transaction-engine:transactions',canView:true,canCreate:true,canEdit:true,canDelete:true}]}}));
  calls.push({path:req.url,key:req.headers.apikey,auth:req.headers.authorization,method:req.method});if(role==='sql-denied'){res.writeHead(403);return res.end(JSON.stringify({code:'42501',message:'PRIVATE_SQL_DETAIL'}));}res.end(JSON.stringify([{synthetic:true}]));
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_ANON_KEY:'synthetic-public',DISABLE_BACKGROUND_JOBS:'true',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());const base=`http://127.0.0.1:${port}`;let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 for(const slug of ['transactions','transaction-lines'])for(const role of ['denied','unrelated','reader','lines','admin','sql-denied'])for(const method of ['GET','POST','PATCH','DELETE']){
  const before=calls.length;const r=await fetch(base+'/api/transaction-engine/'+slug+(['PATCH','DELETE'].includes(method)?'/1':''),{method,headers:{Authorization:'Bearer p78-'+role,'X-Device-Token':'synthetic-p78-device-token-fixture','Content-Type':'application/json'},...(method==='GET'?{}:{body:'{}'})});const body=await r.text();
  const read=method==='GET'&&(role==='admin'||slug==='transactions'&&['reader','sql-denied'].includes(role)||slug==='transaction-lines'&&role==='lines');assert.equal(r.status,read&&role!=='sql-denied'?200:403,[role,slug,method,body].join(' '));assert.equal(calls.length,before+Number(read));assert.ok(!body.includes('PRIVATE_SQL_DETAIL'));
 }
 assert.ok(calls.every(c=>c.method==='GET'&&c.key==='synthetic-public'&&c.auth.startsWith('Bearer p78-')));
});
