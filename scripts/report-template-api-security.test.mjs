import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {isFinancialReportRoute} from '../dist/modules/reports/report-access.service.js';
import {compilePdfTemplate,pdfTemplates,requirePdfTemplateAccess} from '../dist/modules/document-catalogs/pdf-template.service.js';
import {accountingReportOptions} from '../dist/modules/reports/accounting-reports.service.js';
import {settledInvoiceReportOptions} from '../dist/modules/reports/settled-invoices-report.service.js';
import {vatDeclarationReportOptions} from '../dist/modules/reports/vat-declaration-report.service.js';

const report='reports:accounting-reports',templates='documents:pdf-templates';
const reportPaths=['options','balance-sheet','income-statement','cash-flow','equity-changes','trial-balance','general-ledger','journal','pending-invoice-control','receivables-aging','payables-aging','bank-reconciliation','bank-balances','sales-transactions','purchase-transactions','intercompany-loans','intercompany-commercial'].map(n=>[n==='options'?'GET':'POST','/api/reports/accounting/'+n]);
for(const f of ['sales/settled-invoices','purchases/settled-invoices','treasury/payment-requests','tax/vat-declaration','accounting/eight-column-balance','accounting/intercompany-loans','accounting/intercompany-commercial'])for(const ext of ['','/options','/pdf','/excel'])reportPaths.push([ext==='/options'?'GET':'POST','/api/v1/reports/'+f+ext]);
for(const n of ['options','generate','save','pdf'])reportPaths.push(['POST','/api/reports/income-forecast/'+n]);
reportPaths.push(['GET','/api/reports/accounting/purchase-transactions/supports/1'],['POST','/api/reports/accounting/bank-reconciliation/pdf'],['POST','/api/reports/accounting/bank-reconciliation/close-report'],['POST','/api/reports/accounting/pending-invoice-control/pdf']);

test('financial route policy covers reports/exports/supports without requiring report permission for banking writes',()=>{
 for(const[m,p]of reportPaths){assert.equal(isFinancialReportRoute(m,p),true,p);assert.equal(isFinancialReportRoute(m,p+'?probe=1'),true,p);}
 for(const p of ['/api/reports/accounting/bank-reconciliation/import','/api/reports/accounting/bank-reconciliation/match','/api/reports/accounting/bank-reconciliation/bank-fees','/api/v1/reports/audit/changes'])assert.equal(isFinancialReportRoute('POST',p),false);
});

test('services reject denied roles before reading cached options or mock preview',async t=>{
 t.after(()=>invalidateRoleAccessCaches());const auth='Bearer reports-denied';await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 for(const fn of [()=>accountingReportOptions(auth),()=>settledInvoiceReportOptions(auth),()=>vatDeclarationReportOptions(auth),()=>pdfTemplates(auth,'render',{schema:{},compiled:'<script>unsafe()</script>'}),()=>pdfTemplates(auth,'save',{schema:{}}),()=>requirePdfTemplateAccess(auth,'clone',{id:1})])await assert.rejects(fn(),e=>e.status===403);
 await assert.rejects(pdfTemplates('','options'),e=>e.status===401);
});

test('template compiler rejects excessive complexity and escapes text while preserving layout',()=>{
 const schema={zones:{body:[{type:'text',content:'<img src=x onerror=unsafe()> & "literal"'},{type:'items_table'},{type:'totals'}]}};
 const html=compilePdfTemplate(schema);assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('{{items.rows}}'));assert.ok(html.includes('{{totals.grand_total}}'));
 assert.throws(()=>compilePdfTemplate({zones:{body:[{content:'x'.repeat(130000)}]}}),e=>e.status===400);
 let deep={};for(let n=0;n<30;n++)deep={children:[deep]};assert.throws(()=>compilePdfTemplate(deep),e=>e.status===400);
});

test('HTTP permissions: reports blocked before data/export; template actions, canonical compilation and DB denial',{timeout:90000},async t=>{
 const calls=[];const grant=(key,role)=>({resourceKey:key,canView:role!=='denied',canCreate:role==='creator',canEdit:role==='editor',canDelete:role==='deleter'});
 const upstream=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer a05-','')||'denied';
  if(req.url==='/rest/v1/rpc/assert_request_access')return res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:[grant(role==='unrelated'?'inventory:products':report,role),grant(role==='unrelated'?'core:countries':templates,role)]}}));
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');calls.push({path:req.url,body,key:req.headers.apikey,auth:req.headers.authorization});
  if(role==='db-denied'){res.writeHead(403);return res.end(JSON.stringify({code:'42501',message:'PRIVATE_DATABASE_DETAIL'}));}
  const name=req.url.split('/').at(-1);let result={ok:true};
  if(name==='pdf_template_options')result={subsidiary:{id:1,name:'Synthetic'},templates:[],branches:[]};
  if(name==='pdf_template_compiled')result={id:1,schema:{zones:{body:[{type:'text',content:'Canonical {{company.name}}'}]}},compiled:'<script>untrusted_stored_html</script>',pageSize:'A4',orientation:'PORTRAIT'};
  if(name==='pdf_template_save'||name==='pdf_template_clone')result={id:1};
  res.end(JSON.stringify(result));
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_ANON_KEY:'synthetic-public',DISABLE_BACKGROUND_JOBS:'true'},stdio:'ignore'});t.after(()=>child.kill());const base=`http://127.0.0.1:${port}`;
 for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const request=async(role,m,path,body={})=>{const r=await fetch(base+path,{method:m,headers:{Authorization:'Bearer a05-'+role,'X-Device-Token':'synthetic-a05-device-test-fixture','Content-Type':'application/json'},...(m==='GET'?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json()};};
 for(const role of ['denied','unrelated'])for(const[m,p]of reportPaths){const before=calls.length;assert.equal((await request(role,m,p)).status,403,p);assert.equal(calls.length,before,p);}
 for(const role of ['reader','creator','editor','deleter']){
  assert.equal((await request(role,'GET','/api/reports/accounting/options')).status,200);
  for(const[action,p]of [['save',{schema:{}}],['save',{id:1,schema:{}}],['clone',{id:1}],['delete',{id:1}]]){const expected=action==='save'?(p.id?'editor':'creator'):action==='clone'?'creator':'deleter';assert.equal((await request(role,'POST','/api/pdf-templates/'+action,p)).status,role===expected?200:403,role+' '+action);}
  const options=await request(role,'POST','/api/pdf-templates/options');assert.equal(options.status,200);assert.equal(options.data.access.canCreate,role==='creator');
 }
 const schema={zones:{body:[{type:'text',content:'Safe {{company.name}} <b>literal</b>'}]}};
 const preview=await request('reader','POST','/api/pdf-templates/render',{schema,compiled:'<script>untrusted_client_html</script>'});assert.equal(preview.status,200);assert.ok(!preview.data.html.includes('untrusted_client_html'));assert.ok(preview.data.html.includes('&lt;b&gt;literal&lt;/b&gt;'));
 const get=await request('reader','POST','/api/pdf-templates/get',{id:1});assert.equal(get.status,200);assert.ok(!get.data.compiled.includes('untrusted_stored_html'));assert.ok(get.data.compiled.includes('Canonical'));
 assert.equal((await request('reader','POST','/api/pdf-templates/render',{schema,documentType:'FAC_VEN',documentNumber:'SYN'})).status,403);
 for(const action of ['save','clone','delete','get','render'])assert.equal((await request('reader','GET','/api/pdf-templates/'+action)).status,405);
 for(const path of ['/api/reports/accounting/options','/api/pdf-templates/options']){const denied=await request('db-denied',path.includes('accounting')?'GET':'POST',path);assert.equal(denied.status,403);assert.ok(!JSON.stringify(denied.data).includes('PRIVATE_DATABASE_DETAIL'));}
 assert.ok(calls.filter(c=>c.path.endsWith('/pdf_template_save')).every(c=>c.body.p.compiled===''));
 assert.ok(calls.every(c=>c.auth?.startsWith('Bearer a05-')&&c.key==='synthetic-public'));assert.ok(!calls.some(c=>/render_pdf|send|smtp/.test(c.path)));
});
