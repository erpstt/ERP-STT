import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

// Actual modules and production branding in the workspace iframe. Only fake APIs.
const server=await readFile('src/server.ts','utf8'),branding=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/),renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal);
const served=html=>html.replace('</head>',branding[2]+'</head>').replace('<head>','<head>'+renewal[1]+branding[1]);
const cutoff='2026-10-31';
const successMessage='Conciliación finalizada correctamente. Consulte Vista → Resumen de cierre o Vista → Historial de conciliaciones.';
const refreshMessage='La conciliación quedó cerrada, pero no fue posible actualizar la pantalla. Vuelva a cargar el reporte; no es necesario finalizarla otra vez.';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function options(closed){return{subsidiaries:[{id:1,name:'Subsidiaria sintética',currencyId:1}],currencies:[{id:1,code:'CRC',symbol:'₡'}],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],journalOptions:{canReverse:false,modules:[]},pendingInvoiceOptions:{customers:[]},bankOptions:{accounts:[7,8].map(id=>({id,number:'SYN-000'+id,name:'Banco sintético - SYN-000'+id,bankId:2,bankName:'Banco sintético',subsidiaryId:1,currencyId:1,currencyCode:'CRC',currencySymbol:'₡'})),reconciliations:[7,8].map(id=>({id:id===7?41:42,bankAccountId:id,accountNumber:'SYN-000'+id,bankName:'Banco sintético',currencyCode:'CRC',currencySymbol:'₡',date:cutoff,period:'Octubre sintético',status:id===7&&closed?'CERRADA':'ABIERTA',bookBalance:50,statementBalance:50,transitPayments:0,transitDeposits:0,adjustments:0,difference:0,...(id===7&&closed?{closedBy:'Usuario sintético',closedAt:'2026-11-07T12:00:00Z'}:{})}))}};}
const report=(closed,accountId)=>({rows:[],statementLines:[],summary:{bookBalance:50,statementBalance:50,transitPayments:0,transitDeposits:0},reconciliation:{id:accountId===7?41:42,status:closed&&accountId===7?'CERRADA':'ABIERTA'},total:0,page:1,pageSize:250});
async function fixture(t,{width=1536,postError=false,refreshError=null,optionsGate=null}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),calls=[],errors=[],unexpected=[],alerts=[],state={closed:false};
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',async dialog=>{alerts.push(dialog.message());await dialog.accept();});
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-close-history-token');localStorage.setItem('nexo_device_token','synthetic-close-history-device');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/accounting-reports.html'){await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/accounting-reports.html','utf8'))});return;}
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  const call={path:url.pathname,method:request.method(),body:request.method()==='POST'?request.postDataJSON():null};calls.push(call);
  if(url.pathname==='/api/reports/accounting/options'){
   if(state.closed&&optionsGate)await optionsGate.promise;
   if(state.closed&&refreshError==='options'){await route.fulfill({status:503,json:{error:{message:'No fue posible actualizar las opciones sintéticas.'}}});return;}
   await route.fulfill({json:options(state.closed)});return;
  }
  if(url.pathname==='/api/reports/accounting/bank-reconciliation'){
   if(state.closed&&refreshError==='report'){await route.fulfill({status:503,json:{error:{message:'No fue posible actualizar el resumen sintético.'}}});return;}
   await route.fulfill({json:report(state.closed,Number(call.body.bankAccountId))});return;
  }
  if(url.pathname==='/api/reports/accounting/bank-reconciliation/close'){
   if(postError){await route.fulfill({status:409,json:{error:{message:'La conciliación está protegida por su estado.'}}});return;}
   state.closed=true;await route.fulfill({json:{result:41}});return;
  }
  unexpected.push(request.method()+' '+url.pathname);await route.fulfill({status:501,json:{error:{message:'Unmocked API blocked'}}});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/accounting-reports.html"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();await frame.getByText('Bancos y Conciliación',{exact:true}).click();await frame.locator('#bankView').selectOption('WORKSPACE');await frame.locator('#bankAccount').selectOption('7');await frame.locator('#bankCutoff').fill(cutoff);await frame.locator('#bankCutoff').dispatchEvent('change');await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));await expect(frame.locator('#closeReconciliation')).toBeEnabled();
 assert.equal(await frame.locator('html').evaluate(element=>element.classList.contains('inside-erp-workspace')),true);assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(alerts,[]);});return{page,frame,calls,state};
}
const closes=calls=>calls.filter(call=>call.path.endsWith('/close'));
const optionReads=calls=>calls.filter(call=>call.path==='/api/reports/accounting/options');
const reports=calls=>calls.filter(call=>call.path==='/api/reports/accounting/bank-reconciliation');
async function confirm(frame){await frame.locator('#closeReconciliation').click();await expect(frame.locator('#bankCloseDialog')).toBeVisible();await frame.locator('#bankCloseAcknowledgement').check();await frame.locator('#confirmBankClose').click();await expect(frame.locator('#bankCloseDialog')).toBeHidden();}
async function capture(page,name){if(process.env.BANK_CLOSE_HISTORY_CAPTURE!=='1')return;const folder=resolve('..','bank-close-history-qa-20261107');await mkdir(folder,{recursive:true});await page.screenshot({path:resolve(folder,name),fullPage:true,animations:'disabled'});}

for(const width of[1536,390])test(`cierre ${width}: resumen e historial frescos muestran CERRADA con la misma cuenta y corte, sin otro POST de cierre`,{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t,{width});await confirm(frame);await expect(frame.locator('#bankActionMessage')).toHaveText(successMessage);await expect(frame.locator('#bankView')).toHaveValue('CLOSED');assert.equal(await frame.locator('#bankView option:checked').innerText(),'Resumen de cierre');assert.equal(await frame.locator('#bankAccount').inputValue(),'7');assert.equal(await frame.locator('#bankCutoff').inputValue(),cutoff);await expect(frame.locator('#tbody')).toContainText('CERRADA');await expect(frame.locator('#closeReconciliation')).toBeDisabled();await capture(page,`bank-close-${width}-summary.png`);
 assert.deepEqual(closes(calls).map(call=>({method:call.method,body:call.body})),[{method:'POST',body:{p_bank_account_id:7,p_cutoff:cutoff,p_bank_adjustments:0}}]);assert.ok(reports(calls).some(call=>call.body.bankView==='CLOSED'&&String(call.body.bankAccountId)==='7'&&call.body.dateTo===cutoff));
 const before=optionReads(calls).length;await frame.locator('#bankView').selectOption('HISTORY');await expect.poll(()=>optionReads(calls).length).toBe(before+1);await expect(frame.locator('#tbody')).toContainText('CERRADA');const row=frame.locator('#tbody tr').filter({hasText:'SYN-0007'});await expect(row).toContainText(cutoff);await expect(row).toContainText('CERRADA');assert.equal(await row.getByRole('button',{name:'Continuar conciliación',exact:true}).count(),0);assert.equal(await frame.locator('#tbody').getByText('SYN-0008',{exact:false}).count(),0);await capture(page,`bank-close-${width}-history.png`);
 await row.getByRole('button',{name:'Ver reporte de cierre',exact:true}).click();await expect(frame.locator('#bankView')).toHaveValue('CLOSED');await expect(frame.locator('#tbody')).toContainText('CERRADA');assert.equal(await frame.locator('#bankAccount').inputValue(),'7');assert.equal(await frame.locator('#bankCutoff').inputValue(),cutoff);assert.equal(closes(calls).length,1);assert.equal(calls.filter(call=>call.path.endsWith('/close-report')).length,0,'Summary/history read through the existing report endpoint');
});

test('error del POST no anuncia cierre, conserva WORKSPACE y no solicita opciones nuevas ni reintenta',{timeout:30000},async t=>{
 const{frame,calls,state}=await fixture(t,{postError:true}),before=optionReads(calls).length;await confirm(frame);await expect(frame.locator('#bankActionMessage')).toHaveText('La conciliación está protegida por su estado.');assert.equal(state.closed,false);await expect(frame.locator('#bankView')).toHaveValue('WORKSPACE');await expect(frame.locator('#closeReconciliation')).toBeEnabled();assert.equal(closes(calls).length,1);assert.equal(optionReads(calls).length,before);assert.doesNotMatch(await frame.locator('#bankActionMessage').innerText(),/finalizada correctamente|quedó cerrada/);
});

for(const refreshError of['options','report'])test(`cierre persistido y fallo de ${refreshError}: informa actualización pendiente, no habilita ni repite finalizar`,{timeout:30000},async t=>{
 const{frame,calls,state}=await fixture(t,{refreshError});await confirm(frame);await expect(frame.locator('#bankActionMessage')).toHaveText(refreshMessage);assert.equal(state.closed,true);await expect(frame.locator('#closeReconciliation')).toBeDisabled();if(refreshError==='options'){await expect(frame.locator('#bankView')).toHaveValue('CLOSED');await expect(frame.locator('#statementFile')).toBeHidden();await expect(frame.locator('#importStatement')).toBeHidden();await expect(frame.locator('#autoMatch')).toBeHidden();}assert.equal(await frame.locator('#bankAccount').inputValue(),'7');assert.equal(await frame.locator('#bankCutoff').inputValue(),cutoff);await frame.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));assert.equal(closes(calls).length,1);assert.doesNotMatch(await frame.locator('#bankActionMessage').innerText(),/intente finalizar de nuevo|vuelva a finalizar/);
});

test('respuesta tardía del refresco no navega ni muestra el cierre anterior sobre otra cuenta',{timeout:30000},async t=>{
 const gate=deferred(),{page,frame,calls}=await fixture(t,{optionsGate:gate});await confirm(frame);await expect.poll(()=>optionReads(calls).length).toBe(2);await frame.locator('#bankAccount').selectOption('8');await frame.locator('#bankView').selectOption('WORKSPACE');await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));await expect(frame.locator('#closeReconciliation')).toBeEnabled();const before=reports(calls).length,response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/reports/accounting/options');gate.resolve();await(await response).finished();await frame.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));await expect(frame.locator('#bankAccount')).toHaveValue('8');await expect(frame.locator('#bankView')).toHaveValue('WORKSPACE');assert.equal(reports(calls).length,before);assert.notEqual(await frame.locator('#bankActionMessage').innerText(),successMessage);assert.equal(closes(calls).length,1);
});
