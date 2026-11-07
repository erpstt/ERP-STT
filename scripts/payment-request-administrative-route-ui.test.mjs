import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

// Actual browser modules, production theme/branding and same-origin iframe.
// Every API is intercepted with synthetic data; no financial backend is started.
const server=await readFile('src/server.ts','utf8');
const branding=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/);
const renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal,'The production HTML injection must be represented');
function served(raw){const[,guard,assets]=branding,branded=raw.replace('</head>',assets+'</head>'),guarded=branded.replace('<head>','<head>'+guard);return guarded.replace(/<head\b[^>]*>/i,head=>head+renewal[1]);}
const missingApproverMessage='Configure un Aprobador Administrativo activo y autorizado en la subsidiaria antes de enviar la solicitud a aprobación.';
const syntheticHeader=()=>({id:7,numero:'SOL-SYN-7',estado:'BORRADOR',id_solicitante:1,tipo_solicitud:'CXP',id_proveedor:10,id_moneda:1,fecha_solicitud:'2026-11-07',fecha_pago_programada:'2026-11-10',concepto:'Solicitud sintética',total:50,version:4,moneda:'CRC',solicitante:'Solicitante sintético'});
const requestOptions={company:'Subsidiaria sintética',userId:1,admin:false,baseCurrencyId:1,currencies:[{id:1,name:'CRC'}],users:[{id:1,name:'Solicitante sintético'},{id:42,name:'Aprobadora administrativa sintética'}],suppliers:[{id:10,name:'Proveedor sintético'}],accounts:[],customers:[],employees:[],otherNames:[],taxAgencies:[],departments:[],costCenters:[],banks:[],rates:[],beneficiaryBankAccounts:[]};
const invoiceLine={id_factura_proveedor:91,invoiceNumber:'FAC-SYN-91',invoiceDate:'2026-11-01',invoiceDueDate:'2026-11-30',invoiceTotal:100,monto:50};
const workflowOptions={access:{canCreate:true},entityTypes:[{id:'PAYMENT_REQUEST',name:'Solicitudes de pago'},{id:'PURCHASE_ORDER',name:'Órdenes de compra'}],roles:[{id:2,name:'Rol sintético'}],users:requestOptions.users,departments:[],costCenters:[]};
const historicalWorkflow={id:3,nombre:'Flujo histórico sintético',entity_type:'PAYMENT_REQUEST',estado_activo:true,hasHistory:true,revision:'synthetic-revision',actions:{canEdit:true,canDelete:false},rules:[{nombre_nivel:'Nivel histórico',usuario_aprobador_id:42,politica:'CUALQUIERA',tipo_desembolso:'CXP'}]};

async function fixture(t,{width=1536,screen='request',state='BORRADOR',missingApprover=false}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),calls=[],unexpected=[],errors=[];
 const header={...syntheticHeader(),estado:state,...(state==='PENDIENTE_APROBACION'?{approval_route_source:'ADMINISTRATIVE',assigned_approver_id:42}:{})};
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-cxp-route-token');localStorage.setItem('nexo_device_token','synthetic-cxp-route-device');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');});
 const target=screen==='request'?'/payment-requests.html':'/approval-workflows.html';
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname===target){await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public'+target,'utf8'))});return;}
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  if(url.pathname.startsWith('/api/audit/')){await route.fulfill({json:{events:[]}});return;}
  const action=url.pathname.split('/').at(-1),body=request.method()==='POST'?request.postDataJSON():{},call={path:url.pathname,action,method:request.method(),body};calls.push(call);let json;
  if(url.pathname.startsWith('/api/treasury/payment-requests/')){
   if(action==='access')json={canView:true,canCreate:true,canEdit:true,canDelete:false};
   else if(action==='options')json=requestOptions;
   else if(action==='report')json=[header];
   else if(action==='supports')json=[];
   else if(action==='detail')json={header,lines:[invoiceLine],events:[],beneficiaryBankAccounts:[],actions:{canEdit:state==='BORRADOR',canSubmit:state==='BORRADOR',canApprove:state==='PENDIENTE_APROBACION',canExecute:false,canCancel:false}};
   else if(action==='invoices')json=[{id:91,number:'FAC-SYN-91',date:'2026-11-01',dueDate:'2026-11-30',total:100,balance:100,reserved:0,available:100}];
   else if(action==='transition'&&missingApprover){await route.fulfill({status:409,json:{error:{status:409,message:missingApproverMessage}}});return;}
  }else if(url.pathname.startsWith('/api/approval-engine/')){
   if(action==='options')json=workflowOptions;
   else if(action==='workflows')json=[historicalWorkflow];
  }
  if(json===undefined){unexpected.push(request.method()+' '+url.pathname);await route.fulfill({status:501,json:{error:{message:'Unmocked API blocked'}}});return;}
  await route.fulfill({json});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+target+'"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();
 if(screen==='request')await frame.waitForFunction(()=>document.getElementById('company')?.textContent==='Subsidiaria sintética'&&!document.getElementById('new').disabled);
 else await frame.locator('[data-edit="3"]').waitFor();
 assert.equal(await frame.locator('html').evaluate(element=>element.classList.contains('inside-erp-workspace')),true);
 assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});
 return{page,frame,calls,header};
}
const writes=calls=>calls.filter(call=>!['access','options','report','supports','detail','invoices','workflows'].includes(call.action));
async function capture(page,name){if(process.env.CXP_ADMINISTRATIVE_ROUTE_CAPTURE!=='1')return;const directory=resolve('..','cxp-administrative-approval-ui-qa-20261107');await mkdir(directory,{recursive:true});await page.screenshot({path:resolve(directory,name),fullPage:true});}

for(const width of[1536,390])test(`CxP ${width}: explica aprobador por subsidiaria sólo para CxP sin modificar ni enviar decisiones`,{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t,{width});await frame.locator('#new').click();await frame.locator('#type').selectOption('CXP');
 const help=frame.locator('#cxpApprovalHelp');assert.equal(await help.isVisible(),true);assert.match(await help.innerText(),/Aprobador Administrativo de la subsidiaria/);assert.match(await help.innerText(),/permanece en borrador/);assert.equal(await help.locator('input,select,button').count(),0);
 const box=await help.boundingBox();assert.ok(box.width>100&&box.width<=width);assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await help.scrollIntoViewIfNeeded();await capture(page,`cxp-help-${width}.png`);
 await frame.locator('#type').selectOption('OTROS');assert.equal(await help.isVisible(),false);assert.deepEqual(writes(calls),[]);
});

test('CxP ADMINISTRATIVE muestra el usuario asignado por backend y no permite ejecutar el pago',{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t,{state:'PENDIENTE_APROBACION'});await frame.locator('[data-open="7"]').click();await frame.locator('#detailUpApproverCard').waitFor();
 assert.equal(await frame.locator('#detailApprovalTitle').innerText(),'APROBACIÓN ADMINISTRATIVA');assert.equal(await frame.locator('#detailUpApprover').innerText(),'Aprobadora administrativa sintética');assert.equal(await frame.locator('#detailUpSource').innerText(),'Aprobador Administrativo de la subsidiaria');
 assert.equal(await frame.locator('[data-transition="APPROVE"]').isVisible(),true);assert.equal(await frame.locator('[data-transition="EXECUTE"]').count(),0);assert.equal(await frame.locator('#save').isVisible(),false);assert.deepEqual(writes(calls),[]);await capture(page,'cxp-assigned-administrative-desktop.png');
});

test('CxP sin aprobador: error público deja el borrador sin aprobar, ejecutar, recargar ni reintentar automáticamente',{timeout:30000},async t=>{
 const{frame,calls,header}=await fixture(t,{missingApprover:true});await frame.locator('[data-open="7"]').click();await frame.locator('[data-transition="SUBMIT"]').click();await frame.locator('#message').filter({hasText:missingApproverMessage}).waitFor();await frame.waitForFunction(()=>!document.querySelector('[data-transition="SUBMIT"]').disabled);
 assert.equal(await frame.locator('#message').innerText(),missingApproverMessage);assert.match(await frame.locator('#title').innerText(),/BORRADOR/);assert.equal(header.estado,'BORRADOR');assert.equal(header.version,4);assert.equal(await frame.locator('[data-transition="SUBMIT"]').isEnabled(),true);assert.equal(await frame.locator('[data-transition="APPROVE"],[data-transition="EXECUTE"]').count(),0);
 await frame.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));assert.deepEqual(writes(calls).map(call=>call.body),[{id:7,version:4,transition:'SUBMIT'}]);assert.equal(calls.filter(call=>call.action==='detail').length,1);
});

test('Workflow: aviso CxP sólo para PAYMENT_REQUEST, mantiene campos y no guarda al cambiar entidad',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t,{screen:'workflow'});await frame.locator('#new').click();const notice=frame.locator('#paymentRequestRouteNotice');assert.equal(await notice.isVisible(),false);await frame.locator('#entity').selectOption('PAYMENT_REQUEST');assert.equal(await notice.isVisible(),true);assert.match(await notice.innerText(),/reglas de esta pantalla no sustituyen/);assert.match(await notice.innerText(),/flujos ya iniciados conservan su ruta e historial/);
 assert.equal(await frame.locator('[data-k="approverType"]').isEnabled(),true);assert.equal(await frame.locator('[data-k="paymentType"] option[value="CXP"]').count(),1);await frame.locator('#entity').selectOption('PURCHASE_ORDER');assert.equal(await notice.isVisible(),false);assert.deepEqual(writes(calls),[]);
});

test('Workflow histórico PAYMENT_REQUEST: muestra aviso y conserva entidad bloqueada y nivel existente',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t,{screen:'workflow'});await frame.locator('[data-edit="3"]').click();assert.equal(await frame.locator('#paymentRequestRouteNotice').isVisible(),true);assert.equal(await frame.locator('#entity').isDisabled(),true);assert.equal(await frame.locator('#entity').inputValue(),'PAYMENT_REQUEST');assert.equal(await frame.locator('[data-k="name"]').inputValue(),'Nivel histórico');assert.equal(await frame.locator('[data-k="userId"]').inputValue(),'42');assert.equal(await frame.locator('[data-k="paymentType"]').inputValue(),'CXP');assert.deepEqual(writes(calls),[]);
});
