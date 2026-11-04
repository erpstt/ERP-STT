import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const {genericRouteAction}=await import('../dist/core/security/generic-route-action.js');
const {createHash}=await import('node:crypto');
const {createServer,request:httpRequest}=await import('node:http');
const {spawn}=await import('node:child_process');
const {lstat,mkdir,mkdtemp,readdir,readFile,realpath,rmdir,unlink,writeFile}=await import('node:fs/promises');
const {basename,dirname,isAbsolute,join,relative,resolve,sep}=await import('node:path');
const {fileURLToPath,pathToFileURL}=await import('node:url');
const {EventEmitter}=await import('node:events');

// Real router, request/session/device and role gates. Only upstream RPC responses
// are simulated. This verifies HTTP dispatch, not PostgreSQL business acceptance.
const workspace=await realpath(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const namedBase=join(workspace,'.local-tools'),prefix='p163-method-http-';
const publicKey='p163-synthetic-public-key',device='p163-synthetic-device-with-enough-entropy';
const providerCanary='P163_SYNTHETIC_PRIVATE_PROVIDER_CONTEXT';
const assetName='p163-synthetic.txt',assetBody='SYNTHETIC STATIC HEAD CONTRACT\n';
const roles=['reader','creator','editor','deleter','no-view','denied','other','admin','uncached','invalid-session'];
const resources=['core:currencies','purchasing:supplier-payments','sales:customer-payments','security:user-subsidiaries','sales:quotations','banking:bank-checks'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const tokens=new Map(roles.map((role,index)=>[role,'synthetic.'+encode({sub:'11111111-1111-4111-8111-111111111111',session_id:'22222222-2222-4222-8222-'+String(index+1).padStart(12,'0'),exp:Math.floor(Date.now()/1000)+900,fixtureRole:role})+'.synthetic']));
const claims=new Map([...tokens].map(([role,token])=>['Bearer '+token,role]));
function roleAccess(role){
 const keys=role==='other'?['tax:tax-calendar']:role==='denied'?[]:resources;
 return{isAdmin:role==='admin',grants:keys.map(resourceKey=>({resourceKey,canView:role!=='no-view',canCreate:role==='creator'||role==='no-view',canEdit:role==='editor'||role==='uncached'||role==='no-view',canDelete:role==='deleter'||role==='no-view'}))};
}
function can(role,resource,action){const data=roleAccess(role);return data.isAdmin||data.grants.some(grant=>grant.resourceKey===resource&&grant.canView&&grant['can'+action[0].toUpperCase()+action.slice(1)]);}
let child,childState,upstream,directory,base,port,childEnv,stdout='',stderr='',guardAttempted=false,outputLeaked=false;
const calls=[],business=[],unexpected=[];
function inside(parent,target){const part=relative(parent,target);return part!==''&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);}
function observeChild(process){const state={closed:false,failed:false};state.completion=new Promise(done=>{process.once('close',()=>{state.closed=true;done();});process.once('error',()=>{state.failed=true;});});return state;}
function captureOutput(previous,chunk){const combined=previous+chunk.toString();return{text:combined.slice(-32000),blocked:combined.includes('P163_BLOCKED:'),leaked:[...tokens.values(),publicKey,providerCanary].some(token=>combined.includes(token))};}
async function listen(server){await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);done();});});}
async function close(server){if(!server)return;server.closeAllConnections();if(server.listening)await new Promise(done=>server.close(done));}
function request(path,{method='GET',role='reader',payload,raw,deviceToken=device}={}){
 const bytes=raw!==undefined?Buffer.from(raw):payload===undefined?null:Buffer.from(JSON.stringify(payload));
 return new Promise((done,reject)=>{
  const req=httpRequest({hostname:'127.0.0.1',port,path,method,agent:false,headers:{...(role?{Authorization:'Bearer '+tokens.get(role),...(deviceToken?{'X-Device-Token':deviceToken}:{})}:{}),...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},response=>{
   const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>{const buffer=Buffer.concat(chunks);done({status:response.statusCode,headers:response.headers,buffer,json:()=>JSON.parse(buffer.toString('utf8'))});});
  });req.setTimeout(5000,()=>req.destroy(Error('Synthetic method-test request timed out')));req.on('error',reject);req.end(bytes);
 });
}
async function waitClosed(timeout){return Promise.race([childState.completion.then(()=>true),new Promise(done=>{const timer=setTimeout(()=>done(false),timeout);childState.completion.then(()=>clearTimeout(timer));})]);}
async function stop(){if(!child||childState.closed)return;child.kill();if(!await waitClosed(3000)){child.kill('SIGKILL');assert.ok(await waitClosed(3000),'The router must close before fixture cleanup');}}
async function verifySnapshot(){
 assert.equal(await realpath(workspace),workspace);assert.equal(await realpath(namedBase),base);
 const entry=await lstat(directory),target=await realpath(directory);assert.ok(entry.isDirectory()&&!entry.isSymbolicLink());assert.equal(target,directory);assert.ok(inside(workspace,target)&&inside(base,target)&&basename(target).startsWith(prefix));
 assert.deepEqual(await readdir(target),['public']);const publicPath=join(target,'public'),publicEntry=await lstat(publicPath);assert.ok(publicEntry.isDirectory()&&!publicEntry.isSymbolicLink());assert.equal(await realpath(publicPath),publicPath);assert.ok(inside(target,publicPath));assert.deepEqual(await readdir(publicPath),[assetName]);
 const file=join(publicPath,assetName),fileEntry=await lstat(file);assert.ok(fileEntry.isFile()&&!fileEntry.isSymbolicLink());assert.equal(await realpath(file),file);assert.ok(inside(publicPath,file));assert.equal(await readFile(file,'utf8'),assetBody);
 return{file,publicPath,target};
}
async function cleanup(){if(!directory)return;assert.ok(!child||childState?.closed,'Keep the snapshot until child close is confirmed');const{file,publicPath,target}=await verifySnapshot();await unlink(file);await rmdir(publicPath);await rmdir(target);}
before(async()=>{
 try{const entry=await lstat(namedBase);assert.ok(entry.isDirectory()&&!entry.isSymbolicLink());}catch(error){if(error.code!=='ENOENT')throw error;await mkdir(namedBase);}
 base=await realpath(namedBase);assert.equal(base,namedBase);assert.ok(inside(workspace,base));
 const created=await mkdtemp(join(base,prefix));directory=await realpath(created);assert.equal(created,directory);assert.ok(inside(base,directory)&&inside(workspace,directory));assert.deepEqual(await readdir(directory),[]);
 await mkdir(join(directory,'public'));await writeFile(join(directory,'public',assetName),assetBody,{flag:'wx'});await verifySnapshot();
 upstream=createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);assert.equal(req.method,'POST');const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
   const role=claims.get(req.headers.authorization);assert.ok(role,'Only synthetic fixture JWTs are accepted');assert.ok(req.headers.apikey===publicKey,'Only the synthetic public key may be forwarded');
   calls.push({path:req.url,role,body});res.setHeader('Content-Type','application/json');
   if(req.url==='/rest/v1/rpc/assert_request_access'){
    assert.deepEqual(body,{p_session_token_hash:hash(tokens.get(role)),p_device_token_hash:hash(device)});
    res.end(JSON.stringify(role==='invalid-session'?{allowed:false,reason:'SESSION_INVALID'}:{allowed:true,...(role==='uncached'?{}:{roleAccess:roleAccess(role)})}));return;
   }
   if(req.url==='/rest/v1/rpc/security_my_role_access'){res.end(JSON.stringify(roleAccess(role)));return;}
   const name=req.url.replace('/rest/v1/rpc/','');let resource,action;
   if(['core_dictionary_catalog','save_core_dictionary','delete_core_dictionary'].includes(name)){assert.equal(body.p_catalog,'currencies');resource='core:currencies';action=name==='core_dictionary_catalog'?'view':name==='delete_core_dictionary'?'delete':body.p_id===null?'create':'edit';}
   else if(['save_supplier_payment_with_advances','delete_supplier_payment'].includes(name)){resource='purchasing:supplier-payments';action=name==='delete_supplier_payment'?'delete':body.p_payment_id===null?'create':'edit';}
   else if(['save_customer_payment_with_advances','delete_customer_payment'].includes(name)){resource='sales:customer-payments';action=name==='delete_customer_payment'?'delete':body.p_payment_id===null?'create':'edit';}
   else if(name==='security_save_access_master'){assert.equal(body.p_catalog,'user-subsidiaries');resource='security:user-subsidiaries';action='edit';}
   else if(name==='save_sales_document'){assert.equal(body.p_payload.type,'QUOTE');resource='sales:quotations';action=body.p_document_id===null?'create':'edit';}
   else if(name==='save_bank_check_transfer'){resource='banking:bank-checks';action=body.p_check_id===null?'create':'edit';}
   else throw Error('Unexpected synthetic RPC');
   assert.ok(can(role,resource,action),'The real Node gates must authorize the exact action before business RPC');business.push({name,role,body,resource,action});
   res.end(JSON.stringify(name==='core_dictionary_catalog'?[]:{id:7,success:true,synthetic:true}));
  }catch{unexpected.push('UNEXPECTED_SYNTHETIC_UPSTREAM_CONTRACT');res.writeHead(500);res.end('{}');}
 });await listen(upstream);
 const reservation=createServer();await listen(reservation);port=reservation.address().port;await close(reservation);
 childEnv={};for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(process.env[key]!==undefined)childEnv[key]=process.env[key];
 Object.assign(childEnv,{PORT:String(port),NODE_ENV:'test',SUPABASE_URL:'http://127.0.0.1:'+upstream.address().port,SUPABASE_ANON_KEY:publicKey,SUPABASE_PUBLISHABLE_KEY:publicKey,DISABLE_BACKGROUND_JOBS:'true',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0',EMAIL_NOTIFICATIONS_ENABLED:'false',P163_UPSTREAM_ORIGIN:'http://127.0.0.1:'+upstream.address().port});
 child=spawn(process.execPath,['--import',pathToFileURL(join(workspace,'scripts','fixtures','isolated-generic-route-http-child.mjs')).href,join(workspace,'dist','server.js')],{cwd:directory,env:childEnv,stdio:['ignore','pipe','pipe'],windowsHide:true});childState=observeChild(child);
 for(const[name,stream]of[['stdout',child.stdout],['stderr',child.stderr]])stream.on('data',chunk=>{const result=captureOutput(name==='stdout'?stdout:stderr,chunk);if(name==='stdout')stdout=result.text;else stderr=result.text;guardAttempted||=result.blocked;outputLeaked||=result.leaked;});
 let ready=false,lastProbe=null;for(let index=0;index<100;index++){if(childState.closed||childState.failed)break;try{const response=await request('/api/health',{role:null});lastProbe=response.status;if(response.status===200){ready=true;break;}}catch(error){lastProbe=/^[A-Z_]+$/.test(error.code??'')?error.code:'probe-failed';}await new Promise(done=>setTimeout(done,50));}
 assert.ok(ready,'The isolated method-test router must start: '+JSON.stringify({exit:child.exitCode,failed:childState.failed,started:stdout.includes('GENTIA ERP disponible'),probe:lastProbe,blocked:guardAttempted,stderrBytes:stderr.length,errorCode:stderr.match(/\b(?:EACCES|EADDRINUSE|ERR_[A-Z_]+|MODULE_NOT_FOUND)\b/)?.[0]??null}));await verifySnapshot();
});
after(async()=>{try{await stop();assert.equal(guardAttempted,false,'Forbidden I/O must remain visible through child close');assert.equal(outputLeaked,false,'Private output must remain visible through child close');}finally{try{await close(upstream);}finally{await cleanup();}}});

test('the generic method resolver has no default DELETE action and retains only explicit workflow exceptions',()=>{
 for(const resource of resources){for(const[method,action]of[['GET','view'],['PATCH','edit'],['DELETE','delete']])assert.equal(genericRouteAction(method,resource),action);assert.equal(genericRouteAction('POST',resource),resource==='security:user-subsidiaries'?'edit':'create');
  for(const method of[undefined,'','HEAD','OPTIONS','TRACE','PROPFIND','get','PATCHX'])assert.equal(genericRouteAction(method,resource),undefined);
  assert.equal(genericRouteAction('PUT',resource),['purchasing:supplier-payments','sales:customer-payments'].includes(resource)?'edit':undefined);
 }
 for(const alias of['banking:checks','accounting:journal-entry','sales:workflow','purchasing:workflow','fixed-assets:workflow-manage','treasury:schedules'])assert.equal(genericRouteAction('PUT',alias),undefined,'Aliases retain their own routing; the generic resolver grants nothing to them');
});

test('unsupported methods return 405 before a role lookup, body parsing or business RPC for every active profile',async()=>{
 for(const role of roles.filter(role=>role!=='invalid-session'))for(const method of['HEAD','OPTIONS','PUT','TRACE','PROPFIND'])for(const path of['/api/core/currencies','/api/core/currencies/7']){
  const before=calls.length,beforeBusiness=business.length,response=await request(path,{method,role,raw:'{INVALID_SYNTHETIC_JSON'});
  assert.equal(response.status,405,role+' '+method+' '+path);assert.equal(business.length,beforeBusiness);assert.deepEqual(calls.slice(before).map(call=>call.path),['/rest/v1/rpc/assert_request_access']);
  if(method==='HEAD')assert.equal(response.buffer.length,0);else assert.deepEqual(response.json(),{error:{message:'Método no permitido.',status:405}});
 }
});

test('session and device authentication still precede unsupported API method handling',async()=>{
 for(const role of[null,'invalid-session']){const before=business.length,response=await request('/api/core/currencies/7',{method:'PUT',role,raw:'{INVALID'});assert.equal(response.status,401);assert.equal(business.length,before);}
 const before=calls.length,response=await request('/api/core/currencies/7',{method:'PUT',deviceToken:''});assert.equal(response.status,401);assert.equal(calls.length,before);
});

test('GET, POST, PATCH and DELETE require the exact currency action plus view before RPC',async()=>{
 const payload={currency_code:'SYN',name:'SYNTHETIC',symbol:'S',fx_rate_precision:2};
 for(const[method,path,action,status]of[['GET','/api/core/currencies','view',200],['POST','/api/core/currencies','create',201],['PATCH','/api/core/currencies/7','edit',200],['DELETE','/api/core/currencies/7','delete',200]]){
  for(const role of['reader','creator','editor','deleter','no-view','denied','other','admin']){
   const before=business.length,response=await request(path,{method,role,...(method==='GET'?{}:{payload})}),allowed=can(role,'core:currencies',action);
   assert.equal(response.status,allowed?status:403,role+' '+method);assert.equal(business.length,before+(allowed?1:0));if(allowed){assert.equal(business.at(-1).action,action);assert.equal(business.at(-1).resource,'core:currencies');}
  }
 }
});

test('the two payment PUTs keep edit permission without delete, and save/delete retain distinct actions',async()=>{
 for(const[module,slug,rpc]of[['purchasing','supplier-payments','supplier'],['sales','customer-payments','customer']])for(const[method,suffix,action,status]of[['PUT','/7','edit',200],['POST','/save','create',201],['DELETE','/7','delete',200]])for(const role of['reader','creator','editor','deleter','no-view','denied','admin']){
  const before=business.length,response=await request('/api/'+module+'/'+slug+suffix,{method,role,payload:{synthetic:true}}),allowed=can(role,module+':'+slug,action);
  assert.equal(response.status,allowed?status:403,role+' '+module+' '+method);assert.equal(business.length,before+(allowed?1:0));if(allowed){assert.equal(business.at(-1).action,action);assert.equal(business.at(-1).body.p_payment_id,action==='create'?null:7);assert.equal(business.at(-1).name,action==='delete'?'delete_'+rpc+'_payment':'save_'+rpc+'_payment_with_advances');}
 }
});

test('POST user-subsidiaries remains edit rather than create and preserves its existing payload',async()=>{
 const payload={user_id:7,subsidiary_ids:[1],_revision:5};
 for(const role of['reader','creator','editor','deleter','no-view','admin']){
  const before=business.length,response=await request('/api/security/user-subsidiaries',{method:'POST',role,payload}),allowed=can(role,'security:user-subsidiaries','edit');
  assert.equal(response.status,allowed?201:403);assert.equal(business.length,before+(allowed?1:0));if(allowed)assert.deepEqual(business.at(-1).body,{p_catalog:'user-subsidiaries',p_payload:payload,p_id:7});
 }
});

test('workflow PUT aliases outside the generic matrix and banking PUTs before it keep their real edit gates',async()=>{
 for(const[path,resource,name,payload]of[['/api/sales/workflow/7','sales:quotations','save_sales_document',{type:'QUOTE',synthetic:true}],['/api/banking/checks/7','banking:bank-checks','save_bank_check_transfer',{synthetic:true}]])for(const role of['reader','creator','editor','deleter','no-view','admin']){
  const before=business.length,response=await request(path,{method:'PUT',role,payload}),allowed=can(role,resource,'edit');
  assert.equal(response.status,allowed?200:403);assert.equal(business.length,before+(allowed?1:0));if(allowed){assert.equal(business.at(-1).name,name);assert.equal(business.at(-1).action,'edit');}
 }
});

test('a supported uncached request still loads actual role permissions instead of bypassing authorization',async()=>{
 const before=calls.length,response=await request('/api/core/currencies',{role:'uncached'});assert.equal(response.status,200);
 assert.deepEqual(calls.slice(before).map(call=>call.path),['/rest/v1/rpc/assert_request_access','/rest/v1/rpc/security_my_role_access','/rest/v1/rpc/core_dictionary_catalog']);
});

test('static HEAD remains a real asset response outside API authentication and permission dispatch',async()=>{
 const before=calls.length,response=await request('/'+assetName,{method:'HEAD',role:null});assert.equal(response.status,200);assert.equal(response.buffer.length,0);assert.equal(Number(response.headers['content-length']),Buffer.byteLength(assetBody));assert.equal(calls.length,before);
 const get=await request('/'+assetName,{role:null});assert.equal(get.status,200);assert.equal(get.buffer.toString(),assetBody);assert.equal(calls.length,before);
});

test('the router fixture keeps only the synthetic snapshot and an explicit environment without secrets or external collaborators',async()=>{
 const allowed=new Set(['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP','PORT','NODE_ENV','SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_PUBLISHABLE_KEY','DISABLE_BACKGROUND_JOBS','AUTH_REQUEST_ACCESS_CACHE_TTL_MS','EMAIL_NOTIFICATIONS_ENABLED','P163_UPSTREAM_ORIGIN']);
 assert.ok(Object.keys(childEnv).every(key=>allowed.has(key)));for(const key of['ERP_TEST_EMAIL','ERP_TEST_PASSWORD','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_DB_PASSWORD','PGPASSWORD','DATABASE_URL','NODE_OPTIONS','HTTP_PROXY','HTTPS_PROXY','CHROME_PATH'])assert.equal(Object.hasOwn(childEnv,key),false);
 assert.equal(childEnv.DISABLE_BACKGROUND_JOBS,'true');assert.deepEqual(unexpected,[]);assert.equal(guardAttempted,false);assert.equal(outputLeaked,false);await verifySnapshot();
});

test('harness termination and output checks cannot mistake error for close or hide a marker before truncation',async()=>{
 const process=new EventEmitter(),state=observeChild(process);let complete=false;state.completion.then(()=>{complete=true;});process.emit('error',Error('Synthetic child error'));await Promise.resolve();assert.equal(state.failed,true);assert.equal(state.closed,false);assert.equal(complete,false);process.emit('close');await state.completion;assert.equal(state.closed,true);assert.equal(complete,true);
 const captured=captureOutput('',Buffer.from('P163_BLOCKED:synthetic\n'+publicKey+'\n'+'x'.repeat(40000)));assert.equal(captured.blocked,true);assert.equal(captured.leaked,true);assert.equal(captured.text.includes(publicKey),false);assert.equal(captured.text.includes('P163_BLOCKED:'),false);
});
