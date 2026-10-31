import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {spawn} from 'node:child_process';import {test} from 'node:test';
import {bankReconciliationAction,runAccountingReport} from '../dist/modules/reports/accounting-reports.service.js';
import * as q from '../dist/modules/banking-catalogs/quadratic-reconciliation.service.js';
import {createBankingRow,updateBankingRow,deleteBankingRow,listBankingRows,getBankingCatalog} from '../dist/modules/banking-catalogs/banking-catalogs.module.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
const base='/api/v1/bank-reconciliations/quadratic';
const header={bankAccountId:1,periodYear:2026,periodMonth:10,bankStartBalance:0,bankTotalReceipts:100,bankTotalDisbursements:40,bankEndBalance:60};
const item={itemType:'BANK_ERROR',description:'Synthetic item',transactionDate:'2026-10-10',amount:1,impactStartBalance:0,impactReceipts:0,impactDisbursements:0,impactEndBalance:0};
const metadata={bank_account_id:1,statement_date:'2026-10-31',opening_balance:0,closing_balance:60};
const filters={bankAccountId:1,dateFrom:'2026-10-01',dateTo:'2026-10-31'};
const cases=[
 ['POST','/api/reports/accounting/bank-reconciliation','view','run_bank_reconciliation_report',filters,{p_filters:filters},200],
 ...['auto','close','close-report'].map(a=>['POST','/api/reports/accounting/bank-reconciliation/'+a,a==='close-report'?'view':'edit',{auto:'auto_match_bank_reconciliation',close:'close_bank_reconciliation','close-report':'bank_reconciliation_close_report'}[a],{p_bank_account_id:1,p_cutoff:'2026-10-31'},{p_bank_account_id:1,p_cutoff:'2026-10-31'},200]),
 ['POST','/api/reports/accounting/bank-reconciliation/match','edit','match_bank_transaction',{p_bank_tran_id:1,p_statement_line_id:2,p_cutoff:'2026-10-31'},{p_bank_tran_id:1,p_statement_line_id:2,p_cutoff:'2026-10-31'},200],
 ['POST','/api/reports/accounting/bank-reconciliation/import','create','import_bank_statement',{p_bank_account_id:1,p_statement_date:'2026-10-31',p_opening_balance:0,p_closing_balance:60,p_lines:[]},{p_bank_account_id:1,p_statement_date:'2026-10-31',p_opening_balance:0,p_closing_balance:60,p_lines:[]},200],
 ['POST','/api/banking/bank-statements','create','save_bank_statement_metadata',metadata,{p_statement_id:null,p_payload:metadata},201],
 ['PATCH','/api/banking/bank-statements/17','edit','save_bank_statement_metadata',metadata,{p_statement_id:17,p_payload:metadata},200],
 ['DELETE','/api/banking/bank-statements/17','delete','delete_bank_statement',undefined,{p_statement_id:17},200],
 ['GET',base+'/options','view','quadratic_reconciliation_options',undefined,{},200],
 ['GET',base,'view','quadratic_reconciliation_list',undefined,{p_filters:{}},200],
 ['GET',base+'/17','view','quadratic_reconciliation_get',undefined,{p_reconciliation_id:17},200],
 ['GET',base+'/17/matrix','view','quadratic_reconciliation_get',undefined,{p_reconciliation_id:17},200],
 ['POST',base,'create','quadratic_reconciliation_save',header,{p_payload:{...header,notes:null}},201],
 ['POST',base,'edit','quadratic_reconciliation_save',{...header,id:17},{p_payload:{...header,id:17,notes:null}},200],
 ['POST',base+'/17/items','edit','quadratic_reconciliation_item_save',item,{p_reconciliation_id:17,p_item:{...item,referenceNumber:null}},201],
 ['DELETE',base+'/17/items/3','edit','quadratic_reconciliation_item_delete',undefined,{p_reconciliation_id:17,p_item_id:3},200],
 ['POST',base+'/17/matches','edit','quadratic_reconciliation_match',{bankTransactionId:1,statementLineId:2},{p_reconciliation_id:17,p_bank_tran_id:1,p_statement_line_id:2},201],
 ['DELETE',base+'/17/matches/3','edit','quadratic_reconciliation_unmatch',undefined,{p_reconciliation_id:17,p_match_id:3},200],
 ['POST',base+'/17/auto-match','edit','quadratic_reconciliation_auto_match',{}, {p_reconciliation_id:17,p_tolerance_days:3},200],
 ['POST',base+'/17/transition','edit','quadratic_reconciliation_transition',{status:'in_review'},{p_id:17,p_status:'in_review'},200],
 ['POST',base+'/17/approve','edit','quadratic_reconciliation_transition',{}, {p_id:17,p_status:'approved'},200],
 ['POST',base+'/17/close','edit','quadratic_reconciliation_transition',{}, {p_id:17,p_status:'closed'},200]
];
test('guardas internas cubren reportes, exportaciones, acciones, catalogo y cuadratica antes de consultar',async t=>{
 t.after(()=>invalidateRoleAccessCaches());const auth='Bearer rec-direct-denied';await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 const s=getBankingCatalog('bank-statements');
 for(const call of [()=>bankReconciliationAction(auth,'auto',{}),()=>bankReconciliationAction(auth,'import',{p_file_base64:'not-a-file'}),()=>runAccountingReport(auth,'bank-reconciliation',filters),()=>q.quadraticReconciliationOptions(auth),()=>q.listQuadraticReconciliations(auth),()=>q.getQuadraticReconciliation(auth,17),()=>q.saveQuadraticReconciliation(auth,header),()=>q.saveQuadraticReconciliationItem(auth,17,item),()=>q.matchQuadraticReconciliation(auth,17,{bankTransactionId:1,statementLineId:2}),()=>q.deleteQuadraticReconciliationItem(auth,17,3),()=>q.unmatchQuadraticReconciliation(auth,17,3),()=>q.autoMatchQuadraticReconciliation(auth,17),()=>q.transitionQuadraticReconciliation(auth,17,'closed'),()=>q.exportQuadraticReconciliationPdf(auth,17),()=>q.exportQuadraticReconciliationExcel(auth,17),()=>createBankingRow(s,auth,metadata),()=>updateBankingRow(s,auth,17,metadata),()=>deleteBankingRow(s,auth,17),()=>listBankingRows(s,auth)])await assert.rejects(call(),e=>e.status===403);
 await assert.rejects(q.quadraticReconciliationOptions(''),e=>e.status===401);
});
test('23 variantes HTTP separan permisos y conservan JWT, apikey y parametros; acceso anonimo denegado', {timeout:40000},async t=>{
 const calls=[],roles={denied:null,reader:'view',creator:'create',editor:'edit',deleter:'delete',admin:'admin'};
 const resources=['reports:accounting-reports','banking:bank-statements','banking:bank-reconciliations','banking:cash-proof'];
 const stub=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer rec-http-','');
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:resources.map(resourceKey=>({resourceKey,canView:roles[role]==='view',canCreate:roles[role]==='create',canEdit:roles[role]==='edit',canDelete:roles[role]==='delete'}))}}));return;}
  const chunks=[];for await(const c of req)chunks.push(c);calls.push({path:req.url,auth:req.headers.authorization,key:req.headers.apikey,payload:JSON.parse(Buffer.concat(chunks).toString()||'{}')});
  if(role==='admin'&&req.url.endsWith('/quadratic_reconciliation_transition')){res.writeHead(403);res.end(JSON.stringify({code:'42501',message:'private SQL detail'}));return;}
  res.end(JSON.stringify({fixture:true,statement_id:17,header:{},matrix:{}}));
 });
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{stub.closeAllConnections();stub.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'server-fixture',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());
 let ready=false;for(let n=0;n<100;n++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 for(const [method,path,action,rpc,body,expected,status]of cases){for(const [role,grant]of Object.entries(roles)){
  const auth=`Bearer rec-http-${role}`,before=calls.length;const response=await fetch(`http://127.0.0.1:${port}`+path,{method,headers:{Authorization:auth,'X-Device-Token':'reconciliation-http-device-fixture','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const allowed=role==='admin'||grant===action,sqlDenied=role==='admin'&&rpc==='quadratic_reconciliation_transition';assert.equal(response.status,!allowed||sqlDenied?403:status,`${role} ${path}`);assert.equal(calls.length,before+(allowed?1:0));
  if(allowed)assert.deepEqual(calls.at(-1),{path:'/rest/v1/rpc/'+rpc,auth,key:'public-fixture',payload:expected});if(sqlDenied)assert.doesNotMatch(await response.text(),/private SQL detail/);
 }
 const before=calls.length;assert.equal((await fetch(`http://127.0.0.1:${port}`+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})})).status,401);assert.equal(calls.length,before);
 }
 // The generic catalogs cannot bypass workflow status or movement controls.
 for(const slug of ['bank-transactions','bank-reconciliations'])for(const method of ['POST','PATCH','DELETE']){
  const before=calls.length;const r=await fetch(`http://127.0.0.1:${port}/api/banking/${slug}${method==='POST'?'':'/17'}`,{method,headers:{Authorization:'Bearer rec-http-admin','X-Device-Token':'reconciliation-http-device-fixture','Content-Type':'application/json'},...(method!=='DELETE'?{body:'{}'}:{})});assert.equal(r.status,403);assert.equal(calls.length,before);
 }
});
