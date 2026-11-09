import '../dist/modules/security-catalogs/role-access-matrix.module.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {isFinancialReportRoute} from '../dist/modules/reports/report-access.service.js';

test('complete ledger downloads enforce the report boundary and return trusted binary attachments',{timeout:90000},async t=>{
 assert.equal(isFinancialReportRoute('POST','/api/reports/accounting/general-ledger/export'),true);
 assert.equal(isFinancialReportRoute('GET','/api/reports/accounting/general-ledger/export'),false);
 const calls=[];let mode='complete';
 const snapshot=filters=>{
  const rows=[1,2].map((id,index)=>({id,account_id:10,account_number:'00115004',account_name:'Adelantos sintéticos',nature:'Deudora',date:'2026-11-02',transaction_type:'Asiento de Diario General',transaction_number:'SYN-'+id,journal_number:'SYN-JRN-'+id,entity_type:'Proveedor',entity_name:'Proveedor sintético',cost_center:'SYN-CC',concept:'Movimiento de prueba '+id,debit:1,credit:0,running_balance:101+index,opening_balance:100,account_debit_total:2,account_credit_total:0,account_final_balance:102,original_currency_code:index?'JMD':'USD',original_exchange_rate:index?1:5,original_debit:index?1:0.2,original_credit:0}));
  return{rows,total:2,summary:{debit:2,credit:0},snapshotFingerprint:'a'.repeat(32),context:{subsidiary:{id:1,name:'Empresa sintética'},localCurrency:{id:1,code:'JMD',name:'Dólar jamaiquino'},book:null,bookId:null,dateFrom:filters.dateFrom,dateTo:filters.dateTo,filters,generatedAt:'2026-11-09T20:30:00.000Z'}};
 };
 const upstream=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const auth=req.headers.authorization||'',role=auth.replace('Bearer synthetic-ledger-export-','');
  const access={isAdmin:false,grants:role==='reader'||role==='sql-denied'?[{resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}]:[]};
  if(req.url==='/rest/v1/rpc/assert_request_access')return res.end(JSON.stringify({allowed:true,roleAccess:access}));
  if(req.url==='/rest/v1/rpc/security_my_role_access')return res.end(JSON.stringify(access));
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push({path:req.url,auth,key:req.headers.apikey,device:req.headers['x-device-token'],deviceHash:req.headers['x-erp-device-hash'],body});
  if(req.url!=='/rest/v1/rpc/run_general_ledger_export'){res.statusCode=500;return res.end(JSON.stringify({message:'Unexpected synthetic RPC'}));}
  if(role==='sql-denied'){res.statusCode=403;return res.end(JSON.stringify({code:'42501',message:'PRIVATE SQL DETAILS'}));}
  const result=snapshot(body.p_filters);
  if(mode==='partial')result.rows.pop();
  if(mode==='wrong-company')result.context.subsidiary.id=2;
  res.end(JSON.stringify(result));
 });
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{upstream.closeAllConnections();upstream.close(resolve);}));
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,SUPABASE_ANON_KEY:'synthetic-ledger-public-key',SUPABASE_PUBLISHABLE_KEY:'synthetic-ledger-public-key',DISABLE_BACKGROUND_JOBS:'true',SMTP_ENABLED:'false',PDF_RENDERER_URL:'',PDF_RENDERER_TOKEN:'',CHROME_PATH:chromium.executablePath()},stdio:'ignore'});t.after(()=>child.kill());
 const base=`http://127.0.0.1:${port}`;let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready);
 const filters={subsidiaryIds:[1],bookId:null,dateFrom:'2026-11-01',dateTo:'2026-11-09',accountId:null,accountIds:[],accountFrom:null,accountTo:null,entityType:null,entityId:null,costCenterId:null};
 const send=(input,role='reader',method='POST')=>fetch(base+'/api/reports/accounting/general-ledger/export',{method,headers:{...(role?{Authorization:'Bearer synthetic-ledger-export-'+role}:{}),'X-Device-Token':'synthetic-ledger-device','Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(input)})});
 for(const role of ['', 'denied']){const before=calls.length,response=await send({format:'csv',view:'ACCOUNT',filters},role);assert.ok([401,403].includes(response.status));assert.equal(response.headers.get('content-disposition'),null);await response.arrayBuffer();assert.equal(calls.length,before);}
 const get=await send({},'reader','GET');assert.equal(get.status,405);await get.arrayBuffer();
 for(const input of [{format:'html',view:'ACCOUNT',filters},{format:'csv',view:'ACCOUNT',filters,html:'<script>bad</script>'},{format:'csv',view:'ACCOUNT',filters,rows:[]},{format:'csv',view:'UNSUPPORTED',filters},{format:'csv',view:'ACCOUNT',filters:{...filters,page:99}},{format:'csv',view:'ACCOUNT',filters:{...filters,subsidiaryIds:[1,2]}}]){
  const before=calls.length,response=await send(input);assert.equal(response.status,400);assert.equal(response.headers.get('content-disposition'),null);await response.arrayBuffer();assert.equal(calls.length,before);
 }
 for(const[format,mime,magic]of [['csv','text/csv',null],['xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','PK'],['pdf','application/pdf','%PDF']]){
  const before=calls.length,response=await send({format,view:'ENTITY',filters});assert.equal(response.status,200,format);assert.ok(response.headers.get('content-type').startsWith(mime));assert.match(response.headers.get('content-disposition'),/^attachment; filename\*=UTF-8''/);assert.ok(decodeURIComponent(response.headers.get('content-disposition')).endsWith('.'+format));assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('x-report-total-rows'),'2');assert.equal(response.headers.get('x-report-snapshot-fingerprint'),'a'.repeat(32));
  const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length>0);if(magic)assert.equal(bytes.subarray(0,magic.length).toString(),magic);else assert.equal(bytes.toString().split('\r\n').filter(line=>line.startsWith('MOVIMIENTO,')||line.startsWith('"MOVIMIENTO",')).length,2);
  assert.equal(calls.length,before+1,'One complete snapshot RPC, without page collection.');assert.deepEqual(calls.at(-1).body,{p_filters:filters});
 }
 for(mode of ['partial','wrong-company']){const response=await send({format:'csv',view:'ACCOUNT',filters});assert.equal(response.status,502);assert.equal(response.headers.get('content-disposition'),null);assert.equal(response.headers.get('x-report-total-rows'),null);await response.arrayBuffer();}
 const denied=await send({format:'csv',view:'ACCOUNT',filters},'sql-denied');assert.equal(denied.status,403);assert.ok(!(await denied.text()).includes('PRIVATE SQL DETAILS'));
 const expectedDeviceHash=createHash('sha256').update('synthetic-ledger-device').digest('hex');
 assert.ok(calls.every(call=>call.path==='/rest/v1/rpc/run_general_ledger_export'&&call.key==='synthetic-ledger-public-key'&&call.auth.startsWith('Bearer synthetic-ledger-export-')&&call.device===undefined&&call.deviceHash===expectedDeviceHash));
});
