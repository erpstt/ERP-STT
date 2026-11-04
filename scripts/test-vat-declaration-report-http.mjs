import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const {createHash}=await import('node:crypto');
const {createServer,request:httpRequest}=await import('node:http');
const {spawn}=await import('node:child_process');
const {lstat,mkdir,mkdtemp,readdir,realpath,rm}=await import('node:fs/promises');
const {basename,dirname,isAbsolute,join,relative,resolve,sep}=await import('node:path');
const {fileURLToPath,pathToFileURL}=await import('node:url');
const {EventEmitter}=await import('node:events');

// No login, .env, ERP_TEST credentials, company selection or live SQL. This is
// the real HTTP router/report service with synthetic Auth/RPC collaborators.
// XLSX is real and memory-only; PDF worker bytes are simulated, not C02 evidence.
const workspace=await realpath(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const namedBase=join(workspace,'.local-tools'),prefix='p157-vat-http-';
const publicKey='p157-synthetic-public-key',device='p157-synthetic-device-with-enough-entropy';
const workerToken='p157_synthetic_renderer_token_for_local_fixture';
const providerCanary='P157_SYNTHETIC_PRIVATE_PROVIDER_CONTEXT';
const hash=value=>createHash('sha256').update(value).digest('hex');
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const roles=['reader','denied','other','action-without-view','admin','invalid-session'];
const tokens=new Map(roles.map(role=>[role,'synthetic.'+encode({sub:'11111111-1111-4111-8111-111111111111',session_id:'22222222-2222-4222-8222-222222222222',exp:Math.floor(Date.now()/1000)+900,fixtureRole:role})+'.synthetic']));
const claims=new Map([...tokens].map(([role,token])=>['Bearer '+token,role]));
const roleAccess=role=>({isAdmin:role==='admin',grants:role==='reader'?[{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}]:role==='other'?[{resourceKey:'tax:tax-calendar',canView:true,canCreate:false,canEdit:false,canDelete:false}]:role==='action-without-view'?[{resourceKey:'reports:accounting-reports',canView:false,canCreate:true,canEdit:true,canDelete:true}]:[]});
const filters={subsidiaryId:1,periodMonth:'2026-01',includeAdjustments:true,documentStatuses:['APROBADO'],priorPeriodCredit:0};
const options={subsidiary:{id:1,name:'SYNTHETIC_SUBSIDIARY',currencyCode:'USD'},taxLabel:'SYNTHETIC_TAX',documentStatuses:[{value:'APROBADO',label:'Synthetic approved'}]};
function report(empty=false){
 const sales={side:'SALES',documentNumber:'SYNTHETIC-SALE-1',documentType:'SYNTHETIC_INVOICE',date:'2026-01-15',partyName:'<SYNTHETIC_CUSTOMER>',taxCode:'SYNTHETIC_TAX',taxRate:10,baseAmount:100,taxAmount:10,grossAmount:110,currencyCode:'USD',status:'APROBADO',note:'<script>SYNTHETIC_NOTE</script>'};
 const purchases={side:'PURCHASES',documentNumber:'SYNTHETIC-PURCHASE-1',documentType:'SYNTHETIC_INVOICE',date:'2026-01-15',partyName:'SYNTHETIC_SUPPLIER',taxCode:'SYNTHETIC_TAX',taxRate:10,baseAmount:40,taxAmount:4,grossAmount:44,currencyCode:'USD',status:'APROBADO'};
 return{header:{subsidiaryName:'<SYNTHETIC_SUBSIDIARY>',countryName:'SYNTHETIC_COUNTRY',taxLabel:'SYNTHETIC_TAX',periodMonth:empty?'2026-02':'2026-01',dateFrom:empty?'2026-02-01':'2026-01-01',dateTo:empty?'2026-02-28':'2026-01-31',currencyCode:'USD',currencySymbol:'$',includeAdjustments:true,documentStatuses:['APROBADO']},summary:{salesBase:empty?0:100,salesTax:empty?0:10,purchaseBase:empty?0:40,purchaseTax:empty?0:4,netTax:empty?0:6,warnings:[]},details:empty?[]:[sales,purchases]};
}
const routes=[['/api/v1/reports/tax/vat-declaration/options','GET'],['/api/v1/reports/tax/vat-declaration','POST'],['/api/v1/reports/tax/vat-declaration/pdf','POST'],['/api/v1/reports/tax/vat-declaration/excel','POST']];
let child,childState,upstream,directory,base,port,childEnv,stdout='',stderr='',guardAttempted=false,outputLeaked=false,providerStatus=200,rendererStatus=200;
const calls=[],fiscal=[],renders=[],unexpected=[];
function inside(parent,target){const part=relative(parent,target);return part!==''&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);}
function observeChild(process){const state={closed:false,failed:false};state.completion=new Promise(done=>{process.once('close',()=>{state.closed=true;done();});process.once('error',()=>{state.failed=true;});});return state;}
function captureOutput(previous,chunk){const combined=previous+chunk.toString();return{text:combined.slice(-32000),blocked:combined.includes('P157_BLOCKED:'),leaked:[...tokens.values(),workerToken,publicKey,providerCanary].some(token=>combined.includes(token))};}
async function listen(server){await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);done();});});}
async function close(server){if(!server)return;server.closeAllConnections();if(server.listening)await new Promise(done=>server.close(done));}
function request(path,{method='GET',role='reader',payload,deviceToken=device}={}){
 const bytes=payload===undefined?null:Buffer.from(JSON.stringify(payload));
 return new Promise((done,reject)=>{
  const req=httpRequest({hostname:'127.0.0.1',port,path,method,agent:false,headers:{...(role?{Authorization:'Bearer '+tokens.get(role),...(deviceToken?{'X-Device-Token':deviceToken}:{})}:{}),...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},response=>{
   const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>{const buffer=Buffer.concat(chunks);done({status:response.statusCode,headers:response.headers,buffer,json:()=>JSON.parse(buffer.toString('utf8'))});});
  });req.setTimeout(5000,()=>req.destroy(Error('Synthetic VAT request timed out')));req.on('error',reject);req.end(bytes);
 });
}
async function waitClosed(timeout){return Promise.race([childState.completion.then(()=>true),new Promise(done=>{const timer=setTimeout(()=>done(false),timeout);childState.completion.then(()=>clearTimeout(timer));})]);}
async function stop(){if(!child||childState.closed)return;child.kill();if(!await waitClosed(3000)){child.kill('SIGKILL');assert.ok(await waitClosed(3000),'Synthetic router must terminate before cleanup');}}
async function cleanup(){
 if(!directory)return;assert.ok(!child||childState?.closed,'Preserve the fixture CWD until child close is confirmed');assert.equal(await realpath(workspace),workspace);assert.equal(await realpath(namedBase),base);
 const entry=await lstat(directory),target=await realpath(directory);assert.ok(entry.isDirectory()&&!entry.isSymbolicLink());assert.equal(target,directory);assert.ok(inside(workspace,target)&&inside(base,target)&&basename(target).startsWith(prefix));
 assert.deepEqual(await readdir(target),[],'Only the empty owned CWD may be removed');await rm(target,{recursive:true,force:false,maxRetries:5,retryDelay:100});
}
before(async()=>{
 try{const entry=await lstat(namedBase);assert.ok(entry.isDirectory()&&!entry.isSymbolicLink());}catch(error){if(error.code!=='ENOENT')throw error;await mkdir(namedBase);}
 base=await realpath(namedBase);assert.equal(base,namedBase);assert.ok(inside(workspace,base));
 const created=await mkdtemp(join(base,prefix));directory=await realpath(created);assert.equal(created,directory);assert.ok(inside(base,directory)&&inside(workspace,directory));assert.deepEqual(await readdir(directory),[]);
 upstream=createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);assert.equal(req.method,'POST');const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
   if(req.url==='/synthetic-pdf-worker'){
    assert.ok(req.headers.authorization==='Bearer '+workerToken,'Only the synthetic worker token is accepted');assert.ok(typeof body.html==='string'&&body.html.startsWith('<!doctype html>'));assert.ok(!body.html.includes('<script>'));renders.push({html:body.html});
    if(rendererStatus!==200){res.writeHead(rendererStatus,{'Content-Type':'application/json'});res.end(JSON.stringify({message:providerCanary}));return;}
    const pdf=Buffer.from('%PDF-1.7\nSYNTHETIC_WORKER_BYTES\n%%EOF');res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':pdf.length});res.end(pdf);return;
   }
   const role=claims.get(req.headers.authorization);assert.ok(role,'Only synthetic fixture JWTs may reach Auth/RPC');assert.ok(req.headers.apikey===publicKey,'Only the synthetic public key is forwarded');
   calls.push({path:req.url,role,body});res.setHeader('Content-Type','application/json');
   if(req.url==='/rest/v1/rpc/assert_request_access'){
    assert.deepEqual(body,{p_session_token_hash:hash(tokens.get(role)),p_device_token_hash:hash(device)});
    res.end(JSON.stringify(role==='invalid-session'?{allowed:false,reason:'SESSION_INVALID'}:{allowed:true,roleAccess:roleAccess(role)}));return;
   }
   if(req.url==='/rest/v1/rpc/security_my_role_access'){res.end(JSON.stringify(roleAccess(role)));return;}
   assert.ok(role==='reader'||role==='admin','Financial RPC requires the real resource gate to have accepted the actor');
   assert.ok(['/rest/v1/rpc/vat_declaration_report_options','/rest/v1/rpc/run_vat_declaration_report'].includes(req.url));fiscal.push({path:req.url,role,body});
   if(providerStatus!==200){res.writeHead(providerStatus);res.end(JSON.stringify({message:providerCanary,code:providerCanary,details:providerCanary}));return;}
   res.end(JSON.stringify(req.url.endsWith('vat_declaration_report_options')?options:report(body.p_filters.periodMonth==='2026-02')));
  }catch{unexpected.push('UNEXPECTED_SYNTHETIC_UPSTREAM_CONTRACT');res.writeHead(500);res.end('{}');}
 });await listen(upstream);
 const reservation=createServer();await listen(reservation);port=reservation.address().port;await close(reservation);
 childEnv={};for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(process.env[key]!==undefined)childEnv[key]=process.env[key];
 Object.assign(childEnv,{PORT:String(port),NODE_ENV:'test',SUPABASE_URL:'http://127.0.0.1:'+upstream.address().port,SUPABASE_ANON_KEY:publicKey,SUPABASE_PUBLISHABLE_KEY:publicKey,DISABLE_BACKGROUND_JOBS:'true',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0',EMAIL_NOTIFICATIONS_ENABLED:'false',PDF_RENDERER_URL:'http://p157-renderer.railway.internal/',PDF_RENDERER_TOKEN:workerToken,P157_UPSTREAM_ORIGIN:'http://127.0.0.1:'+upstream.address().port});
 child=spawn(process.execPath,['--import',pathToFileURL(join(workspace,'scripts','fixtures','isolated-vat-http-child.mjs')).href,join(workspace,'dist','server.js')],{cwd:directory,env:childEnv,stdio:['ignore','pipe','pipe'],windowsHide:true});
 childState=observeChild(child);
 child.stdout.on('data',chunk=>{const result=captureOutput(stdout,chunk);stdout=result.text;guardAttempted||=result.blocked;outputLeaked||=result.leaked;});child.stderr.on('data',chunk=>{const result=captureOutput(stderr,chunk);stderr=result.text;guardAttempted||=result.blocked;outputLeaked||=result.leaked;});
 let ready=false,lastProbe='not probed';for(let index=0;index<100;index++){if(childState.closed||childState.failed)break;try{const result=await request('/api/health',{role:null});lastProbe='HTTP '+result.status;if(result.status===200){ready=true;break;}}catch(error){lastProbe=error.code??'probe failed';}await new Promise(done=>setTimeout(done,50));}
 let startupReason=stderr.match(/(?:^|\n)\w*Error(?: \[[A-Z_]+\])?:[^\n]*/)?.[0]?.trim()??'No child error message';
 for(const token of[...tokens.values(),workerToken,publicKey])startupReason=startupReason.replaceAll(token,'[SYNTHETIC REDACTED]');
 assert.ok(ready,'The isolated VAT router must start: '+JSON.stringify({exit:child.exitCode,reason:startupReason,probe:lastProbe,started:stdout.includes('GENTIA ERP disponible'),stderrBytes:stderr.length,blocked:stderr.includes('P157_')}));assert.deepEqual(await readdir(directory),[]);
});
after(async()=>{try{await stop();assert.equal(guardAttempted,false,'No caught or late forbidden I/O attempt may be hidden by fixture shutdown');assert.equal(outputLeaked,false,'No token or provider context may be hidden by truncation or shutdown');}finally{try{await close(upstream);}finally{await cleanup();}}});

test('VAT HTTP fixture uses an empty CWD and an explicit OS/synthetic environment without production credentials',()=>{
 const allowed=new Set(['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP','PORT','NODE_ENV','SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_PUBLISHABLE_KEY','DISABLE_BACKGROUND_JOBS','AUTH_REQUEST_ACCESS_CACHE_TTL_MS','EMAIL_NOTIFICATIONS_ENABLED','PDF_RENDERER_URL','PDF_RENDERER_TOKEN','P157_UPSTREAM_ORIGIN']);
 assert.ok(Object.keys(childEnv).every(key=>allowed.has(key)));for(const key of['ERP_TEST_EMAIL','ERP_TEST_PASSWORD','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_DB_PASSWORD','PGPASSWORD','DATABASE_URL','NODE_OPTIONS','HTTP_PROXY','HTTPS_PROXY','CHROME_PATH'])assert.equal(Object.hasOwn(childEnv,key),false);
 assert.equal(childEnv.DISABLE_BACKGROUND_JOBS,'true');assert.equal(childEnv.EMAIL_NOTIFICATIONS_ENABLED,'false');
});

test('all four real VAT routes deny anonymous/session/device/resource failures before financial RPC or PDF I/O',async()=>{
 for(const [path,method]of routes)for(const role of[null,'invalid-session','denied','other','action-without-view']){
  const before=fiscal.length,pdfBefore=renders.length,response=await request(path,{method,role,...(method==='POST'?{payload:filters}:{})});
  assert.equal(response.status,role===null||role==='invalid-session'?401:403);assert.equal(fiscal.length,before);assert.equal(renders.length,pdfBefore);
 }
 const before=calls.length;for(const [path,method]of routes){const response=await request(path,{method,deviceToken:'',...(method==='POST'?{payload:filters}:{})});assert.equal(response.status,401);}assert.equal(calls.length,before);
});

test('authorized reader and administrator preserve options and JSON payload/filter/JWT contracts',async()=>{
 for(const role of['reader','admin']){
  let response=await request(routes[0][0],{role});assert.equal(response.status,200);assert.deepEqual(response.json(),options);assert.deepEqual(fiscal.at(-1),{path:'/rest/v1/rpc/vat_declaration_report_options',role,body:{}});
  response=await request(routes[1][0],{method:'POST',role,payload:filters});assert.equal(response.status,200);assert.deepEqual(response.json(),report());assert.deepEqual(fiscal.at(-1),{path:'/rest/v1/rpc/run_vat_declaration_report',role,body:{p_filters:filters}});
 }
});

test('PDF route preserves download headers and export filters with only synthetic worker bytes',async()=>{
 for(const role of['reader','admin']){
  const before=renders.length,response=await request(routes[2][0],{method:'POST',role,payload:filters});assert.equal(response.status,200);assert.equal(response.headers['content-type'],'application/pdf');assert.match(response.headers['content-disposition'],/attachment;.*\.pdf/i);assert.equal(Number(response.headers['content-length']),response.buffer.length);assert.equal(response.buffer.subarray(0,4).toString(),'%PDF');assert.equal(renders.length,before+1);
  assert.ok(renders.at(-1).html.includes('&lt;SYNTHETIC_SUBSIDIARY&gt;'));assert.ok(!renders.at(-1).html.includes('<script>'));
  assert.deepEqual(fiscal.at(-1).body,{p_filters:{...filters,export:true,includeDetails:true,page:1,pageSize:100000,limit:100000}});
 }
});

test('XLSX route generates a real in-memory workbook with synthetic sheets/content and export filters',async()=>{
 const {default:ExcelJS}=await import('exceljs');
 for(const role of['reader','admin']){
  const before=renders.length,response=await request(routes[3][0],{method:'POST',role,payload:filters});assert.equal(response.status,200);assert.equal(response.headers['content-type'],'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');assert.match(response.headers['content-disposition'],/attachment;.*\.xlsx/i);assert.equal(response.buffer.subarray(0,2).toString(),'PK');assert.equal(renders.length,before);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(response.buffer);assert.deepEqual(workbook.worksheets.map(sheet=>sheet.name),['Resumen','Detalle Ventas','Detalle Compras']);assert.equal(workbook.getWorksheet('Detalle Ventas').getCell('C4').value,'SYNTHETIC-SALE-1');assert.equal(workbook.getWorksheet('Detalle Compras').getCell('C4').value,'SYNTHETIC-PURCHASE-1');
  assert.deepEqual(fiscal.at(-1).body,{p_filters:{...filters,export:true,includeDetails:true,page:1,pageSize:100000,limit:100000}});
 }
});

test('empty synthetic results retain JSON/PDF/XLSX contracts without a live financial dataset',async()=>{
 const empty={...filters,periodMonth:'2026-02'};let response=await request(routes[1][0],{method:'POST',payload:empty});assert.equal(response.status,200);assert.deepEqual(response.json().details,[]);
 response=await request(routes[2][0],{method:'POST',payload:empty});assert.equal(response.status,200);assert.equal(response.buffer.subarray(0,4).toString(),'%PDF');
 response=await request(routes[3][0],{method:'POST',payload:empty});assert.equal(response.status,200);const{default:ExcelJS}=await import('exceljs');const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(response.buffer);assert.match(workbook.getWorksheet('Detalle Ventas').getCell('A5').value,/No hay movimientos/);
});

test('upstream 401/403 and worker failure retain safe statuses without reflecting provider context',async()=>{
 try{
  for(const status of[401,403]){providerStatus=status;const response=await request(routes[1][0],{method:'POST',payload:filters});assert.equal(response.status,status);assert.ok(!response.buffer.includes(providerCanary));}
  providerStatus=200;rendererStatus=503;const before=renders.length,response=await request(routes[2][0],{method:'POST',payload:filters});assert.equal(response.status,503);assert.ok(!response.buffer.includes(providerCanary));assert.equal(renders.length,before+1);
 }finally{providerStatus=200;rendererStatus=200;}
});

test('fixture never logs synthetic tokens, reads environment files, starts Chrome or calls undeclared endpoints',async()=>{
 assert.deepEqual(unexpected,[]);assert.ok(calls.every(call=>['/rest/v1/rpc/assert_request_access','/rest/v1/rpc/security_my_role_access','/rest/v1/rpc/vat_declaration_report_options','/rest/v1/rpc/run_vat_declaration_report'].includes(call.path)));
 for(const token of[...tokens.values(),workerToken,publicKey]){assert.ok(!stdout.includes(token));assert.ok(!stderr.includes(token));}
 assert.ok(!stderr.includes(providerCanary));assert.ok(!stdout.includes(providerCanary));assert.ok(!stderr.includes('P157_BLOCKED:'));assert.ok(!stderr.includes('P157_FORBIDDEN_IO'));assert.deepEqual(await readdir(directory),[]);
});

test('child error is not termination and oversized log chunks retain privacy/guard indicators before truncation',async()=>{
 const process=new EventEmitter(),observed=observeChild(process);let completed=false;observed.completion.then(()=>{completed=true;});
 process.emit('error',Error('Synthetic child error'));await Promise.resolve();assert.equal(observed.failed,true);assert.equal(observed.closed,false);assert.equal(completed,false);
 process.emit('close');await observed.completion;assert.equal(observed.closed,true);assert.equal(completed,true);
 const captured=captureOutput('',Buffer.from('P157_BLOCKED:synthetic\n'+workerToken+'\n'+'x'.repeat(40000)));assert.equal(captured.blocked,true);assert.equal(captured.leaked,true);assert.equal(captured.text.includes(workerToken),false);assert.equal(captured.text.includes('P157_BLOCKED:'),false);
});

test('callback, Promise and Resolver DNS queries are blocked while literal lookup uses no resolver',async()=>{
 const preload=pathToFileURL(join(workspace,'scripts','fixtures','isolated-vat-http-child.mjs')).href;
 const programs=["import dns from'node:dns';try{dns.resolve('127.0.0.1',()=>{});}catch{}", "import dns from'node:dns';try{await dns.promises.resolve4('127.0.0.1');}catch{}", "import dns from'node:dns/promises';try{await dns.resolve4('127.0.0.1');}catch{}", "import dns from'node:dns';try{new dns.Resolver();}catch{}", "import dns from'node:dns/promises';try{new dns.Resolver();}catch{}", "import dns from'node:dns';try{dns.lookupService('127.0.0.1',80,()=>{});}catch{}"];
 async function probe(program){
  const process=spawn(globalThis.process.execPath,['--import',preload,'--input-type=module','-e',program],{cwd:directory,env:childEnv,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let text='';for(const stream of[process.stdout,process.stderr])stream.on('data',chunk=>{text+=chunk.toString();});
  await new Promise((done,reject)=>{let timedOut=false,failed=false;const timer=setTimeout(()=>{timedOut=true;process.kill('SIGKILL');},5000);process.once('error',()=>{failed=true;});process.once('close',()=>{clearTimeout(timer);if(timedOut||failed)reject(Error('Synthetic DNS probe did not complete normally'));else done();});});
  return{code:process.exitCode,text};
 }
 for(const program of programs){const result=await probe(program);assert.equal(result.code,86);assert.ok(result.text.includes('P157_BLOCKED:dns-'));}
 const result=await probe("import assert from'node:assert/strict';import dns from'node:dns';assert.deepEqual(await dns.promises.lookup('127.0.0.1'),{address:'127.0.0.1',family:4});await new Promise((done,reject)=>dns.lookup('127.0.0.1',(error,address,family)=>{if(error)return reject(error);assert.equal(address,'127.0.0.1');assert.equal(family,4);done();}));");assert.equal(result.code,0);assert.equal(result.text,'');
});
