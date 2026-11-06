import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

// Real public scripts, theme and branding in the same-origin workspace iframe.
// All APIs are synthetic route fixtures. Nothing reaches a financial backend.
const source=await readFile('src/server.ts','utf8');
const branding=source.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/);
const renewal=source.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal,'Production HTML injection must remain represented');
function served(raw){const[,guard,assets]=branding,branded=raw.includes('</head>')?raw.replace('</head>',assets+'</head>'):assets+raw,html=branded.includes('<head>')?branded.replace('<head>','<head>'+guard):guard+branded;return /<head\b[^>]*>/i.test(html)?html.replace(/<head\b[^>]*>/i,head=>head+renewal[1]):renewal[1]+html;}
const accountLabels={203:'118002 · Anticipos al personal',204:'610001 · Gasto de administración',205:'610002 · Gasto de alquiler'};
const defaultOptions={userId:1,admin:false,canApprove:false,canExecute:false,company:'Synthetic subsidiary',baseCurrencyId:1,currencies:[{id:1,name:'CRC'}],users:[{id:1,name:'Synthetic requester'}],accounts:Object.entries(accountLabels).map(([id,name])=>({id:Number(id),name})),suppliers:[{id:10,name:'Álvarez Servicios'},{id:11,name:'ALFA Proveedora'}],employees:[{id:20,name:'Ana Empleada'}],customers:[{id:30,name:'Cliente Sintético'}],otherNames:[{id:40,name:'ON-000040 · Otro Nombre'}],taxAgencies:[{id:50,name:'Agencia Tributaria Sintética'}],departments:[{id:21,name:'Departamento interno',type:'Interno'},{id:22,name:'Otro departamento interno',type:'Interno'},{id:23,name:'Departamento cliente',type:'Cliente'}],costCenters:[{id:31,name:'Centro interno',type:'INTERNO',departmentId:21},{id:32,name:'Otro centro',type:'INTERNO',departmentId:22},{id:33,name:'Centro cliente',type:'CLIENTE',departmentId:23}],banks:[{id:1,name:'Synthetic bank',currencyId:1}],rates:[],beneficiaryBankAccounts:[{entityType:'Proveedor',entityId:10,name:'Álvarez Servicios',beneficiaryName:'Beneficiario sintético',accounts:[]},{entityType:'Empleado',entityId:20,name:'Ana Empleada',beneficiaryName:'Empleada sintética',accounts:[]}]};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const apiLine=line=>({id_cuenta_contable:Number(line.accountId),tipo_tercero:line.entityType,[{'Proveedor':'id_proveedor','Empleado':'id_empleado','Cliente':'id_cliente','Otro Nombre':'id_otro_nombre','Agencia Tributaria':'id_agencia_tributaria'}[line.entityType]||'entity_id']:Number(line.entityId),id_departamento:Number(line.departmentId),departmentType:line.departmentType,id_centro_costo:line.costCenterId?Number(line.costCenterId):null,concepto:line.concept,monto:Number(line.amount),accountName:accountLabels[line.accountId]||'Synthetic account',party:'Synthetic party'});

async function fixture(t,{width=1536,options={},access={},initial=null,saveGate=null,saveStatus=200}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000});
 const opts={...structuredClone(defaultOptions),...options},calls=[],unexpected=[],errors=[];
 const state={header:{id:7,numero:'SOL-SYN-7',estado:'BORRADOR',id_solicitante:1,tipo_solicitud:'OTROS',id_moneda:1,fecha_solicitud:'2026-11-05',fecha_pago_programada:'2026-11-05',concepto:'Solicitud sintética',total:12.345678,version:1,solicitante:'Synthetic requester',moneda:'CRC'},lines:[apiLine({accountId:203,entityType:'Proveedor',entityId:10,departmentType:'Interno',departmentId:21,costCenterId:31,concept:'Línea sintética',amount:12.345678})],...initial};
 state.header={id:7,numero:'SOL-SYN-7',estado:'BORRADOR',id_solicitante:1,tipo_solicitud:'OTROS',id_moneda:1,fecha_solicitud:'2026-11-05',fecha_pago_programada:'2026-11-05',concepto:'Solicitud sintética',total:12.345678,version:1,solicitante:'Synthetic requester',moneda:'CRC',...initial?.header};
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-request-search-token');localStorage.setItem('nexo_device_token','synthetic-request-search-device');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');window.NexoSessionRenewal={current:()=>({generation:'synthetic-request-search-generation'})};});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/payment-requests.html'){await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/payment-requests.html','utf8'))});return;}
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  if(url.pathname.startsWith('/api/audit/')){await route.fulfill({json:{events:[]}});return;}
  const action=url.pathname.split('/').at(-1),body=request.method()==='POST'?request.postDataJSON():{},call={action,path:url.pathname,method:request.method(),body};calls.push(call);
  let json;
  if(url.pathname.startsWith('/api/treasury/payment-requests/')){
   if(action==='access')json={canView:true,canCreate:true,canEdit:true,canDelete:false,...access};
   else if(action==='options')json=opts;
   else if(action==='report')json=initial?[state.header]:[];
   else if(action==='supports')json=[];
   else if(action==='detail')json={header:state.header,lines:state.lines,events:[],beneficiaryBankAccounts:opts.beneficiaryBankAccounts,actions:{canEdit:access.canEdit!==false&&state.header.estado==='BORRADOR',canSubmit:access.canEdit!==false&&state.header.estado==='BORRADOR',canApprove:false,canExecute:false,canCancel:false}};
   else if(action==='invoices')json=[{id:91,number:'FAC-SYN-91',date:'2026-11-01',dueDate:'2026-11-30',total:100,balance:100,reserved:0,available:100}];
   else if(action==='save'){
    if(saveGate)await saveGate.promise;
    if(saveStatus!==200){await route.fulfill({status:saveStatus,json:{error:{message:'Synthetic request changed'}}});return;}
    state.header={...state.header,tipo_solicitud:body.type,id_moneda:Number(body.currencyId),id_proveedor:body.supplierId?Number(body.supplierId):null,fecha_pago_programada:body.plannedDate,concepto:body.concept,total:body.lines.reduce((sum,line)=>sum+Number(line.amount),0),version:state.header.version+1};
    state.lines=body.type==='CXP'?body.lines.map(line=>({id_factura_proveedor:Number(line.invoiceId),invoiceNumber:'FAC-SYN-91',invoiceDate:'2026-11-01',invoiceDueDate:'2026-11-30',invoiceTotal:100,monto:Number(line.amount)})):body.lines.map(apiLine);json={id:7};
   }else if(action==='transition'){state.header={...state.header,estado:'PENDIENTE_APROBACION',version:state.header.version+1};json={id:7};}
  }
  if(json===undefined){unexpected.push(request.method()+' '+url.pathname);await route.fulfill({status:501,json:{error:{message:'Unmocked API blocked'}}});return;}
  await route.fulfill({json});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/payment-requests.html"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();
 await frame.waitForFunction(()=>document.querySelector('#company')?.textContent==='Synthetic subsidiary'&&!document.querySelector('#new')?.disabled);
 assert.equal(await frame.locator('html').evaluate(el=>el.classList.contains('inside-erp-workspace')),true);
 assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length>0)),true);
 t.after(()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});
 return{page,frame,calls,state,opts};
}
const row=(frame,index=0)=>frame.locator('#directLines tr').nth(index);
const picker=(frame,kind,index=0)=>row(frame,index).getByRole('combobox',{name:new RegExp('^'+kind+'$','i')});
const writes=calls=>calls.filter(call=>['save','transition','execute'].includes(call.action));
async function newOther(frame){await frame.locator('#new').click();await frame.locator('#type').selectOption('OTROS');await frame.locator('#concept').fill('Solicitud sintética de prueba');}
async function choose(frame,kind,query,label,index=0){await picker(frame,kind,index).fill(query);await frame.getByRole('option',{name:label,exact:true}).click();}
async function completeLine(frame,index=0){await choose(frame,'Cuenta','118002',accountLabels[203],index);await row(frame,index).locator('.entityType').selectOption('Proveedor');await choose(frame,'Tercero','alvarez','Álvarez Servicios',index);await row(frame,index).locator('.departmentType').selectOption('Interno');await row(frame,index).locator('.department').selectOption('21');await row(frame,index).locator('.center').selectOption('31');await row(frame,index).locator('.concept').fill('Imputación sintética');await row(frame,index).locator('.amount').fill('12.345678');}

test('core: Cuenta filtra por número/acento y escribir sobre selección reemplaza la etiqueta completa',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t);await newOther(frame);
 await picker(frame,'Cuenta').fill('1180');assert.deepEqual(await frame.locator('.request-smart-list [role="option"]').allTextContents(),[accountLabels[203]]);
 await frame.getByRole('option',{name:accountLabels[203],exact:true}).click();assert.equal(await row(frame).locator('.account').inputValue(),'203');
 await picker(frame,'Cuenta').click();await picker(frame,'Cuenta').pressSequentially('ADMINISTRACION');
 assert.equal(await picker(frame,'Cuenta').inputValue(),'ADMINISTRACION');assert.equal(await row(frame).locator('.account').inputValue(),'');
 assert.deepEqual(await frame.locator('.request-smart-list [role="option"]').allTextContents(),[accountLabels[204]]);
 await frame.getByRole('option',{name:accountLabels[204],exact:true}).click();assert.equal(await row(frame).locator('.account').inputValue(),'204');assert.equal(await picker(frame,'Cuenta').inputValue(),accountLabels[204]);
 assert.equal(calls.filter(call=>call.action==='options').length,1);assert.equal(writes(calls).length,0);
});

test('core: Tercero filtra por nombre y tipo; guardar envía IDs y dimensiones reales',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t);await newOther(frame);assert.equal(await picker(frame,'Tercero').isDisabled(),true);await completeLine(frame);
 assert.equal(await row(frame).locator('.entity').inputValue(),'10');assert.match(await frame.locator('#beneficiaryBankingContent').innerText(),/Álvarez Servicios/);
 await frame.locator('#save').click();await frame.locator('#message').filter({hasText:'Borrador y archivos'}).waitFor();
 const saved=calls.filter(call=>call.action==='save');assert.equal(saved.length,1);assert.deepEqual(saved[0].body.lines,[{accountId:'203',entityType:'Proveedor',entityId:'10',departmentType:'Interno',departmentId:'21',costCenterId:'31',concept:'Imputación sintética',amount:'12.345678'}]);assert.equal(calls.some(call=>call.action==='execute'),false);
});

test('core: teclado selecciona el ID activo sin enviar formulario y Escape/Tab cierran el listado',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t);await newOther(frame);const input=picker(frame,'Cuenta');await input.fill('gasto');await input.press('ArrowDown');
 let active=await input.getAttribute('aria-activedescendant');assert.equal(await frame.locator('#'+active).textContent(),accountLabels[204]);await input.press('ArrowDown');active=await input.getAttribute('aria-activedescendant');assert.equal(await frame.locator('#'+active).textContent(),accountLabels[205]);
 await input.press('Enter');assert.equal(await row(frame).locator('.account').inputValue(),'205');assert.equal(await input.getAttribute('aria-expanded'),'false');assert.equal(writes(calls).length,0);
 await input.click();await input.press('Escape');assert.equal(await input.getAttribute('aria-expanded'),'false');assert.equal(await row(frame).locator('.account').inputValue(),'205');
 await input.click();await input.press('Tab');assert.equal(await input.getAttribute('aria-expanded'),'false');assert.equal(await row(frame).locator('.entityType').evaluate(el=>el===document.activeElement),true);
});

test('core: texto libre de Cuenta/Tercero limpia el ID y bloquea guardado nativo y submit programático',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t);await newOther(frame);await completeLine(frame);
 await picker(frame,'Cuenta').fill('Cuenta inexistente');assert.equal(await row(frame).locator('.account').inputValue(),'');await frame.locator('#save').click();assert.equal(writes(calls).length,0);
 await frame.locator('#requestForm').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(writes(calls).length,0);assert.equal(await picker(frame,'Cuenta').evaluate(el=>el.validity.customError),true);
 await choose(frame,'Cuenta','118002',accountLabels[203]);await picker(frame,'Tercero').fill('Tercero inexistente');assert.equal(await row(frame).locator('.entity').inputValue(),'');assert.doesNotMatch(await frame.locator('#beneficiaryBankingContent').innerText(),/Álvarez Servicios/);
 await frame.locator('#save').click();assert.equal(writes(calls).length,0);assert.equal(await frame.locator('#requestForm').evaluate(form=>form.checkValidity()),false);
});

test('cambiar tipo de tercero destruye el listado anterior y no acepta una selección tardía',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t);await newOther(frame);await completeLine(frame);await picker(frame,'Tercero').fill('ALFA');
 await frame.locator('.request-smart-option').evaluate(node=>{window.__detachedPartyOption=node;});
 await row(frame).locator('.entityType').selectOption('Empleado');
 assert.equal(await frame.locator('.request-smart-popup').count(),0);assert.equal(await row(frame).locator('.entity').inputValue(),'');
 await frame.evaluate(()=>window.__detachedPartyOption.click());assert.equal(await row(frame).locator('.entity').inputValue(),'');
 await picker(frame,'Tercero').fill('ana');assert.deepEqual(await frame.locator('.request-smart-list [role="option"]').allTextContents(),['Ana Empleada']);
 await picker(frame,'Tercero').press('ArrowDown');await picker(frame,'Tercero').press('Enter');
 assert.equal(await row(frame).locator('.entity').inputValue(),'20');assert.equal(await row(frame).locator('.account').inputValue(),'203');assert.equal(await row(frame).locator('.center').inputValue(),'31');
 assert.match(await frame.locator('#beneficiaryBankingContent').innerText(),/Ana Empleada/);assert.doesNotMatch(await frame.locator('#beneficiaryBankingContent').innerText(),/Álvarez/);
 assert.equal(await picker(frame,'Tercero').getAttribute('aria-expanded'),'false');assert.equal(await picker(frame,'Tercero').evaluate(el=>el===document.activeElement),true);
 await row(frame).locator('.entityType').selectOption('');assert.equal(await picker(frame,'Tercero').isDisabled(),true);assert.equal(await row(frame).locator('.entity').inputValue(),'');assert.equal(writes(calls).length,0);
});

test('varias líneas conservan cuentas/importes y sólo una selección propaga el tercero; dimensiones mantienen su cascada',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t);await newOther(frame);await completeLine(frame);await frame.locator('#addLine').click();
 await choose(frame,'Cuenta','610002',accountLabels[205],1);await row(frame,1).locator('.departmentType').selectOption('Interno');await row(frame,1).locator('.department').selectOption('21');await row(frame,1).locator('.center').selectOption('31');await row(frame,1).locator('.concept').fill('Segunda imputación');await row(frame,1).locator('.amount').fill('2.345678');
 await picker(frame,'Tercero').fill('alfa');assert.equal(await row(frame).locator('.entity').inputValue(),'');assert.equal(await row(frame,1).locator('.entity').inputValue(),'10');
 await frame.getByRole('option',{name:'ALFA Proveedora',exact:true}).click();
 assert.deepEqual(await frame.locator('#directLines .entity').evaluateAll(selects=>selects.map(select=>select.value)),['11','11']);
 assert.deepEqual(await frame.locator('#directLines .account').evaluateAll(selects=>selects.map(select=>select.value)),['203','205']);
 assert.equal(await row(frame).locator('.center').inputValue(),'31');assert.equal(await row(frame,1).locator('.center').inputValue(),'31');
 await row(frame,1).locator('.department').selectOption('22');assert.equal(await row(frame,1).locator('.center').inputValue(),'');assert.deepEqual(await row(frame,1).locator('.center option').evaluateAll(options=>options.map(option=>option.value)),['','32']);await row(frame,1).locator('.center').selectOption('32');
 await frame.locator('#save').click();await frame.locator('#message').filter({hasText:'Borrador y archivos'}).waitFor();
 const saved=calls.find(call=>call.action==='save').body.lines;assert.equal(saved.length,2);assert.deepEqual(saved.map(line=>[line.accountId,line.entityId,line.departmentId,line.costCenterId,line.amount]),[['203','11','21','31','12.345678'],['205','11','22','32','2.345678']]);
});

test('edición conserva el ID entre terceros homónimos y envío usa la versión guardada sin ejecutar pagos',{timeout:30000},async t=>{
 const options={suppliers:[{id:10,name:'Nombre Duplicado'},{id:11,name:'Nombre Duplicado'}]};
 const initial={lines:[apiLine({accountId:205,entityType:'Proveedor',entityId:11,departmentType:'Interno',departmentId:21,costCenterId:31,concept:'Histórica sin cambiar',amount:12.345678})]};
 const{frame,calls}=await fixture(t,{options,initial});await frame.locator('[data-open="7"]').click();await frame.locator('#requestForm').waitFor({state:'visible'});
 assert.equal(await row(frame).locator('.account').inputValue(),'205');assert.equal(await row(frame).locator('.entity').inputValue(),'11');assert.equal(await picker(frame,'Tercero').inputValue(),'Nombre Duplicado');
 await frame.locator('#concept').fill('Sólo cambia la nota del encabezado');await frame.locator('#save').click();await frame.locator('#message').filter({hasText:'Borrador y archivos'}).waitFor();
 const saved=calls.find(call=>call.action==='save');assert.equal(saved.body.id,7);assert.equal(saved.body.version,1);assert.equal(saved.body.lines[0].accountId,'205');assert.equal(saved.body.lines[0].entityId,'11');assert.equal(saved.body.lines[0].amount,'12.345678');
 await frame.locator('[data-transition="SUBMIT"]').click();await frame.locator('#message').filter({hasText:'Estado actualizado'}).waitFor();
 assert.deepEqual(calls.filter(call=>call.action==='transition').map(call=>call.body),[{id:7,version:2,transition:'SUBMIT'}]);assert.equal(calls.filter(call=>call.action==='save').length,1);assert.equal(calls.some(call=>call.action==='execute'),false);
});

test('guardado pendiente bloquea buscadores y doble submit; error del servidor restaura selección sin reintentar',{timeout:30000},async t=>{
 const gate=deferred();t.after(()=>gate.resolve());const{frame,calls}=await fixture(t,{saveGate:gate,saveStatus:409});await newOther(frame);await completeLine(frame);
 await frame.locator('#save').click();await frame.waitForFunction(()=>document.querySelector('#save').disabled&&[...document.querySelectorAll('#directLines .request-smart-input')].every(input=>input.disabled));
 assert.equal(await picker(frame,'Cuenta').isDisabled(),true);assert.equal(await picker(frame,'Tercero').isDisabled(),true);assert.equal(await row(frame).locator('.entityType').isDisabled(),true);
 await picker(frame,'Cuenta').evaluate(input=>{input.value='No debe reemplazar';input.dispatchEvent(new Event('input',{bubbles:true}));});
 await frame.locator('#requestForm').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 assert.equal(calls.filter(call=>call.action==='save').length,1);assert.equal(await row(frame).locator('.account').inputValue(),'203');assert.equal(await picker(frame,'Cuenta').inputValue(),accountLabels[203]);assert.equal(await frame.locator('.request-smart-popup').count(),0);
 gate.resolve();await frame.locator('#message').filter({hasText:'Synthetic request changed'}).waitFor();
 assert.equal(await picker(frame,'Cuenta').isDisabled(),false);assert.equal(await picker(frame,'Tercero').isDisabled(),false);await choose(frame,'Cuenta','610002',accountLabels[205]);assert.equal(await row(frame).locator('.account').inputValue(),'205');assert.equal(calls.filter(call=>call.action==='save').length,1);
});

test('CxP deshabilita imputaciones ocultas y permite guardar con validación nativa sin enviar IDs de Otros Pagos',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t);await newOther(frame);await picker(frame,'Cuenta').fill('Búsqueda incompleta');await frame.locator('#type').selectOption('CXP');
 assert.equal(await frame.locator('.request-smart-popup').count(),0);assert.equal(await frame.locator('#otherSection input,#otherSection select,#otherSection button').evaluateAll(controls=>controls.every(control=>control.disabled)),true);
 await frame.locator('#supplierSearch').fill('Álvarez Servicios');await frame.locator('#supplierSearch').press('Tab');await frame.locator('#invoices tr[data-id="91"]').waitFor();await frame.locator('#invoices input[type="checkbox"]').check();await frame.locator('#invoices .payAmount').fill('25.123456');
 assert.equal(await frame.locator('#requestForm').evaluate(form=>form.checkValidity()),true);await frame.locator('#save').click();await frame.locator('#message').filter({hasText:'Borrador y archivos'}).waitFor();
 const saved=calls.find(call=>call.action==='save').body;assert.equal(saved.type,'CXP');assert.equal(saved.supplierId,10);assert.deepEqual(saved.lines,[{invoiceId:'91',amount:'25.123456'}]);assert.equal(calls.filter(call=>call.action==='save').length,1);assert.equal(calls.some(call=>call.action==='execute'),false);
});

test('consulta de solo lectura conserva referencias y mantiene buscadores deshabilitados sin acciones de guardado',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t,{access:{canCreate:false,canEdit:false},initial:{header:{estado:'APROBADO'}}});assert.equal(await frame.locator('#new').isHidden(),true);await frame.locator('[data-open="7"]').click();await frame.locator('#savedDetail').waitFor({state:'visible'});
 assert.equal(await frame.locator('#requestForm').isHidden(),true);assert.equal(await frame.locator('#save').isHidden(),true);assert.equal(await frame.locator('#directLines .request-smart-input').evaluateAll(inputs=>inputs.length===2&&inputs.every(input=>input.disabled)),true);
 assert.equal(await row(frame).locator('.account').inputValue(),'203');assert.equal(await row(frame).locator('.entity').inputValue(),'10');assert.equal(await frame.locator('.request-smart-popup').count(),0);assert.equal(writes(calls).length,0);
});

test('resultados se limitan a80 sin llamadas adicionales y etiquetas hostiles se muestran como texto',{timeout:30000},async t=>{
 const hostile='<img src=x onerror="window.searchXss=true"> & Cuenta literal',accounts=[...Array.from({length:100},(_,index)=>({id:index+1000,name:`700${String(index).padStart(3,'0')} · Cuenta sintética ${index}`})),{id:900,name:hostile}];
 const{frame,calls}=await fixture(t,{options:{accounts}});await newOther(frame);await picker(frame,'Cuenta').click();assert.equal(await frame.locator('.request-smart-option').count(),80);assert.match(await frame.locator('.request-smart-notice').innerText(),/80 de 101/);
 await picker(frame,'Cuenta').fill('<img');assert.deepEqual(await frame.locator('.request-smart-option').allTextContents(),[hostile]);assert.equal(await frame.locator('.request-smart-popup img,.request-smart-popup script').count(),0);assert.equal(await frame.evaluate(()=>window.searchXss),undefined);
 await frame.getByRole('option',{name:hostile,exact:true}).click();assert.equal(await row(frame).locator('.account').inputValue(),'900');assert.equal(calls.filter(call=>call.action==='options').length,1);assert.equal(writes(calls).length,0);
});

test('sync del componente acepta opciones nuevas idénticas en el mismo select y conserva el ID elegido',{timeout:30000},async t=>{
 const{frame}=await fixture(t);
 await frame.evaluate(async()=>{const{enhancePaymentRequestSelect}=await import('/payment-request-search.js?v=20261105-payment-request-search');const select=document.createElement('select');select.className='account';select.innerHTML='<option value="">Seleccione</option><option value="81">Cuenta de prueba</option>';document.body.append(select);const control=enhancePaymentRequestSelect(select,{label:'Cuenta de prueba'});select.innerHTML=select.innerHTML;control.sync();window.__cacheSelect=select;window.__cachePicker=control;window.__cacheChanges=0;select.addEventListener('change',()=>window.__cacheChanges++);});
 const input=frame.getByRole('combobox',{name:'Cuenta de prueba',exact:true});await input.fill('prueba');await frame.getByRole('option',{name:'Cuenta de prueba',exact:true}).click();
 assert.deepEqual(await frame.evaluate(()=>({id:window.__cacheSelect.value,changes:window.__cacheChanges,live:window.__cacheSelect.contains(window.__cacheSelect.selectedOptions[0])})),{id:'81',changes:1,live:true});await frame.evaluate(()=>window.__cachePicker.destroy());
});

for(const width of [1536,390])test(`visual ${width}: Cuenta/Tercero muestran popup fuera de la tabla con contraste y límites de pantalla`,{timeout:30000},async t=>{
 const{page,frame}=await fixture(t,{width});await newOther(frame);
 const artifacts=resolve('..','payment-request-search-qa-20261105');
 for(const kind of ['Cuenta','Tercero']){
  if(kind==='Tercero'){await choose(frame,'Cuenta','118002',accountLabels[203]);await row(frame).locator('.entityType').selectOption('Proveedor');}
  await picker(frame,kind).scrollIntoViewIfNeeded();await picker(frame,kind).click();await picker(frame,kind).fill(kind==='Cuenta'?'gasto':'al');await picker(frame,kind).press('ArrowDown');
  const popup=frame.locator('.request-smart-popup');await popup.waitFor({state:'visible'});
  const metrics=await popup.evaluate(element=>{const box=element.getBoundingClientRect(),active=element.querySelector('.is-active'),style=getComputedStyle(active),luminance=value=>value.match(/[\d.]+/g).slice(0,3).map(Number).map(channel=>channel/255).map(channel=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4).reduce((sum,channel,index)=>sum+channel*[.2126,.7152,.0722][index],0),a=luminance(style.color),b=luminance(style.backgroundColor);return{parentIsBody:element.parentElement===document.body,x:box.x,y:box.y,right:box.right,bottom:box.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
  assert.equal(metrics.parentIsBody,true);assert.ok(metrics.x>=0&&metrics.right<=metrics.viewportWidth+1&&metrics.y>=0&&metrics.bottom<=metrics.viewportHeight+1,JSON.stringify(metrics));assert.ok(metrics.contrast>=4.5,JSON.stringify(metrics));
  const layout=await frame.evaluate(()=>{const form=document.querySelector('#requestForm'),fieldset=document.querySelector('#editable'),editor=document.querySelector('#editor'),table=document.querySelector('#otherSection .table-scroll');return{formWidth:form.clientWidth,fieldsetWidth:fieldset.getBoundingClientRect().width,editorScroll:editor.scrollLeft,editorWidth:editor.clientWidth,editorContentWidth:editor.scrollWidth,tableWidth:table.clientWidth,tableContentWidth:table.scrollWidth};});
  assert.ok(layout.fieldsetWidth<=layout.formWidth+1,'El detalle no debe ensanchar todo el formulario: '+JSON.stringify(layout));assert.equal(layout.editorScroll,0,'Buscar un tercero debe desplazar la tabla, sin mover toda la solicitud');assert.ok(layout.editorContentWidth<=layout.editorWidth+1,'El documento no debe desbordarse por el detalle');
  t.diagnostic(JSON.stringify({kind,width,popup:metrics,input:await picker(frame,kind).evaluate(input=>{const box=input.getBoundingClientRect(),table=input.closest('.table-scroll');return{x:box.x,right:box.right,width:box.width,pageWidth:document.documentElement.scrollWidth,tableWidth:table?.clientWidth,tableScroll:table?.scrollLeft};})}));
  if(process.env.PAYMENT_REQUEST_SEARCH_CAPTURE==='1'){await mkdir(artifacts,{recursive:true});await page.screenshot({path:resolve(artifacts,`${kind==='Cuenta'?'account':'party'}-${width}.png`),fullPage:true});}
  await picker(frame,kind).press('Escape');
 }
});
