import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

// Real UI/theme in a same-origin workspace iframe. All APIs are synthetic.
const source=await readFile('src/server.ts','utf8'),branding=source.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/),renewal=source.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal);
const served=html=>html.replace('</head>',branding[2]+'</head>').replace('<head>','<head>'+renewal[1]+branding[1]);
const options={subsidiaries:[{id:1,name:'Subsidiaria sintética',currencyId:1}],currencies:[{id:1,code:'CRC',symbol:'₡'}],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],journalOptions:{canReverse:false,modules:[]},pendingInvoiceOptions:{customers:[]},bankOptions:{accounts:[{id:7,number:'000-SYN-7',name:'Banco sintético - 000-SYN-7',bankId:2,bankName:'Banco sintético',subsidiaryId:1,currencyId:1,currencyCode:'CRC',currencySymbol:'₡'}],reconciliations:[]}};
const report=empty=>({rows:empty?[]:[{id:11,date:'2026-11-07',value_date:'2026-11-07',reconciliation_status:'PENDIENTE',transaction_type:'DEP',reference:'SYN-DEP',beneficiary:'Beneficiario sintético',description:'Movimiento sintético',note:'Pendiente de conciliación',deposits:50,withdrawals:0,running_balance:50}],statementLines:empty?[]:[{statement_line_id:20,bank_date:'2026-11-07',reconciliation_status:'PENDIENTE',reference:'SYN-DEP',description:'Línea bancaria sintética',amount:50}],summary:{bookBalance:50,statementBalance:50,transitPayments:0,transitDeposits:0},reconciliation:{status:'ABIERTA'},total:empty?0:1,page:1,pageSize:250});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function fixture(t,{width=1536,result=1,gate=null,error=null,emptyAfter=false,refreshError=false}={}){
 const{page,baseURL,cleanup}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),calls=[],alerts=[],unexpected=[],errors=[];let posted=false;
 page.on('pageerror',failure=>errors.push(failure.message));page.on('dialog',async dialog=>{alerts.push(dialog.message());await dialog.accept();});
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-auto-match-token');localStorage.setItem('nexo_device_token','synthetic-auto-match-device');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/accounting-reports.html'){await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/accounting-reports.html','utf8'))});return;}
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  const call={path:url.pathname,method:request.method(),body:request.method()==='POST'?request.postDataJSON():null};calls.push(call);
  if(url.pathname==='/api/reports/accounting/options'){await route.fulfill({json:options});return;}
  if(url.pathname==='/api/reports/accounting/bank-reconciliation'){
   if(posted&&refreshError){await route.fulfill({status:503,json:{error:{message:'No fue posible actualizar el reporte sintético.'}}});return;}
   await route.fulfill({json:report(posted&&emptyAfter)});return;
  }
  if(url.pathname==='/api/reports/accounting/bank-reconciliation/auto'){
   if(gate)await gate.promise;posted=true;
   if(error==='network'){await route.abort('failed');return;}
   if(error){await route.fulfill({status:503,json:{error:{message:'No fue posible confirmar la respuesta de la conciliación.'}}});return;}
   await route.fulfill({json:{result}});return;
  }
  unexpected.push(url.pathname);await route.fulfill({status:501,json:{error:{message:'Unmocked API blocked'}}});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/accounting-reports.html"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();await frame.getByText('Bancos y Conciliación',{exact:true}).click();await frame.locator('#bankView').selectOption('WORKSPACE');await frame.locator('#bankCutoff').fill('2026-11-07');await frame.locator('#bankCutoff').dispatchEvent('change');await expect(frame.locator('#autoMatch')).toBeEnabled();await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));
 assert.equal(await frame.locator('html').evaluate(element=>element.classList.contains('inside-erp-workspace')),true);assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});return{page,frame,calls,alerts,cleanup};
}
const mutations=calls=>calls.filter(call=>call.path.endsWith('/auto'));
const reports=calls=>calls.filter(call=>call.path==='/api/reports/accounting/bank-reconciliation');
async function capture(page,name){if(process.env.BANK_AUTO_MATCH_RESULT_CAPTURE!=='1')return;const folder=resolve('..','bank-auto-match-result-qa-20261107');await mkdir(folder,{recursive:true});await page.screenshot({path:resolve(folder,name),fullPage:true});}
function contrast(rgb1,rgb2){const luminosity=rgb=>{const values=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(value=>{const s=value/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4});return values[0]*.2126+values[1]*.7152+values[2]*.0722;};const a=luminosity(rgb1),b=luminosity(rgb2);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);}

for(const[count,width,message]of[[0,1536,'No se encontraron nuevas coincidencias para conciliar automáticamente. Puede revisar los movimientos pendientes.'],[1,1536,'Se concilió 1 movimiento automáticamente.'],[4,390,'Se conciliaron 4 movimientos automáticamente.']])test(`resultado ${count} a ${width}: modal integrado, contador correcto y actualización sólo después de Entendido`,{timeout:30000},async t=>{
 const{page,frame,calls,alerts}=await fixture(t,{width,result:count}),before=reports(calls).length;await frame.locator('#autoMatch').click();const dialog=frame.getByRole('dialog',{name:'Conciliación automática'});await expect(dialog).toBeVisible();assert.equal(await frame.locator('#bankAutoMatchResultCount').innerText(),String(count));assert.equal(await frame.locator('#bankAutoMatchResultMessage').innerText(),message);assert.equal(await dialog.getAttribute('aria-describedby'),'bankAutoMatchResultMessage');assert.equal(reports(calls).length,before);assert.deepEqual(alerts,[]);
 assert.deepEqual(mutations(calls).map(call=>({method:call.method,body:call.body})),[{method:'POST',body:{p_bank_account_id:7,p_cutoff:'2026-11-07'}}]);await expect(frame.locator('#acknowledgeBankAutoMatchResult')).toBeFocused();await page.keyboard.press('Tab');await expect(frame.locator('#closeBankAutoMatchResult')).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(frame.locator('#acknowledgeBankAutoMatchResult')).toBeFocused();
 const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width&&bounds.y>=0&&bounds.y+bounds.height<=1000);assert.equal(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1),true);const colors=await frame.locator('#acknowledgeBankAutoMatchResult').evaluate(element=>{const style=getComputedStyle(element);return{background:style.backgroundColor,text:style.color,height:element.getBoundingClientRect().height};});assert.ok(contrast(colors.background,colors.text)>=4.5);assert.ok(colors.height>=44);await capture(page,`bank-auto-match-${count}-${width}.png`);
 await frame.locator('#acknowledgeBankAutoMatchResult').click();await expect(dialog).toBeHidden();await expect.poll(()=>reports(calls).length).toBe(before+1);await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));await expect(frame.locator('#autoMatch')).toBeFocused();assert.equal(mutations(calls).length,1);
});

for(const dismiss of['close','escape','backdrop'])test(`resultado se cierra por ${dismiss}, resuelve una vez y devuelve foco sin repetir conciliación`,{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t),before=reports(calls).length;await frame.locator('#autoMatch').click();await expect(frame.locator('#bankAutoMatchResultDialog')).toBeVisible();
 if(dismiss==='close')await frame.locator('#closeBankAutoMatchResult').click();else if(dismiss==='escape')await page.keyboard.press('Escape');else await page.mouse.click(3,3);
 await expect(frame.locator('#bankAutoMatchResultDialog')).toBeHidden();await expect.poll(()=>reports(calls).length).toBe(before+1);await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));await expect(frame.locator('#autoMatch')).toBeFocused();assert.equal(mutations(calls).length,1);
});

test('doble click durante POST y ack genera sólo una petición y no rehabilita el botón sin parejas después de actualizar',{timeout:30000},async t=>{
 const gate=deferred(),{frame,calls}=await fixture(t,{gate,emptyAfter:true}),before=reports(calls).length;
 await frame.evaluate(()=>{const button=document.getElementById('autoMatch');button.onclick();button.onclick();});await expect.poll(()=>mutations(calls).length).toBe(1);assert.equal(await frame.locator('#autoMatch').isDisabled(),true);gate.resolve();await expect(frame.locator('#bankAutoMatchResultDialog')).toBeVisible();assert.equal(await frame.locator('#autoMatch').isDisabled(),true);await frame.locator('#acknowledgeBankAutoMatchResult').click();await expect.poll(()=>reports(calls).length).toBe(before+1);await frame.waitForFunction(()=>!document.getElementById('workspace').classList.contains('loading'));assert.equal(await frame.locator('#autoMatch').isDisabled(),true);await expect(frame.locator('#bankView')).toBeFocused();assert.equal(mutations(calls).length,1);
});

for(const error of['server','network'])test(`error ${error}: no presenta cero ni éxito y no reintenta POST automáticamente`,{timeout:30000},async t=>{
 const{frame,calls,alerts}=await fixture(t,{error}),before=reports(calls).length;await frame.locator('#autoMatch').click();await expect.poll(()=>alerts.length).toBe(1);await expect(frame.locator('#autoMatch')).toBeEnabled();assert.equal(await frame.locator('#bankAutoMatchResultDialog').isVisible(),false);assert.equal(await frame.locator('#bankAutoMatchResultCount').innerText(),'');assert.equal(mutations(calls).length,1);assert.equal(reports(calls).length,before);
});

test('conteos inválidos nunca se presentan como cero conciliaciones ni disparan reintento o actualización',{timeout:60000},async t=>{
 for(const result of[null,'not-a-count',-1,1.5]){
  const{frame,calls,alerts,cleanup}=await fixture(t,{result}),before=reports(calls).length;await frame.locator('#autoMatch').click();await expect.poll(()=>alerts.length).toBe(1);await expect(frame.locator('#autoMatch')).toBeEnabled();assert.match(alerts[0],/No fue posible confirmar el resultado/);assert.equal(await frame.locator('#bankAutoMatchResultDialog').isVisible(),false);assert.equal(await frame.locator('#bankAutoMatchResultCount').innerText(),'');assert.equal(mutations(calls).length,1);assert.equal(reports(calls).length,before);await cleanup();
 }
});

test('fallo al refrescar después del resultado conserva botón bloqueado y no repite el POST',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t,{refreshError:true});await frame.locator('#autoMatch').click();await expect(frame.locator('#bankAutoMatchResultDialog')).toBeVisible();await frame.locator('#acknowledgeBankAutoMatchResult').click();await expect(frame.locator('#message')).toHaveText('No fue posible actualizar el reporte sintético.');assert.equal(await frame.locator('#autoMatch').isDisabled(),true);assert.equal(mutations(calls).length,1);await expect(frame.locator('#bankView')).toBeFocused();
});
