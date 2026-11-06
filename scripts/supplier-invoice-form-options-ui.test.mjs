import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
import {supplierInvoiceFormOptionPaths as paths} from './lib/supplier-invoice-form-options-fixture.mjs';

const source=JSON.parse(await readFile('scripts/fixtures/supplier-invoice-ui.json','utf8'));
const html=await readFile('public/supplier-invoice-entry.html','utf8'),server=await readFile('src/server.ts','utf8');
const injection=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/),renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(injection&&renewal,'The real server HTML injections must be represented');
function served(){const[,guard,assets]=injection,branded=html.replace('</head>',assets+'</head>');return branded.replace('<head>','<head>'+renewal[1]+guard);}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function until(check){const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(done=>setTimeout(done,10));}throw Error('Synthetic request was not observed');}
function bundleFor(invoiceId=null){
 const result={...Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,structuredClone(source[path]||[])])),context:{subsidiaryId:1,invoiceId}};
 result.periods=[{...result.periods[0],period_name:'Synthetic open period',start_date:'2000-01-01',end_date:'2100-12-31',is_closed:false,gl_closed:false,ap_closed:false}];result.invoices=[];result.invoiceLines=[];
 if(invoiceId){result.invoices=[{invoice_id:invoiceId,invoice_number:'SYN-INV-'+invoiceId,invoice_type:'Factura estándar',supplier_id:1,payment_term_id:1,location_id:1,subsidiary_id:1,currency_id:1,invoice_date:'2026-11-06',due_date:'2026-11-06',fiscal_period_id:1,exchange_rate:1,memo:'Historical invoice',journal_id:700,payable_account_id:20}];result.invoiceLines=[{invoice_id:invoiceId,account_id:10,quantity:1,unit_price:12.345678,amount:12.345678,tax_code_id:null,tax_rate:0,note:'Historical line'}];}
 return result;
}

async function fixture(t,{query='',access={canView:true,canCreate:true,canEdit:false},bundle=bundleFor(),failure=null,gate=null,pending=false,expectError=false,receipt=null,receiptFailure=null,prefillMissing=false,allowMasters=false}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width:1536,height:768},timeout:10000}),calls=[],errors=[],legacy=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-supplier-invoice-token');localStorage.setItem('nexo_device_token','synthetic-supplier-invoice-device');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');window.NexoSessionRenewal={current:()=>({generation:'synthetic-supplier-invoice-generation'})};});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/supplier-invoice-entry.html'){await route.fulfill({contentType:'text/html; charset=utf-8',body:served()});return;}
  if(url.pathname==='/supplier-invoice-receipt-prefill.js'&&prefillMissing){await route.fulfill({status:404,contentType:'text/javascript',body:''});return;}
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  if(url.pathname.startsWith('/api/audit/')){await route.fulfill({json:{events:[]}});return;}
  const call={path:url.pathname,query:url.search,method:request.method(),payload:request.postData()?request.postDataJSON():null};calls.push(call);
  if(url.pathname==='/api/purchasing/supplier-invoice-access'){await route.fulfill({json:access});return;}
  if(url.pathname==='/api/purchasing/supplier-invoice-form-options'){
   if(gate)await gate.promise;
   if(failure){await route.fulfill(failure.raw?{status:failure.status,contentType:'text/html',body:'<html>Synthetic bad gateway</html>'}:{status:failure.status,json:{error:{message:failure.message||'Synthetic form options denied'}}});return;}
   await route.fulfill({json:bundle});return;
  }
  if(url.pathname==='/api/accounting/journal-supports'){await route.fulfill({status:403,json:{error:{message:'Synthetic support permission denied'}}});return;}
  if(url.pathname==='/api/purchasing/supplier-invoice-receipt-source/7'&&(receipt||receiptFailure)){await route.fulfill(receiptFailure?{status:403,json:{error:{message:'Synthetic receipt access denied'}}}:{json:receipt});return;}
  if(url.pathname==='/api/purchasing/supplier-invoice-entry'&&request.method()==='POST'){await route.fulfill({json:{invoiceId:77,journalId:700,total:100}});return;}
  legacy.push(url.pathname);await route.fulfill(allowMasters?{json:source[url.pathname]||[]}:{status:403,json:{error:{message:'No master catalogue permission in this synthetic role'}}});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/supplier-invoice-entry.html'+query+'"></iframe></body></html>',{waitUntil:'domcontentloaded'});
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();await frame.locator('#invoiceLoadStatus').waitFor({state:'attached'});
 if(!pending){if(expectError)await frame.locator('#invoiceLoadError').waitFor({state:'visible'});else await frame.waitForFunction(()=>document.querySelector('#invoiceLoadStatus').hidden&&document.querySelector('#invoiceLoadError').hidden);}
 t.after(()=>{assert.deepEqual(legacy,[],'The form must never fall back to generic catalogue GETs');assert.deepEqual(errors,[],'Loading failures must be handled without an unhandled module rejection');});
 return{page,frame,calls,legacy,errors};
}
const mutations=calls=>calls.filter(call=>['POST','PUT','PATCH','DELETE'].includes(call.method));
async function assertFailed(frame,calls){assert.equal(await frame.locator('#save').isDisabled(),true);const enabled=await frame.locator('main input,main select,main textarea,main button').evaluateAll(controls=>controls.filter(control=>!control.disabled).map(control=>({id:control.id,class:control.className,text:control.textContent})));assert.deepEqual(enabled,[]);const box=await frame.locator('#invoiceLoadError').boundingBox();assert.ok(box.y>=0&&box.y+box.height<=768,'The load error must be visible near the heading');assert.equal(mutations(calls).length,0);}

test('invoice creator and Administrator load suppliers/defaults from the authorized bundle and save the selected IDs',{timeout:30000},async t=>{
 const bundle=bundleFor();bundle.suppliers.push({supplier_id:2,company_name:'Other subsidiary supplier',subsidiary_ids:[2]},{supplier_id:3,company_name:'Inactive supplier',subsidiary_ids:[1],is_inactive:true},{supplier_id:4,company_name:'Shared supplier',subsidiary_id:2,subsidiary_ids:[1,2],payment_term_id:1});
 for(const isAdmin of [false,true]){
 const{page,frame,calls}=await fixture(t,{bundle,access:{canView:true,canCreate:true,canEdit:isAdmin,isAdmin},allowMasters:isAdmin});assert.deepEqual(await frame.locator('#supplier option').evaluateAll(options=>options.map(option=>option.value).filter(Boolean).sort()),['1','4']);assert.equal(await frame.locator('#currency').inputValue(),'1');assert.equal(await frame.locator('#subsidiary').inputValue(),'Empresa de pruebas');assert.match(await frame.locator('#invoiceDate').inputValue(),/^\d{4}-\d{2}-\d{2}$/);assert.equal(await frame.locator('#period').inputValue(),'1');assert.equal(await frame.locator('#save').isEnabled(),true);
 assert.deepEqual(calls.map(call=>call.path),['/api/purchasing/supplier-invoice-access','/api/purchasing/supplier-invoice-form-options']);
 await frame.locator('#invoiceNumber').fill('SYN-INVOICE-LOADING');await frame.locator('#supplier').selectOption('1');assert.equal(await frame.locator('#paymentTerm').inputValue(),'1');await frame.locator('.account-search').fill('631001');await frame.locator('[data-key=unit_price]').fill('100');
 if(isAdmin&&process.env.SUPPLIER_FORM_OPTIONS_CAPTURE==='1'){const directory=resolve('..','supplier-invoice-provider-loading-qa-20261106');await mkdir(directory,{recursive:true});await page.screenshot({path:resolve(directory,'after-administrator-loaded-1536.png'),fullPage:true});}
 await frame.locator('#save').click();await frame.locator('#successModal').waitFor({state:'visible'});
 const saved=mutations(calls);assert.equal(saved.length,1);assert.equal(saved[0].payload.supplier_id,'1');assert.equal(saved[0].payload.payment_term_id,'1');assert.equal(saved[0].payload.location_id,1);assert.equal(saved[0].payload.lines[0].account_id,'10');assert.equal(saved[0].payload.lines[0].amount,100);
 }
});

test('first paint and pending bundle keep the form locked; token refresh in the same session generation preserves the load',{timeout:30000},async t=>{
 assert.match(html,/<button\b[^>]*id="save"[^>]*disabled/);const gate=deferred();t.after(()=>gate.resolve());const{frame,calls}=await fixture(t,{gate,pending:true});await until(()=>calls.some(call=>call.path.endsWith('/supplier-invoice-form-options')));assert.equal(await frame.locator('#invoiceLoadStatus').isVisible(),true);assert.equal(await frame.locator('#save').isDisabled(),true);assert.equal(await frame.locator('#supplier').isDisabled(),true);assert.equal(await frame.locator('#invoiceNumber').isDisabled(),true);
 await frame.evaluate(()=>{localStorage.setItem('nexo_token','synthetic-renewed-access-token');window.dispatchEvent(new StorageEvent('storage',{key:'nexo_token'}));});gate.resolve();await frame.waitForFunction(()=>document.querySelector('#invoiceLoadStatus').hidden);assert.equal(await frame.locator('#supplier').isEnabled(),true);assert.equal(await frame.locator('#invoiceLoadError').isHidden(),true);assert.equal(calls.length,2);
 await frame.evaluate(()=>{localStorage.setItem('nexo_role','3');window.dispatchEvent(new StorageEvent('storage',{key:'nexo_role'}));document.getElementById('supportLinkUrl').value='https://example.invalid/local-draft';document.getElementById('addSupportLink').onclick();document.getElementById('save').onclick();});await assertFailed(frame,calls);
});

for(const failure of[{status:403,message:'El rol activo no puede cargar las opciones de esta factura.'},{status:500,message:'No fue posible consultar las opciones de la factura.'},{status:502,raw:true}])test(`required bundle ${failure.status} remains blocked and shows a visible error without fallback`,{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t,{failure,expectError:true,...(failure.status===403?{access:{canView:false,canCreate:true,canEdit:false}}:{})});await assertFailed(frame,calls);assert.equal(await frame.locator('#supplier option').count(),0);assert.equal(await frame.locator('#invoiceDate').inputValue(),'');assert.match(await frame.locator('#invoiceLoadError').innerText(),failure.raw?/respuesta válida/:new RegExp(failure.message.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));assert.equal(calls.length,2);
 if(failure.status===500&&process.env.SUPPLIER_FORM_OPTIONS_CAPTURE==='1'){const directory=resolve('..','supplier-invoice-provider-loading-qa-20261106');await mkdir(directory,{recursive:true});await page.screenshot({path:resolve(directory,'after-options-error-1536.png'),fullPage:true});await page.setViewportSize({width:390,height:768});await page.screenshot({path:resolve(directory,'after-options-error-390.png'),fullPage:true});}
});

for(const invalid of['missing-array','foreign-context','create-documents'])test(`rejects incomplete or wrong-scope form options: ${invalid}`,{timeout:30000},async t=>{
 const bundle=bundleFor();if(invalid==='missing-array')delete bundle.taxTypes;else if(invalid==='foreign-context')bundle.context.subsidiaryId=2;else bundle.invoices=[{invoice_id:99,subsidiary_id:2}];
 const{frame,calls}=await fixture(t,{bundle,expectError:true});await assertFailed(frame,calls);assert.equal(await frame.locator('#supplier option').count(),0);assert.equal(await frame.locator('#currency option').count(),0);
});

test('a company change while options are pending discards the response before populating the form',{timeout:30000},async t=>{
 const gate=deferred();t.after(()=>gate.resolve());const{frame,calls}=await fixture(t,{gate,pending:true});await until(()=>calls.some(call=>call.path.endsWith('/supplier-invoice-form-options')));await frame.evaluate(()=>{localStorage.setItem('nexo_company','2');window.dispatchEvent(new StorageEvent('storage',{key:'nexo_company'}));});gate.resolve();await frame.locator('#invoiceLoadError').filter({hasText:'cambi'}).waitFor();await assertFailed(frame,calls);assert.equal(await frame.locator('#supplier option').count(),0);assert.equal(calls.length,2);
});

test('view-only cannot request create options and preserves the access gate',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t,{access:{canView:true,canCreate:false,canEdit:false},expectError:true});await assertFailed(frame,calls);assert.deepEqual(calls.map(call=>call.path),['/api/purchasing/supplier-invoice-access']);assert.match(await frame.locator('#invoiceLoadError').innerText(),/No tiene permiso para crear/);
});

test('selected invoice uses exact ID/context and retains historical values in read-only mode despite denied support access',{timeout:30000},async t=>{
 const bundle=bundleFor(77);bundle.suppliers[0].is_inactive=true;bundle.invoices[0].location_id=2;bundle.locations.push({location_id:2,name:'Historical location',subsidiary_id:1});const{frame,calls}=await fixture(t,{query:'?id=77',access:{canView:true,canCreate:false,canEdit:false},bundle});
 assert.equal(calls.find(call=>call.path.endsWith('/supplier-invoice-form-options')).query,'?invoiceId=77');assert.equal(await frame.locator('#supplier').inputValue(),'1');assert.equal(await frame.locator('#invoiceNumber').inputValue(),'SYN-INV-77');assert.equal(await frame.locator('#location').inputValue(),'2');assert.equal(await frame.locator('#location').isDisabled(),true);assert.equal(await frame.locator('#save').isDisabled(),true);assert.equal(await frame.locator('[data-key=unit_price]').inputValue(),'12,345678');assert.equal(calls.filter(call=>call.path==='/api/accounting/journal-supports').length,1);assert.equal(mutations(calls).length,0);
});

test('selected invoice rejects an unexpected invoice context before any header or line is shown',{timeout:30000},async t=>{
 const bundle=bundleFor(77);bundle.context.invoiceId=78;const{frame,calls}=await fixture(t,{query:'?id=77',access:{canView:true,canCreate:false,canEdit:true},bundle,expectError:true});await assertFailed(frame,calls);assert.equal(await frame.locator('#invoiceNumber').inputValue(),'');assert.equal(await frame.locator('#lines tr').count(),0);assert.equal(calls.length,2);
});

test('receipt-derived creation keeps its source guard and exact receipt location with the bundled catalogues',{timeout:30000},async t=>{
 const bundle=bundleFor();bundle.locations.push({location_id:2,name:'Receipt location',subsidiary_id:1});const receipt={header:{document_id:7,document_type:'RECEIPT',document_number:'REC-SYN-7',supplier_id:1,payment_term_id:1,location_id:2,document_date:'2026-11-06',fiscal_period_id:1,currency_id:1,exchange_rate:1,memo:'Synthetic receipt'},accounts:bundle.accounts,lines:[{account_id:10,quantity:1,unit_cost:100,description:'Receipt line'}]};const{frame,calls}=await fixture(t,{query:'?receiptId=7',bundle,receipt});assert.equal(await frame.locator('#receiptDocumentId').inputValue(),'7');assert.equal(await frame.locator('#location').inputValue(),'2');assert.equal(await frame.locator('#location').isDisabled(),true);assert.equal(await frame.locator('#save').isEnabled(),true);await frame.locator('#invoiceNumber').fill('SYN-RECEIPT-INVOICE');await frame.locator('#save').click();await frame.locator('#successModal').waitFor({state:'visible'});const saved=mutations(calls);assert.equal(saved.length,1);assert.equal(saved[0].payload.purchase_receipt_document_id,7);assert.equal(saved[0].payload.location_id,2);
 for(const failure of[{receiptFailure:true},{prefillMissing:true}]){
  const failed=await fixture(t,{query:'?receiptId=7',bundle,expectError:true,...failure});assert.equal(await failed.frame.locator('#save').isDisabled(),true);assert.equal(await failed.frame.locator('#location').isDisabled(),true);assert.equal(await failed.frame.locator('#supportsTab').isEnabled(),true);assert.equal(await failed.frame.locator('#invoiceLoadStatus').isHidden(),true);
  await failed.frame.locator('#supportsTab').click();await failed.frame.locator('#supportLinkName').fill('Local receipt draft');await failed.frame.locator('#supportLinkUrl').fill('https://example.invalid/receipt-draft');await failed.frame.locator('#addSupportLink').click();assert.equal(await failed.frame.locator('#supportList .support-item').count(),1);await failed.frame.locator('#linesTab').click();await failed.frame.locator('#addLine').click();assert.equal(await failed.frame.locator('#save').isDisabled(),true);await failed.frame.evaluate(()=>document.getElementById('save').onclick());assert.equal(mutations(failed.calls).length,0);
 }
});

test('invalid invoice route is rejected before access/options requests',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t,{query:'?id=1e3',expectError:true});await assertFailed(frame,calls);assert.deepEqual(calls,[]);assert.match(await frame.locator('#invoiceLoadError').innerText(),/identificador/);
});
