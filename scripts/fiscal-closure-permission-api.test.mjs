import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fiscalClosurePermissionOptions,setFiscalClosurePermission} from '../dist/modules/organization-catalogs/fiscal-closure-permission.service.js';
const origin='https://synthetic-fiscal-permission.example.invalid',auth='Bearer synthetic-fiscal-permission',key='synthetic-public-key',revision='a'.repeat(32);
const original={fetch:globalThis.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY};
const dto=(enabled=false)=>({canConfigure:true,enabled,revision,role:{id:1,name:'Synthetic administrator'}});
let calls;
beforeEach(()=>{process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});const p=JSON.parse(init.body);return Response.json(dto(p.p_enabled??false));};});
afterEach(()=>{globalThis.fetch=original.fetch;});
after(()=>{for(const [name,k]of [['SUPABASE_URL','url'],['SUPABASE_ANON_KEY','key']])if(original[k]===undefined)delete process.env[name];else process.env[name]=original[k];});

test('authentication and exact body validation happen before any provider request',async()=>{
 await assert.rejects(fiscalClosurePermissionOptions(''),e=>e.status===401);await assert.rejects(setFiscalClosurePermission('',{}),e=>e.status===401);
 for(const input of [null,[],{},true,{enabled:'true',revision},{enabled:true,revision:'bad'},{enabled:true,revision,roleId:1},{enabled:true,revision,permissionId:35},{enabled:true,revision,actor:'forged'}])await assert.rejects(setFiscalClosurePermission(auth,input),e=>e.status===400);
 assert.equal(calls.length,0);
});
test('only the two dedicated RPCs receive the public key, caller JWT and bounded arguments',async()=>{
 assert.deepEqual(await fiscalClosurePermissionOptions(auth),dto(false));assert.deepEqual(await setFiscalClosurePermission(auth,{enabled:true,revision}),dto(true));
 assert.deepEqual(calls.map(x=>new URL(x.url).pathname),['/rest/v1/rpc/fiscal_closure_permission_options','/rest/v1/rpc/set_fiscal_closure_permission']);
 assert.deepEqual(JSON.parse(calls[0].init.body),{});assert.deepEqual(JSON.parse(calls[1].init.body),{p_enabled:true,p_revision:revision});
 for(const call of calls){const h=new Headers(call.init.headers);assert.equal(h.get('apikey'),key);assert.equal(h.get('Authorization'),auth);assert.equal(call.init.method,'POST');}
});
test('unauthorized capability is minimal and malformed or unconfirmed responses fail closed',async()=>{
 globalThis.fetch=async()=>Response.json({canConfigure:false,role:{id:999,name:'PRIVATE'},revision,enabled:true});assert.deepEqual(await fiscalClosurePermissionOptions(auth),{canConfigure:false});
 for(const response of [null,{},[],{...dto(),revision:'bad'},{...dto(),role:{id:0,name:'PRIVATE'}},{...dto(),enabled:'false'}]){globalThis.fetch=async()=>Response.json(response);await assert.rejects(fiscalClosurePermissionOptions(auth),e=>e.status===502);}
 globalThis.fetch=async()=>Response.json(dto(false));await assert.rejects(setFiscalClosurePermission(auth,{enabled:true,revision}),e=>e.status===502);
});
test('provider denial, stale state and unavailable responses never expose SQL or audit details',async()=>{
 for(const [status,code,expected]of [[401,'42501',401],[403,'42501',403],[400,'55000',409],[400,'22023',400],[500,'XX000',503]]){globalThis.fetch=async()=>Response.json({code,message:'PRIVATE SQL DETAIL',details:'PRIVATE AUDIT'},{status});await assert.rejects(setFiscalClosurePermission(auth,{enabled:true,revision}),e=>e.status===expected&&!/PRIVATE/.test(e.message));}
 globalThis.fetch=async()=>new Response('PRIVATE not JSON',{status:503});await assert.rejects(fiscalClosurePermissionOptions(auth),e=>e.status===502&&!/PRIVATE/.test(e.message));
 globalThis.fetch=async()=>{throw Error('PRIVATE transport detail');};await assert.rejects(setFiscalClosurePermission(auth,{enabled:true,revision}),e=>e.status===503&&!/PRIVATE/.test(e.message));
});
test('Node enables and removes only the legacy non-operational permission through real A06 audited RPCs',async t=>{
 const {setupFiscalClosurePermission,assumeSecurityUser,fiscalPermissionState}=await import('./fixtures/setup-fiscal-closure-permission.mjs');const fixture=await setupFiscalClosurePermission();t.after(()=>fixture.db.close());
 const before=await fixture.db.exec('reset role').then(()=>fiscalPermissionState(fixture.db));await assumeSecurityUser(fixture.db);
 globalThis.fetch=async(url,init)=>{const h=new Headers(init.headers),p=JSON.parse(init.body);assert.equal(h.get('apikey'),key);assert.equal(h.get('Authorization'),auth);const name=new URL(url).pathname.split('/').at(-1);assert.ok(['fiscal_closure_permission_options','set_fiscal_closure_permission'].includes(name));try{const data=name==='fiscal_closure_permission_options'?(await fixture.db.query('select public.fiscal_closure_permission_options()data')).rows[0].data:(await fixture.db.query('select public.set_fiscal_closure_permission($1,$2)data',[p.p_enabled,p.p_revision])).rows[0].data;return Response.json(data);}catch(e){return Response.json({code:e.code,message:e.message},{status:e.code==='42501'?403:400});}};
 const a=await fiscalClosurePermissionOptions(auth);assert.equal(a.enabled,false);const b=await setFiscalClosurePermission(auth,{enabled:true,revision:a.revision});assert.equal(b.enabled,true);assert.equal((await fiscalClosurePermissionOptions(auth)).enabled,true);const c=await setFiscalClosurePermission(auth,{enabled:false,revision:b.revision});assert.equal(c.enabled,false);
 await fixture.db.exec('reset role');const after=await fiscalPermissionState(fixture.db);for(const k of ['matrix','grants','permissions','periods','gl'])assert.deepEqual(after[k],before[k]);assert.equal(after.audit.length,before.audit.length+2);
});
test('HTTP static route rejects target roles, query parameters and other verbs before the protected RPC', {timeout:45000},async t=>{
 globalThis.fetch=original.fetch;let rpcCalls=0;
 const provider=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:true,grants:[]}}));return;}const chunks=[];for await(const x of req)chunks.push(x);const p=JSON.parse(Buffer.concat(chunks).toString()||'{}');rpcCalls++;assert.equal(req.headers.apikey,key);if(req.url==='/rest/v1/rpc/fiscal_closure_permission_options')res.end(JSON.stringify(dto(false)));else if(req.url==='/rest/v1/rpc/set_fiscal_closure_permission'){assert.deepEqual(Object.keys(p).sort(),['p_enabled','p_revision']);res.end(JSON.stringify(dto(p.p_enabled)));}else{res.statusCode=404;res.end('{}');}});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{provider.closeAllConnections();provider.close(r);}));const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${provider.address().port}`,SUPABASE_ANON_KEY:key,SUPABASE_SERVICE_ROLE_KEY:'synthetic-unused',SMTP_ENABLED:'false',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());let ready=false;for(let n=0;n<120;n++){try{if((await original.fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const url=`http://127.0.0.1:${port}/api/organization/fiscal-closure-permission`,headers={Authorization:auth,'X-Device-Token':'synthetic-fiscal-permission-device','Content-Type':'application/json'};
 assert.equal((await original.fetch(url)).status,401);assert.equal((await original.fetch(url+'?roleId=3',{headers})).status,400);assert.equal((await original.fetch(url,{method:'PATCH',headers,body:'{}'})).status,405);
 assert.equal((await original.fetch(url,{method:'POST',headers,body:JSON.stringify({enabled:true,revision,roleId:3})})).status,400);assert.equal(rpcCalls,0);
 const get=await original.fetch(url,{headers});assert.equal(get.status,200);assert.deepEqual(await get.json(),dto(false));const post=await original.fetch(url,{method:'POST',headers,body:JSON.stringify({enabled:true,revision})});assert.equal(post.status,200);assert.deepEqual(await post.json(),dto(true));assert.equal(rpcCalls,2);
});
