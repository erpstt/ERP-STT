import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

// Serve the real entry module and the same late theme/workspace injections as
// serveFile. Every API call is synthetic; this test starts no financial backend.
const html=await readFile('public/bank-check-entry.html','utf8'),server=await readFile('src/server.ts','utf8');
const injection=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/),renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(injection&&renewal,'The production HTML injections must be represented');
function served(){const[,guard,assets]=injection;return html.replace('</head>',assets+'</head>').replace('<head>','<head>'+renewal[1]+guard);}
const deferred=()=>{let release;const promise=new Promise(done=>{release=done;});return{promise,release};};
const period={fiscal_period_id:1,period_name:'Synthetic open period',start_date:'2000-01-01',end_date:'2100-12-31',subsidiary_id:1,is_closed:false,gl_closed:false,is_inactive:false};
const catalogs={
 '/api/accounting/chart-accounts':[{account_id:100,account_number:'111001',account_name:'Synthetic bank ledger',subsidiary_id:1,accepts_entries:true},{account_id:600,account_number:'631001',account_name:'Synthetic expense',subsidiary_id:1,accepts_entries:true}],
 '/api/core/currencies':[{currency_id:1,currency_code:'CRC',name:'Colón'}],
 '/api/configuration/exchange-rates':[],
 '/api/banking/checks/periods':[period],
 '/api/organization/departments':[], '/api/organization/cost-centers':[], '/api/organization/classes':[], '/api/organization/financial-creditors':[], '/api/organization/related-companies':[],
 '/api/entities/customers':[{customer_id:10,company_name:'Cliente sintético',subsidiary_ids:[1]}],
 '/api/entities/suppliers':[{supplier_id:20,company_name:'Proveedor de la línea',subsidiary_ids:[1]}], '/api/entities/employees':[]
};
async function fixture(t,{width=1536,type='CHEQUE',edit=false,beneficiary='Receptor histórico <texto> & compañía',saveGate=null}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),calls=[],errors=[],unexpected=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-beneficiary-token');localStorage.setItem('nexo_device_token','synthetic-beneficiary-device');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');window.NexoSessionRenewal={current:()=>({generation:'synthetic-beneficiary-generation'})};});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/bank-check-entry.html'){await route.fulfill({contentType:'text/html; charset=utf-8',body:served()});return;}
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  if(url.pathname.startsWith('/api/audit/')){await route.fulfill({json:{events:[]}});return;}
  const call={path:url.pathname,method:request.method(),payload:request.postData()?request.postDataJSON():null};calls.push(call);
  let result;
  if(catalogs[url.pathname])result=catalogs[url.pathname];
  else if(url.pathname==='/api/banking/checks/options')result={subsidiary:{id:1,name:'Empresa sintética',currencyId:1},location:{id:1,name:'Oficina sintética'},accounts:[{id:5,bankId:1,bankName:'Banco sintético',number:'000005',currencyId:1,currencyCode:'CRC',ledgerAccountId:100,balance:1000}],access:{canView:true,canCreate:true,canEdit:true,canDelete:true}};
  else if(url.pathname==='/api/banking/checks/1'&&call.method==='GET')result={header:{check_id:1,check_number:'CHQ-SYN-1',bank_account_id:5,currency_id:1,exchange_rate:1,amount:12.345678,payment_type:type,payment_date:'2026-11-06',fiscal_period_id:1,location_id:1,bank_reference:'SYN-REFERENCE',beneficiary,memo:'Documento sintético'},lines:[{account_id:600,amount:12.345678,note:'Línea sintética',entity_type:'Proveedor',supplier_id:20}]};
  else if(['/api/banking/checks','/api/banking/checks/1'].includes(url.pathname)&&['POST','PUT'].includes(call.method)){if(saveGate)await saveGate.promise;result={checkId:1,journalId:77,transactionNumber:'CHQ-SYN-SAVED',total:12.345678};}
  else{unexpected.push(call.method+' '+call.path);await route.fulfill({status:501,json:{error:{message:'Unmocked request blocked'}}});return;}
  await route.fulfill({json:result});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/bank-check-entry.html'+(edit?'?id=1':'')+'"></iframe></body></html>',{waitUntil:'domcontentloaded'});
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();await frame.waitForFunction(()=>window.NexoBankCheckEntry&&!document.getElementById('save').disabled&&(!location.search||document.querySelector('h1').textContent.startsWith('Editar')));
 t.after(()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});return{page,frame,calls};
}
const writes=calls=>calls.filter(call=>['POST','PUT','PATCH','DELETE'].includes(call.method));
async function fillCreate(frame,type){await frame.locator('#type').selectOption(type);await frame.locator('#bank').selectOption('1');await frame.locator('#bankAccount').selectOption('5');await frame.locator('#reference').fill('SYN-REFERENCE');await frame.locator('.account-search').fill('631001');await frame.locator('[data-k=amount]').fill('12.345678');await frame.locator('[data-k=amount]').blur();}
async function assertField(frame,width){
 const field=frame.locator('#beneficiary');assert.equal(await field.isVisible(),true,'Beneficiary must remain visible after both entry modules finish loading');assert.equal(await field.isEnabled(),true);assert.equal(await field.getAttribute('required'),null);assert.equal(await field.getAttribute('maxlength'),null);
 assert.equal(await frame.locator('html').evaluate(element=>element.classList.contains('inside-erp-workspace')),true);assert.equal(await frame.locator('link[href*="gentia-theme.css"]').count(),1);assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length>0)),true);
 assert.equal(await field.getAttribute('aria-describedby'),'beneficiaryHelp');assert.equal(await frame.locator('#beneficiaryHelp').innerText(),'Nombre de la persona o empresa que recibe el pago.');
 await field.scrollIntoViewIfNeeded();const box=await field.boundingBox();assert.ok(box.width>150&&box.height>=30);assert.ok(box.x>=-1&&box.x+box.width<=width+1,'The full beneficiary field must fit inside the iframe');assert.ok(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'The page must not overflow horizontally');
}
async function capture(page,name){if(process.env.BANK_CHECK_BENEFICIARY_CAPTURE!=='1')return;const directory=resolve('..','bank-check-beneficiary-qa-20261106');await mkdir(directory,{recursive:true});await page.screenshot({path:resolve(directory,name),fullPage:true});}

for(const type of['CHEQUE','TRANSFERENCIA'])for(const width of[1536,390])test(`${type} ${width}: beneficiario estable y editable conserva su valor independiente de entidades al crear`,{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t,{type,width});await assertField(frame,width);const beneficiary=frame.locator('#beneficiary');await beneficiary.fill('  Persona receptora & Compañía  ');await fillCreate(frame,type);
 await frame.locator('[data-k=entity_type]').selectOption('Proveedor');await frame.locator('[data-k=entity_id]').selectOption('20');await frame.locator('#type').selectOption(type==='CHEQUE'?'TRANSFERENCIA':'CHEQUE');await frame.locator('#type').selectOption(type);await frame.locator('#memo').fill('Concepto sintético');assert.equal(await beneficiary.inputValue(),'  Persona receptora & Compañía  ');assert.equal(await beneficiary.isVisible(),true);await beneficiary.scrollIntoViewIfNeeded();await capture(page,`${type.toLowerCase()}-${width}.png`);
 await frame.locator('#save').click();await frame.locator('#successModal').waitFor({state:'visible'});assert.equal(writes(calls).length,1);assert.equal(writes(calls)[0].method,'POST');assert.equal(writes(calls)[0].payload.beneficiary,'Persona receptora & Compañía');assert.equal(writes(calls)[0].payload.payment_type,type);assert.equal(writes(calls)[0].payload.lines[0].entity_type,'Proveedor');assert.equal(writes(calls)[0].payload.lines[0].entity_id,'20');assert.equal(await beneficiary.inputValue(),'  Persona receptora & Compañía  ');
});
for(const type of['CHEQUE','TRANSFERENCIA'])test(`${type}: edición conserva el beneficiario histórico sin derivarlo de las líneas`,{timeout:30000},async t=>{
 const value='Receptor histórico <texto> & compañía',{frame,calls}=await fixture(t,{type,edit:true,beneficiary:value});await assertField(frame,1536);assert.equal(await frame.locator('#beneficiary').inputValue(),value);assert.equal(await frame.locator('#beneficiary').evaluate(element=>element.closest('label').querySelectorAll('texto').length),0);await frame.locator('#memo').fill('Único cambio: nota');await frame.locator('[data-k=entity_type]').selectOption('Cliente');await frame.locator('[data-k=entity_id]').selectOption('10');assert.equal(await frame.locator('#beneficiary').inputValue(),value);await frame.locator('#save').click();await frame.locator('#successModal').waitFor({state:'visible'});assert.equal(writes(calls).length,1);assert.equal(writes(calls)[0].path,'/api/banking/checks/1');assert.equal(writes(calls)[0].method,'PUT');assert.equal(writes(calls)[0].payload.beneficiary,value);assert.equal(writes(calls)[0].payload.payment_type,type);
});
test('beneficiario opcional acepta vacío en ambos tipos sin inventar una obligatoriedad',{timeout:30000},async t=>{
 for(const type of['CHEQUE','TRANSFERENCIA']){const{frame,calls}=await fixture(t,{type});assert.equal(await frame.locator('#beneficiary').isVisible(),true);assert.equal(await frame.locator('#beneficiary').getAttribute('required'),null);await fillCreate(frame,type);await frame.locator('#beneficiary').fill('   ');await frame.locator('#save').click();await frame.locator('#successModal').waitFor({state:'visible'});assert.equal(writes(calls).length,1);assert.equal(writes(calls)[0].payload.beneficiary,'');}
});
test('guardado pendiente bloquea beneficiario y doble evento sin perder su valor ni duplicar POST',{timeout:30000},async t=>{
 const saveGate=deferred();t.after(()=>saveGate.release());const{frame,calls}=await fixture(t,{saveGate});await fillCreate(frame,'CHEQUE');await frame.locator('#beneficiary').fill('Receptora durante guardado');await frame.locator('#save').click();await frame.waitForFunction(()=>document.getElementById('save').disabled);assert.equal(await frame.locator('#beneficiary').isDisabled(),true);assert.equal(await frame.locator('#beneficiary').isVisible(),true);assert.equal(await frame.locator('#beneficiary').inputValue(),'Receptora durante guardado');await frame.evaluate(()=>document.getElementById('save').onclick());assert.equal(writes(calls).length,1);saveGate.release();await frame.locator('#successModal').waitFor({state:'visible'});assert.equal(writes(calls).length,1);assert.equal(writes(calls)[0].payload.beneficiary,'Receptora durante guardado');
});
