import assert from 'node:assert/strict';
import {sendCatalogPageFixture,catalogPageResponse} from './lib/catalog-page-fixture.mjs';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {aiCatalogs,listAiRows,createAiRow,updateAiRow,deleteAiRow} from '../dist/modules/ai-catalogs/ai-catalogs.module.js';

const payloads={
 'ai-agents':{agent_name:'Synthetic',system_prompt:'Synthetic instructions',model_version:'synthetic-model',is_active:true},
 'ai-prompts':{agent_id:1,prompt_name:'Synthetic',prompt_text:'Synthetic prompt',module_target:'Synthetic'},
 'ai-conversations':{agent_id:1,started_at:'2026-11-03T12:00:00Z'},
 'ai-documents':{document_id:1,extracted_data_json:'{"synthetic":true}',confidence_score:75},
 'ai-predictions':{subsidiary_id:1,prediction_type:'Synthetic',target_entity_id:1,value_predicted:4,confidence:75,execution_date:'2026-11-03'}
};
const grants=()=>aiCatalogs.map(c=>({resourceKey:'ai:'+c.slug,canView:true,canCreate:true,canEdit:true,canDelete:true}));

test('direct IA services require a session and exact resource permissions before validation or IO',async t=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected network');};
 t.after(()=>{globalThis.fetch=original;invalidateRoleAccessCaches();});
 const auth='Bearer p79-direct-denied';
 for(const c of aiCatalogs){
  for(const permissions of [[],[{resourceKey:'inventory:products',canView:true,canCreate:true,canEdit:true,canDelete:true}],[{resourceKey:'ai:'+c.slug,canView:false,canCreate:true,canEdit:true,canDelete:true}]]){
   await primeRoleAccessCache(auth,{isAdmin:false,grants:permissions});
   for(const action of [()=>listAiRows(c,auth),()=>createAiRow(c,auth,{}),()=>updateAiRow(c,auth,1,{}),()=>deleteAiRow(c,auth,1)])await assert.rejects(action(),e=>e.status===403);
  }
  for(const token of ['', 'Bearer ', 'Basic synthetic'])for(const action of [()=>listAiRows(c,token),()=>createAiRow(c,token,{}),()=>updateAiRow(c,token,1,{}),()=>deleteAiRow(c,token,1)])await assert.rejects(action(),e=>e.status===401);
  await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'ai:'+c.slug,canView:true,canCreate:false,canEdit:false,canDelete:false}]});
  for(const action of [()=>createAiRow(c,auth,{}),()=>updateAiRow(c,auth,1,{}),()=>deleteAiRow(c,auth,1)])await assert.rejects(action(),e=>e.status===403);
 }
 await assert.rejects(listAiRows({...aiCatalogs[0],slug:'unrecognized'},auth),e=>e.status===400);
 assert.equal(calls,0);
});

test('explicit non-admin IA CRUD retains user JWT/public key, canonical catalogs and safe DB errors',async t=>{
 const original=globalThis.fetch,env={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_ANON_KEY:process.env.SUPABASE_ANON_KEY};
 process.env.SUPABASE_URL='https://synthetic.invalid';process.env.SUPABASE_ANON_KEY='synthetic-public';
 t.after(()=>{globalThis.fetch=original;for(const [key,value]of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}invalidateRoleAccessCaches();});
 const auth='Bearer p79-explicit-non-admin';await primeRoleAccessCache(auth,{isAdmin:false,grants:grants()});
 const calls=[];globalThis.fetch=async(url,init={})=>{calls.push({path:new URL(url).pathname,method:init.method||'GET',auth:new Headers(init.headers).get('authorization'),key:new Headers(init.headers).get('apikey'),body:init.body});if((init.method||'GET')==='GET'){const key=new URL(url).searchParams.get('order').split('.')[0];return catalogPageResponse([{[key]:1,synthetic:true}]);}return new Response(init.method==='DELETE'?null:JSON.stringify([{synthetic:true}]),{status:init.method==='DELETE'?204:200,headers:{'Content-Type':'application/json'}});};
 for(const c of aiCatalogs){
  assert.deepEqual(await listAiRows(c,auth),[{[c.primaryKey]:1,synthetic:true}]);
  assert.deepEqual(await createAiRow(c,auth,{...payloads[c.slug],user_id:999,private_injected:'must drop'}),{synthetic:true});
  assert.deepEqual(await updateAiRow(c,auth,1,{...payloads[c.slug],user_id:999}),{synthetic:true});
  assert.equal(await deleteAiRow(c,auth,1),null);
 }
 await listAiRows({...aiCatalogs[0],table:'users',primaryKey:'user_id'},auth);
 assert.equal(calls.at(-1).path,'/rest/v1/ai_agents');
 assert.ok(calls.every(c=>c.auth===auth&&c.key==='synthetic-public'));
 assert.ok(calls.filter(c=>c.body).every(c=>!c.body.includes('private_injected')));
 assert.equal(calls.filter(c=>c.path==='/rest/v1/ai_conversation'&&c.body).length,2);
 assert.ok(calls.filter(c=>c.path==='/rest/v1/ai_conversation'&&c.body).every(c=>!Object.hasOwn(JSON.parse(c.body),'user_id')),'Conversation writes must use the database owner default and preserve it on update');
 for(const [status,code,expected]of [[403,'42501',403],[400,'42501',403],[401,'PGRST301',401],[400,'23503',400],[400,'23514',400],[500,'XX000',500]]){
  globalThis.fetch=async()=>new Response(JSON.stringify({code,message:'PRIVATE_SQL_DETAILS',details:'PRIVATE_SCHEMA'}),{status});
  await assert.rejects(createAiRow(aiCatalogs[0],auth,payloads['ai-agents']),e=>e.status===expected&&!/PRIVATE_SQL|PRIVATE_SCHEMA/.test(e.message));
 }
 globalThis.fetch=async()=>new Response('PRIVATE_NON_JSON_SQL',{status:403});
 await assert.rejects(createAiRow(aiCatalogs[0],auth,payloads['ai-agents']),e=>e.status===403&&!e.message.includes('PRIVATE'));
 globalThis.fetch=async()=>new Response(JSON.stringify({message:'PRIVATE_ROLE_LOOKUP_SQL'}),{status:403});
 await assert.rejects(listAiRows(aiCatalogs[0],'Bearer p79-role-lookup-denied'),e=>e.status===403&&!e.message.includes('PRIVATE'),'Permission lookup failures must be safe too');
});

test('HTTP IA action matrix gates all five catalogs and masks SQL denial without privileged keys',{timeout:90000},async t=>{
 const calls=[];let resource='ai:ai-agents';
 const upstream=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.split('-').at(-1)||'denied';
  if(req.url==='/rest/v1/rpc/assert_request_access')return res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:role==='denied'?[]:[{resourceKey:role==='unrelated'?'inventory:products':resource,canView:role!=='blind',canCreate:role==='creator'||role==='blind',canEdit:role==='editor'||role==='blind',canDelete:role==='deleter'||role==='blind'}]}}));
  const chunks=[];for await(const c of req)chunks.push(c);
  calls.push({path:req.url,method:req.method,auth:req.headers.authorization,key:req.headers.apikey,body:Buffer.concat(chunks).toString()});
  if(role==='sqlDenied'){res.writeHead(403);return res.end(JSON.stringify({code:'42501',message:'PRIVATE_SQL_DETAILS'}));}
  if(req.method==='DELETE'){res.writeHead(204);return res.end();}
  if(sendCatalogPageFixture(req,res))return;return res.end(JSON.stringify([{synthetic:true}]));
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_ANON_KEY:'synthetic-public',DISABLE_BACKGROUND_JOBS:'true',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());
 const base=`http://127.0.0.1:${port}`;let ready=false;
 for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 for(const c of aiCatalogs){
  resource='ai:'+c.slug;const path='/api/ai/'+c.slug;
  for(const role of ['denied','unrelated','blind','reader','creator','editor','deleter','admin','sqlDenied'])for(const method of ['GET','POST','PATCH','DELETE']){
   const before=calls.length;const r=await fetch(base+path+(['PATCH','DELETE'].includes(method)?'/1':''),{method,headers:{Authorization:'Bearer p79-'+c.slug+'-'+role,'X-Device-Token':'synthetic-p79-device-token-fixture','Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(payloads[c.slug])})});const body=await r.text();
   const allowed=role==='admin'||!['denied','unrelated','blind'].includes(role)&&(method==='GET'||method==={creator:'POST',editor:'PATCH',deleter:'DELETE'}[role]);
   assert.equal(r.status,allowed?(role==='sqlDenied'?403:method==='POST'?201:200):403,[c.slug,role,method,body].join(' '));
   assert.equal(calls.length,before+Number(allowed));assert.ok(!body.includes('PRIVATE_SQL_DETAILS'));
  }
  for(const method of ['GET','POST','PATCH','DELETE']){
   const before=calls.length;const r=await fetch(base+path+(['PATCH','DELETE'].includes(method)?'/1':''),{method,...(method==='GET'?{}:{headers:{'Content-Type':'application/json'},body:'{}'})});await r.text();assert.equal(r.status,401);assert.equal(calls.length,before);
  }
 }
 assert.ok(calls.length>30);assert.ok(calls.every(c=>c.key==='synthetic-public'&&c.auth.startsWith('Bearer p79-')));assert.ok(calls.every(c=>!c.path.includes('/rpc/')));
});
