import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { chromium } from '@playwright/test';

const kind='SOLICITUD_PAGO_APROBADA';
const tags=['empresa_nombre','numero_solicitud','tipo_solicitud','fecha_solicitud','fecha_pago_programada','moneda','monto_total','beneficiario_nombre','concepto','solicitante_nombre','aprobador_nombre','fecha_aprobacion','enlace_solicitud'];
async function fixture(t){
 const root=resolve('public'),server=createServer(async(request,response)=>{try{const path=resolve(root,'.'+new URL(request.url,'http://localhost').pathname);if(!path.startsWith(root+sep))throw Error();response.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/html');response.end(await readFile(path))}catch{response.writeHead(404);response.end()}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done)}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
 return{page,base:`http://127.0.0.1:${server.address().port}`};
}
const subsidiary={subsidiary_id:1,name:'Synthetic company',legal_name:'Synthetic SA',tax_id:'SYNTHETIC',country_id:1,currency_id:1,secondary_currency_ids:[],timezone_id:1,fiscal_calendar_id:9500,is_active:true,is_elimination:false,applies_income_autorent:false,default_up_approver_id:null,administrative_approver:null,tax_supervisor_user_id:null,email:'contact@example.invalid',treasury_email:'treasury@example.invalid',phone:'555',address:'Synthetic',parent_id:null,_revision:'SYN'};
async function companyFixture(t){
 const result=await fixture(t),{page,base}=result,calls=[];let writable=true;
 await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url()),path=url.pathname;calls.push({path,method:request.method(),payload:request.postDataJSON()});let json=[];
  if(path==='/api/auth/turnstile-config')json={enabled:false};
  else if(path==='/api/organization/master/options')json={canView:true,canCreate:writable,canEdit:writable,canDelete:false,references:{'organization/subsidiaries':[{subsidiary_id:1,name:'Synthetic',country_id:1}],'core/countries':[{country_id:1,name:'Synthetic country',country_code_iso2:'XX'}],'core/currencies':[{currency_id:1,currency_code:'USD',name:'Dollar'}],'core/timezones':[{timezone_id:1,name:'UTC'}],'organization/fiscal-calendars':[{fiscal_calendar_id:9500,calendar_name:'Synthetic'}],'organization/up-approver-options':[],'organization/approver-options':[],'security/users':[],'accounting/chart-accounts':[]}};
  else if(path==='/api/organization/subsidiaries')json=request.method()==='GET'?[{...subsidiary,_actions:{canEdit:writable,canDelete:false}}]:{...subsidiary,...request.postDataJSON()};
  else if(path==='/api/organization/subsidiaries/1')json={...subsidiary,...(request.postDataJSON()||{}),_actions:{canEdit:writable,canDelete:false}};
  await route.fulfill({json});
 });
 await page.goto(base+'/index.html');await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
 await page.evaluate(async()=>{localStorage.setItem('nexo_token','synthetic-token');localStorage.setItem('nexo_device_token','synthetic-device');const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.sessionReady=true;v.authenticated=true;v.selectingRole=false;v.selectingCompany=false;v.activeCompany={subsidiaryId:1,name:'Synthetic'};v.activeRole={roleId:1,name:'Administrador'};v.roleAccess={loaded:true,isAdmin:true,legacy:false,grants:{},modules:[]};v.closeWorkspace();v.currentModule='Organización';v.currentSection=v.catalogs.find(c=>c.slug==='subsidiaries').title;await v.loadCatalog();await v.openRecordForm(v.rows[0])});
 await page.locator('[data-field-key="treasury_email"] input').waitFor({state:'visible'}).catch(async error=>{throw Error(JSON.stringify(await page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;return{dialog:v.recordDialog,slug:v.activeCatalog?.slug,tab:v.subsidiaryFormTab,error:v.dialogError,table:v.tableError,body:document.body.innerText.slice(-1500)}})),{cause:error})});return{...result,calls,readonly:()=>{writable=false}};
}
const vue=async(page,callback,arg)=>{const handle=await page.evaluateHandle(()=>document.getElementById('app').__vue_app__._container._vnode.component.proxy);try{return await handle.evaluate(callback,arg)}finally{await handle.dispose()}};

test('Tesorería: contacto opcional independiente en Información de la empresa, alta y edición con revisión',{timeout:45000},async t=>{
 const{page,calls}=await companyFixture(t),input=page.locator('[data-field-key="treasury_email"] input');
 assert.equal(await input.isVisible(),true);assert.equal(await input.getAttribute('type'),'email');assert.equal(await input.getAttribute('required'),null);assert.equal(await input.inputValue(),'treasury@example.invalid');
 const order=await page.locator('.modal [data-field-key]').evaluateAll(fields=>fields.map(field=>field.dataset.fieldKey));assert.equal(order.indexOf('treasury_email'),order.indexOf('email')+1);assert.equal(order.indexOf('phone'),order.indexOf('treasury_email')+1);
 assert.match(await page.locator('[data-field-key="treasury_email"]').innerText(),/opcional.*aprobación final/is);
 await page.click('#subsidiary-tab-currency');assert.equal(await input.isHidden(),true);await page.click('#subsidiary-tab-company');
 await input.fill('updated-treasury@example.invalid');await vue(page,async v=>v.submitRecord());
 const patch=calls.find(call=>call.method==='PATCH');assert.equal(patch.payload.treasury_email,'updated-treasury@example.invalid');assert.equal(patch.payload.email,'contact@example.invalid');assert.equal(patch.payload.phone,'555');assert.equal(patch.payload._revision,'SYN');
 await vue(page,async(v,row)=>{await v.openRecordForm();Object.assign(v.recordDialog.values,row);delete v.recordDialog.values._revision;v.recordDialog.values.treasury_email=''},subsidiary);
 assert.equal(await input.inputValue(),'');await vue(page,async v=>v.submitRecord());const create=calls.find(call=>call.method==='POST'&&call.path==='/api/organization/subsidiaries');assert.ok(create);assert.equal(create.payload.treasury_email,'');assert.equal(create.payload.email,'contact@example.invalid');
});

test('Tesorería: rechaza listas, correo inválido y longitud excesiva incluso en otra pestaña; conserva permisos',{timeout:45000},async t=>{
 const{page,calls,readonly}=await companyFixture(t);
 for(const value of['invalid','a@example.invalid;b@example.invalid','a@example.invalid,b@example.invalid','x'.repeat(243)+'@example.invalid','a@example.invalid\r\n','a\0@example.invalid','a..b@example.invalid','.a@example.invalid','a.@example.invalid','x'.repeat(65)+'@example.invalid']){
  await vue(page,async(v,email)=>{v.recordDialog.values.treasury_email=email;v.selectSubsidiaryTab('currency');await v.submitRecord()},value);
  assert.equal(calls.filter(call=>call.method==='PATCH').length,0);assert.match(await vue(page,v=>v.dialogError),/único correo electrónico válido.*254/);assert.equal(await page.getAttribute('#subsidiary-tab-company','aria-selected'),'true');assert.equal(await vue(page,v=>v.recordDialog.values.treasury_email),value);
 }
 readonly();await vue(page,async v=>{await v.loadCatalog();v.recordDialog.values.treasury_email='valid@example.invalid';await v.submitRecord()});assert.equal(calls.filter(call=>call.method==='PATCH').length,0);assert.match(await vue(page,v=>v.dialogError),/permiso explícito/);
});

async function templateFixture(t,{canEdit=true,denied=false}={}){
 const result=await fixture(t),{page,base}=result,calls=[];
 await page.addInitScript(()=>{if(window.top===window){localStorage.setItem('nexo_token','synthetic-token');localStorage.setItem('nexo_device_token','synthetic-device')}});
 await page.route('**/api/**',async route=>{const request=route.request(),action=new URL(request.url()).pathname.split('/').at(-1),payload=request.postDataJSON();calls.push({action,payload});assert.equal(payload.kind,kind);
  if(action==='get'&&denied)return route.fulfill({status:403,json:{error:{message:'Sin permiso de consulta.'}}});
  if(action==='get')return route.fulfill({json:{canEdit,subsidiary:{id:1,name:'Synthetic company'},transport:{enabled:true},template:null,defaults:{subject:'Solicitud {{numero_solicitud}} aprobada · {{empresa_nombre}}',body:'<p>Aprobación final de {{numero_solicitud}}. Consulte el estado actual antes de ejecutar el pago.</p>'}}});
  if(action==='preview')return route.fulfill({json:{subject:'Solicitud SYN-001 aprobada',html:'<!doctype html><p>Aprobación final. Consulte el estado actual antes de ejecutar el pago.</p><a href="https://example.invalid/payment-requests.html?id=1&amp;subsidiaryId=1">Consultar solicitud</a><script>parent.syntheticPreviewRan=true</script>'}});
  if(action==='save')return route.fulfill({json:{template:{cuerpo_template:'<p>Mensaje guardado para {{beneficiario_nombre}}.</p>',updated_by_email:'editor@example.invalid',updated_at:'2026-11-04T12:00:00Z'}}});
  throw Error('Unexpected synthetic API action '+action);
 });
 await page.goto(base+'/notification-templates.html?kind='+kind);
 if(denied)await page.locator('#message').filter({hasText:'Sin permiso'}).waitFor();else await page.locator('#previewSubject').filter({hasText:'SYN-001'}).waitFor();
 return{...result,calls};
}

test('plantilla aprobada: variables completas, vista previa inerte y guardar sin envío ni pago',{timeout:45000},async t=>{
 const{page,calls,base}=await templateFixture(t);
 assert.equal(await page.inputValue('#notificationType'),kind);assert.equal(await page.locator('#notificationType option:checked').textContent(),'Solicitud de pago aprobada · Tesorería');assert.equal(await page.locator('#typeTitle').textContent(),'Solicitud de pago aprobada · Tesorería');
 assert.deepEqual(await page.locator('#variables button').allTextContents(),tags.map(tag=>'{{'+tag+'}}'));assert.equal(await page.locator('#scheduleFields').isHidden(),true);assert.equal(await page.locator('#active').isChecked(),false);
 assert.match(await page.locator('#activeHelp').innerText(),/únicamente.*Tesorería.*esta subsidiaria.*aprobación final/);assert.match(await page.locator('#schedule').innerText(),/parciales no generan/);assert.match(await page.locator('#automaticHelp').innerText(),/consulta autenticada/);assert.match(await page.locator('#previewHelp').innerText(),/no envía correos ni ejecuta pagos/);
 assert.equal(await page.locator('#preview').getAttribute('sandbox'),'');await page.frameLocator('#preview').getByRole('link',{name:'Consultar solicitud'}).waitFor();assert.equal(await page.evaluate(()=>window.syntheticPreviewRan),undefined);
 await page.fill('#subject','Solicitud ');await page.focus('#subject');await page.locator('#variables button').getByText('{{numero_solicitud}}',{exact:true}).click();assert.equal(await page.inputValue('#subject'),'Solicitud {{numero_solicitud}}');
 await page.locator('#editor').fill('Aviso a {{beneficiario_nombre}}.');await page.check('#active');await page.click('#previewButton');await page.locator('#message').filter({hasText:'Vista previa actualizada.'}).waitFor();
 await page.click('#save');await page.locator('#message').filter({hasText:'Plantilla guardada.'}).waitFor();const save=calls.find(call=>call.action==='save');assert.equal(save.payload.kind,kind);assert.equal(save.payload.subject,'Solicitud {{numero_solicitud}}');assert.match(save.payload.body,/beneficiario_nombre/);assert.equal(save.payload.active,true);assert.equal(save.payload.day,undefined);assert.equal(save.payload.time,undefined);assert.equal(await page.locator('#editor').innerHTML(),'<p>Mensaje guardado para {{beneficiario_nombre}}.</p>');
 assert.ok(calls.every(call=>['get','preview','save'].includes(call.action)));assert.equal(calls.filter(call=>call.action==='save').length,1);
 await page.route('**/notification-templates.html?kind=SOLICITUD_GASTO_APROBACION',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><p>Synthetic navigation target</p>'}));await page.selectOption('#notificationType','SOLICITUD_GASTO_APROBACION');await page.waitForURL(base+'/notification-templates.html?kind=SOLICITUD_GASTO_APROBACION');
});

test('plantilla aprobada: consulta permite preview y bloquea edición/submit por permiso',{timeout:45000},async t=>{
 const{page,calls}=await templateFixture(t,{canEdit:false});await page.locator('#message').filter({hasText:'Modo de solo lectura'}).waitFor();
 assert.equal(await page.locator('#subject').getAttribute('readonly'),'');assert.equal(await page.locator('#editor').getAttribute('contenteditable'),'false');for(const selector of['#active','#save','#variables button','#addLink','[data-command]'])assert.ok((await page.locator(selector).evaluateAll(elements=>elements.every(element=>element.disabled))));
 await page.click('#previewButton');await page.locator('#message').filter({hasText:'Vista previa actualizada.'}).waitFor();await page.locator('#form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await page.locator('#message').filter({hasText:'no modificarla'}).waitFor();assert.equal(calls.filter(call=>call.action==='save').length,0);assert.equal(calls.filter(call=>call.action==='preview').length,2);
});

test('plantilla aprobada: denegar consulta mantiene Guardar cerrado y no solicita preview',{timeout:45000},async t=>{
 const{page,calls}=await templateFixture(t,{denied:true});assert.equal(await page.locator('#save').isDisabled(),true);assert.deepEqual(calls.map(call=>call.action),['get']);await page.locator('#form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.deepEqual(calls.map(call=>call.action),['get']);
});

async function requestFixture(t,status,company='1'){
 const result=await fixture(t),{page,base}=result,calls=[];
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-token');localStorage.setItem('nexo_device_token','synthetic-device');localStorage.setItem('nexo_company','1');window.NexoRecordAudit={show(){}}});
 await page.route('**/api/**',async route=>{const request=route.request(),action=new URL(request.url()).pathname.split('/').at(-1),payload=request.postDataJSON();calls.push({action,payload});
  if(action==='access')return route.fulfill({json:{canView:true,canCreate:false,canEdit:false}});
  if(action==='options')return route.fulfill({json:{company:'Synthetic company',userId:1,baseCurrencyId:1,currencies:[{id:1,name:'USD'}],users:[{id:1,name:'Synthetic requester'}],suppliers:[],customers:[],employees:[],accounts:[],banks:[],rates:[]}});
  if(action==='report'||action==='supports')return route.fulfill({json:[]});
  if(action==='detail')return route.fulfill({json:{header:{id:1,numero:'SYN-001',estado:status,tipo_solicitud:'OTROS',id_moneda:1,id_solicitante:1,fecha_solicitud:'2026-11-04',fecha_pago_programada:'2026-11-10',total:10,concepto:'Synthetic request',version:1},lines:[],events:[],actions:{canEdit:false,canExecute:status==='APROBADO'}}});
  throw Error('Unexpected synthetic request action '+action);
 });
 await page.goto(base+'/payment-requests.html?id=1&subsidiaryId='+company);
 return{...result,calls};
}
for(const[status,expected]of[
 ['APROBADO',/Solicitud aprobada.*antes de aplicar o ejecutar el pago/],
 ['APLICADO',/Solicitud ya aplicada.*pago registrado/],
 ['ANULADO',/Solicitud anulada.*disponible para consulta/],
 ['RECHAZADO',/Solicitud rechazada.*estado actual/],
 ['PENDIENTE_APROBACION',/Solicitud cargada desde la notificación\. Revise el detalle antes de aprobar o rechazar\./]
])test('enlace de notificación refleja '+status+' sin ejecutar acciones',{timeout:45000},async t=>{
 const{page,calls}=await requestFixture(t,status);await page.locator('#message').filter({hasText:expected}).waitFor();assert.equal(await page.locator('#editor').isVisible(),true);assert.equal(await page.locator('#documentStatus').textContent(),status.replaceAll('_',' '));
 assert.deepEqual(calls.map(call=>call.action).sort(),['access','detail','options','report','supports']);assert.equal(await page.locator('#payDialog').evaluate(dialog=>dialog.open),false);assert.equal(await page.locator('#reasonDialog').evaluate(dialog=>dialog.open),false);assert.equal(await page.locator('#workflow [data-transition="EXECUTE"]').count(),status==='APROBADO'?1:0);if(status!=='PENDIENTE_APROBACION')assert.doesNotMatch(await page.locator('#message').textContent(),/aprobar o rechazar/);
});

test('enlace de notificación de otra empresa se bloquea antes de consultar o ejecutar',{timeout:45000},async t=>{
 const{page,calls}=await requestFixture(t,'APROBADO','2');await page.locator('#message').filter({hasText:'empresa indicada no está activa'}).waitFor();assert.deepEqual(calls,[]);assert.equal(await page.locator('#editor').isHidden(),true);assert.equal(await page.locator('#new').isHidden(),true);assert.equal(await page.locator('input,select,textarea,button').evaluateAll(controls=>controls.every(control=>control.disabled)),true);
});
