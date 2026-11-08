import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {runAccountingReport} from '../dist/modules/reports/accounting-reports.service.js';
import {runAccruedPayrollPayablesReport} from '../dist/modules/reports/accrued-payroll-payables-report.service.js';
import {isFinancialReportRoute} from '../dist/modules/reports/report-access.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const auth='Bearer synthetic-accrued-payroll',origin='https://accrued-payroll.example.invalid',key='synthetic-public';
const original={fetch:globalThis.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_ANON_KEY};
const base={subsidiaryIds:[1],dateFrom:'2026-10-01',dateTo:'2026-10-31'},defaults={...base,bookId:null,accountId:null,currencyId:null,departmentId:null,costCenterId:null,onlyNonzero:true,page:1,pageSize:50};
const report={rows:[{sourceKey:'JL:42:BOOK:1',rowKind:'movement',movementType:'payroll',creditOriginal:100,creditLocal:16000,currencyCode:'USD'}],totalRows:1,movementCount:1,page:1,pageSize:50,group:{code:'223'},summary:{controlClosingLocal:16000},dataFingerprint:'0123456789abcdef0123456789abcdef'};
let calls;
beforeEach(async()=>{
 process.env.SUPABASE_URL=origin;process.env.SUPABASE_ANON_KEY=key;calls=[];invalidateRoleAccessCaches();
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}]});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json(report);};
});
afterEach(()=>{globalThis.fetch=original.fetch;invalidateRoleAccessCaches();});
after(()=>{for(const[name,field]of[['SUPABASE_URL','url'],['SUPABASE_ANON_KEY','key']])if(original[field]===undefined)delete process.env[name];else process.env[name]=original[field];});

test('the 223 report uses its guarded RPC with a date range, one company and the caller identity',async()=>{
 const input=structuredClone(base);assert.deepEqual(await runAccountingReport(auth,'accrued-payroll-payables',input),report);assert.deepEqual(input,base);assert.equal(calls.length,1);
 const call=calls[0],headers=new Headers(call.init.headers);assert.equal(call.url,origin+'/rest/v1/rpc/run_accrued_payroll_payables_report');assert.equal(call.init.method,'POST');assert.equal(headers.get('Authorization'),auth);assert.equal(headers.get('apikey'),key);assert.deepEqual(JSON.parse(call.init.body),{p_filters:defaults});
 assert.equal(isFinancialReportRoute('POST','/api/reports/accounting/accrued-payroll-payables'),true);assert.equal(isFinancialReportRoute('GET','/api/reports/accounting/accrued-payroll-payables'),false);
});

test('account, native currency, department, cost center, book and complete-export pages normalize without mutating filters',async()=>{
 for(const onlyNonzero of[true,false]){
  const input={...base,subsidiaryIds:['1'],bookId:'2',accountId:'3',currencyId:'4',departmentId:'5',costCenterId:'6',onlyNonzero,page:2,pageSize:250},before=structuredClone(input);
  assert.deepEqual(await runAccruedPayrollPayablesReport(auth,input),report);assert.deepEqual(input,before);assert.deepEqual(JSON.parse(calls.at(-1).init.body),{p_filters:{...input,subsidiaryIds:[1],bookId:2,accountId:3,currencyId:4,departmentId:5,costCenterId:6}});
 }
 await runAccruedPayrollPayablesReport(auth,{...base,bookId:'',accountId:null,currencyId:null,departmentId:'',costCenterId:null});assert.deepEqual(JSON.parse(calls.at(-1).init.body),{p_filters:defaults});
});

test('invalid companies, calendar ranges, inherited scopes, coercions and unbounded pages never reach the provider',async()=>{
 const cases=[null,[],{},Object.create(base),...[
  {subsidiaryIds:[]},{subsidiaryIds:[1,2]},{subsidiaryIds:'1'},{subsidiaryIds:[true]},{subsidiaryIds:['01']},{subsidiaryIds:[9007199254740992]},
  {dateFrom:'2026-02-30'},{dateTo:'2026-13-01'},{dateFrom:'2026-11-01'},{dateTo:'2026-10-31T12:00:00Z'},{dateFrom:'01/10/2026'},{dateFrom:'0000-01-01'},
  {bookId:0},{accountId:'1e3'},{currencyId:[]},{departmentId:true},{costCenterId:' 6 '},{onlyNonzero:'false'},{onlyNonzero:null},{page:0},{page:2_147_483_648},{pageSize:251},
  {groupCode:'224'},{supplierId:7},{consolidated:true},{presentationCurrency:'USD'},{movementType:'payroll'},
 ].map(patch=>({...base,...patch}))];
 for(const input of cases)await assert.rejects(runAccruedPayrollPayablesReport(auth,input),error=>error.status===400);
 assert.equal(calls.length,0);
});

test('view authorization precedes filter validation and blocks write-only users from probing account data',async()=>{
 await assert.rejects(runAccruedPayrollPayablesReport('',null),error=>error.status===401);await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 await assert.rejects(runAccountingReport(auth,'accrued-payroll-payables',{accountId:99}),error=>error.status===403);assert.equal(calls.length,0);
});

test('permission, validation and malformed-provider failures disclose only safe report errors',async()=>{
 for(const[http,code,status]of[[401,'42501',401],[403,'42501',403],[400,'42501',403],[400,'22023',400],[500,'XX000',500]]){
  globalThis.fetch=async()=>Response.json({code,message:'PRIVATE SQL body and payroll identifiers',details:'PRIVATE row',hint:'PRIVATE hint'},{status:http});
  await assert.rejects(runAccruedPayrollPayablesReport(auth,base),error=>error.status===status&&!/PRIVATE|XX000|42501/.test(error.message));
 }
 for(const payload of['not JSON','null','[]']){globalThis.fetch=async()=>new Response(payload,{status:200});await assert.rejects(runAccruedPayrollPayablesReport(auth,base),error=>error.status===502&&!error.message.includes(payload));}
});

test('the real accounting HTTP route enforces read rights and forwards the exact compact report contract',{timeout:30000},async t=>{
 globalThis.fetch=original.fetch;const queries=[];
 const stub=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const allowed=req.headers.authorization==='Bearer accrued-http-reader';
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:false,grants:[{resourceKey:'reports:accounting-reports',canView:allowed,canCreate:!allowed,canEdit:false,canDelete:false}]}}));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');queries.push({path:req.url,auth:req.headers.authorization,key:req.headers.apikey,body});res.end(JSON.stringify(report));
 });
 await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{stub.closeAllConnections();stub.close(resolve);}));
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:key,SUPABASE_SERVICE_ROLE_KEY:'synthetic-server',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());
 const server=`http://127.0.0.1:${port}`;let ready=false;for(let n=0;n<100;n++){try{if((await original.fetch(server+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready);
 const post=(token,body)=>original.fetch(server+'/api/reports/accounting/accrued-payroll-payables',{method:'POST',headers:{...(token?{Authorization:token}:{}),'X-Device-Token':'synthetic-accrued-device','Content-Type':'application/json'},body:JSON.stringify(body)});
 for(const[token,status]of[['',401],['Bearer accrued-http-writer',403]]){const response=await post(token,base);assert.equal(response.status,status);assert.equal(queries.length,0);}
 const invalid=await post('Bearer accrued-http-reader',{...base,dateFrom:'2026-11-01'});assert.equal(invalid.status,400);assert.equal(queries.length,0);
 const valid=await post('Bearer accrued-http-reader',base);assert.equal(valid.status,200);assert.deepEqual(await valid.json(),report);assert.deepEqual(queries,[{path:'/rest/v1/rpc/run_accrued_payroll_payables_report',auth:'Bearer accrued-http-reader',key,body:{p_filters:defaults}}]);
});
