import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {runAccountingReport} from '../dist/modules/reports/accounting-reports.service.js';
import {runSupplierAdvancesReport} from '../dist/modules/reports/supplier-advances-report.service.js';
import {isFinancialReportRoute} from '../dist/modules/reports/report-access.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const auth='Bearer synthetic-supplier-advances',origin='https://supplier-advances.example.invalid',key='synthetic-public';
const original={fetch:globalThis.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY};
const base={subsidiaryIds:[1],dateTo:'2026-10-31'},defaults={...base,bookId:null,supplierId:null,currencyId:null,onlyNonzero:true,page:1,pageSize:50};
const report={reportMode:'UNAPPLIED_ADVANCES',rows:[{rowId:'JL:42:BOOK:1',sourceKey:'JL:42:BOOK:1',sourceLineId:42,advanceOriginal:100,appliedOriginal:30,pendingOriginal:70,advanceLocal:16000,appliedLocal:4800,pendingLocal:11200,currencyCode:'USD'}],total:1,page:1,pageSize:50,currencyTotals:[],supplierTotals:[],summary:{pendingLocal:11200},account:{number:'115004'},localCurrency:{id:1,code:'JMD'}};
let calls;
beforeEach(async()=>{
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;calls=[];invalidateRoleAccessCaches();
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}]});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json(report);};
});
afterEach(()=>{globalThis.fetch=original.fetch;invalidateRoleAccessCaches();});
after(()=>{for(const[name,field]of[['SUPABASE_URL','url'],['SUPABASE_ANON_KEY','key']])if(original[field]===undefined)delete process.env[name];else process.env[name]=original[field];});

test('supplier advances use their own guarded read RPC with one company, cutoff and preserved caller identity',async()=>{
 const input=structuredClone(base),result=await runAccountingReport(auth,'supplier-advances',input);assert.deepEqual(input,base);assert.deepEqual(result,report);assert.equal(calls.length,1);
 const call=calls[0],headers=new Headers(call.init.headers);assert.equal(call.url,origin+'/rest/v1/rpc/run_supplier_advances_report');assert.equal(call.init.method,'POST');assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),key);assert.deepEqual(JSON.parse(call.init.body),{p_filters:defaults});
 assert.equal(isFinancialReportRoute('POST','/api/reports/accounting/supplier-advances'),true);assert.equal(isFinancialReportRoute('GET','/api/reports/accounting/supplier-advances'),false);
});

test('book, supplier, currency and export pages normalize while legacy flags cannot include fully applied advances',async()=>{
 for(const onlyNonzero of[true,false]){
  const input={subsidiaryIds:['1'],dateTo:'2026-10-31',bookId:'2',supplierId:'3',currencyId:'4',onlyNonzero,page:2,pageSize:250},before=structuredClone(input);
  assert.deepEqual(await runSupplierAdvancesReport(auth,input),report);assert.deepEqual(input,before);assert.deepEqual(JSON.parse(calls.at(-1).init.body),{p_filters:{...input,subsidiaryIds:[1],bookId:2,supplierId:3,currencyId:4,onlyNonzero:true}});
 }
 await runSupplierAdvancesReport(auth,{...base,bookId:'',supplierId:null,currencyId:null});assert.deepEqual(JSON.parse(calls.at(-1).init.body),{p_filters:defaults});
});

test('invalid scopes, real-calendar dates, injected fields, coercions and unbounded pages are rejected before any provider query',async()=>{
 const cases=[null,[],{},...[
  {subsidiaryIds:[]},{subsidiaryIds:[1,2]},{subsidiaryIds:'1'},{subsidiaryIds:[true]},{subsidiaryIds:['01']},{subsidiaryIds:[9007199254740992]},
  {dateTo:'2026-02-30'},{dateTo:'2026-13-01'},{dateTo:'2026-10-31T12:00:00Z'},{dateTo:'31/10/2026'},{dateTo:'0000-01-01'},
  {bookId:0},{supplierId:'1e3'},{currencyId:[]},{onlyNonzero:'false'},{onlyNonzero:null},{page:0},{page:2_147_483_648},{pageSize:251},
  {accountId:99},{accountNumber:'211001'},{consolidated:true},{presentationCurrency:'USD'},{dateFrom:'2026-10-01'},
 ].map(patch=>({...base,...patch}))];
 for(const input of cases)await assert.rejects(runSupplierAdvancesReport(auth,input),error=>error.status===400);
 assert.equal(calls.length,0);
});

test('authorization precedes malformed filters and no denied caller can probe account information',async()=>{
 await assert.rejects(runSupplierAdvancesReport('',null),error=>error.status===401);await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 await assert.rejects(runAccountingReport(auth,'supplier-advances',{accountId:99}),error=>error.status===403);assert.equal(calls.length,0);
});

test('provider permission, validation and malformed-response failures expose only safe report errors',async()=>{
 for(const[http,code,status]of[[401,'42501',401],[403,'42501',403],[400,'42501',403],[400,'22023',400],[500,'XX000',500]]){
  globalThis.fetch=async()=>Response.json({code,message:'PRIVATE SQL body and supplier identifiers',details:'PRIVATE row',hint:'PRIVATE hint'},{status:http});
  await assert.rejects(runSupplierAdvancesReport(auth,base),error=>error.status===status&&!/PRIVATE|XX000|42501/.test(error.message));
 }
 for(const payload of['not JSON','null','[]']){globalThis.fetch=async()=>new Response(payload,{status:200});await assert.rejects(runSupplierAdvancesReport(auth,base),error=>error.status===502&&!error.message.includes(payload));}
 for(const mode of[undefined,'LEDGER']){globalThis.fetch=async()=>Response.json({...report,reportMode:mode});await assert.rejects(runSupplierAdvancesReport(auth,base),error=>error.status===502);}
});

test('the real accounting HTTP route enforces view rights and forwards only the compact report filters',{timeout:30000},async t=>{
 globalThis.fetch=original.fetch;const queries=[];
 const stub=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const allowed=req.headers.authorization==='Bearer advances-http-reader';
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:allowed,canCreate:!allowed,canEdit:false,canDelete:false}]}}));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');queries.push({path:req.url,auth:req.headers.authorization,key:req.headers.apikey,body});res.end(JSON.stringify(report));
 });
 await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{stub.closeAllConnections();stub.close(resolve);}));
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:key,SUPABASE_SERVICE_ROLE_KEY:'synthetic-server',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());
 const server=`http://127.0.0.1:${port}`;let ready=false;for(let n=0;n<100;n++){try{if((await original.fetch(server+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready);
 const post=(token,body)=>original.fetch(server+'/api/reports/accounting/supplier-advances',{method:'POST',headers:{...(token?{Authorization:token}:{}),'X-Device-Token':'synthetic-advances-device','Content-Type':'application/json'},body:JSON.stringify(body)});
 for(const[token,status]of[['',401],['Bearer advances-http-writer',403]]){const response=await post(token,base);assert.equal(response.status,status);assert.equal(queries.length,0);}
 const invalid=await post('Bearer advances-http-reader',{...base,accountId:99});assert.equal(invalid.status,400);assert.equal(queries.length,0);
 const valid=await post('Bearer advances-http-reader',base);assert.equal(valid.status,200);assert.deepEqual(await valid.json(),report);assert.deepEqual(queries,[{path:'/rest/v1/rpc/run_supplier_advances_report',auth:'Bearer advances-http-reader',key,body:{p_filters:defaults}}]);
});
