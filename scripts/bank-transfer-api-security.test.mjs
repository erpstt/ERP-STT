import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {bankTransferOptions,createBankTransfer,runBankTransferReport,bankTransferJournal} from '../dist/modules/banking-catalogs/bank-transfer.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const resource='banking:bank-transfers';
const transfer={sourceAccountId:1,destinationAccountId:2,sourceAmount:100,destinationAmount:100,transferDate:'2026-10-10'};
const filters={dateFrom:'2026-10-01',dateTo:'2026-10-31'};
const endpoints=[
 ['GET','/options','view','bank_transfer_options',{},undefined],
 ['POST','','create','create_bank_transfer',{p_payload:transfer},transfer],
 ['POST','/report','view','run_bank_transfer_report',{p_filters:filters},filters],
 ['GET','/17/journal','view','bank_transfer_journal',{p_transfer_id:17},undefined]
];

test('las llamadas internas exigen permisos antes de consultar datos y validan identificadores',async t=>{
 t.after(()=>invalidateRoleAccessCaches());const auth='Bearer transfer-direct-denied';
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 for(const action of [()=>bankTransferOptions(auth),()=>createBankTransfer(auth,transfer),()=>runBankTransferReport(auth,filters),()=>bankTransferJournal(auth,17)])
  await assert.rejects(action(),e=>e.status===403);
 await assert.rejects(bankTransferOptions(''),e=>e.status===401);
 for(const id of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>bankTransferJournal(auth,id),e=>e.status===400);
});

test('las cuatro rutas respetan lectura/creacion y el JWT; los rechazos no invocan operaciones bancarias', {timeout:25000},async t=>{
 const calls=[];const roles={denied:null,reader:'view',creator:'create',editor:'edit',admin:'admin'};
 const stub=createServer(async(request,response)=>{
  response.setHeader('Content-Type','application/json');const role=request.headers.authorization?.replace('Bearer transfer-http-','');
  if(request.url==='/rest/v1/rpc/assert_request_access'){
   response.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:[{resourceKey:resource,canView:roles[role]==='view',canCreate:roles[role]==='create',canEdit:roles[role]==='edit',canDelete:false}]}}));return;
  }
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  calls.push({path:request.url,authorization:request.headers.authorization,key:request.headers.apikey,payload:JSON.parse(Buffer.concat(chunks).toString()||'{}')});
  if(role==='admin'&&request.url.endsWith('/bank_transfer_journal')){response.writeHead(403);response.end(JSON.stringify({code:'42501',message:'private SQL detail'}));return;}
  response.end(JSON.stringify({fixture:true}));
 });
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{stub.closeAllConnections();stub.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'server-fixture',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});
 t.after(()=>child.kill());let ready=false;
 for(let n=0;n<70;n++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready);const base=`http://127.0.0.1:${port}/api/banking/transfers`;let checked=0;
 for(const [method,path,action,rpc,payload,body] of endpoints){
  for(const [role,grant]of Object.entries(roles)){
   const authorization=`Bearer transfer-http-${role}`;const before=calls.length;
   const response=await fetch(base+path,{method,headers:{Authorization:authorization,'X-Device-Token':'transfer-http-device-fixture','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   const allowed=role==='admin'||grant===action;const sqlDenied=role==='admin'&&rpc==='bank_transfer_journal';
   assert.equal(response.status,!allowed||sqlDenied?403:rpc==='create_bank_transfer'?201:200,`${role} ${rpc}`);
   if(!allowed)assert.equal(calls.length,before,'Sin permiso no debe llamar a los RPC');
   else{assert.equal(calls.length,before+1);assert.deepEqual(calls.at(-1),{path:`/rest/v1/rpc/${rpc}`,authorization,key:'public-fixture',payload});}
   if(sqlDenied)assert.doesNotMatch(await response.text(),/private SQL detail/);checked++;
  }
  const before=calls.length;const anonymous=await fetch(base+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  assert.equal(anonymous.status,401);assert.equal(calls.length,before);
 }
 assert.equal(checked,20);
});
