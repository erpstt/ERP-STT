import assert from 'node:assert/strict';
import {sendCatalogPageFixture,catalogPageResponse} from './lib/catalog-page-fixture.mjs';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {purchasingCatalogs,listPurchasingRows,createPurchasingRow,updatePurchasingRow,deletePurchasingRow} from '../dist/modules/purchasing-catalogs/purchasing-catalogs.module.js';
import {savePurchaseDocument} from '../dist/modules/purchasing-catalogs/purchase-workflow.service.js';
const catalogs=purchasingCatalogs.filter(c=>['requisitions','quotes'].includes(c.slug));
const grants=resource=>[{resourceKey:resource,canView:true,canCreate:true,canEdit:true,canDelete:true}];

test('legacy purchase services gate independent reads and reject all direct writes before IO even for admin',async t=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected network');};t.after(()=>{globalThis.fetch=original;invalidateRoleAccessCaches();});
 for(const c of catalogs){
  for(const token of ['', 'Bearer ', 'Basic synthetic'])for(const fn of [()=>listPurchasingRows(c,token),()=>createPurchasingRow(c,token,{}),()=>updatePurchasingRow(c,token,1,{}),()=>deletePurchasingRow(c,token,1)])await assert.rejects(fn(),e=>e.status===401);
  for(const permission of [[],grants('inventory:products'),[{resourceKey:'purchasing:'+c.slug,canView:false,canCreate:true,canEdit:true,canDelete:true}]]){
   const auth='Bearer p80-denied';await primeRoleAccessCache(auth,{isAdmin:false,grants:permission});await assert.rejects(listPurchasingRows(c,auth),e=>e.status===403);
  }
  for(const isAdmin of [false,true]){
   const auth='Bearer p80-write-'+isAdmin;await primeRoleAccessCache(auth,{isAdmin,grants:grants('purchasing:'+c.slug)});
   for(const fn of [()=>createPurchasingRow(c,auth,{}),()=>updatePurchasingRow(c,auth,0,{}),()=>deletePurchasingRow(c,auth,1)])await assert.rejects(fn(),e=>e.status===403&&e.message.includes('formulario'));
  }
 }
 assert.equal(calls,0);
});

test('legacy purchase reads keep caller JWT/public key, canonical catalog and safe SQL failures',async t=>{
 const original=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_PUBLISHABLE_KEY'],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.SUPABASE_URL='https://synthetic.invalid';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SUPABASE_PUBLISHABLE_KEY='synthetic-public';
 t.after(()=>{globalThis.fetch=original;for(const [k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}invalidateRoleAccessCaches();});
 const calls=[],auth='Bearer p80-reader';await primeRoleAccessCache(auth,{isAdmin:false,grants:catalogs.flatMap(c=>grants('purchasing:'+c.slug))});
 globalThis.fetch=async(url,init={})=>{calls.push({url:new URL(url),auth:new Headers(init.headers).get('authorization'),key:new Headers(init.headers).get('apikey'),method:init.method||'GET'});const key=new URL(url).searchParams.get('order').split('.')[0];return catalogPageResponse([{[key]:1,synthetic:true}]);};
 for(const c of catalogs){assert.deepEqual(await listPurchasingRows({...c,table:'users',primaryKey:'user_id'},auth),[{[c.primaryKey]:1,synthetic:true}]);assert.equal(calls.at(-1).url.pathname,'/rest/v1/'+c.table);assert.equal(calls.at(-1).url.searchParams.get('order'),c.primaryKey+'.asc');}
 assert.ok(calls.every(c=>c.auth===auth&&c.key==='synthetic-public'&&c.method==='GET'));
 for(const [status,code,expected]of [[403,'42501',403],[400,'42501',403],[401,'PGRST301',401],[400,'23503',400],[400,'23514',400],[500,'XX000',500]]){
  globalThis.fetch=async()=>new Response(JSON.stringify({code,message:'PRIVATE_SQL_DETAILS',details:'PRIVATE_SCHEMA'}),{status});
  await assert.rejects(listPurchasingRows(catalogs[0],auth),e=>e.status===expected&&!/PRIVATE_SQL|PRIVATE_SCHEMA/.test(e.message));
 }
 globalThis.fetch=async()=>new Response('PRIVATE_NON_JSON_SQL',{status:403});await assert.rejects(listPurchasingRows(catalogs[0],auth),e=>e.status===403&&!e.message.includes('PRIVATE'));
 globalThis.fetch=async()=>new Response(JSON.stringify({message:'PRIVATE_ROLE_LOOKUP_SQL'}),{status:403});await assert.rejects(listPurchasingRows(catalogs[0],'Bearer p80-uncached'),e=>e.status===403&&!e.message.includes('PRIVATE'));
});

test('real purchase workflow still sends authorized requisition and quote create/edit operations to its existing RPC',async t=>{
 const original=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_PUBLISHABLE_KEY'],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.SUPABASE_URL='https://synthetic.invalid';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SUPABASE_PUBLISHABLE_KEY='synthetic-public';
 t.after(()=>{globalThis.fetch=original;for(const [k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}invalidateRoleAccessCaches();});
 const calls=[];globalThis.fetch=async(url,init={})=>{calls.push({path:new URL(url).pathname,auth:new Headers(init.headers).get('authorization'),key:new Headers(init.headers).get('apikey'),body:JSON.parse(init.body)});return new Response(JSON.stringify({synthetic:true}),{status:200});};
 for(const [kind,slug]of [['REQUISITION','requisitions'],['QUOTE','quotes']])for(const action of ['create','edit']){
  const auth='Bearer p80-workflow-'+kind+'-'+action;await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'purchasing:'+slug,canView:true,canCreate:action==='create',canEdit:action==='edit',canDelete:false}]});
  assert.deepEqual(await savePurchaseDocument(auth,{type:kind},action==='edit'?0:undefined),{synthetic:true});
  const call=calls.at(-1);assert.equal(call.path,'/rest/v1/rpc/save_purchase_document');assert.equal(call.body.p_payload.type,kind);assert.equal(call.body.p_document_id,action==='edit'?0:null);assert.equal(call.auth,auth);assert.equal(call.key,'synthetic-public');
 }
 assert.equal(calls.length,4);
});

test('HTTP legacy purchases allow only explicit reads and preserve the caller identity without SQL leakage',{timeout:60000},async t=>{
 const calls=[];const upstream=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer p80-http-','')||'denied';
  if(req.url==='/rest/v1/rpc/assert_request_access')return res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:role==='denied'?[]:[{resourceKey:role==='quote'?'purchasing:quotes':role==='unrelated'?'inventory:products':'purchasing:requisitions',canView:role!=='blind',canCreate:true,canEdit:true,canDelete:true}]}}));
  calls.push({path:req.url,key:req.headers.apikey,auth:req.headers.authorization,method:req.method});if(role==='sqlDenied'){res.writeHead(403);return res.end(JSON.stringify({code:'42501',message:'PRIVATE_SQL_DETAILS'}));}if(sendCatalogPageFixture(req,res))return;res.end(JSON.stringify([{synthetic:true}]));
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),SUPABASE_URL:'http://127.0.0.1:'+upstream.address().port,SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_ANON_KEY:'synthetic-public',DISABLE_BACKGROUND_JOBS:'true',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());
 const base='http://127.0.0.1:'+port;let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 for(const c of catalogs){
  for(const role of ['denied','unrelated','blind','reader','quote','admin','sqlDenied'])for(const method of ['GET','POST','PATCH','DELETE']){
   const before=calls.length;const r=await fetch(base+'/api/purchasing/'+c.slug+(['PATCH','DELETE'].includes(method)?'/1':''),{method,headers:{Authorization:'Bearer p80-http-'+role,'X-Device-Token':'synthetic-p80-device-token-fixture','Content-Type':'application/json'},...(method==='GET'?{}:{body:'{}'})});const body=await r.text();
   const read=method==='GET'&&(role==='admin'||c.slug==='requisitions'&&['reader','sqlDenied'].includes(role)||c.slug==='quotes'&&role==='quote');
   assert.equal(r.status,read&&role!=='sqlDenied'?200:403,[c.slug,role,method,body].join(' '));assert.equal(calls.length,before+Number(read));assert.ok(!body.includes('PRIVATE_SQL_DETAILS'));
  }
  for(const method of ['GET','POST','PATCH','DELETE']){const before=calls.length;const r=await fetch(base+'/api/purchasing/'+c.slug+(['PATCH','DELETE'].includes(method)?'/1':''),{method,...(method==='GET'?{}:{headers:{'Content-Type':'application/json'},body:'{}'})});await r.text();assert.equal(r.status,401);assert.equal(calls.length,before);}
 }
 assert.ok(calls.every(c=>c.method==='GET'&&c.key==='synthetic-public'&&c.auth.startsWith('Bearer p80-http-')));assert.ok(calls.every(c=>!c.path.includes('/rpc/')));
});
