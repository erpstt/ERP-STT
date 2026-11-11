import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {validateDocumentSnapshot,documentSnapshotHtml,downloadDocumentSnapshot} from '../dist/modules/reports/document-snapshot-pdf.service.js';
import {preparePdfHtml} from '../dist/core/security/pdf-renderer.js';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
const cell=(text,numeric=false)=>({text,span:1,numeric});
const snapshot=()=>({scope:'accounting',title:'Libro Diario',company:'Empresa sintética',period:'2026-11-01 al 2026-11-11',currency:'USD',blocks:[{kind:'table',rows:[{header:true,cells:[cell('Documento'),cell('Débito'),cell('Crédito')]},{header:false,cells:[cell('<img src=x onerror=alert(1)>'),cell('1 234,56',true),cell('0,00',true)]}]}]});
test('PDF snapshot validates scope, bounds, no HTML payload and authentication',async()=>{
 assert.deepEqual(validateDocumentSnapshot(snapshot()),snapshot());
 for(const bad of [{...snapshot(),html:'<body>'},{...snapshot(),scope:'security'},{...snapshot(),blocks:[{kind:'script',text:'alert(1)'}]},{...snapshot(),blocks:[{kind:'table',rows:[{cells:[{...cell('x'),span:0}]}]}]}])assert.throws(()=>validateDocumentSnapshot(bad),e=>e.status===400);
 await assert.rejects(downloadDocumentSnapshot('',snapshot()),e=>e.status===401);
});
test('PDF escapes text and repeats all identifiers across readable wide-table panels',()=>{
 const input=snapshot(),html=preparePdfHtml(documentSnapshotHtml(input));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));assert.ok(html.includes('1 234,56'));assert.ok(html.includes('landscape')===false);
 const wide=snapshot();wide.blocks=[{kind:'table',rows:[{header:true,cells:Array.from({length:30},(_,i)=>cell('COLUMNA-'+i))},{header:false,cells:Array.from({length:30},(_,i)=>cell('VALOR-'+i))}]}];const out=documentSnapshotHtml(wide);for(let i=0;i<30;i++)assert.ok(out.includes('VALOR-'+i));assert.ok(out.split('VALOR-0').length>=4);assert.ok(out.includes('landscape'));
});
test('Every repaired document downloads PDF without opening print; snapshot excludes controls and hidden content',{timeout:60000},async t=>{
 const{page,baseURL}=await bankBrowserFixture(t);let last;await page.route('**/api/documents/export-pdf',route=>{last=route.request().postDataJSON();return route.fulfill({json:{base64:Buffer.from('%PDF-1.4 fixture').toString('base64'),fileName:'documento.pdf'}});});
 for(const name of ['account-statement','journal-view','bank-check-view','bank-deposit-view','bank-fee-view','fixed-asset-view','sales-document-view','purchase-document-view','supplier-payment-view','sales-note-view']){
  await page.route(baseURL+'/'+name+'.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Documento sintético</title><button id="print">Descargar PDF</button><main id="document"><h1>Documento</h1><section class="details"><div><small>Fecha</small><b>2026-11-11</b></div></section><p hidden>PRIVATE-HIDDEN</p><table><thead><tr><th>Factura</th><th>Importe</th></tr></thead><tbody><tr><td>FAC-001</td><td class="num">100,00</td></tr></tbody></table></main>'}));
  await page.goto(baseURL+'/'+name+'.html');await page.evaluate(()=>{localStorage.setItem('nexo_token','fixture');window.print=()=>{throw Error('Printing must not be called');};});const pending=page.waitForEvent('download');await page.evaluate(async()=>{const mod=await import('/document-pdf-download.js');await mod.downloadPagePdf();});const download=await pending;assert.equal(download.suggestedFilename(),'documento.pdf');assert.ok((await readFile(await download.path())).subarray(0,4).equals(Buffer.from('%PDF')));const text=JSON.stringify(last);assert.ok(text.includes('FAC-001'));assert.ok(!text.includes('PRIVATE-HIDDEN'));assert.ok(!text.includes('Descargar PDF'));assert.equal(last.blocks.find(b=>b.kind==='table').rows[1].cells[1].numeric,true);
 }
});
import ExcelJS from 'exceljs';
test('Libro Diario exports every account line and every page to numeric XLSX and a direct PDF',{timeout:30000},async t=>{
 const{page,baseURL}=await bankBrowserFixture(t);const opts={subsidiaries:[{id:1,name:'Empresa sintética',currencyId:1}],currencies:[{id:1,code:'USD'}],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],journalOptions:{modules:[]},agingOptions:{customers:[],suppliers:[],salesRepresentatives:[]},pendingInvoiceOptions:{customers:[]},bankOptions:{accounts:[]}};
 const journal=n=>({journal_id:n,date:'2026-11-11',journal_number:'ASI-'+n,document_number:'DOC-'+n,status:'CONTABILIZADO',memo:'Concepto',debit:100,credit:100,lines:[{account_number:'00100',account_name:'Banco',debit:100,credit:0},{account_number:'00200',account_name:'Cliente',debit:0,credit:100}]});let last;
 await page.addInitScript(()=>{localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_token','fixture');window.print=()=>{throw Error('Print forbidden');};});
 await page.route('**/api/**',route=>{const u=new URL(route.request().url());if(u.pathname.endsWith('/options'))return route.fulfill({json:opts});if(u.pathname.endsWith('/export-pdf')){last=route.request().postDataJSON();return route.fulfill({json:{base64:Buffer.from('%PDF-1.4 fixture').toString('base64'),fileName:'diario.pdf'}});}const p=route.request().postDataJSON();return route.fulfill({json:{rows:p.pageSize===250?[journal(1),journal(2)]:[journal(1)],total:2,summary:{debit:200,credit:200}}});});
 await page.goto(baseURL+'/accounting-reports.html?reporte=journal');await page.locator('#tbody').getByText('ASI-1',{exact:true}).waitFor();
 let pending=page.waitForEvent('download');await page.locator('#excel').click();const file=await pending,book=new ExcelJS.Workbook();await book.xlsx.load(await readFile(await file.path()));const values=JSON.stringify(book.worksheets[0].getSheetValues());assert.ok(values.includes('ASI-2'));assert.ok(!values.includes('[object Object]'));assert.equal(book.worksheets[0].getCell('F7').value,'00100');assert.equal(book.worksheets[0].getCell('K7').value,100);
 pending=page.waitForEvent('download');await page.locator('#pdf').click();await pending;assert.ok(JSON.stringify(last).includes('ASI-2'));assert.equal(await page.locator('#tbody').getByText('ASI-2',{exact:true}).count(),0);
});
import {primeRoleAccessCache} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {downloadPdfTemplatePreview} from '../dist/modules/document-catalogs/pdf-template.service.js';
test('All snapshot scopes and template download enforce view permission before rendering or reading data',async()=>{
 const token='Bearer denied-export-review-fixture';primeRoleAccessCache(token,{isAdmin:false,grants:[]});
 for(const scope of ['accounting','assets','asset','journal','check','deposit','fee','payment','credit-note','debit-note','sales-document','purchase-document'])await assert.rejects(downloadDocumentSnapshot(token,{...snapshot(),scope}),e=>e.status===403);
 await assert.rejects(downloadPdfTemplatePreview(token,{schema:{}}),e=>e.status===403);
});
test('Template designer downloads a PDF from its schema without calling iframe print',{timeout:15000},async t=>{
 const{page,baseURL}=await bankBrowserFixture(t);let posted;
 await page.route('**/api/pdf-templates/**',route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/options'))return route.fulfill({json:{branches:[],templates:[],access:{canCreate:true}}});if(path.endsWith('/render'))return route.fulfill({json:{html:'<!doctype html><html><body>Vista previa</body></html>'}});posted=route.request().postDataJSON();return route.fulfill({json:{base64:Buffer.from('%PDF-1.4 template fixture').toString('base64'),fileName:'plantilla.pdf'}});});
 await page.goto(baseURL+'/pdf-template-builder.html');await page.locator('#type option').first().waitFor({state:'attached'});await page.locator('#preview').click();await page.locator('#previewDialog').waitFor();const pending=page.waitForEvent('download');await page.locator('#printPreview').click();assert.equal((await pending).suggestedFilename(),'plantilla.pdf');assert.equal(posted.documentType,'FAC_VEN');assert.ok(posted.schema.zones.body.length>0);assert.equal(posted.html,undefined);
});
test('Account statement retrieves every page before rendering and downloading',{timeout:15000},async t=>{
 const{page,baseURL}=await bankBrowserFixture(t);let snapshot;
 await page.addInitScript(()=>{sessionStorage.setItem('nexo_account_statement',JSON.stringify({kind:'AR',report:'receivables-aging',filters:{dateTo:'2026-11-11',page:1,pageSize:50},subsidiary:{id:1,name:'Empresa'},currency:{symbol:'USD'},entityId:1}));});
 const row=n=>({document_number:'FAC-'+n,issue_date:'2026-11-01',due_date:'2026-11-30',overdue_days:0,original_amount:100,applied_amount:0,pending:100,bucket:'CURRENT'});
 await page.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;if(p.endsWith('/export-pdf')){snapshot=route.request().postDataJSON();return route.fulfill({json:{base64:Buffer.from('%PDF-1.4 fixture').toString('base64'),fileName:'estado.pdf'}});}if(p.includes('/receivables-aging')){const f=route.request().postDataJSON();return route.fulfill({json:{rows:f.pageSize===250?[row(1),row(2)]:[row(1)],total:2,summary:{pending:200}}});}if(p==='/api/entities/customers')return route.fulfill({json:[{customer_id:1,company_name:'Cliente sintético'}]});return route.fulfill({json:{name:'Empresa sintética'}});});
 await page.goto(baseURL+'/account-statement.html');await page.locator('#documents').getByText('FAC-2',{exact:true}).waitFor();const pending=page.waitForEvent('download');await page.locator('#print').click();await pending;assert.ok(JSON.stringify(snapshot).includes('FAC-2'));assert.equal(snapshot.scope,'accounting');
});
