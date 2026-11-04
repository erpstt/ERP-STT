import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { chromium } from '@playwright/test';
import ExcelJS from 'exceljs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}};
async function until(predicate){const end=Date.now()+5000;while(Date.now()<end){if(predicate())return;await new Promise(done=>setTimeout(done,10))}throw Error('Synthetic request not observed')}
const options={
 subsidiaries:[{id:1,name:'Synthetic A',currencyId:1},{id:2,name:'Synthetic B',currencyId:2},{id:3,name:'Synthetic USD',currencyId:3}],
 currencies:[{id:1,code:'JMD',name:'Jamaican dollar',symbol:'J$'},{id:2,code:'CRC',name:'Colón',symbol:'₡'},{id:3,code:'USD',name:'US Dollar',symbol:'US$'}],
 books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],
 journalOptions:{modules:[]},agingOptions:{customers:[],suppliers:[],salesRepresentatives:[]},bankOptions:{accounts:[]},pendingInvoiceOptions:{customers:[]}
};
function report(kind,filters){
 const usd=filters.presentationCurrency==='USD',local={1:'JMD',2:'CRC',3:'USD'}[filters.subsidiaryIds[0]],scale=usd||local==='USD'?1:10,metadata=usd?{presentationCurrency:'USD',presentationCurrencyCode:'USD',localCurrencyCode:local,consolidated:false}:{};
 if(['general-ledger','receivables-aging','payables-aging'].includes(kind))return{rows:[],summary:{},total:0};
 if(kind==='balance-sheet')return{...metadata,rows:[{account_id:30,account_number:'1001',account_name:'Activo',category:'Activo',closing:10*scale},{account_id:40,account_number:'3001',account_name:'Capital',category:'Patrimonio',closing:-10*scale}],summary:{currentPeriodResult:0,resultExercise:0},total:2};
 const rows=[{account_id:10,account_number:'4001',account_name:'Ventas',category:'Ingreso',debit:0,credit:10*scale,dimensions:{one:10*scale}},{account_id:20,account_number:'5001',account_name:'Gastos',category:'Gasto',debit:4*scale,credit:0,dimensions:{one:4*scale}}];
 return{...metadata,rows,total:2,summary:{periodResult:6*scale,columnView:filters.columnView},...(filters.columnView!=='TOTAL'?{columns:[{id:'one',name:'Unidad sintética'}]}:{})};
}
async function fixture(t,respond=report){
 const root=resolve('public'),server=createServer(async(request,response)=>{try{const pathname=new URL(request.url,'http://localhost').pathname,path=resolve(root,'.'+(pathname==='/informes/contabilidad'?'/accounting-reports.html':pathname));if(!path.startsWith(root+sep))throw Error();response.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/html');response.end(await readFile(path))}catch{response.writeHead(404);response.end()}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done)}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage(),calls=[],errors=[],base=`http://127.0.0.1:${server.address().port}`;
 page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-token');localStorage.setItem('nexo_device_token','synthetic-device');localStorage.setItem('nexo_company','1');window.syntheticPrints=[];window.print=()=>{window.syntheticPrints.push({unit:document.getElementById('printCurrency').textContent,company:document.getElementById('printSubsidiary').textContent,body:document.getElementById('tbody').textContent});window.dispatchEvent(new Event('afterprint'))}});
 await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url());if(url.pathname==='/api/reports/accounting/options')return route.fulfill({json:structuredClone(options)});if(url.pathname.startsWith('/api/reports/accounting/')){const kind=url.pathname.split('/').at(-1),filters=request.postDataJSON();calls.push({kind,filters});const result=await respond(kind,filters,calls.length);return route.fulfill(result?.error?{status:400,json:{error:{message:result.error}}}:{json:result})}return route.fulfill({json:[]})});
 return{page,calls,base};
}
async function open(page,base,kind='balance-sheet'){await page.goto(base+'/accounting-reports.html?reporte='+kind);await page.locator('#reportCurrencyInfo').filter({hasText:'Expresado'}).waitFor()}
async function usd(page){await page.selectOption('#presentationCurrency','USD');await page.locator('#reportCurrencyInfo').filter({hasText:'Expresado en USD'}).waitFor()}

test('LOCAL por omisión, USD por empresa sin consolidar, y otros reportes conservan moneda local',{timeout:45000},async t=>{
 const{page,calls,base}=await fixture(t);await open(page,base);
 assert.equal(await page.inputValue('#presentationCurrency'),'LOCAL');assert.equal(await page.locator('#presentationCurrencyLabel').isVisible(),true);assert.equal(await page.locator('#localCurrencyLabel').isHidden(),true);
 assert.equal(calls.at(-1).filters.currencyId,'1');assert.equal(calls.at(-1).filters.presentationCurrency,'LOCAL');
 await usd(page);assert.equal(calls.at(-1).filters.currencyId,'1');assert.equal(calls.at(-1).filters.consolidated,false);assert.deepEqual(calls.at(-1).filters.subsidiaryIds,[1]);
 assert.ok((await page.locator('#tbody').innerText()).includes('US$ 10,00'));assert.ok(!(await page.locator('#tbody').innerText()).includes('J$'));
 await page.click('#catalog');await page.getByText('Libro Mayor',{exact:true}).click();await page.locator('#thead th').nth(13).waitFor();
 assert.equal(await page.locator('#presentationCurrencyLabel').isHidden(),true);assert.equal(await page.locator('#currency').isDisabled(),true);assert.equal(await page.inputValue('#currency'),'1');assert.equal(calls.at(-1).filters.presentationCurrency,undefined);assert.equal(await page.locator('#thead th').count(),14);
});

test('cargas rápidas y cambios sin generar no relabelan ni exportan un resultado viejo',{timeout:45000},async t=>{
 const pending=[];let slow=false;const{page,base}=await fixture(t,async(kind,filters)=>{if(!slow)return report(kind,filters);const request=deferred();pending.push({request,filters,kind});return request.promise});await open(page,base);slow=true;
 await page.selectOption('#presentationCurrency','USD');await until(()=>pending.length===1);await page.selectOption('#presentationCurrency','LOCAL');await until(()=>pending.length===2);
 pending[1].request.resolve(report(pending[1].kind,pending[1].filters));await page.locator('#reportCurrencyInfo').filter({hasText:'Expresado en JMD'}).waitFor();pending[0].request.resolve(report(pending[0].kind,pending[0].filters));await page.evaluate(()=>new Promise(requestAnimationFrame));
 assert.ok(!(await page.locator('#tbody').innerText()).includes('US$'));
 await page.fill('#to','2026-10-31');assert.equal(await page.locator('#tbody tr').count(),0);for(const id of['csv','excel','pdf'])assert.equal(await page.locator('#'+id).isDisabled(),true);
 await page.evaluate(()=>document.getElementById('pdf').onclick());assert.equal(await page.evaluate(()=>window.syntheticPrints.length),0);
 await page.selectOption('#subsidiaries','2');assert.equal(await page.inputValue('#presentationCurrency'),'LOCAL');assert.equal(await page.inputValue('#currency'),'2');assert.equal(await page.locator('#reportCurrencyInfo').textContent(),'');
});

test('USD inválido o tasa faltante falla cerrado y permite regresar a LOCAL',{timeout:45000},async t=>{
 let bad=true;const{page,base}=await fixture(t,(kind,filters)=>filters.presentationCurrency==='USD'&&bad?{error:'Falta la tasa de conversión registrada.'}:report(kind,filters));await open(page,base);
 await page.selectOption('#presentationCurrency','USD');await page.locator('#message').filter({hasText:'Falta la tasa'}).waitFor();assert.equal(await page.locator('#tbody .tree-account').count(),0);assert.equal(await page.locator('#pdf').isDisabled(),true);assert.equal(await page.locator('#reportCurrencyInfo').textContent(),'');
 bad=false;await page.selectOption('#presentationCurrency','LOCAL');await page.locator('#reportCurrencyInfo').filter({hasText:'Expresado en JMD'}).waitFor();assert.equal(await page.locator('#pdf').isDisabled(),false);
 await page.route('**/api/reports/accounting/balance-sheet',route=>route.fulfill({json:{...report('balance-sheet',{presentationCurrency:'USD',subsidiaryIds:[1]}),consolidated:true}}));
 await page.selectOption('#presentationCurrency','USD');await page.locator('#message').filter({hasText:'no corresponde'}).waitFor();assert.equal(await page.locator('#csv').isDisabled(),true);
});

test('balance USD conserva resultado explícito menor al centavo y no ofrece drill de ajuste virtual',{timeout:45000},async t=>{
 const{page,base}=await fixture(t,(kind,filters)=>{const result=report(kind,filters);if(filters.presentationCurrency==='USD'){result.rows[0].closing=1;result.rows[1].closing=-.949;result.rows.push({account_id:null,account_number:null,account_name:'Diferencia de conversión de presentación',category:'Patrimonio',closing:-.05,is_presentation_adjustment:true});result.summary={currentPeriodResult:.001,resultExercise:9,exerciseResult:.001,translationAdjustment:.05}}return result});await open(page,base);await usd(page);
 const adjustment=page.locator('#tbody tr').filter({hasText:'Diferencia de conversión de presentación'});assert.equal(await adjustment.locator('[data-account]').count(),0);assert.equal(await adjustment.locator('td').first().textContent(),'—');assert.ok((await page.locator('#summary').innerText()).includes('Cuadrada al centavo'));assert.ok((await page.locator('#financialDrillNote').innerText()).includes('moneda local (JMD)'));
 await page.locator('#tbody [data-account="30"]').click();await page.waitForURL('**/*reporte=general-ledger*');await page.locator('#thead th').nth(13).waitFor();assert.equal(await page.locator('#presentationCurrencyLabel').isHidden(),true);assert.equal(await page.inputValue('#currency'),'1');
});

test('matriz, PDF y Excel/CSV identifican USD y conservan importes numéricos convertidos',{timeout:45000},async t=>{
 const{page,base}=await fixture(t);await open(page,base,'income-statement');await usd(page);await page.selectOption('#columnView','DEPARTMENT');await page.locator('#thead').filter({hasText:'Unidad sintética'}).waitFor();assert.ok((await page.locator('#thead').innerText()).includes('Total del reporte'));assert.ok(!(await page.locator('#thead').innerText()).includes('Total Consolidado'));assert.ok((await page.locator('#summary').innerText()).includes('US$ 6,00'));
 await page.click('#pdf');const printed=await page.evaluate(()=>window.syntheticPrints.at(-1));assert.ok(printed.unit.includes('USD'));assert.equal(printed.company,'Synthetic A');assert.ok(printed.body.includes('US$ 6,00'));
 const csvPromise=page.waitForEvent('download');await page.click('#csv');const csv=await(await readFile(await(await csvPromise).path())).toString('utf8');assert.ok(csv.includes('"6"'));assert.ok(!csv.includes('"US$ 6,00"'));assert.ok(csv.includes('"Moneda de presentación","USD"'));assert.ok(csv.includes('"Moneda local","JMD"'));
 const excelPromise=page.waitForEvent('download');await page.click('#excel');const excel=await readFile(await(await excelPromise).path()),book=new ExcelJS.Workbook();await book.xlsx.load(excel);const sheet=book.worksheets[0];assert.equal(sheet.getCell('A1').value,'Synthetic A');assert.ok(sheet.getCell('A4').value.startsWith('USD'));let numericSix=false;sheet.eachRow(row=>row.eachCell(cell=>{if(cell.value===6)numericSix=true}));assert.equal(numericSix,true);
});

test('cambiar presentación durante Excel pendiente cancela su descarga',{timeout:45000},async t=>{
 const{page,base}=await fixture(t),vendor=deferred();let requested=false,downloaded=0;page.on('download',()=>downloaded++);
 await page.route('**/vendor/exceljs-4.4.0.min.js',async route=>{requested=true;await vendor.promise;return route.fulfill({contentType:'text/javascript',body:await readFile('public/vendor/exceljs-4.4.0.min.js')})});
 await open(page,base);await usd(page);await page.evaluate(()=>{window.syntheticExcel=document.getElementById('excel').onclick()});await until(()=>requested);
 await page.selectOption('#presentationCurrency','LOCAL');await page.locator('#reportCurrencyInfo').filter({hasText:'Expresado en JMD'}).waitFor();vendor.resolve();await page.evaluate(()=>window.syntheticExcel);assert.equal(downloaded,0);
});

test('matriz USD por período conserva meses sin movimientos y el total convertido',{timeout:45000},async t=>{
 const{page,base}=await fixture(t,(kind,filters)=>{const result=report(kind,filters);if(filters.columnView==='ACCOUNTING_PERIOD'){result.columns=[{id:'2026-01',name:'Enero 2026'},{id:'2026-02',name:'Febrero 2026'}];result.rows[0].dimensions={'2026-01':0,'2026-02':filters.presentationCurrency==='USD'?10:100};result.rows[1].dimensions={'2026-01':0,'2026-02':filters.presentationCurrency==='USD'?4:40}}return result});
 await open(page,base,'income-statement');await usd(page);await page.selectOption('#columnView','ACCOUNTING_PERIOD');await page.locator('#thead').filter({hasText:'Enero 2026'}).waitFor();const headers=await page.locator('#thead th').allTextContents();assert.ok(headers.includes('Febrero 2026'));assert.ok(!headers.includes('Sin Asignar / General'));assert.equal(headers.at(-1),'Total del reporte');assert.ok((await page.locator('#summary').innerText()).includes('US$ 6,00'));
});

test('empresa funcional USD mantiene identidad sin cambiar moneda local ni activar consolidación',{timeout:45000},async t=>{
 const{page,calls,base}=await fixture(t);await open(page,base);await page.selectOption('#subsidiaries','3');assert.equal(await page.inputValue('#presentationCurrency'),'LOCAL');assert.equal(await page.inputValue('#currency'),'3');await page.locator('#filters').evaluate(form=>form.requestSubmit());await page.locator('#reportCurrencyInfo').filter({hasText:'Expresado en USD'}).waitFor();const localValues=await page.locator('#tbody').innerText();await usd(page);assert.equal(calls.at(-1).filters.currencyId,'3');assert.deepEqual(calls.at(-1).filters.subsidiaryIds,[3]);assert.equal(calls.at(-1).filters.consolidated,false);assert.ok((await page.locator('#reportCurrencyInfo').innerText()).includes('Moneda local de la empresa: USD'));assert.ok(localValues.includes('US$'));assert.equal(await page.locator('#tbody').innerText(),localValues);
});

test('proyección conserva moneda local sin heredar el modo USD de los dos estados financieros',{timeout:45000},async t=>{
 const{page,base}=await fixture(t);await page.route('**/income-forecast.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic forecast</title>'}));await open(page,base,'income-statement');await usd(page);assert.ok((await page.locator('#forecastFromIncome').getAttribute('title')).includes('moneda local (JMD)'));await page.click('#forecastFromIncome');await page.waitForURL('**/income-forecast.html');const selected=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('nexo_income_forecast_filters')));assert.equal(selected.presentationCurrency,undefined);assert.equal(selected.currencyId,'1');assert.equal(selected.consolidated,false);
});

test('modo ORIGINAL oculto de CxC no sustituye USD en encabezados PDF y Excel financieros',{timeout:45000},async t=>{
 const{page,base}=await fixture(t);await page.goto(base+'/accounting-reports.html?reporte=receivables-aging');await page.locator('#agingCurrencyMode').selectOption('ORIGINAL');await page.click('#catalog');await page.getByText('Estado de Situación Financiera',{exact:true}).click();await page.locator('#reportCurrencyInfo').filter({hasText:'Expresado en JMD'}).waitFor();await usd(page);assert.equal(await page.inputValue('#agingCurrencyMode'),'ORIGINAL');await page.click('#pdf');assert.ok((await page.evaluate(()=>window.syntheticPrints.at(-1).unit)).includes('USD'));const exported=page.waitForEvent('download');await page.click('#excel');const book=new ExcelJS.Workbook();await book.xlsx.load(await readFile(await(await exported).path()));assert.ok(book.worksheets[0].getCell('A4').value.startsWith('USD'));
});

test('matriz exporta subcentavos crudos y totales sin reconstruirlos del texto visible',{timeout:45000},async t=>{
 const{page,base}=await fixture(t,(kind,filters)=>{const result=report(kind,filters);if(filters.columnView==='DEPARTMENT'){const ids=Array.from({length:200},(_,index)=>'dimension-'+index);result.columns=[...ids,'dimension-micro'].map(id=>({id,name:id}));result.rows=[{account_id:10,account_number:'4001',account_name:'Ventas',category:'Ingreso',debit:0,credit:.0100001,dimensions:{...Object.fromEntries(ids.map(id=>[id,.00005])),'dimension-micro':.0000001}}];result.summary={periodResult:.0100001,columnView:'DEPARTMENT'}}return result});await open(page,base,'income-statement');await usd(page);await page.selectOption('#columnView','DEPARTMENT');await page.locator('#thead').filter({hasText:'dimension-199'}).waitFor();assert.ok((await page.locator('#thead').innerText()).includes('dimension-micro'));let downloads=0;page.on('download',()=>downloads++);
 const csvPending=page.waitForEvent('download');await page.click('#csv');const csv=await readFile(await(await csvPending).path(),'utf8'),line=csv.split('\r\n').find(line=>line.startsWith('"4001","Ventas"'));assert.ok(line.includes('"0.00005"'));const values=JSON.parse('['+line+']');assert.equal(Number(values[2]),.00005);assert.ok(Math.abs(Number(values.at(-1))-.0100001)<1e-12);
 const excelPending=page.waitForEvent('download');await page.click('#excel');const book=new ExcelJS.Workbook();await book.xlsx.load(await readFile(await(await excelPending).path()));let row;book.worksheets[0].eachRow(candidate=>{if(candidate.getCell(1).value==='4001')row=candidate});assert.equal(row.getCell(3).value,.00005);assert.ok(Math.abs(row.getCell(book.worksheets[0].columnCount).value-.0100001)<1e-12);
 await page.locator('#tbody .tree-account [data-export-number]').first().evaluate(cell=>cell.dataset.exportNumber='NaN');await page.click('#csv');await page.locator('#message').filter({hasText:'importe numérico inválido'}).waitFor();assert.equal(downloads,2);
});

test('balance USD no declara cuadre si la fuente local viene sin conciliar',{timeout:45000},async t=>{
 const{page,base}=await fixture(t,(kind,filters)=>{const result=report(kind,filters);if(filters.presentationCurrency==='USD')Object.assign(result.summary,{sourceBalanced:false,localBalanceDifference:.1,translationAdjustment:0});return result});await open(page,base);await usd(page);assert.ok((await page.locator('#summary').innerText()).includes('Origen pendiente de conciliación en JMD'));assert.ok(!(await page.locator('#summary').innerText()).includes('Cuadrada al centavo'));assert.equal(await page.locator('#summary .unreconciled').count(),1);
});
