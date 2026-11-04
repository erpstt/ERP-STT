import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {auditCatalogs,listAuditRows,createAuditRow,updateAuditRow,deleteAuditRow} from '../dist/modules/audit-catalogs/audit-catalogs.module.js';
import {auditChangeReportOptions,runAuditChangeReport} from '../dist/modules/reports/audit-change-report.service.js';

const rawGrants=()=>auditCatalogs.map(c=>({resourceKey:'audit:'+c.slug,canView:true,canCreate:true,canEdit:true,canDelete:true}));
const reportGrant={resourceKey:'audit:change-report',canView:true,canCreate:false,canEdit:false,canDelete:false};

test('all raw audit services reject direct reads and writes before any IO, including administrators',async t=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected network');};
 t.after(()=>{globalThis.fetch=original;invalidateRoleAccessCaches();});
 assert.equal(auditCatalogs.length,5);
 for(const c of auditCatalogs){
  const operations=auth=>[()=>listAuditRows(c,auth),()=>createAuditRow(c,auth,{}),()=>updateAuditRow(c,auth,0,{}),()=>deleteAuditRow(c,auth,1)];
  for(const auth of ['', 'Bearer ', 'Basic synthetic', 'Bearer synthetic extra'])for(const fn of operations(auth))await assert.rejects(fn(),e=>e.status===401);
  for(const [role,isAdmin,grants]of [['regional',false,rawGrants()],['admin',true,[]],['report',false,[reportGrant]]]){
   const auth='Bearer p81-direct-'+role;await primeRoleAccessCache(auth,{isAdmin,grants});
   const fns=operations(auth);for(let n=0;n<fns.length;n++)await assert.rejects(fns[n](),e=>e.status===403&&(n===0?e.message.includes('informe'):e.message.includes('inmutables')));
   await assert.rejects(listAuditRows({...c,table:'users',primaryKey:'user_id'},auth),e=>e.status===403);
  }
 }
 assert.equal(calls,0);
});

test('the scoped audit report keeps its independent permission, caller JWT/public key and filters',async t=>{
 const original=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_PUBLISHABLE_KEY'],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.SUPABASE_URL='https://synthetic.invalid';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SUPABASE_PUBLISHABLE_KEY='synthetic-public';
 t.after(()=>{globalThis.fetch=original;for(const [k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}invalidateRoleAccessCaches();});
 const calls=[];globalThis.fetch=async(url,init={})=>{calls.push({path:new URL(url).pathname,auth:new Headers(init.headers).get('authorization'),key:new Headers(init.headers).get('apikey'),body:JSON.parse(init.body)});return new Response(JSON.stringify({synthetic:true}),{status:200});};
 const regional='Bearer p81-regional';await primeRoleAccessCache(regional,{isAdmin:false,grants:rawGrants()});
 for(const fn of [()=>auditChangeReportOptions(regional),()=>runAuditChangeReport(regional,{subsidiaryIds:[1]})])await assert.rejects(fn(),e=>e.status===403);
 assert.equal(calls.length,0,'Raw catalog grants must not become a report grant');
 const authorized='Bearer p81-report';await primeRoleAccessCache(authorized,{isAdmin:false,grants:[reportGrant]});
 const filters={month:'2026-11',subsidiaryIds:[1,2],page:1,pageSize:20};
 assert.deepEqual(await auditChangeReportOptions(authorized),{synthetic:true});
 assert.deepEqual(await runAuditChangeReport(authorized,filters),{synthetic:true});
 assert.deepEqual(calls.map(c=>c.path),['/rest/v1/rpc/audit_change_report_options','/rest/v1/rpc/run_audit_change_report']);
 assert.deepEqual(calls[0].body,{});assert.deepEqual(calls[1].body,{p_filters:filters});
 assert.ok(calls.every(c=>c.auth===authorized&&c.key==='synthetic-public'));
});

test('HTTP raw catalogs stay closed for readers/admins while scoped reports retain their own permission',{timeout:60000},async t=>{
 const calls=[];const access=role=>({isAdmin:role==='admin',grants:role==='report'?[reportGrant]:role==='regional'?rawGrants():[]});
 const upstream=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer p81-http-','')||'denied';
  if(req.url==='/rest/v1/rpc/assert_request_access')return res.end(JSON.stringify({allowed:true,roleAccess:access(role)}));
  if(req.url==='/rest/v1/rpc/my_role_access')return res.end(JSON.stringify(access(role)));
  const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push({path:req.url,method:req.method,auth:req.headers.authorization,key:req.headers.apikey,body});res.end(JSON.stringify({synthetic:true}));
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),SUPABASE_URL:'http://127.0.0.1:'+upstream.address().port,SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_ANON_KEY:'synthetic-public',DISABLE_BACKGROUND_JOBS:'true',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());
 const base='http://127.0.0.1:'+port;let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 for(const c of auditCatalogs)for(const role of ['regional','admin','report'])for(const method of ['GET','POST','PATCH','DELETE']){
  const before=calls.length,path='/api/audit/'+c.slug+(['PATCH','DELETE'].includes(method)?'/0':'');
  const r=await fetch(base+path,{method,headers:{Authorization:'Bearer p81-http-'+role,'X-Device-Token':'synthetic-p81-device-fixture','Content-Type':'application/json'},...(method==='GET'?{}:{body:'{}'})});
  const body=await r.text();assert.equal(r.status,403,[role,method,path,body].join(' '));assert.equal(calls.length,before,'Raw audit data must never reach Supabase');assert.ok(!/PRIVATE_SQL|record_data_json|old_value/.test(body));
 }
 for(const c of auditCatalogs)for(const method of ['GET','POST','PATCH','DELETE']){
  const before=calls.length,r=await fetch(base+'/api/audit/'+c.slug+(['PATCH','DELETE'].includes(method)?'/0':''),{method,...(method==='GET'?{}:{headers:{'Content-Type':'application/json'},body:'{}'})});await r.text();assert.equal(r.status,401);assert.equal(calls.length,before);
 }
 const filters={month:'2026-11',subsidiaryIds:[1],page:1,pageSize:20};
 for(const role of ['regional','report','admin'])for(const [path,method,rpc]of [['/api/v1/reports/audit/changes/options','GET','audit_change_report_options'],['/api/v1/reports/audit/changes','POST','run_audit_change_report']]){
  const before=calls.length,r=await fetch(base+path,{method,headers:{Authorization:'Bearer p81-http-'+role,'X-Device-Token':'synthetic-p81-device-fixture','Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(filters)})});await r.text();
  assert.equal(r.status,role==='regional'?403:200,[role,path].join(' '));assert.equal(calls.length,before+Number(role!=='regional'));
  if(role!=='regional'){const call=calls.at(-1);assert.equal(call.path,'/rest/v1/rpc/'+rpc);assert.equal(call.auth,'Bearer p81-http-'+role);assert.equal(call.key,'synthetic-public');assert.deepEqual(call.body,method==='GET'?{}:{p_filters:filters});}
 }
 assert.equal(calls.length,4);assert.ok(calls.every(c=>['/rest/v1/rpc/audit_change_report_options','/rest/v1/rpc/run_audit_change_report'].includes(c.path)));
});
