import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {forecastCsv,forecastPdfHtml} from '../public/income-forecast-export.js';
import {renderBankReconciliationPdf} from '../dist/modules/reports/accounting-reports.service.js';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
const months=Array.from({length:12},(_,i)=>`2026-${String(i+1).padStart(2,'0')}`),rows=[
 {key:'1:7',number:'400101',name:'Ingresos por servicios profesionales',category:'Ingreso',dimension:'7',values:months.map((_,i)=>i===8?125000:100000)},
 {key:'2:8',number:'500101',name:'Costos de operación regional',category:'Costo',dimension:'8',values:months.map(()=>40000)},
 {key:'3:7',number:'600101',name:'Gastos administrativos y comerciales',category:'Gasto',dimension:'7',values:months.map((_,i)=>i===9?-1500:15000)}];
const report={start:'2026-01-01',end:'2026-12-31',cutoff:'2026-08-31',k:8,months,method:'RUN_RATE',currency:'USD',companies:[{name:'Sociedad de demostración'}],rows,notes:['Los meses futuros se proyectan con base en el promedio mensual YTD.'],rates:[]};
const options={scenario:'Plan comercial 2026',dimensionName:id=>id==='7'?'Administración':'Operaciones',filters:[['Departamento','Todos'],['Nivel de detalle','Cuentas'],['Excluir cierres','Sí']],overrides:{'1:7:2026-09':{amount:125000,reason:'Contrato adicional previsto para septiembre'}},issuedAt:new Date('2026-09-22T15:00:00Z')};
const csv=forecastCsv(report,options),html=forecastPdfHtml(report,options);
assert.ok(csv.startsWith('\uFEFFsep=;\r\n'));assert.ok(!csv.includes('RUN_RATE'));assert.ok(!csv.includes('1:7:2026'));assert.ok(csv.includes('Resultado neto'));assert.ok(csv.includes('Contrato adicional'));assert.ok(csv.includes('125000,00'));
// Quoted fields may contain commas or line breaks; inspect the CSV as records.
const records=[];let record=[],cell='',quoted=false;const content=csv.slice(csv.indexOf('\r\n')+2);for(let i=0;i<content.length;i++){const ch=content[i];if(ch==='"'){if(quoted&&content[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(ch===';'&&!quoted){record.push(cell);cell='';}else if(ch==='\r'&&!quoted&&content[i+1]==='\n'){record.push(cell);records.push(record);record=[];cell='';i++;}else cell+=ch;}record.push(cell);records.push(record);
assert.ok(records.every(r=>r.length===records[0].length));assert.equal(records[0].length,28);assert.equal(records.filter(r=>r[5]==='Detalle').length,3);assert.equal(records.filter(r=>r[5]==='Resumen').length,5);
assert.ok(html.includes('Administración'));assert.ok(html.includes('Operaciones'));assert.ok(html.includes('A4 landscape'));assert.equal((html.match(/Detalle mensual ·/g)||[]).length,2);assert.ok(html.includes('(1 500,00)')||html.includes('(1500,00)')||html.includes('(1 500,00)'));
const malicious={...report,companies:[{name:'<script>bad</script>'}],rows:[{...rows[0],name:'=HYPERLINK("bad")'}]};assert.ok(forecastCsv(malicious,options).includes("'=HYPERLINK"));assert.ok(forecastPdfHtml(malicious,options).includes('&lt;script&gt;'));
await writeFile('.tmp/forecast-professional.html',html);await writeFile('.tmp/forecast-professional.csv',csv);
const file=await renderBankReconciliationPdf({html,fileName:'forecast-professional.pdf'});assert.equal(Buffer.from(file.base64,'base64').subarray(0,4).toString(),'%PDF');await writeFile('.tmp/forecast-professional.pdf',Buffer.from(file.base64,'base64'));
console.log(JSON.stringify({uniformCsv:true,numericAmounts:true,allDimensions:true,annualSummary:true,semesterDetail:true,readableAdjustments:true,escapedContent:true,realPdf:true}));
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage({acceptDownloads:true}),errors=[];await page.addInitScript(()=>{sessionStorage.setItem('nexo_token','test-session');sessionStorage.setItem('nexo_device_token','test-device');});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/test-professional-forecast',r=>r.fulfill({contentType:'text/html',body:'<iframe src="/income-forecast.html" style="width:100%;height:1000px"></iframe>'}));
 const uiReport={...report,columnView:'ACCOUNTING_PERIOD',overrides:options.overrides,totals:{real:360000,future:221500,annual:581500},rows:rows.map(r=>({...r,ytd:r.values.slice(0,8).reduce((s,v)=>s+v,0),future:r.values.slice(8).reduce((s,v)=>s+v,0),annual:r.values.reduce((s,v)=>s+v,0)}))};
 await page.route('**/api/reports/income-forecast/**',r=>r.fulfill({json:r.request().url().endsWith('/options')?{activeSubsidiaryId:1,subsidiaries:[{id:1,name:'Sociedad de demostración',currencyId:1}],currencies:[{id:1,code:'USD',name:'Dólar'}],years:[{id:1,name:'2026',start:report.start,end:report.end}],scenarios:[],departments:[{id:7,name:'Administración',subsidiaryId:1},{id:8,name:'Operaciones',subsidiaryId:1}]}:uiReport}));
 await page.route('**/api/reports/accounting/pending-invoice-control/pdf',async r=>{assert.equal(r.request().headers()['x-device-token'],'test-device');assert.equal(r.request().headers().authorization,'Bearer test-session');const p=r.request().postDataJSON();assert.ok(p.html.includes('Resumen anual'));assert.ok(p.html.includes('Contrato adicional'));assert.ok(!p.html.includes('RUN_RATE'));await r.fulfill({json:await renderBankReconciliationPdf(p)});});
 await page.goto('http://localhost:3000/test-professional-forecast');const frame=page.frameLocator('iframe');await frame.locator('#year option').first().waitFor({state:'attached'});await frame.locator('#cutoff').selectOption(report.cutoff);await frame.locator('#generate').click();await frame.locator('#matrix button[data-key]').first().waitFor();
 const csvDownload=page.waitForEvent('download');await frame.locator('#csv').click();assert.ok((await csvDownload).suggestedFilename().endsWith('.csv'));
 const pdfDownload=page.waitForEvent('download');await frame.locator('#pdf').click();assert.ok((await pdfDownload).suggestedFilename().endsWith('.pdf'));assert.deepEqual(errors,[]);
 console.log(JSON.stringify({csvButtonDownload:true,pdfButtonDownload:true,browserErrors:0}));
}finally{await browser.close();}
