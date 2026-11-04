import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer,request as httpRequest} from 'node:http';
import {lstat,mkdir,mkdtemp,readdir,realpath,rm} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicRequestError} from '../dist/core/security/public-request-errors.js';

assert.deepEqual(process.argv.slice(2),[],'This isolated fixture accepts no destinations or credentials');
const canary='P97_PRIVATE_SQL_TOKEN_CANARY';
const id='12345678-1234-4234-8234-123456789abc';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const generic='No fue posible procesar la solicitud. Inténtalo de nuevo o consulta la referencia.';
const login='No fue posible iniciar sesión. Revisa tus datos o inténtalo más tarde.';
const opening='No fue posible validar el archivo. Revisa el formato o consulta la referencia.';
const context={requestId:id,status:400,method:'GET',target:'/api/reports/accounting/options?token='+canary};
const logKeys=['id','status','method','family','errorType'].sort();

test('unknown 400 and outer 500 share a safe response and exactly five whitelisted log fields',()=>{
 for(const status of[400,500]){
  const cause=Object.assign(new Error(canary),{name:canary,stack:canary,code:canary,body:canary,headers:{Authorization:canary}});
  const result=publicRequestError(cause,{...context,status});
  assert.deepEqual(result.payload,{error:{message:generic,status,requestId:id}});
  assert.deepEqual(result.log,{id,status,method:'GET',family:'REPORTS',errorType:'ERROR'});
  assert.deepEqual(Object.keys(result.log).sort(),logKeys);assert.ok(!JSON.stringify(result).includes(canary));
 }
});
test('message, name, stack and code getters are never read when selecting an error-type enum',()=>{
 let reads=0;const cause=new TypeError();
 for(const property of['name','message','stack','code'])Object.defineProperty(cause,property,{get(){reads++;throw Error(canary);}});
 assert.equal(publicRequestError(cause,context).log.errorType,'TYPE_ERROR');assert.equal(reads,0);
 for(const [failure,type]of[[new RangeError(canary),'RANGE_ERROR'],[new SyntaxError(canary),'SYNTAX_ERROR'],[new ReferenceError(canary),'REFERENCE_ERROR'],[new URIError(canary),'URI_ERROR'],[new EvalError(canary),'EVAL_ERROR']]){
  assert.equal(publicRequestError(failure,context).log.errorType,type);
 }
});
test('non-Error values and hostile proxies cannot leak through serialization or error classification',()=>{
 const hostile=new Proxy({},{get(){throw Error(canary);},getPrototypeOf(){throw Error(canary);}});
 for(const cause of[undefined,null,canary,42,1n,Symbol(canary),{message:canary,name:canary,stack:canary,code:canary},hostile]){
  const result=publicRequestError(cause,context);assert.equal(result.log.errorType,'NON_ERROR');assert.ok(!JSON.stringify(result).includes(canary));
 }
});
test('methods and API families use closed enums and never retain path, query or arbitrary method text',()=>{
 for(const [target,family]of[['/api/auth/login?secret='+canary,'AUTH'],['/api/security/users/'+canary,'SECURITY'],['/api/v1/reports/x?secret='+canary,'REPORTS'],['/api/opening-balances/validate?secret='+canary,'OPENING_BALANCES'],['/api/reports-not-a-family/'+canary,'API'],['/private/'+canary,'OTHER']]){
  const result=publicRequestError(new Error(),{...context,target,method:canary});
  assert.equal(result.log.method,'OTHER');assert.equal(result.log.family,family);assert.ok(!JSON.stringify(result).includes(canary));
 }
 for(const method of['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'])assert.equal(publicRequestError(null,{...context,method}).log.method,method);
});
test('known login and opening validation use fixed public instructions instead of upstream details',()=>{
 assert.equal(publicRequestError(new Error(canary),{...context,method:'POST',target:'/api/auth/login?secret='+canary}).payload.error.message,login);
 assert.equal(publicRequestError(new Error(canary),{...context,method:'POST',target:'/api/opening-balances/validate'}).payload.error.message,opening);
 assert.equal(publicRequestError(new Error(canary),{...context,method:'POST',target:'/api/auth/login-extra'}).payload.error.message,generic);
});
test('invalid correlation IDs and non-fallback statuses are rejected without reflecting their values',()=>{
 assert.throws(()=>publicRequestError(null,{...context,requestId:canary}),error=>error instanceof RangeError&&!error.message.includes(canary));
 assert.throws(()=>publicRequestError(null,{...context,status:429}),RangeError);
});

function inside(parent,target){const part=relative(parent,target);return part!==''&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);}
async function closeServer(server){if(!server)return;server.closeAllConnections();await new Promise(done=>server.close(done));}
async function stopChild(child){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 child.kill();await new Promise(done=>{const timer=setTimeout(done,3000);child.once('close',()=>{clearTimeout(timer);done();});if(child.exitCode!==null||child.signalCode!==null){clearTimeout(timer);done();}});
 assert.ok(child.exitCode!==null||child.signalCode!==null,'Router must stop before fixture cleanup');
}
test('real router sanitizes only unknown fallbacks with correlated server UUIDs and closed JSON logs',{timeout:45000},async t=>{
 const workspace=await realpath(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
 const namedBase=join(workspace,'.local-tools');
 try{const entry=await lstat(namedBase);assert.ok(entry.isDirectory()&&!entry.isSymbolicLink());}
 catch(error){if(error.code!=='ENOENT')throw error;await mkdir(namedBase);}
 const base=await realpath(namedBase);assert.equal(relative(workspace,base),'.local-tools');assert.ok(inside(workspace,base));
 const created=await mkdtemp(join(base,'p97-public-errors-')),cwd=await realpath(created);
 assert.equal(created,cwd);assert.ok(inside(base,cwd)&&inside(workspace,cwd));assert.deepEqual(await readdir(cwd),[]);
 let child,upstream;let stdout='',stderr='';const calls=[],unexpected=[],issued=[];
 t.after(async()=>{
  await stopChild(child);await closeServer(upstream);
  assert.equal(await realpath(workspace),workspace);assert.equal(await realpath(namedBase),base);
  const entry=await lstat(cwd),target=await realpath(cwd);assert.ok(entry.isDirectory()&&!entry.isSymbolicLink());assert.equal(target,cwd);
  assert.ok(inside(base,target)&&inside(workspace,target)&&basename(target).startsWith('p97-public-errors-'));
  await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 });
 upstream=createServer(async(request,response)=>{
  response.setHeader('Content-Type','application/json');
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  calls.push(request.url);
  if(request.url==='/rest/v1/rpc/assert_request_access'){
   if(request.headers.authorization==='Bearer p97-invalid'){response.writeHead(401);response.end(JSON.stringify({message:canary}));return;}
   const grants=request.headers.authorization==='Bearer p97-denied'?[]:[{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}];
   response.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:false,grants}}));return;
  }
  if(request.url==='/rest/v1/rpc/accounting_report_options_bundle'){
   response.writeHead(400);response.end(JSON.stringify({message:'syntax error in SELECT '+canary,code:canary,details:canary,hint:canary}));return;
  }
  unexpected.push(request.url);response.writeHead(500);response.end('{}');
 });
 await new Promise(done=>upstream.listen(0,'127.0.0.1',done));
 const reservation=createServer();await new Promise(done=>reservation.listen(0,'127.0.0.1',done));const port=reservation.address().port;await new Promise(done=>reservation.close(done));
 const origin='http://127.0.0.1:'+upstream.address().port;
 const env={};for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(process.env[key]!==undefined)env[key]=process.env[key];
 Object.assign(env,{PORT:String(port),NODE_ENV:'test',DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:origin,SUPABASE_ANON_KEY:'p97-synthetic-public',SUPABASE_PUBLISHABLE_KEY:'p97-synthetic-public',SUPABASE_SERVICE_ROLE_KEY:'p97-synthetic-service-'+canary,AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0',EMAIL_NOTIFICATIONS_ENABLED:'false',TURNSTILE_ENABLED:'false'});
 // Loopback-only fetch; .env is unavailable. Inject one pre-router TypeError
 // solely in this child to exercise the outer 500 without a production hook.
 const preloader="import{ServerResponse}from'node:http';const original=ServerResponse.prototype.setHeader;ServerResponse.prototype.setHeader=function(name,value){if(name==='X-Content-Type-Options'&&this.req?.url?.startsWith('/api/health?p97-outer=')){const failure=new TypeError("+JSON.stringify(canary)+");failure.name="+JSON.stringify(canary)+";failure.code="+JSON.stringify(canary)+";failure.stack="+JSON.stringify(canary)+";throw failure;}return original.call(this,name,value);};process.loadEnvFile=()=>{throw Error('Synthetic environment-file access disabled');};const fetchLocal=globalThis.fetch;globalThis.fetch=(input,init)=>{const target=new URL(input instanceof Request?input.url:String(input));if(target.origin!=="+JSON.stringify(origin)+")throw Error('P97_NON_LOOPBACK_FETCH_BLOCKED');return fetchLocal(input,init);};";
 child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preloader),join(workspace,'dist','server.js')],{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 child.stdout.on('data',chunk=>{stdout=(stdout+chunk.toString()).slice(-64000);});child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-64000);});
 let startupError;child.once('error',error=>{startupError=error;});
 function request(path,{method='GET',raw='{}',auth,declaredLength,sendBody=true}={}){
  const bytes=Buffer.from(raw),hasBody=method!=='GET'&&method!=='HEAD';
  return new Promise((done,reject)=>{
   const req=httpRequest({hostname:'127.0.0.1',port,path,method,agent:false,headers:{'X-Request-ID':clientId,'X-Private-Fixture':canary,'User-Agent':canary,...(auth?{Authorization:'Bearer '+auth,'X-Device-Token':'p97-synthetic-device-with-enough-entropy'}:{}),...(hasBody?{'Content-Type':'application/json','Content-Length':declaredLength??bytes.byteLength}:{})}},response=>{
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');done({status:response.statusCode,headers:response.headers,text,json:()=>JSON.parse(text)});});
   });req.setTimeout(5000,()=>req.destroy(Error('Isolated loopback request timed out')));req.on('error',reject);req.end(hasBody&&sendBody?bytes:undefined);
  });
 }
 let ready=false,lastProbe='not probed';
 for(let i=0;i<100;i++){
  if(startupError)throw startupError;if(child.exitCode!==null)break;
  try{const health=await request('/api/health');lastProbe='HTTP '+health.status;if(health.status===200){ready=true;break;}}catch(error){lastProbe=error.code??'probe failed';}
  await new Promise(done=>setTimeout(done,50));
 }
 assert.ok(ready,'The isolated router must start: '+JSON.stringify({exit:child.exitCode,probe:lastProbe,diagnostic:stderr.replaceAll(canary,'[REDACTED FIXTURE]').slice(-1200)}));assert.deepEqual(await readdir(cwd),[]);
 function unknown(response,status,message){
  assert.equal(response.status,status);const error=response.json().error;
  assert.deepEqual(Object.keys(error).sort(),['message','status','requestId'].sort());assert.equal(error.status,status);assert.equal(error.message,message);
  assert.match(error.requestId,uuid);assert.equal(response.headers['x-request-id'],error.requestId);assert.notEqual(error.requestId,clientId);
  assert.ok(!response.text.includes(canary));issued.push(error.requestId);return error.requestId;
 }
 await t.test('RPC SQL/provider canary reaches the real inner fallback, remains private, and receives a new UUID per request',async()=>{
  const before=calls.length;
  const first=unknown(await request('/api/reports/accounting/options',{auth:'p97-valid'}),400,generic);
  const second=unknown(await request('/api/reports/accounting/options',{auth:'p97-valid'}),400,generic);assert.notEqual(first,second);
  assert.equal(calls.slice(before).filter(path=>path==='/rest/v1/rpc/accounting_report_options_bundle').length,2);
 });
 await t.test('malformed public JSON has a fixed login instruction and never reaches Auth/RPC',async()=>{
  const before=calls.length;unknown(await request('/api/auth/login',{method:'POST',raw:'{"password":"'+canary+'","broken":]'}),400,login);assert.equal(calls.length,before);
 });
 await t.test('outer pre-router failure returns a sanitized 500 despite canaries in error fields, headers and raw query',async()=>{
  const before=calls.length;unknown(await request('/api/health?p97-outer='+canary),500,generic);assert.equal(calls.length,before);
 });
 await t.test('typed session and permission failures retain statuses/messages and do not use unknown-error correlation',async()=>{
  const noAuth=await request('/api/reports/accounting/options');assert.equal(noAuth.status,401);assert.equal(noAuth.json().error.message,'Debe iniciar sesión.');assert.equal(noAuth.headers['x-request-id'],undefined);
  const invalid=await request('/api/reports/accounting/options',{auth:'p97-invalid'});assert.equal(invalid.status,401);assert.equal(invalid.json().error.message,'La sesión expiró o fue revocada. Inicie sesión nuevamente.');assert.equal(invalid.headers['x-request-id'],undefined);
  const denied=await request('/api/reports/accounting/options',{auth:'p97-denied'});assert.equal(denied.status,403);assert.equal(denied.json().error.message,'El rol activo no tiene permiso para realizar esta acción.');assert.equal(denied.headers['x-request-id'],undefined);
 });
 await t.test('413 retains its exact limit message and 429 retains Retry-After and its original public instruction',async()=>{
  const before=calls.length;
  const oversized=await request('/api/auth/login',{method:'POST',declaredLength:16*1024+1,sendBody:false});assert.equal(oversized.status,413);assert.equal(oversized.json().error.message,'La solicitud supera el límite permitido de 16 KB.');assert.equal(oversized.headers['x-request-id'],undefined);
  for(let i=0;i<5;i++)unknown(await request('/api/auth/login',{method:'POST',raw:JSON.stringify({email:'p97-rate@example.invalid',password:'x'})}),400,login);
  const limited=await request('/api/auth/login',{method:'POST',raw:JSON.stringify({email:'p97-rate@example.invalid',password:'x'})});assert.equal(limited.status,429);assert.match(limited.json().error.message,/^Demasiados intentos de acceso\./);assert.ok(Number(limited.headers['retry-after'])>0);assert.equal(limited.headers['x-request-id'],undefined);assert.equal(calls.length,before);
 });
 await t.test('each response UUID has exactly one safe structured log; no input or provider canary is emitted',async()=>{
  let records=[];
  for(let i=0;i<20;i++){records=stderr.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));if(records.length>=issued.length)break;await new Promise(done=>setTimeout(done,10));}
  assert.equal(records.length,issued.length);assert.equal(new Set(issued).size,issued.length);
  for(const record of records){assert.deepEqual(Object.keys(record).sort(),logKeys);assert.ok(issued.includes(record.id));assert.ok([400,500].includes(record.status));assert.ok(['GET','POST'].includes(record.method));assert.ok(['AUTH','REPORTS','API'].includes(record.family));assert.ok(['ERROR','SYNTAX_ERROR','TYPE_ERROR'].includes(record.errorType));}
  assert.equal(records.filter(record=>record.status===500&&record.errorType==='TYPE_ERROR').length,1);
  assert.ok(!stderr.includes(canary));assert.ok(!stdout.includes(canary));assert.ok(!stderr.includes('P97_NON_LOOPBACK_FETCH_BLOCKED'));assert.deepEqual(unexpected,[]);
  assert.ok(calls.every(path=>['/rest/v1/rpc/assert_request_access','/rest/v1/rpc/accounting_report_options_bundle'].includes(path)));
  assert.equal((await request('/api/health')).status,200);
 });
});
