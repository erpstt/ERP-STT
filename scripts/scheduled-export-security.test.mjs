import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import ExcelJS from 'exceljs';
import {chromium} from '@playwright/test';
import {scheduledReportCsv,scheduledReportHtml,scheduledReportFiles,deliverScheduledReport} from '../dist/modules/reports/scheduled-reports.service.js';
import {genericReportCsv,reportSections} from '../dist/modules/reports/scheduled-report-renderer.js';
import {parseBudgetCsv} from '../dist/modules/budget/budget.service.js';
import {buildSettledInvoiceExcel} from '../dist/modules/reports/settled-invoices-report.service.js';
import {buildSettledSupplierInvoiceExcel} from '../dist/modules/reports/settled-supplier-invoices-report.service.js';
import {buildQuadraticReconciliationExcel} from '../dist/modules/banking-catalogs/quadratic-reconciliation.service.js';
import {normalizeEightColumnBalanceReport,buildEightColumnBalanceExcel} from '../dist/modules/reports/eight-column-balance-report.service.js';
const attacks=['=1+1','+SUM(A1:A2)','-1+2','@SUM(A1:A2)',' \t=1+1','\r=1+1','\n=1+1','\u0000=1+1','\u200b=1+1','\u2066=1+1','\uff1d1+1','\uff0b1','\uff0d1','\uff201','=1+1";=2+2\n,=3+3'];
const report=(kind='AR',text='Empresa')=>({kind,title:text,company:text,currency:text,cutoff:'2026-11-02',rows:[{entity_name:text,document_number:'00123',issue_date:'2026-10-01',due_date:'2026-11-01',overdue_days:1,original_amount:-123.45,applied_amount:-3.45,pending:-120}],summary:{subledger:-120,advances:0,netBalance:-120}});
for(const kind of ['AR','AP'])test(kind+': CSV de programados conserva columnas, códigos y números con quince ataques',()=>{
 for(const attack of attacks){const data=report(kind,attack),before=structuredClone(data),csv=scheduledReportCsv(data),rows=parseBudgetCsv(csv.replace(/^\ufeff/,''));assert.equal(rows.length,2);assert.equal(rows[0].length,11);assert.equal(rows[1].length,11);assert.equal(rows[1][0],'\t'+attack);assert.equal(rows[1][1],'\t'+attack);assert.equal(rows[1][3],'\t'+attack);assert.equal(rows[1][4],'00123');assert.equal(rows[1][8],'-123.45');assert.equal(rows[1][10],'-120');assert.deepEqual(data,before);}
});
test('CSV genérico: metadatos, encabezados desconocidos y detalles anidados neutralizados',()=>{
 for(const attack of attacks){const data={...report('general-ledger',attack),dateFrom:'2026-01-01',data:{rows:[{account_number:'00123',account_name:attack,amount:-123.45,[attack]:attack,lines:[{description:attack,amount:-12.34}]}]}},before=structuredClone(data),rows=parseBudgetCsv(genericReportCsv(data).replace(/^\ufeff/,'')),cells=rows.flat();assert.ok(cells.includes('\t'+attack));assert.ok(cells.includes('00123'));assert.ok(cells.includes('-123.45'));assert.ok(cells.includes('-12.34'));assert.ok(!cells.includes(attack));assert.deepEqual(data,before);}
});
test('resultados financieros conservan sus totales calculados',()=>{
 const data={...report('income-statement'),data:{rows:[{account_name:'Ventas',category:'Ingreso',debit:0,credit:1000},{account_name:'Costos',category:'Costo',debit:300,credit:0},{account_name:'Gastos generales',category:'Gasto',debit:200,credit:0}]}};
 const sections=reportSections(data),net=sections[0].rows.find(row=>row[0]==='Resultado neto');assert.equal(net[1],500);assert.ok(parseBudgetCsv(genericReportCsv(data)).some(row=>row.includes('500')));
});
test('HTML de AR/AP y genérico conserva texto hostil sin ejecutar etiquetas',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.route('**/*',r=>r.abort());const attack='"><img src=x onerror="window.__xss=true"> & <b>dato</b>';
 for(const kind of ['AR','AP','general-ledger']){const data={...report(kind,attack),data:{rows:[{account_name:attack,amount:-120,lines:[{description:attack}]}]}};await page.setContent(scheduledReportHtml(data));assert.equal(await page.locator('[onerror],img,script,svg').count(),0);assert.ok((await page.locator('body').textContent()).includes(attack));assert.equal(await page.evaluate(()=>window.__xss===true),false);}
});
test('adjunto CSV real usa el serializador protegido, sin invocar PDF',async()=>{
 for(const kind of ['AR','AP','general-ledger']){const data={...report(kind,' \u2066=1+1'),data:{rows:[{description:'=1+1',amount:-120}]}},files=await scheduledReportFiles(data,'CSV');assert.equal(files.length,1);assert.equal(files[0].mimeType,'text/csv');assert.ok(files[0].fileName.endsWith('.csv'));assert.equal(Buffer.from(files[0].base64,'base64').toString('utf8'),scheduledReportCsv(data));}
 await assert.rejects(scheduledReportFiles(report(),'INVALID'),/Formato/);
});
const job={id:'synthetic',lease:'synthetic',subsidiary_id:1,cutoff:'2026-11-02',recipient:'synthetic@example.invalid',configuration:{report_kind:'AR',format:'CSV',name:'Reporte sintético'}};
test('entrega simulada conserva adjunto protegido y un destinatario, sin SMTP ni URLs de archivos',async()=>{
 const data=report('AR',' \n=1+1'),mails=[],statuses=[];await deliverScheduledReport(job,async()=>data,async mail=>{mails.push(mail);return {accepted:[job.recipient],messageId:'synthetic'};},async()=>true,async(...args)=>statuses.push(args));assert.equal(mails.length,1);assert.equal(mails[0].to,job.recipient);assert.equal(mails[0].disableFileAccess,true);assert.equal(mails[0].disableUrlAccess,true);assert.ok(!/[\r\n]/.test(mails[0].subject));assert.ok(mails[0].attachments[0].content.toString().includes('"\t \n=1+1"'));assert.equal(statuses[0][0],'ENVIADO');
});
for(const [name,cause,status]of [['incierto',{code:'ETIMEDOUT'},'INCIERTO'],['rechazado',{responseCode:550,message:'Synthetic private detail'},'ERROR']])test('SMTP '+name+': estado preservado y una sola llamada simulada',async()=>{
 let sends=0;const statuses=[];await deliverScheduledReport(job,async()=>report(),async()=>{sends++;throw cause;},async()=>true,async(...args)=>statuses.push(args));assert.equal(sends,1);assert.equal(statuses[0][0],status);assert.ok(!JSON.stringify(statuses).includes('Synthetic private detail'));
});
test('cancelación, destinatario inválido y fallo de preparación no envían',async()=>{
 for(const mode of ['cancel','recipient','prepare']){let sends=0;const states=[];await deliverScheduledReport({...job,recipient:mode==='recipient'?'bad\r\naddress':job.recipient},async()=>{if(mode==='prepare')throw Error('Synthetic');return report();},async()=>{sends++;return {};},async()=>mode!=='cancel',async status=>states.push(status));assert.equal(sends,0);assert.deepEqual(states,mode==='cancel'?[]:['ERROR']);}
});
test('se conservan límites de filas y profundidad de reportes genéricos',()=>{
 assert.throws(()=>genericReportCsv({...report('general-ledger'),data:{rows:Array(50001).fill({amount:1})}}),/máximo/);
 let nested={value:1};for(let i=0;i<10;i++)nested={nested};assert.throws(()=>genericReportCsv({...report('general-ledger'),data:nested}),/profundidad/);
});
async function fixture(file,name){const source=await readFile(new URL('./'+file,import.meta.url),'utf8'),sf=ts.createSourceFile(file,source,99,true,1);for(const statement of sf.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)if(declaration.name.getText(sf)===name)return new Function('return ('+declaration.initializer.getText(sf)+')')();throw Error('Fixture not found');}
for(const [name,file,build]of [['ventas','test-settled-sales-invoices-exports.mjs',buildSettledInvoiceExcel],['proveedores','test-settled-supplier-invoices-exports.mjs',buildSettledSupplierInvoiceExcel]])test('XLSX existente de '+name+': celdas de texto no se convierten en fórmulas',async()=>{
 const data=await fixture(file,'report');data.header.subsidiary='=1+1';data.header.legalName='=1+1';for(const row of data.rows){row.customerName='=1+1';row.supplierName='=1+1';row.invoiceNumber='00123';row.invoiceAmount=-123.45;}const result=await build(data),book=new ExcelJS.Workbook();await book.xlsx.load(result.buffer);const values=[];for(const sheet of book.worksheets)sheet.eachRow(row=>row.eachCell(cell=>{assert.notEqual(cell.type,ExcelJS.ValueType.Formula);values.push(cell.value);}));assert.ok(values.some(v=>typeof v==='string'&&v.includes('=1+1')));assert.ok(values.includes(-123.45));assert.ok(values.includes('00123'));
});
test('XLSX cuadrático mantiene texto y montos, sin ejecutar generador PDF',async()=>{
 const data=await fixture('test-quadratic-exports.mjs','detail');data.header.subsidiaryName='=1+1';data.header.subsidiaryLegalName='=1+1';const result=await buildQuadraticReconciliationExcel(data),book=new ExcelJS.Workbook();await book.xlsx.load(result.buffer);let found=false;for(const sheet of book.worksheets)sheet.eachRow(row=>row.eachCell(cell=>{assert.notEqual(cell.type,ExcelJS.ValueType.Formula);if(typeof cell.value==='string'&&cell.value.includes('=1+1'))found=true;}));assert.ok(found);
});
test('balance de ocho columnas mantiene fórmulas internas y datos externos como texto',async()=>{
 const row=(number,name,classification,values)=>({account_number:number,account_name:name,classification,debit:0,credit:0,debtor_balance:0,creditor_balance:0,asset:0,liability:0,loss:0,gain:0,...values});
 const data=normalizeEightColumnBalanceReport({header:{subsidiary_name:'=1+1',currency_code:'USD',date_from:'2026-01-01',date_to:'2026-11-02'},rows:[row('00123','=1+1','ACTIVO',{debit:100,debtor_balance:100,asset:100}),row('200','Pasivo','PASIVO',{credit:100,creditor_balance:100,liability:100})]});const result=await buildEightColumnBalanceExcel(data),book=new ExcelJS.Workbook();await book.xlsx.load(result.buffer);let formulas=0,found=false;for(const sheet of book.worksheets)sheet.eachRow(row=>row.eachCell(cell=>{if(cell.type===ExcelJS.ValueType.Formula){formulas++;assert.ok(!cell.formula.includes('=1+1'));}if(cell.value==='=1+1')found=true;}));assert.ok(found);assert.ok(formulas>0);
});
