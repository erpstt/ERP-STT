import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

const server=await readFile('src/server.ts','utf8'),branding=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/),renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal);
const served=html=>html.replace('</head>',branding[2]+'</head>').replace('<head>','<head>'+renewal[1]+branding[1]);
const cutoff='2026-10-31',ownerCutoff='2026-11-03';
const options={subsidiaries:[{id:1,name:'Empresa sintética',currencyId:1}],currencies:[{id:1,code:'USD',symbol:'US$'}],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],journalOptions:{canReverse:false,modules:[]},pendingInvoiceOptions:{customers:[]},bankOptions:{accounts:[7,8].map(id=>({id,number:`000-SYN-${id}`,name:`Banco sintético - 000-SYN-${id}`,bankId:2,bankName:'Banco sintético',subsidiaryId:1,currencyId:1,currencyCode:'USD',currencySymbol:'US$'})),reconciliations:[]}};
const metadata=(id,date=ownerCutoff)=>({match_id:id,reconciliation_id:31+id,reconciliation_cutoff:date,can_unmatch:true});
const erp=(id,match,amount)=>({id,date:'2026-10-20',value_date:'2026-10-20',reference:`ERP-SYN-${id}`,note:'Movimiento ERP sintético',deposits:amount,withdrawals:0,reconciliation_status:'CONCILIADO',...metadata(match)});
const bank=(id,match,amount)=>({statement_line_id:id,bank_date:'2026-10-20',reference:`BANK-SYN-${id}`,description:'Línea de extracto sintética',amount,reconciliation_status:'CONCILIADO',...metadata(match)});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function fixture(t,{width=1536,postError=null,refreshError=false,staleReport=false,postGate=null,optionsGate=null,permission=true,closed=false,badMetadata=null}={}){
 const{page,baseURL,cleanup}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),calls=[],errors=[],unexpected=[],state={removed:false};let optionReads=0;
 const report=filters=>{
  const other=Number(filters.bankAccountId)===8,rows=other?[{...erp(18,88,80),can_unmatch:false}]:[erp(11,71,50),erp(12,72,60)],statementLines=other?[]:[bank(21,72,60),bank(22,71,50)];
  for(const row of[...rows,...statementLines]){if(!permission)row.can_unmatch=false;if(badMetadata)Object.assign(row,badMetadata);if(state.removed&&!staleReport&&row.match_id===71){row.reconciliation_status=row.statement_line_id?'PENDIENTE':'PENDIENTE_EN_TRANSITO';row.match_id=null;row.reconciliation_id=null;row.reconciliation_cutoff=null;row.can_unmatch=false;}}
  return{rows,statementLines,summary:{bookBalance:110,statementBalance:110,transitPayments:0,transitDeposits:0},reconciliation:{status:closed?'CERRADA':'ABIERTA'},total:rows.length,page:1,pageSize:250};
 };
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',async dialog=>{unexpected.push('Native dialog: '+dialog.message());await dialog.accept();});
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-classic-unmatch-token');localStorage.setItem('nexo_device_token','synthetic-classic-unmatch-device');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/accounting-reports.html'){await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/accounting-reports.html','utf8'))});return;}
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  const call={path:url.pathname,method:request.method(),body:request.method()==='POST'?request.postDataJSON():null};calls.push(call);
  if(url.pathname==='/api/reports/accounting/options'){optionReads++;if(optionReads>1){if(optionsGate)await optionsGate.promise;if(refreshError){await route.fulfill({status:503,json:{error:{message:'No fue posible actualizar las opciones sintéticas.'}}});return;}}await route.fulfill({json:options});return;}
  if(url.pathname==='/api/reports/accounting/bank-reconciliation'){await route.fulfill({json:report(call.body)});return;}
  if(url.pathname==='/api/reports/accounting/bank-reconciliation/unmatch'){
   if(postGate)await postGate.promise;if(postError==='network'){state.removed=true;await route.abort('connectionreset');return;}if(postError){await route.fulfill({status:postError,json:{error:{message:'El estado del punteo debe revisarse.'}}});return;}
   state.removed=true;await route.fulfill({json:{result:{success:true,bankAccountId:7,cutoff:ownerCutoff,matchId:71,reconciliationId:102,bankTransactionId:11,statementId:41,statementLineId:22}}});return;
  }
  unexpected.push(request.method()+' '+url.pathname);await route.fulfill({status:501,json:{error:{message:'Unexpected API blocked'}}});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/accounting-reports.html"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();await frame.getByText('Bancos y Conciliación',{exact:true}).click();await frame.locator('#bankCutoff').fill(cutoff);await frame.locator('#bankCutoff').dispatchEvent('change');await frame.locator('#bankView').selectOption('RECONCILED');await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));await expect(frame.locator('#bankReconciledTab')).toHaveAttribute('aria-selected','true');
 assert.equal(await frame.locator('html').evaluate(element=>element.classList.contains('inside-erp-workspace')),true);assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{postGate?.resolve();optionsGate?.resolve();assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.ok(calls.every(call=>call.path.endsWith('/options')&&call.method==='GET'||call.path.endsWith('/bank-reconciliation')&&call.method==='POST'||call.path.endsWith('/unmatch')&&call.method==='POST'));});
 return{page,frame,calls,state,cleanup};
}
const mutations=calls=>calls.filter(call=>call.path.endsWith('/unmatch'));
const optionReads=calls=>calls.filter(call=>call.path.endsWith('/options'));
const button=frame=>frame.locator('[data-bank-unmatch="71"][data-bank-unmatch-side="statement"]');
async function open(frame){await button(frame).click();await expect(frame.getByRole('dialog',{name:'Deshacer punteo',exact:true})).toBeVisible();await expect(frame.locator('#cancelBankUnmatch')).toBeFocused();await expect(frame.locator('#bankUnmatchCutoff')).toHaveText('03/11/2026');await expect(frame.locator('#bankUnmatchAccount')).toContainText('000-SYN-7');await expect(frame.locator('#bankUnmatchReference')).toHaveText('BANK-SYN-22');}
async function capture(page,width){if(process.env.BANK_CLASSIC_UNMATCH_CAPTURE!=='1')return;const folder=resolve('..','bank-classic-unmatch-qa-20261107');await mkdir(folder,{recursive:true});await page.screenshot({path:resolve(folder,`classic-unmatch-${width}.png`),animations:'disabled'});}

for(const width of[1536,390])test(`deshacer clásico ${width}: modal muestra propietario real y sólo confirma el par correcto; refresca ambos lados`,{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t,{width});await expect(frame.locator('[data-bank-unmatch]')).toHaveCount(4);await open(frame);await expect(frame.locator('#bankUnmatchDescription')).toContainText('Los importes no se modificarán y el extracto no se eliminará.');
 const geometry=await frame.locator('#bankUnmatchDialog').evaluate(dialog=>({width:innerWidth,left:dialog.getBoundingClientRect().left,right:dialog.getBoundingClientRect().right,scroll:dialog.scrollWidth,client:dialog.clientWidth,buttons:[...dialog.querySelectorAll('footer button')].map(b=>({left:b.getBoundingClientRect().left,right:b.getBoundingClientRect().right}))}));assert.ok(geometry.left>=0&&geometry.right<=width+1,JSON.stringify(geometry));assert.ok(geometry.scroll<=geometry.client+1);for(const b of geometry.buttons)assert.ok(b.left>=geometry.left&&b.right<=geometry.right+1);
 await frame.locator('#cancelBankUnmatch').press('Shift+Tab');await expect(frame.locator('#confirmBankUnmatch')).toBeFocused();await frame.locator('#confirmBankUnmatch').press('Tab');await expect(frame.locator('#cancelBankUnmatch')).toBeFocused();assert.equal(mutations(calls).length,0);await capture(page,width);
 const reads=optionReads(calls).length;await frame.locator('#confirmBankUnmatch').click();await expect(frame.locator('#bankUnmatchDialog')).toBeHidden();await expect(frame.locator('#bankActionMessage')).toContainText('Punteo deshecho.');assert.deepEqual(mutations(calls).map(call=>call.body),[{p_bank_account_id:7,p_cutoff:ownerCutoff,p_match_id:71}]);assert.equal(optionReads(calls).length,reads+1);await expect(frame.locator('#bankView')).toHaveValue('RECONCILED');await expect(frame.locator('#bankCutoff')).toHaveValue(cutoff);await expect(frame.locator('[data-bank-unmatch="71"]')).toHaveCount(0);await expect(frame.locator('[data-bank-unmatch="72"]')).toHaveCount(2);
 await frame.locator('#bankPendingTab').click();await expect(frame.locator('#tbody')).toContainText('ERP-SYN-11');await expect(frame.locator('#tbody')).toContainText('BANK-SYN-22');await expect(frame.locator('#tbody')).toContainText('50,00');assert.equal(mutations(calls).length,1);
});

test('Cancelar y Escape no envían POST ni conservan una confirmación previa',{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t);for(const dismiss of['cancel','escape']){await open(frame);if(dismiss==='cancel')await frame.locator('#cancelBankUnmatch').click();else await page.keyboard.press('Escape');await expect(frame.locator('#bankUnmatchDialog')).toBeHidden();await expect(button(frame)).toBeEnabled();assert.equal(mutations(calls).length,0);}await open(frame);await expect(frame.locator('#confirmBankUnmatch')).toBeEnabled();await expect(frame.locator('#bankUnmatchError')).toBeHidden();await frame.locator('#cancelBankUnmatch').click();
});

test('doble clic durante POST envía una sola operación y bloquea cancelar/Escape hasta conocer resultado',{timeout:30000},async t=>{
 const gate=deferred(),{page,frame,calls}=await fixture(t,{postGate:gate});await open(frame);await frame.locator('#confirmBankUnmatch').click();await expect.poll(()=>mutations(calls).length).toBe(1);await expect(frame.locator('#confirmBankUnmatch')).toBeDisabled();await expect(frame.locator('#cancelBankUnmatch')).toBeDisabled();await frame.locator('#confirmBankUnmatch').dispatchEvent('click');await page.keyboard.press('Escape');await expect(frame.locator('#bankUnmatchDialog')).toBeVisible();assert.equal(mutations(calls).length,1);gate.resolve();await expect(frame.locator('#bankUnmatchDialog')).toBeHidden();assert.equal(mutations(calls).length,1);
});

test('errores de POST no muestran éxito ni permiten repetir sobre la misma vista sin recargar',{timeout:60000},async t=>{
 for(const status of[409,503,'network']){const{frame,calls,cleanup}=await fixture(t,{postError:status});await open(frame);await frame.locator('#confirmBankUnmatch').click();await expect(frame.locator('#bankUnmatchError')).toContainText('Actualice el reporte para comprobar su estado');await expect(frame.locator('#confirmBankUnmatch')).toBeDisabled();await expect(frame.locator('#cancelBankUnmatch')).toBeEnabled();await frame.locator('#confirmBankUnmatch').dispatchEvent('click');assert.equal(mutations(calls).length,1);await expect(frame.locator('#bankActionMessage')).not.toHaveText(/^Punteo deshecho/);await frame.locator('#cancelBankUnmatch').click();await expect(button(frame)).toBeDisabled();await frame.locator('#filters').evaluate(form=>form.requestSubmit());await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));if(status==='network')await expect(button(frame)).toHaveCount(0);else await expect(button(frame)).toBeEnabled();assert.equal(mutations(calls).length,1);await cleanup();}
});

test('POST confirmado con refresco fallido informa operación persistida y no habilita otro intento',{timeout:30000},async t=>{
 for(const config of[{refreshError:true},{staleReport:true}]){const{frame,calls,cleanup}=await fixture(t,config);await open(frame);await frame.locator('#confirmBankUnmatch').click();await expect(frame.locator('#bankUnmatchError')).toContainText('El punteo quedó deshecho, pero no fue posible actualizar la pantalla.');await expect(frame.locator('#confirmBankUnmatch')).toBeDisabled();await frame.locator('#cancelBankUnmatch').click();if(config.staleReport){await expect(frame.locator('[data-bank-unmatch]')).toHaveCount(4);for(const button of await frame.locator('[data-bank-unmatch]').all())await expect(button).toBeDisabled();}else await expect(frame.locator('[data-bank-unmatch]')).toHaveCount(0);assert.equal(mutations(calls).length,1);await cleanup();}
});

test('contexto cambiado antes de confirmar o durante refresco no envía otro POST ni reemplaza la cuenta nueva',{timeout:45000},async t=>{
 const before=await fixture(t);await open(before.frame);await before.frame.locator('#bankAccount').evaluate(select=>{select.value='8';select.dispatchEvent(new Event('change',{bubbles:true}));});await before.frame.locator('#confirmBankUnmatch').click();await expect(before.frame.locator('#bankUnmatchError')).toContainText('contexto cambió');assert.equal(mutations(before.calls).length,0);await before.frame.locator('#cancelBankUnmatch').click();await before.cleanup();
 const gate=deferred(),{frame,calls}=await fixture(t,{optionsGate:gate});await open(frame);await frame.locator('#confirmBankUnmatch').click();await expect.poll(()=>optionReads(calls).length).toBe(2);await frame.locator('#bankAccount').evaluate(select=>{select.value='8';select.dispatchEvent(new Event('change',{bubbles:true}));});await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));gate.resolve();await expect(frame.locator('#bankUnmatchDialog')).toBeHidden();await expect(frame.locator('#bankAccount')).toHaveValue('8');await expect(frame.locator('#tbody')).toContainText('ERP-SYN-18');await expect(frame.locator('#bankActionMessage')).not.toHaveText(/^Punteo deshecho/);assert.equal(mutations(calls).length,1);
});

test('lector, cierre y metadata incompleta no ofrecen deshacer; HISTORY/CLOSED quedan sin esa acción',{timeout:60000},async t=>{
 for(const config of[{permission:false},{closed:true},{badMetadata:{match_id:null}},{badMetadata:{reconciliation_cutoff:'2026-02-30'}}]){const{frame,calls,cleanup}=await fixture(t,config);await expect(frame.locator('[data-bank-unmatch]')).toHaveCount(0);await frame.locator('#bankView').selectOption('CLOSED');await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));await expect(frame.locator('[data-bank-unmatch]')).toHaveCount(0);await frame.locator('#bankView').selectOption('HISTORY');await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));await expect(frame.locator('[data-bank-unmatch]')).toHaveCount(0);assert.equal(mutations(calls).length,0);await cleanup();}
});
