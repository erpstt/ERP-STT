import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

// Production modules/theme inside the workspace iframe; every API is synthetic.
const server=await readFile('src/server.ts','utf8'),branding=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/),renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal,'The served HTML injection must stay represented');
const served=html=>html.replace('</head>',branding[2]+'</head>').replace('<head>','<head>'+renewal[1]+branding[1]);
const acknowledgement='Confirmo que revisé los movimientos pendientes y los saldos.';
const options={subsidiaries:[{id:1,name:'Subsidiaria sintética',currencyId:1}],currencies:[{id:1,code:'CRC',symbol:'₡'}],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],journalOptions:{canReverse:false,modules:[]},pendingInvoiceOptions:{customers:[]},bankOptions:{accounts:[{id:7,number:'000-SYN-7',name:'Banco sintético - 000-SYN-7',bankId:2,bankName:'Banco sintético',subsidiaryId:1,currencyId:1,currencyCode:'CRC',currencySymbol:'₡'}],reconciliations:[]}};
const report=closed=>({rows:[],statementLines:[],summary:{bookBalance:50,statementBalance:50,transitPayments:0,transitDeposits:0},reconciliation:{status:closed?'CERRADA':'ABIERTA'},total:0,page:1,pageSize:250});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function fixture(t,{width=1536,closeGate=null}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),calls=[],errors=[],unexpected=[],alerts=[];let closed=false;
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',async dialog=>{alerts.push(dialog.message());await dialog.accept();});
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-bank-close-switch-token');localStorage.setItem('nexo_device_token','synthetic-bank-close-switch-device');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/accounting-reports.html'){await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/accounting-reports.html','utf8'))});return;}
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  const call={path:url.pathname,method:request.method(),body:request.method()==='POST'?request.postDataJSON():null};calls.push(call);
  if(url.pathname==='/api/reports/accounting/options'){await route.fulfill({json:options});return;}
  if(url.pathname==='/api/reports/accounting/bank-reconciliation'){await route.fulfill({json:report(closed)});return;}
  if(url.pathname==='/api/reports/accounting/bank-reconciliation/close'){if(closeGate)await closeGate.promise;closed=true;await route.fulfill({json:{result:3}});return;}
  unexpected.push(request.method()+' '+url.pathname);await route.fulfill({status:501,json:{error:{message:'Unmocked API blocked'}}});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/accounting-reports.html"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();await frame.getByText('Bancos y Conciliación',{exact:true}).click();await frame.locator('#bankView').selectOption('WORKSPACE');await frame.locator('#bankCutoff').fill('2026-11-07');await frame.locator('#bankCutoff').dispatchEvent('change');await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));await expect(frame.locator('#closeReconciliation')).toBeEnabled();
 assert.equal(await frame.locator('html').evaluate(element=>element.classList.contains('inside-erp-workspace')),true);assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(alerts,[]);});return{page,frame,calls};
}
const closes=calls=>calls.filter(call=>call.path.endsWith('/close'));
async function open(frame){await frame.locator('#closeReconciliation').click();await expect(frame.locator('#bankCloseDialog')).toBeVisible();const control=frame.getByRole('switch',{name:acknowledgement,exact:true});await expect(control).not.toBeChecked();await expect(frame.locator('#confirmBankClose')).toBeDisabled();return control;}
async function visualState(frame,on){await expect(frame.locator(on?'.bank-close-check-on':'.bank-close-check-off')).toBeVisible();await expect(frame.locator(on?'.bank-close-check-off':'.bank-close-check-on')).toBeHidden();await expect(frame.getByRole('switch',{name:acknowledgement,exact:true})).toHaveAccessibleName(acknowledgement);}
async function clickTrack(page,frame){const bounds=await frame.locator('.bank-close-switch-track').boundingBox();assert.ok(bounds&&bounds.width>0&&bounds.height>0);await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2);}
async function thumbPosition(frame){return frame.locator('.bank-close-switch-track').evaluate(track=>{const transform=getComputedStyle(track,'::after').transform;return transform==='none'?0:new DOMMatrixReadOnly(transform).m41;});}
async function capture(page,name){if(process.env.BANK_CLOSE_SWITCH_CAPTURE!=='1')return;const folder=resolve('..','bank-close-switch-qa-20261107');await mkdir(folder,{recursive:true});await page.screenshot({path:resolve(folder,name),fullPage:true,animations:'disabled'});}

for(const width of[1536,390,320])test(`cierre ${width}: interruptor accesible OFF/ON, teclado y carril sin contabilizar; contenido cabe en el modal`,{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t,{width}),control=await open(frame);assert.equal(await control.getAttribute('type'),'checkbox');assert.equal(await control.getAttribute('aria-labelledby'),'bankCloseAcknowledgementText');assert.equal(await control.getAttribute('aria-checked'),null);assert.equal(await frame.locator('.bank-close-switch-track').getAttribute('aria-hidden'),'true');await visualState(frame,false);const offTrackColor=await frame.locator('.bank-close-switch-track').evaluate(track=>getComputedStyle(track).backgroundColor);
 const metrics=await frame.locator('#bankCloseDialog').evaluate(dialog=>{const label=dialog.querySelector('.bank-close-check'),copy=label.querySelector('.bank-close-check-copy'),input=label.querySelector('input'),style=getComputedStyle(input);return{dialog:{left:dialog.getBoundingClientRect().left,right:dialog.getBoundingClientRect().right,width:dialog.clientWidth,scrollWidth:dialog.scrollWidth},label:{left:label.getBoundingClientRect().left,right:label.getBoundingClientRect().right,height:label.getBoundingClientRect().height},copy:{right:copy.getBoundingClientRect().right,scrollWidth:copy.scrollWidth,width:copy.clientWidth},input:{display:style.display,visibility:style.visibility,width:input.getBoundingClientRect().width,height:input.getBoundingClientRect().height}};});
 assert.ok(metrics.dialog.left>=0&&metrics.dialog.right<=width+1);assert.ok(metrics.dialog.scrollWidth<=metrics.dialog.width+1);assert.ok(metrics.label.left>=metrics.dialog.left&&metrics.label.right<=metrics.dialog.right+1);assert.ok(metrics.label.height>=44);assert.ok(metrics.copy.right<=metrics.label.right+1&&metrics.copy.scrollWidth<=metrics.copy.width+1);assert.notEqual(metrics.input.display,'none');assert.notEqual(metrics.input.visibility,'hidden');assert.ok(metrics.input.width>0&&metrics.input.height>0);await capture(page,`bank-close-${width}-off.png`);
 await control.focus();await control.press('Space');await expect(control).toBeFocused();await expect(control).toBeChecked();await expect(frame.locator('#confirmBankClose')).toBeEnabled();await visualState(frame,true);await expect.poll(()=>thumbPosition(frame)).toBe(20);const onTrack=await frame.locator('.bank-close-switch-track').evaluate(track=>{const style=getComputedStyle(track);return{color:style.backgroundColor,outlineWidth:parseFloat(style.outlineWidth),outlineStyle:style.outlineStyle};});assert.notEqual(onTrack.color,offTrackColor);assert.ok(onTrack.outlineWidth>=2);assert.notEqual(onTrack.outlineStyle,'none');await capture(page,`bank-close-${width}-on.png`);
 await control.press('Space');await expect(control).not.toBeChecked();await expect(frame.locator('#confirmBankClose')).toBeDisabled();await visualState(frame,false);await expect.poll(()=>thumbPosition(frame)).toBe(0);assert.equal(await frame.locator('.bank-close-switch-track').evaluate(track=>getComputedStyle(track).backgroundColor),offTrackColor);await frame.locator('.bank-close-check-copy').click();await expect(control).toBeChecked();await clickTrack(page,frame);await expect(control).not.toBeChecked();await expect(frame.locator('#confirmBankClose')).toBeDisabled();assert.deepEqual(closes(calls),[]);await frame.locator('#cancelBankClose').click();
});

test('cancelar y Escape no envían cierre y cada reapertura reinicia interruptor y CTA en OFF',{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t);for(const dismiss of['cancel','escape']){const control=await open(frame);await control.press('Space');await expect(frame.locator('#confirmBankClose')).toBeEnabled();if(dismiss==='cancel')await frame.locator('#cancelBankClose').click();else await page.keyboard.press('Escape');await expect(frame.locator('#bankCloseDialog')).toBeHidden();assert.deepEqual(closes(calls),[]);}
 await open(frame);await visualState(frame,false);assert.deepEqual(closes(calls),[]);await frame.locator('#cancelBankClose').click();
});

test('alternar no cierra: sólo CTA habilitado manda una petición close con cuenta, corte y ajustes intactos',{timeout:30000},async t=>{
 const gate=deferred(),{frame,calls}=await fixture(t,{closeGate:gate}),control=await open(frame);await control.press('Space');await control.press('Space');await expect(frame.locator('#confirmBankClose')).toBeDisabled();assert.deepEqual(closes(calls),[]);await control.press('Space');await expect(frame.locator('#confirmBankClose')).toBeEnabled();assert.deepEqual(closes(calls),[]);await frame.locator('#confirmBankClose').click();await expect.poll(()=>closes(calls).length).toBe(1);await expect(frame.locator('#bankCloseDialog')).toBeHidden();assert.deepEqual(closes(calls).map(call=>({method:call.method,body:call.body})),[{method:'POST',body:{p_bank_account_id:7,p_cutoff:'2026-11-07',p_bank_adjustments:0}}]);gate.resolve();await expect(frame.locator('#bankActionMessage')).toContainText('Conciliación finalizada correctamente.');await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));await expect(frame.locator('#closeReconciliation')).toBeDisabled();assert.equal(closes(calls).length,1);
});
