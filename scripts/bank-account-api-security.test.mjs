import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
import {createBankingRow,updateBankingRow,deleteBankingRow,getBankingCatalog} from '../dist/modules/banking-catalogs/banking-catalogs.module.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
const resource='banking:bank-accounts',payload={account_number:'SYNTHETIC',bank_id:1,subsidiary_id:1,currency_id:1,account_id:101,country_id:1};
test('llamadas internas de catalogo exigen permisos antes de consultar',async t=>{
 t.after(()=>invalidateRoleAccessCaches());const auth='Bearer account-direct-denied',c=getBankingCatalog('bank-accounts');await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 for(const action of [()=>createBankingRow(c,auth,payload),()=>updateBankingRow(c,auth,17,payload),()=>deleteBankingRow(c,auth,17)])await assert.rejects(action(),e=>e.status===403);
 await assert.rejects(createBankingRow(c,'',payload),e=>e.status===401);
 for(const id of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1])await assert.rejects(updateBankingRow(c,auth,id,payload),e=>e.status===400);
});
test('tres rutas de catalogo usan RPC autorizado y conservan JWT, apikey y payload', {timeout:25000},async t=>{
 const calls=[],roles={denied:null,reader:'view',creator:'create',editor:'edit',deleter:'delete',admin:'admin'};
 const stub=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer account-http-','');
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:[{resourceKey:resource,canView:roles[role]==='view',canCreate:roles[role]==='create',canEdit:roles[role]==='edit',canDelete:roles[role]==='delete'}]}}));return;}
  const chunks=[];for await(const c of req)chunks.push(c);calls.push({path:req.url,auth:req.headers.authorization,key:req.headers.apikey,payload:JSON.parse(Buffer.concat(chunks).toString()||'{}')});
  if(role==='admin'&&req.url.endsWith('/update_bank_account')){res.writeHead(403);res.end(JSON.stringify({code:'42501',message:'private SQL detail'}));return;}
  res.end(JSON.stringify({bank_account_id:17,balance:0}));
 });
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{stub.closeAllConnections();stub.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'server-fixture',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});
 t.after(()=>child.kill());let ready=false;for(let n=0;n<70;n++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const cases=[['POST','','create','create_bank_account',payload,{p_payload:payload}],['PATCH','/17','edit','update_bank_account',payload,{p_bank_account_id:17,p_payload:payload}],['DELETE','/17','delete','delete_bank_account',undefined,{p_bank_account_id:17}]];
 for(const [method,path,action,rpc,body,expected]of cases){
  const url=`http://127.0.0.1:${port}/api/banking/bank-accounts`+path;
  for(const [role,grant]of Object.entries(roles)){
   const auth=`Bearer account-http-${role}`,before=calls.length;
   const response=await fetch(url,{method,headers:{Authorization:auth,'X-Device-Token':'account-http-device-fixture','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   const allowed=role==='admin'||grant===action,sqlDenied=role==='admin'&&action==='edit';
   assert.equal(response.status,!allowed||sqlDenied?403:action==='create'?201:200,`${role} ${rpc}`);assert.equal(calls.length,before+(allowed?1:0));
   if(allowed)assert.deepEqual(calls.at(-1),{path:'/rest/v1/rpc/'+rpc,auth,key:'public-fixture',payload:expected});
   if(sqlDenied)assert.doesNotMatch(await response.text(),/private SQL detail/);
  }
  const before=calls.length;assert.equal((await fetch(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})})).status,401);assert.equal(calls.length,before);
 }
});
test('formulario mantiene saldo visible de solo lectura y lo excluye de crear/editar',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const catalog=vm.runInNewContext('('+source.split('\n').find(l=>l.includes("slug:'bank-accounts'")).trim().replace(/,$/,'')+')');
 const methods=vm.runInNewContext('({'+source.slice(source.indexOf('async submitRecord() {'),source.indexOf('async calculateConsolidatedRates()'))+'})');
 // Exercise submitRecord itself with UI state and stubbed transport, without finance data.
 assert.equal(catalog.fields.find(f=>f.key==='balance').readOnly,true);
 for(const id of [null,17]){
  let sent;const state={activeCatalog:catalog,recordDialog:{id,values:{...payload,balance:900}},validateSubsidiaryForm(){},validateChartAccountSubsidiaries(){},validateUserSubsidiaries(){},validateChartAccountReferences(){},validateAutorentConfiguration(){},normalizeBankStatementPayload(){},catalogPath:()=>'/api/banking/bank-accounts',api:async(path,request)=>{sent=JSON.parse(request.body);return{};},loadCatalog:async()=>{}};
  await methods.submitRecord.call(state);assert.ok(sent, state.dialogError);assert.equal(Object.hasOwn(sent,'balance'),false);assert.equal(sent.account_number,payload.account_number);
 }
});
