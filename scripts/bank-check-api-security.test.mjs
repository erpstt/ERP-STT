import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {bankCheckOptions,bankCheckReport,bankCheckDetail,saveBankCheck,deleteBankCheck} from '../dist/modules/banking-catalogs/bank-check.service.js';
import {bankCheckPeriods} from '../dist/modules/banking-catalogs/bank-check-period.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
const resource='banking:bank-checks';
const payload={bank_account_id:1,payment_type:'CHEQUE',payment_date:'2026-10-10',bank_reference:'SYNTHETIC',currency_id:1,exchange_rate:1,fiscal_period_id:10,lines:[{amount:100,account_id:103}]};
const filters={dateFrom:'2026-10-01',dateTo:'2026-10-31'};
const cases=[['GET','/checks/options','view','bank_check_options',undefined,{}],['GET','/checks/periods','view','bank_check_periods',undefined,{}],['POST','/checks/report','view','bank_check_report',filters,{p_filters:filters}],['GET','/checks/17','view','bank_check_detail',undefined,{p_check_id:17}],['POST','/checks','create','save_bank_check_transfer',payload,{p_payload:payload,p_check_id:null}],['PUT','/checks/17','edit','save_bank_check_transfer',payload,{p_payload:payload,p_check_id:17}],['DELETE','/checks/17','delete','delete_bank_check_transfer',undefined,{p_check_id:17}]];

test('autorizacion interna de las siete operaciones precede a cualquier consulta',async t=>{
 t.after(()=>invalidateRoleAccessCaches());const auth='Bearer check-direct-denied';await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 for(const action of [()=>bankCheckOptions(auth),()=>bankCheckPeriods(auth),()=>bankCheckReport(auth,filters),()=>bankCheckDetail(auth,17),()=>saveBankCheck(auth,payload),()=>saveBankCheck(auth,payload,17),()=>deleteBankCheck(auth,17)])await assert.rejects(action(),e=>e.status===403);
 await assert.rejects(bankCheckOptions(''),e=>e.status===401);
 for(const id of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>bankCheckDetail(auth,id),e=>e.status===400);
});
test('siete rutas exigen view/create/edit/delete y conservan identidad, parametros y denegaciones SQL', {timeout:25000},async t=>{
 const calls=[];const roles={denied:null,reader:'view',creator:'create',editor:'edit',deleter:'delete',admin:'admin'};
 const stub=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer check-http-','');
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:[{resourceKey:resource,canView:roles[role]==='view',canCreate:roles[role]==='create',canEdit:roles[role]==='edit',canDelete:roles[role]==='delete'}]}}));return;}
  const chunks=[];for await(const c of req)chunks.push(c);calls.push({path:req.url,auth:req.headers.authorization,key:req.headers.apikey,payload:JSON.parse(Buffer.concat(chunks).toString()||'{}')});
  if(role==='admin'&&req.url.endsWith('/save_bank_check_transfer')){res.writeHead(403);res.end(JSON.stringify({code:'42501',message:'private SQL detail'}));return;}
  res.end(JSON.stringify({fixture:true}));
 });
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{stub.closeAllConnections();stub.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'server-fixture',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});
 t.after(()=>child.kill());let ready=false;for(let n=0;n<70;n++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 for(const [method,path,action,rpc,body,expected]of cases){
  const url=`http://127.0.0.1:${port}/api/banking`+path;
  for(const [role,grant]of Object.entries(roles)){
   const auth=`Bearer check-http-${role}`;const before=calls.length;
   const response=await fetch(url,{method,headers:{Authorization:auth,'X-Device-Token':'check-http-device-fixture','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   const allowed=role==='admin'||grant===action;const sqlDenied=role==='admin'&&rpc==='save_bank_check_transfer';
   assert.equal(response.status,!allowed||sqlDenied?403:method==='POST'&&path==='/checks'?201:200,`${role} ${rpc}`);
   assert.equal(calls.length,before+(allowed?1:0));
   if(allowed)assert.deepEqual(calls.at(-1),{path:'/rest/v1/rpc/'+rpc,auth,key:'public-fixture',payload:expected});
   if(sqlDenied)assert.doesNotMatch(await response.text(),/private SQL detail/);
  }
  const before=calls.length;const anon=await fetch(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});assert.equal(anon.status,401);assert.equal(calls.length,before);
 }
});
