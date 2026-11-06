import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {supplierInvoiceFormOptions} from '../dist/modules/purchasing-catalogs/supplier-invoice.service.js';
import {invalidateRoleAccessCaches,primeRoleAccessCache} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();

const keys=['accounts','accountGroups','taxes','taxTypes','departments','classes','costs','creditors','related','customers','suppliers','paymentTerms','periods','currencies','rates','countries','subsidiaries','locations','invoices','invoiceLines'];
const bundle=(id=null)=>({...Object.fromEntries(keys.map(key=>[key,[]])),context:{subsidiaryId:1,invoiceId:id},suppliers:[{supplier_id:10,company_name:'Synthetic vendor',subsidiary_ids:[1],currency_ids:[1]}],invoices:id===null?[]:[{invoice_id:id,subsidiary_id:1}]});
const grant=(extra={})=>({resourceKey:'purchasing:supplier-invoices',canView:true,canCreate:false,canEdit:false,canDelete:false,...extra});
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;invalidateRoleAccessCaches();});
function syntheticConfig(t){
 const previous={};for(const key of ['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY'])previous[key]=process.env[key];
 process.env.SUPABASE_URL='https://synthetic.example.invalid';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-service-not-for-caller';
 t.after(()=>{for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
}

test('form options use one dedicated RPC with the public key, caller JWT and exact optional invoice ID',async t=>{
 syntheticConfig(t);const auth='Bearer invoice-form-creator';await primeRoleAccessCache(auth,{isAdmin:false,grants:[grant({canCreate:true})]});const calls=[];
 globalThis.fetch=async(url,init)=>{const headers=new Headers(init.headers),payload=JSON.parse(init.body);calls.push({path:new URL(url).pathname,method:init.method,payload,auth:headers.get('authorization'),key:headers.get('apikey')});return Response.json(bundle(payload.p_invoice_id));};
 assert.deepEqual(await supplierInvoiceFormOptions(auth),bundle());assert.deepEqual(await supplierInvoiceFormOptions(auth,42),bundle(42));
 assert.deepEqual(calls,[null,42].map(id=>({path:'/rest/v1/rpc/supplier_invoice_form_options',method:'POST',payload:{p_invoice_id:id},auth,key:'synthetic-public'})));
});

test('invalid service IDs never reach authorization or database calls',async t=>{
 syntheticConfig(t);let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected network');};
 for(const id of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1','',false,{},[]])await assert.rejects(async()=>supplierInvoiceFormOptions('Bearer synthetic-invalid-id',id),error=>error.status===400);
 assert.equal(calls,0);
});

test('anonymous, denied and blind roles receive no references; readers and editors cannot load a creation form',async t=>{
 syntheticConfig(t);let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected network');};
 await assert.rejects(supplierInvoiceFormOptions(''),error=>error.status===401);
 for(const[role,grants]of [['denied',[]],['delete',[grant({canView:false,canDelete:true})]],['blind',[grant({canView:false,canCreate:true,canEdit:true})]]]){
  const auth='Bearer invoice-form-'+role;await primeRoleAccessCache(auth,{isAdmin:false,grants});await assert.rejects(supplierInvoiceFormOptions(auth),error=>error.status===403);await assert.rejects(supplierInvoiceFormOptions(auth,42),error=>error.status===403);
 }
 for(const[role,permission]of [['reader',grant()],['editor',grant({canEdit:true})]]){const auth='Bearer invoice-form-'+role;await primeRoleAccessCache(auth,{isAdmin:false,grants:[permission]});await assert.rejects(supplierInvoiceFormOptions(auth),error=>error.status===403);}
 assert.equal(calls,0);
});

test('SQL scope denials and server errors retain safe statuses without master or service-role fallback',async t=>{
 syntheticConfig(t);const auth='Bearer invoice-form-reader';await primeRoleAccessCache(auth,{isAdmin:false,grants:[grant()]});let calls=0;
 for(const[status,code,expected]of [[403,'42501',403],[400,'22023',400],[500,'XX000',500]]){
  globalThis.fetch=async(url)=>{calls++;assert.equal(new URL(url).pathname,'/rest/v1/rpc/supplier_invoice_form_options');return Response.json({code,message:'PRIVATE SQL SOURCE AND ENTITY DATA'},{status});};
  await assert.rejects(supplierInvoiceFormOptions(auth,42),error=>error.status===expected&&!/PRIVATE|SOURCE|ENTITY DATA/.test(error.message));
 }
 assert.equal(calls,3);
});

test('HTTP form options enforce create versus selected-invoice view, strict IDs and unchanged independent master permissions',{timeout:45000},async t=>{
 const calls=[],roles={creator:grant({canCreate:true}),reader:grant(),editor:grant({canEdit:true}),blind:grant({canView:false,canCreate:true,canEdit:true}),deleter:grant({canView:false,canDelete:true}),denied:null,admin:null,sqlDenied:grant({canCreate:true})};
 const stub=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer form-http-','');
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:roles[role]?[roles[role]]:[]}}));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const payload=JSON.parse(Buffer.concat(chunks).toString()||'{}');calls.push({path:req.url,auth:req.headers.authorization,key:req.headers.apikey,payload});
  if(req.url!=='/rest/v1/rpc/supplier_invoice_form_options'){res.writeHead(500);res.end(JSON.stringify({code:'XX000',message:'Unexpected master access'}));return;}
  if(role==='sqlDenied'){res.writeHead(403);res.end(JSON.stringify({code:'42501',message:'PRIVATE SQL SCOPE'}));return;}
  res.end(JSON.stringify(bundle(payload.p_invoice_id)));
 });
 await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{stub.closeAllConnections();stub.close(resolve);}));
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const env={};for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','ComSpec','PATHEXT'])if(process.env[key])env[key]=process.env[key];
 Object.assign(env,{NODE_ENV:'test',PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',EMAIL_NOTIFICATIONS_ENABLED:'false',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'synthetic-public',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-never-used',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'});
 const child=spawn(process.execPath,['dist/server.js'],{env,stdio:'ignore'});t.after(async()=>{if(child.exitCode!==null)return;const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;});
 const base=`http://127.0.0.1:${port}`;let ready=false;
 for(let attempt=0;attempt<100;attempt++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready,'Synthetic HTTP server starts');
 const path='/api/purchasing/supplier-invoice-form-options';const headers=role=>({Authorization:'Bearer form-http-'+role,'X-Device-Token':'synthetic-invoice-form-device'});
 for(const role of Object.keys(roles))for(const suffix of ['', '?invoiceId=42']){
  const before=calls.length,result=await fetch(base+path+suffix,{headers:headers(role)}),allowed=(suffix?['creator','reader','editor','admin','sqlDenied']:['creator','admin','sqlDenied']).includes(role);assert.equal(result.status,allowed&&role!=='sqlDenied'?200:403,role+' '+suffix);assert.match(result.headers.get('cache-control')||'',/private, no-store/);assert.equal(calls.length,before+(allowed?1:0));
  if(allowed){assert.deepEqual(calls.at(-1),{path:'/rest/v1/rpc/supplier_invoice_form_options',auth:'Bearer form-http-'+role,key:'synthetic-public',payload:{p_invoice_id:suffix?42:null}});if(role==='sqlDenied')assert.doesNotMatch(await result.text(),/PRIVATE SQL SCOPE/);else assert.deepEqual(await result.json(),bundle(suffix?42:null));}
 }
 const invalid=['','0','01','-1','+1','1.0','1e3','0x10','../2',' 1','1 ','1\n','١','１２','9007199254740992','9223372036854775807','9'.repeat(1000)];
 for(const query of [...invalid.map(value=>'?'+new URLSearchParams({invoiceId:value})),'?invoiceId=42&invoiceId=42','?invoiceId=1&invoiceId=2']){
  const before=calls.length;assert.equal((await fetch(base+path+query,{headers:headers('creator')})).status,400,query);assert.equal(calls.length,before,'Malformed ID must not reach an RPC');
 }
 let before=calls.length;assert.equal((await fetch(base+path)).status,401);assert.equal(calls.length,before);
 for(const method of ['POST','PUT','PATCH','DELETE']){before=calls.length;assert.equal((await fetch(base+path,{method,headers:headers('creator')})).status,405);assert.equal(calls.length,before);}
 for(const master of ['/api/entities/suppliers','/api/accounting/chart-accounts','/api/configuration/tax-codes','/api/organization/accounting-periods']){before=calls.length;assert.equal((await fetch(base+master,{headers:headers('creator')})).status,403);assert.equal(calls.length,before,'Invoice options grant must not grant master access');}
});
