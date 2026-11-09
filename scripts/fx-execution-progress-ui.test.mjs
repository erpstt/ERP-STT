import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

const server=await readFile('src/server.ts','utf8'),branding=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/),renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal);
const served=html=>html.replace('</head>',branding[2]+'</head>').replace('<head>','<head>'+renewal[1]+branding[1]);
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const snapshot=[{accountId:71,accountNumber:'111991',accountName:'Banco sintético',sourceType:'Mayor',foreignBalance:1000,bookValue:150000,historicalRate:150,revaluedBalance:155000,adjustment:5000,signedAdjustment:5000,impact:'GANANCIA NO REALIZADA'}];
const preview={run_id:7,subsidiary_id:1,currency_id:2,status:'PENDIENTE',fingerprint:'f'.repeat(32),closing_date:'2026-10-31',closing_rate:155,auto_reverse:true,reversal_date:'2026-11-01',gain_account_id:72,loss_account_id:73,gain_taxable:false,loss_deductible:false,tax_note:'',snapshot,journal_id:null,reversal_journal_id:null};
const posted={...preview,status:'CONTABILIZADO',journal_id:701,reversal_journal_id:702,effective_status:'REVERSADO',currency:'USD',period:'Octubre sintético',journalNumber:'DIF-SYN-701',reversalNumber:'DIF-SYN-702',accounts:[]};
const options={access:{canCreate:true,canViewHistory:true,canCancel:false},subsidiary:{id:1,name:'Empresa sintética',currency:'JMD'},currencies:[{id:2,code:'USD',name:'Dólar sintético'}],accounts:[{id:71,number:'111991',name:'Banco sintético',category:'Activo'},{id:72,number:'420199',name:'Ganancia sintética',category:'Ingreso'},{id:73,number:'520199',name:'Pérdida sintética',category:'Gasto'}],periods:[{id:10,name:'Octubre sintético',start:'2026-10-01',end:'2026-10-31',closed:false}],rates:[{currencyId:2,date:'2026-10-31',rate:155}],settings:{gain_account_id:72,loss_account_id:73,gain_taxable:false,loss_deductible:false,tax_note:''}};
async function fixture(t,{width=1536,executeGate=null,checkGate=null,history=true,reader=false,executeError=null,checkError=false,globalError=false,incomplete=false,reportPending=false}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),calls=[],errors=[],unexpected=[],controls={executeError,checkError,globalError,incomplete,reportPending};
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-fx-progress-token');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');localStorage.setItem('nexo_device_token','synthetic-fx-progress-device');});
 for(const gate of[executeGate,checkGate])if(gate)t.after(()=>gate.resolve());
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL)return route.fallback();
  if(url.pathname==='/fx-revaluation.html')return route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/fx-revaluation.html','utf8'))});
  if(!url.pathname.startsWith('/api/'))return route.fallback();
  const action=url.pathname.split('/').at(-1),body=request.method()==='POST'?request.postDataJSON():null;calls.push({action,path:url.pathname,method:request.method(),body});
  if(url.pathname==='/api/audit/record-actor')return route.fulfill({json:{}});
  if(!url.pathname.startsWith('/api/accounting/fx-revaluation/')){unexpected.push(url.pathname);return route.fulfill({status:501,json:{error:{message:'Unexpected synthetic API'}}});}
  if(action==='options')return route.fulfill({json:{...options,access:{canCreate:!reader,canViewHistory:history,canCancel:false}}});
  if(action==='preview')return route.fulfill({json:preview});
  if(action==='execute'){
   if(executeGate)await executeGate.promise;
   if(controls.executeError==='network')return route.abort('failed');
   if(controls.executeError)return route.fulfill({status:controls.executeError,json:{error:{message:controls.executeError===409?'La vista previa cambió. Vuelva a visualizar el asiento.':'No fue posible procesar la revaluación.'}}});
   return route.fulfill({json:controls.incomplete?{run_id:7,status:'CONTABILIZADO'}:posted});
  }
  if(action==='report'){
   if(body?.runId!==undefined){assert.deepEqual(body,{runId:7});if(checkGate)await checkGate.promise;if(controls.checkError)return route.fulfill({status:503,json:{error:{message:'Consulta sintética no disponible'}}});return route.fulfill({json:{runs:[controls.reportPending?preview:controls.badReversal?{...posted,reversal_journal_id:799}:posted]}});}
   if(controls.globalError)return route.fulfill({status:503,json:{error:{message:'Análisis sintético no disponible'}}});return route.fulfill({json:{runs:[posted]}});
  }
  unexpected.push(action);return route.fulfill({status:501,json:{error:{message:'Unexpected synthetic action'}}});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{width:100%;height:100vh;border:0;display:block}</style></head><body><iframe src="'+baseURL+'/fx-revaluation.html"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();await expect(frame.locator('#company')).toHaveText('Empresa sintética');
 await expect(frame.locator('#previewButton')).toBeEnabled({enabled:!reader});
 assert.equal(await frame.locator('html').evaluate(element=>element.classList.contains('inside-erp-workspace')),true);assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 const prepare=async()=>{await frame.locator('#closingDate').fill('2026-10-31');await frame.locator('#closingDate').dispatchEvent('change');await frame.locator('#previewButton').click();await expect(frame.locator('#execute')).toBeEnabled();};
 t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);});return{page,frame,calls,controls,prepare};
}
const executes=calls=>calls.filter(call=>call.action==='execute');
const exactReads=calls=>calls.filter(call=>call.action==='report'&&call.body?.runId===7);
async function capture(page,name){if(process.env.FX_EXECUTION_PROGRESS_CAPTURE!=='1')return;const folder=resolve('..','fx-execution-progress-qa-20261109');await mkdir(folder,{recursive:true});await page.screenshot({path:resolve(folder,name),animations:'disabled'});}

for(const width of[1536,390])test(`avance ${width}: 33 fijo durante POST, 67 durante consulta y 100 sólo comprobado; doble click no duplica`,{timeout:40000},async t=>{
 const executeGate=deferred(),checkGate=deferred(),{page,frame,calls,prepare}=await fixture(t,{width,executeGate,checkGate});await prepare();
 await frame.evaluate(()=>{document.getElementById('execute').onclick();document.getElementById('execute').onclick();});await expect.poll(()=>executes(calls).length).toBe(1);
 await expect(frame.locator('#fxExecutionPercent')).toHaveText('33%');await expect(frame.locator('#fxExecutionCount')).toHaveText('1 de 3 etapas confirmadas');await expect(frame.getByRole('progressbar',{name:'Avance por etapas'})).toHaveAttribute('aria-valuenow','33');
 await page.waitForTimeout(350);await expect(frame.locator('#fxExecutionPercent')).toHaveText('33%');await expect(frame.locator('#execute')).toBeDisabled();await expect(frame.locator('#closingDate')).toBeDisabled();await expect(frame.locator('#fxExecutionTitle')).toBeFocused();
 const bounds=await frame.locator('#fxExecutionProgress').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1,JSON.stringify(bounds));assert.equal(await frame.locator('#fxExecutionProgress').evaluate(element=>element.scrollWidth<=element.clientWidth+1),true);await capture(page,`fx-progress-${width}-processing.png`);
 executeGate.resolve();await expect.poll(()=>exactReads(calls).length).toBe(1);await expect(frame.locator('#fxExecutionPercent')).toHaveText('67%');await expect(frame.locator('#fxExecutionBadge')).toHaveText('Contabilización confirmada');await expect(frame.locator('#execute')).toBeDisabled();
 checkGate.resolve();await expect(frame.locator('#fxExecutionPercent')).toHaveText('100%');await expect(frame.locator('#fxExecutionCount')).toHaveText('3 de 3 etapas confirmadas');await expect(frame.locator('#fxExecutionBadge')).toHaveText('Comprobada');
 assert.deepEqual(executes(calls).map(call=>call.body),[{runId:7,fingerprint:'f'.repeat(32)}]);await expect(frame.getByRole('link',{name:'Ver asiento de cierre',exact:true})).toHaveAttribute('href','/journal-view.html?id=701');await expect(frame.getByRole('link',{name:'Ver asiento de reversión',exact:true})).toHaveAttribute('href','/journal-view.html?id=702');assert.equal(executes(calls).length,1);await expect(frame.locator('#execute')).toBeDisabled();await capture(page,`fx-progress-${width}-complete.png`);
});

test('POST confirmado y consulta fallida mantienen 67 y sólo permiten consultar estado sin otro execute',{timeout:30000},async t=>{
 const{frame,calls,controls,prepare}=await fixture(t,{checkError:true});await prepare();await frame.locator('#execute').click();await expect(frame.locator('#fxExecutionProgress')).toHaveAttribute('data-phase','confirmed-pending');await expect(frame.locator('#fxExecutionPercent')).toHaveText('67%');await expect(frame.locator('#fxExecutionStatus')).toContainText('contabilización está confirmada');await expect(frame.locator('#execute')).toBeDisabled();await expect(frame.locator('#previewButton')).toBeDisabled();
 controls.checkError=false;controls.badReversal=true;await frame.getByRole('button',{name:'Consultar estado',exact:true}).click();await expect(frame.locator('#fxExecutionProgress')).toHaveAttribute('data-phase','confirmed-pending');await expect(frame.locator('#fxExecutionPercent')).toHaveText('67%');
 controls.badReversal=false;await frame.getByRole('button',{name:'Consultar estado',exact:true}).click();await expect(frame.locator('#fxExecutionPercent')).toHaveText('100%');assert.equal(executes(calls).length,1);assert.equal(exactReads(calls).length,3);
});

test('respuesta perdida se recupera con lectura exacta y reconoce reversión efectiva sin repetir contabilización',{timeout:30000},async t=>{
 const{frame,calls,prepare}=await fixture(t,{executeError:'network',history:false});await prepare();await frame.locator('#execute').click();await expect(frame.locator('#fxExecutionPercent')).toHaveText('100%');await expect(frame.locator('#fxExecutionStatus')).toContainText('contabilizados y comprobados');assert.equal(executes(calls).length,1);assert.equal(exactReads(calls).length,1);assert.ok(calls.filter(call=>call.action==='report').every(call=>call.body?.runId===7));await expect(frame.locator('#reportTab')).toBeDisabled();
});

test('JSON 2xx incompleto requiere lectura; fallo del análisis global no borra el éxito comprobado',{timeout:30000},async t=>{
 const{frame,calls,prepare}=await fixture(t,{incomplete:true,globalError:true});await prepare();await frame.locator('#execute').click();await expect(frame.locator('#fxExecutionPercent')).toHaveText('100%');await expect(frame.locator('#message')).toContainText('contabilizada y comprobada');await expect(frame.locator('#message')).toContainText('No fue posible cargar el análisis');assert.equal(await frame.locator('#message').getAttribute('class'),'');assert.equal(executes(calls).length,1);assert.equal(exactReads(calls).length,1);await expect(frame.locator('#execute')).toBeDisabled();
});

test('409 no muestra éxito ni repite POST; red ambigua y proceso pendiente exigen nueva vista previa',{timeout:40000},async t=>{
 const first=await fixture(t,{executeError:409});await first.prepare();await first.frame.locator('#execute').click();await expect(first.frame.locator('#fxExecutionProgress')).toHaveAttribute('data-phase','failed');await expect(first.frame.locator('#message')).toContainText('Vuelva a visualizar');await expect(first.frame.locator('#execute')).toBeDisabled();assert.equal(executes(first.calls).length,1);assert.equal(exactReads(first.calls).length,0);
 const second=await fixture(t,{executeError:'network',reportPending:true});await second.prepare();await second.frame.locator('#execute').click();await expect(second.frame.locator('#fxExecutionProgress')).toHaveAttribute('data-phase','failed');await expect(second.frame.locator('#message')).toContainText('nueva vista previa');await expect(second.frame.locator('#fxExecutionPercent')).toHaveText('33%');await expect(second.frame.locator('#execute')).toBeDisabled();await expect(second.frame.locator('#previewButton')).toBeEnabled();assert.equal(executes(second.calls).length,1);assert.equal(exactReads(second.calls).length,1);
});

test('error incierto y lectura indisponible bloquean ejecución; la recuperación manual sólo consulta',{timeout:30000},async t=>{
 const{frame,calls,controls,prepare}=await fixture(t,{executeError:500,checkError:true});await prepare();await frame.locator('#execute').click();await expect(frame.locator('#fxExecutionProgress')).toHaveAttribute('data-phase','uncertain');await expect(frame.locator('#fxExecutionPercent')).toHaveText('33%');await expect(frame.locator('#execute')).toBeDisabled();await expect(frame.locator('#previewButton')).toBeDisabled();controls.checkError=false;await frame.getByRole('button',{name:'Consultar estado',exact:true}).click();await expect(frame.locator('#fxExecutionPercent')).toHaveText('100%');assert.equal(executes(calls).length,1);assert.equal(exactReads(calls).length,2);
});

test('renovación de misma sesión conserva operación; cambio real de empresa descarta respuesta anterior y el lector no ejecuta',{timeout:45000},async t=>{
 const gate=deferred(),first=await fixture(t,{executeGate:gate,history:false});await first.prepare();await first.frame.evaluate(()=>{window.NexoSessionRenewal={current:()=>({generation:'synthetic-generation',identity:'synthetic-user/session'})};});await first.frame.locator('#execute').click();await expect(first.frame.locator('#fxExecutionPercent')).toHaveText('33%');await first.frame.evaluate(()=>localStorage.setItem('nexo_token','synthetic-renewed-token'));gate.resolve();await expect(first.frame.locator('#fxExecutionPercent')).toHaveText('100%');assert.equal(executes(first.calls).length,1);
 const late=deferred(),second=await fixture(t,{executeGate:late});await second.prepare();await second.frame.locator('#execute').click();await expect(second.frame.locator('#fxExecutionPercent')).toHaveText('33%');await second.frame.evaluate(()=>{localStorage.setItem('nexo_company','2');dispatchEvent(new Event('focus'));});late.resolve();await expect(second.frame.locator('#fxExecutionProgress')).toBeHidden();await expect(second.frame.locator('#message')).toContainText('empresa original');assert.equal(exactReads(second.calls).length,0);await expect(second.frame.locator('#execute')).toBeDisabled();
 const reader=await fixture(t,{reader:true});await expect(reader.frame.locator('#previewButton')).toBeDisabled();await expect(reader.frame.locator('#execute')).toBeDisabled();assert.equal(executes(reader.calls).length,0);
});
