import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {createServer,request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readdir,realpath,rm} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();

const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixtureBase=join(workspace,'.local-tools');
const reportPermission={resourceKey:'audit:change-report',canView:true,canCreate:false,canEdit:false,canDelete:false};
const rawPermissions=['audit-logs','change-logs','event-logs','activity-logs','deleted-records'].map(slug=>({resourceKey:'audit:'+slug,canView:true,canCreate:false,canEdit:false,canDelete:false}));
const roleAccess=role=>({isAdmin:role==='admin',grants:role==='report'?[reportPermission]:role==='regional'?rawPermissions:[]});
const options={users:[],modules:[],entityTypes:[],months:[{id:'2026-11'}],defaultMonth:'2026-11'};
const filters={month:'2026-11',subsidiaryIds:[1],page:1,pageSize:25};
const calls=[],unexpected=[];
let upstream,child,fixtureDir,port,childEnvironment,diagnostic='';

function localRequest(path,{method='GET',role,body}={}){
 assert.ok(path.startsWith('/'));const data=body===undefined?null:JSON.stringify(body);
 return new Promise((resolveRequest,reject)=>{
  const req=httpRequest({hostname:'127.0.0.1',port,path,method,agent:false,headers:{
   ...(role?{Authorization:'Bearer isolated-audit-'+role,'X-Device-Token':'isolated-audit-device'}:{}),
   ...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})
  }},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolveRequest({status:res.statusCode,text,json:()=>JSON.parse(text)});});});
  req.setTimeout(1500,()=>req.destroy(Error('Isolated loopback request timed out')));req.on('error',reject);req.end(data);
 });
}
async function closeServer(server){if(!server)return;server.closeAllConnections();await new Promise(r=>server.close(r));}
function insideDirectory(root,target){const part=relative(root,target);return Boolean(part)&&part!=='..'&&!part.startsWith('..'+String.fromCharCode(92))&&!part.startsWith('../')&&!isAbsolute(part);}
async function stopChild(){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 child.kill();
 await new Promise(r=>{const timer=setTimeout(r,3000);child.once('exit',()=>{clearTimeout(timer);r();});if(child.exitCode!==null){clearTimeout(timer);r();}});
 assert.ok(child.exitCode!==null||child.signalCode!==null,'The isolated ERP must stop before fixture cleanup');
}
async function removeFixture(){
 if(!fixtureDir)return;
 const base=await realpath(fixtureBase),target=await realpath(fixtureDir);
 if(!insideDirectory(await realpath(workspace),base)||!insideDirectory(base,target)||!basename(target).startsWith('p82-http-fixture-'))throw Error('Refusing cleanup outside the isolated fixture directory');
 await rm(target,{recursive:true,force:true});
}
before(async()=>{
 await mkdir(fixtureBase,{recursive:true});assert.ok(insideDirectory(await realpath(workspace),await realpath(fixtureBase)),'The fixture base must resolve inside the workspace');fixtureDir=await mkdtemp(join(fixtureBase,'p82-http-fixture-'));
 assert.deepEqual(await readdir(fixtureDir),[],'The ERP fixture working directory must start empty');
 upstream=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  const role=req.headers.authorization?.replace('Bearer isolated-audit-','')||'denied';
  if(req.url==='/rest/v1/rpc/assert_request_access')return res.end(JSON.stringify({allowed:true,roleAccess:roleAccess(role)}));
  if(req.url==='/rest/v1/rpc/my_role_access')return res.end(JSON.stringify(roleAccess(role)));
  const chunks=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push({path:req.url,method:req.method,auth:req.headers.authorization,key:req.headers.apikey,body});
  if(req.url==='/rest/v1/rpc/audit_change_report_options')return res.end(JSON.stringify(options));
  if(req.url==='/rest/v1/rpc/run_audit_change_report')return res.end(JSON.stringify({header:{month:body.p_filters.month},summary:{modifiedCount:1,deletedCount:1,totalEvents:2,operationCount:2},rows:[{auditId:'synthetic-1',subsidiaryId:'1'}],total:2}));
  unexpected.push(req.url);res.writeHead(404);res.end(JSON.stringify({code:'SYNTHETIC_UNKNOWN_RPC'}));
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));port=reservation.address().port;await new Promise(r=>reservation.close(r));
 // No inherited application credentials, database variables, NODE_OPTIONS or proxies.
 childEnvironment={};
 for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(process.env[key]!==undefined)childEnvironment[key]=process.env[key];
 Object.assign(childEnvironment,{PORT:String(port),NODE_ENV:'test',SUPABASE_URL:'http://127.0.0.1:'+upstream.address().port,SUPABASE_ANON_KEY:'isolated-public',SUPABASE_PUBLISHABLE_KEY:'isolated-public',DISABLE_BACKGROUND_JOBS:'true',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'});
 child=spawn(process.execPath,[join(workspace,'dist','server.js')],{cwd:fixtureDir,env:childEnvironment,stdio:['ignore','pipe','pipe'],windowsHide:true});
 for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{diagnostic=(diagnostic+data.toString()).slice(-2000);});
 let startupError;child.once('error',error=>{startupError=error;});
 let ready=false;for(let n=0;n<100;n++){if(startupError)throw startupError;if(child.exitCode!==null)break;try{if((await localRequest('/api/health')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'Isolated ERP did not start: '+diagnostic);
});
after(async()=>{try{await stopChild();}finally{try{await closeServer(upstream);}finally{await removeFixture();}}});

test('HTTP audit fixture starts the real router with an empty working directory and an allowlisted environment',()=>{
 assert.equal(childEnvironment.DISABLE_BACKGROUND_JOBS,'true');assert.equal(childEnvironment.SUPABASE_URL,'http://127.0.0.1:'+upstream.address().port);
 assert.equal(childEnvironment.SUPABASE_ANON_KEY,'isolated-public');assert.equal(childEnvironment.SUPABASE_PUBLISHABLE_KEY,'isolated-public');
 const allowed=new Set(['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP','PORT','NODE_ENV','SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_PUBLISHABLE_KEY','DISABLE_BACKGROUND_JOBS','AUTH_REQUEST_ACCESS_CACHE_TTL_MS']);
 assert.ok(Object.keys(childEnvironment).every(key=>allowed.has(key)));
 for(const key of ['SUPABASE_SERVICE_ROLE_KEY','SUPABASE_DB_PASSWORD','PGPASSWORD','ERP_TEST_EMAIL','ERP_TEST_PASSWORD','NODE_OPTIONS','HTTP_PROXY','HTTPS_PROXY'])assert.equal(Object.hasOwn(childEnvironment,key),false);
});

test('scoped audit report routes preserve synthetic identity and filters without login, production data or exports',async()=>{
 for(const role of ['regional','denied','report','admin'])for(const [path,method,rpc]of [
  ['/api/v1/reports/audit/changes/options','GET','audit_change_report_options'],
  ['/api/v1/reports/audit/changes','POST','run_audit_change_report']
 ]){
  const before=calls.length,response=await localRequest(path,{method,role,...(method==='POST'?{body:filters}:{})}),allowed=role==='report'||role==='admin';
  assert.equal(response.status,allowed?200:403,role+' '+path);assert.equal(calls.length,before+Number(allowed));
  if(allowed){const call=calls.at(-1);assert.equal(call.path,'/rest/v1/rpc/'+rpc);assert.equal(call.auth,'Bearer isolated-audit-'+role);assert.equal(call.key,'isolated-public');assert.deepEqual(call.body,method==='GET'?{}:{p_filters:filters});const result=response.json();if(method==='GET'){assert.ok(Array.isArray(result.users));assert.ok(Array.isArray(result.modules));assert.ok(Array.isArray(result.entityTypes));}else{assert.equal(result.header.month,filters.month);assert.ok(Array.isArray(result.rows));assert.equal(result.summary.modifiedCount+result.summary.deletedCount,result.summary.totalEvents);}}
 }
 for(const [path,method]of [['/api/v1/reports/audit/changes/options','GET'],['/api/v1/reports/audit/changes','POST']]){const before=calls.length,r=await localRequest(path,{method,...(method==='POST'?{body:filters}:{})});assert.equal(r.status,401);assert.equal(calls.length,before);}
 assert.equal(calls.length,4);assert.deepEqual(unexpected,[]);assert.ok(calls.every(call=>['/rest/v1/rpc/audit_change_report_options','/rest/v1/rpc/run_audit_change_report'].includes(call.path)));
});
