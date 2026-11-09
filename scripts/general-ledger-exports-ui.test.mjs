import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect} from '@playwright/test';
import ExcelJS from 'exceljs';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
import {renderGeneralLedgerExport} from '../dist/modules/reports/general-ledger-export-renderer.js';

const server=await readFile('src/server.ts','utf8'),branding=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/),renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal);
const served=html=>html.replace('</head>',branding[2]+'</head>').replace('<head>','<head>'+renewal[1]+branding[1]);
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const round=value=>Number(value.toFixed(6));
function snapshot(total){
 const rows=Array.from({length:total},(_,index)=>{const first=index<400,start=first?0:400,count=first?Math.min(total,400):total-400;return{id:index+1,date:'2026-10-31',transaction_type:'Asiento',transaction_number:'DOC-SYN-'+(index+1),journal_id:900+index,journal_number:'ASI-SYN-'+(index+1),account_id:first?71:72,account_number:first?'111991':'212991',account_name:first?'Banco sintético':'Pasivo sintético',nature:'Deudora',entity_name:'Proveedor sintético '+index%3,entity_type:'Proveedor',cost_center:'Centro sintético '+index%2,concept:index===total-1?'ULTIMO_MOVIMIENTO_FUERA_DE_PAGINA':'Movimiento sintético '+(index+1),debit:1.234567,credit:0,running_balance:round((index-start+1)*1.234567),opening_balance:0,account_debit_total:round(count*1.234567),account_credit_total:0,account_final_balance:round(count*1.234567),original_currency_code:index%2?'JMD':'USD',original_exchange_rate:index%2?1:123.456789012,original_debit:index%2?1.234567:.01,original_credit:0};});
 return{rows,total,summary:{debit:round(total*1.234567),credit:0},snapshotFingerprint:'a'.repeat(32),context:{subsidiary:{id:1,name:'Empresa sintética'},localCurrency:{id:1,code:'JMD'},book:{id:5,name:'Libro principal sintético'},bookId:5,dateFrom:'2026-10-01',dateTo:'2026-10-31',filters:{subsidiaryIds:[1],dateFrom:'2026-10-01',dateTo:'2026-10-31'},generatedAt:'2026-11-09T20:00:00Z'}};
}
const initial=snapshot(520),fresh=snapshot(521);
const options={subsidiaries:[{id:1,name:'Empresa sintética',currencyId:1}],currencies:[{id:1,code:'JMD',symbol:'J$',name:'Dólar jamaiquino'},{id:2,code:'USD',symbol:'US$',name:'Dólar estadounidense'}],books:[{id:5,name:'Libro principal sintético',subsidiaryId:1}],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[{id:71,code:'111991',name:'Banco sintético',subsidiaryId:1},{id:72,code:'212991',name:'Pasivo sintético',subsidiaryId:1}],thirdParties:[],accountGroups:[],journalOptions:{canReverse:false,modules:[]},pendingInvoiceOptions:{customers:[]},bankOptions:{accounts:[],reconciliations:[]},agingOptions:{customers:[],suppliers:[],salesRepresentatives:[],supplierCategories:[]}};
// An opaque, valid PDF transport fixture. Professional PDF layout belongs to
// the renderer's own tests; the browser must download these bytes, never print.
function pdfFixture(){const stream='BT /F1 12 Tf 36 760 Td (Synthetic ledger export) Tj ET',objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>','<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];let out='%PDF-1.4\n',offsets=[0];objects.forEach((body,index)=>{offsets.push(Buffer.byteLength(out));out+=(index+1)+' 0 obj\n'+body+'\nendobj\n';});const start=Buffer.byteLength(out);out+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n';return Buffer.from(out);}
const prepared=new Map();
async function output(format,view,total=521){const key=format+'/'+view+'/'+total;if(!prepared.has(key))prepared.set(key,format==='pdf'?{buffer:pdfFixture(),mimeType:'application/pdf'}:await renderGeneralLedgerExport(total===0?snapshot(0):fresh,format,view));return prepared.get(key);}

async function fixture(t,{width=1536}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),calls=[],errors=[],unexpected=[],downloads=[],controls={gate:null,failure:null,filename:null};
 page.on('pageerror',error=>errors.push(error.message));page.on('download',download=>downloads.push(download));
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-ledger-export-token');localStorage.setItem('nexo_device_token','synthetic-ledger-export-device');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL)return route.fallback();
  if(url.pathname==='/accounting-reports.html')return route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/accounting-reports.html','utf8'))});
  if(!url.pathname.startsWith('/api/'))return route.fallback();
  const body=request.method()==='POST'?request.postDataJSON():null;calls.push({path:url.pathname,method:request.method(),body});
  if(url.pathname==='/api/reports/accounting/options')return route.fulfill({json:options});
  if(url.pathname==='/api/reports/accounting/general-ledger'){
   const size=Number(body.pageSize),start=(Number(body.page)-1)*size;return route.fulfill({json:{rows:initial.rows.slice(start,start+size),total:520,summary:initial.summary,page:body.page,pageSize:body.pageSize}});
  }
  if(url.pathname==='/api/reports/accounting/trial-balance')return route.fulfill({json:{rows:[],total:0,summary:{}}});
  if(url.pathname==='/api/reports/accounting/general-ledger/export'){
   const gate=controls.gate;if(gate)await gate.promise;
   if(controls.failure==='server')return route.fulfill({status:503,json:{error:{message:'No fue posible preparar la descarga sintética.'}}});
   const result=await output(body.format,body.view,controls.zeroRows?0:521),headers={'Content-Type':result.mimeType,'Content-Disposition':controls.filename||"attachment; filename*=UTF-8''Libro%20Mayor%20sint%C3%A9tico."+body.format,'X-Report-Total-Rows':controls.zeroRows?'0':'521','X-Report-Snapshot-Fingerprint':'a'.repeat(32)};
   if(controls.failure==='mime')headers['Content-Type']='text/html';if(controls.failure==='disposition')delete headers['Content-Disposition'];if(controls.failure==='fingerprint')headers['X-Report-Snapshot-Fingerprint']='invalid';
   return route.fulfill({status:controls.failure==='partial'?206:200,headers,body:controls.failure==='empty'?Buffer.alloc(0):result.buffer});
  }
  unexpected.push(url.pathname);return route.fulfill({status:501,json:{error:{message:'Unexpected synthetic API'}}});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;border:0;width:100%;height:100vh}</style></head><body><iframe src="'+baseURL+'/accounting-reports.html?reporte=general-ledger&dateFrom=2026-10-01&dateTo=2026-10-31&bookId=5"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();await expect(frame.locator('#reportTitle')).toHaveText('Libro Mayor');await expect(frame.locator('#excel')).toBeEnabled();await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));
 await frame.evaluate(()=>{window.syntheticPrints=0;window.syntheticOpens=0;window.print=()=>window.syntheticPrints++;window.open=()=>{window.syntheticOpens++;return null;};window.syntheticUrls={created:0,revoked:0};const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=value=>{window.syntheticUrls.created++;return create(value);};URL.revokeObjectURL=value=>{window.syntheticUrls.revoked++;return revoke(value);};});
 assert.equal(await frame.locator('html').evaluate(element=>element.classList.contains('inside-erp-workspace')),true);assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{controls.gate?.resolve();assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);});return{page,frame,calls,controls,downloads};
}
const exportsOf=calls=>calls.filter(call=>call.path==='/api/reports/accounting/general-ledger/export');
async function capture(page,name){if(process.env.GENERAL_LEDGER_EXPORTS_CAPTURE!=='1')return;const folder=resolve('..','general-ledger-exports-qa-20261109');await mkdir(folder,{recursive:true});await page.screenshot({path:resolve(folder,name),animations:'disabled'});}

for(const[format,view,width]of[['xlsx','ACCOUNT',1536],['csv','COST',390],['pdf','ENTITY',390]])test(`${format} ${width}: descarga binaria completa con filtros generados y vista ${view}, sin imprimir`,{timeout:45000},async t=>{
 const{page,frame,calls,controls}=await fixture(t,{width});await frame.locator('#ledgerView').selectOption(view);const gate=deferred();controls.gate=gate;const waiting=page.waitForEvent('download');await frame.locator('#'+(format==='xlsx'?'excel':format)).click();await expect.poll(()=>exportsOf(calls).length).toBe(1);
 for(const id of['pdf','excel','csv']){await expect(frame.locator('#'+id)).toBeDisabled();await expect(frame.locator('#'+id)).toHaveAttribute('aria-busy','true');}await expect(frame.locator('#ledgerExportStatus')).toHaveAttribute('aria-busy','true');
 const buttons=await frame.locator('.exports').evaluate(element=>[...element.querySelectorAll('button:not([hidden])')].map(button=>button.getBoundingClientRect().toJSON()));for(const box of buttons)assert.ok(box.x>=0&&box.right<=width+1&&box.height>=44,JSON.stringify(box));await capture(page,`ledger-exports-${format}-${width}-loading.png`);
 gate.resolve();const downloaded=await waiting;assert.equal(downloaded.suggestedFilename(),'Libro Mayor sintético.'+format);const bytes=await readFile(await downloaded.path()),expected=await output(format,view);assert.deepEqual(bytes,expected.buffer);
 const request=exportsOf(calls)[0].body;assert.deepEqual(Object.keys(request).sort(),['filters','format','view']);assert.equal(request.format,format);assert.equal(request.view,view);assert.deepEqual(Object.keys(request.filters).sort(),['subsidiaryIds','bookId','dateFrom','dateTo','accountId','accountFrom','accountTo','entityType','entityId','costCenterId'].sort());assert.deepEqual(request.filters.subsidiaryIds,[1]);assert.equal(request.filters.dateFrom,'2026-10-01');assert.equal(request.filters.dateTo,'2026-10-31');assert.equal(String(request.filters.bookId),'5');assert.equal(Object.hasOwn(request.filters,'page'),false);assert.equal(Object.hasOwn(request,'rows'),false);
 if(format==='xlsx'){const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);const sheet=workbook.getWorksheet('Libro Mayor'),movements=[];sheet.eachRow(row=>{if(row.getCell(1).value instanceof Date)movements.push(row);});assert.equal(movements.length,521);assert.equal(movements.at(-1).getCell(7).value,'ULTIMO_MOVIMIENTO_FUERA_DE_PAGINA');assert.equal(typeof movements[0].getCell(12).value,'number');assert.equal(movements[0].getCell(12).value,123.456789012);assert.equal(typeof movements[0].getCell(13).value,'number');assert.equal(movements[0].getCell(14).value,0);}
 if(format==='csv'){const text=bytes.toString('utf8');assert.equal(text.split('\r\n').filter(line=>/^"?MOVIMIENTO"?,/.test(line)).length,521);assert.ok(text.includes('ULTIMO_MOVIMIENTO_FUERA_DE_PAGINA'));assert.ok(text.includes('Moneda original'));}
 await expect(frame.locator('#ledgerExportStatus')).toContainText('521 movimientos');await expect(frame.locator('#excel')).toBeEnabled();assert.equal(await frame.evaluate(()=>window.syntheticPrints+window.syntheticOpens),0);await frame.waitForFunction(()=>window.syntheticUrls.revoked===1);assert.deepEqual(await frame.evaluate(()=>window.syntheticUrls),{created:1,revoked:1});
});

test('doble click y formatos simultáneos originan una sola descarga, con estados accesibles restaurados',{timeout:30000},async t=>{
 const{page,frame,calls,controls,downloads}=await fixture(t);const gate=deferred();controls.gate=gate;await frame.evaluate(()=>{document.getElementById('csv').onclick();document.getElementById('csv').onclick();document.getElementById('pdf').onclick();});await expect.poll(()=>exportsOf(calls).length).toBe(1);await expect(frame.getByRole('status')).toContainText('Preparando CSV');const waiting=page.waitForEvent('download');gate.resolve();await waiting;await expect(frame.locator('#csv')).toBeEnabled();assert.equal(downloads.length,1);assert.equal(exportsOf(calls).length,1);await expect(frame.locator('#csv')).toHaveText('CSV');await expect(frame.locator('#pdf')).toHaveText('PDF');
});

test('filtros no generados bloquean antes del request; cambiar vista o fecha cancela la descarga pendiente',{timeout:40000},async t=>{
 const{frame,calls,controls,downloads}=await fixture(t);await frame.locator('#accountFrom').selectOption('71');await expect(frame.locator('#excel')).toBeDisabled();await frame.locator('#excel').evaluate(button=>button.onclick());await expect(frame.locator('#ledgerExportStatus')).toContainText('Genere el Libro Mayor');assert.equal(exportsOf(calls).length,0);
 await frame.locator('#filters').dispatchEvent('submit');await expect(frame.locator('#excel')).toBeEnabled();const first=deferred();controls.gate=first;await frame.locator('#csv').click();await expect.poll(()=>exportsOf(calls).length).toBe(1);await frame.locator('#ledgerView').selectOption('ENTITY');first.resolve();await expect(frame.locator('#csv')).toBeEnabled();assert.equal(downloads.length,0);
 const second=deferred();controls.gate=second;await frame.locator('#pdf').click();await expect.poll(()=>exportsOf(calls).length).toBe(2);await frame.locator('#from').fill('2026-10-02');second.resolve();await expect(frame.locator('#pdf')).toBeDisabled();await expect(frame.locator('#ledgerExportStatus')).toContainText('canceló');assert.equal(downloads.length,0);
});

test('renovación de misma generación permite descargar y cambios reales de empresa o rol descartan incluso un blob ya recibido',{timeout:50000},async t=>{
 const first=await fixture(t),gate=deferred();first.controls.gate=gate;await first.frame.evaluate(()=>{const state=window.NexoSessionRenewal.current();window.NexoSessionRenewal={current:()=>state};});const waiting=first.page.waitForEvent('download');await first.frame.locator('#csv').click();await expect.poll(()=>exportsOf(first.calls).length).toBe(1);await first.frame.evaluate(()=>{localStorage.setItem('nexo_token','synthetic-renewed-ledger-token');dispatchEvent(new Event('focus'));});gate.resolve();await waiting;assert.equal(first.downloads.length,1);
 for(const[key,value]of[['nexo_company','2'],['nexo_role','3']]){const item=await fixture(t);await item.frame.evaluate(()=>{const native=window.fetch.bind(window);window.fetch=async(resource,init)=>{const response=await native(resource,init);if(String(resource).endsWith('/general-ledger/export')){const blob=await response.blob();response.blob=()=>new Promise(done=>{window.syntheticReleaseBlob=()=>done(blob);window.syntheticBlobHeld=true;});}return response;};});await item.frame.locator('#csv').click();await item.frame.waitForFunction(()=>window.syntheticBlobHeld);await item.frame.evaluate(([key,value])=>{localStorage.setItem(key,value);dispatchEvent(new Event('focus'));window.syntheticReleaseBlob();},[key,value]);await expect(item.frame.locator('#ledgerExportStatus')).toContainText('empresa, el rol o la sesión');await expect(item.frame.locator('#csv')).toBeDisabled();assert.equal(item.downloads.length,0);assert.equal(exportsOf(item.calls).length,1);}
});

test('errores, MIME incorrecto, adjunto incompleto y cuerpo vacío no descargan; filename malicioso usa alternativa segura',{timeout:50000},async t=>{
 const{page,frame,calls,controls,downloads}=await fixture(t);for(const failure of['server','mime','disposition','fingerprint','partial','empty']){controls.failure=failure;await frame.locator('#csv').click();await expect(frame.locator('#ledgerExportStatus')).toHaveAttribute('data-state','error');await expect(frame.locator('#csv')).toBeEnabled();assert.equal(downloads.length,0,failure);}
 assert.equal(exportsOf(calls).length,6);controls.failure=null;controls.filename='attachment; filename="../../archivo.html"';const waiting=page.waitForEvent('download');await frame.locator('#csv').click();const file=await waiting;assert.equal(file.suggestedFilename(),'libro-mayor-2026-10-31.csv');assert.equal(downloads.length,1);
 controls.zeroRows=true;controls.filename=null;const emptyReport=page.waitForEvent('download');await frame.locator('#csv').click();const emptyFile=await emptyReport;assert.ok((await readFile(await emptyFile.path())).length>0);await expect(frame.locator('#ledgerExportStatus')).toContainText('0 movimientos');assert.equal(downloads.length,2);
});

test('salir del Mayor cancela su descarga y conserva el PDF por impresión de otros informes',{timeout:30000},async t=>{
 const{frame,calls,controls,downloads}=await fixture(t),gate=deferred();controls.gate=gate;await frame.locator('#pdf').click();await expect.poll(()=>exportsOf(calls).length).toBe(1);await frame.locator('#catalog').click();await frame.locator('[data-i18n="reports.catalog.trial-balance.title"]').click();await expect(frame.locator('#reportTitle')).toHaveText(/Balance de comprobación/i);await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));gate.resolve();await frame.locator('#pdf').click();await expect.poll(()=>frame.evaluate(()=>window.syntheticPrints)).toBe(1);assert.equal(downloads.length,0);assert.equal(exportsOf(calls).length,1);await expect(frame.locator('#ledgerExportStatus')).toBeHidden();
 await frame.locator('#catalog').click();await frame.locator('[data-i18n="reports.catalog.general-ledger.title"]').click();await expect(frame.locator('#csv')).toBeEnabled();const leaving=deferred();controls.gate=leaving;await frame.locator('#csv').click();await expect.poll(()=>exportsOf(calls).length).toBe(2);await frame.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));leaving.resolve();await frame.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await expect(frame.locator('#csv')).toBeEnabled();assert.equal(downloads.length,0);
});
