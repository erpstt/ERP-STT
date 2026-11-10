import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

// Serve the real UI inside the ERP workspace, with synthetic APIs only.
// No application backend, financial database, real session, or email is used.
const serverSource=await readFile('src/server.ts','utf8');
const branding=serverSource.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/);
const renewal=serverSource.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal,'Represent the production workspace assets');
function served(raw){
 const [,guard,assets]=branding;
 return raw.replace('</head>',assets+'</head>').replace('<head>','<head>'+guard).replace(/<head\b[^>]*>/i,head=>head+renewal[1]);
}

const company='Subsidiaria <img src=x onerror="window.inventoryInjected=true"> & equipo';
const entityTypes=[
 {id:'PURCHASE_ORDER',name:'Órdenes de compra'},
 {id:'SALES_ORDER',name:'Órdenes de venta'},
 {id:'PAYMENT_REQUEST',name:'Solicitudes de pago'},
 {id:'BUDGET_TRANSFER',name:'Modificaciones presupuestarias'}
];
function workflow(id,entityType,{active=true,write=true,name=`Flujo sintético ${id}`}={}){
 return {id,nombre:name,entity_type:entityType,estado_activo:active,revision:`synthetic-revision-${id}`,hasHistory:true,
  actions:{canEdit:write,canDelete:write},
  rules:[{nombre_nivel:'Aprobación sintética',usuario_aprobador_id:42,politica:'CUALQUIERA'}]};
}
async function fixture(t,{write=true,deny=false,width=1536,workflows}={}){
 const {page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000});
 const calls=[],unexpected=[],errors=[];
 const rows=workflows??[workflow(7,'PURCHASE_ORDER',{write}),workflow(8,'SALES_ORDER',{active:false,write})];
 const options={company,isAdmin:true,access:{canView:true,canCreate:write,canEdit:write,canDelete:write},entityTypes,
  roles:[{id:2,name:'Rol sintético'}],users:[{id:42,name:'Aprobadora sintética'}],departments:[],costCenters:[]};
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  localStorage.setItem('nexo_token','synthetic-inventory-token');
  localStorage.setItem('nexo_device_token','synthetic-inventory-device');
  localStorage.setItem('nexo_company','1');
  localStorage.setItem('nexo_role','2');
 });
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/approval-workflows.html'){
   await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/approval-workflows.html','utf8'))});return;
  }
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  if(url.pathname.startsWith('/api/audit/')){await route.fulfill({json:{events:[]}});return;}
  const action=url.pathname.split('/').at(-1);
  calls.push({action,method:request.method(),body:request.method()==='POST'?request.postDataJSON():null});
  if(url.pathname.startsWith('/api/approval-engine/')&&['options','workflows'].includes(action)){
   if(deny){await route.fulfill({status:403,json:{error:{message:'Inventario protegido.'}}});return;}
   await route.fulfill({json:action==='options'?options:rows});return;
  }
  unexpected.push(request.method()+' '+url.pathname);
  await route.fulfill({status:501,json:{error:{message:'Synthetic fixture blocked an unexpected API'}}});
 });
 await page.goto(baseURL);
 await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/approval-workflows.html"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();
 if(deny)await frame.locator('#message').filter({hasText:'Inventario protegido.'}).waitFor();
 else await frame.locator('#inventory [data-inventory-id]').first().waitFor();
 t.after(()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});
 return {page,frame,calls};
}
const inventoryRows=frame=>frame.locator('#inventory [data-inventory-id]');
const rowNamed=(frame,name)=>inventoryRows(frame).filter({hasText:name});
const writes=calls=>calls.filter(call=>call.method!=='GET');
async function capture(page,frame,name){
 if(process.env.APPROVAL_INVENTORY_CAPTURE!=='1')return;
 const directory=resolve('.local-tools/approval-inventory');
 await mkdir(directory,{recursive:true});
 const height=await frame.locator('main').evaluate(element=>element.scrollHeight);
 await page.locator('iframe').evaluate((element,value)=>element.style.height=value+'px',height);
 await page.screenshot({path:resolve(directory,name),fullPage:true});
 await page.locator('iframe').evaluate(element=>element.style.height='100vh');
}

test('inventario muestra nueve transacciones, empresa escapada y cobertura activa, inactiva y ausente',async t=>{
 const {page,frame,calls}=await fixture(t);
 assert.equal(await inventoryRows(frame).count(),9);
 assert.deepEqual((await inventoryRows(frame).evaluateAll(rows=>rows.map(row=>row.dataset.inventoryId))).sort(),[
  'PURCHASE_ORDER','SALES_ORDER','BUDGET_TRANSFER','PAYMENT_REQUEST_CXP','PAYMENT_REQUEST_OTROS',
  'BUDGET_APPROVAL','BUDGET_OVERRIDE','QUADRATIC_RECONCILIATION','EXPENSE_APPROVAL'
 ].sort());
 assert.match(await frame.locator('#inventoryCompany').innerText(),/Subsidiaria <img src=x/);
 assert.equal(await frame.locator('#inventoryCompany img').count(),0);
 assert.equal(await frame.evaluate(()=>window.inventoryInjected),undefined);
 assert.equal(await rowNamed(frame,/órdenes de compra/i).getAttribute('data-state'),'active');
 assert.equal(await rowNamed(frame,/órdenes de venta/i).getAttribute('data-state'),'inactive');
 assert.equal(await rowNamed(frame,/modificaciones presupuestarias/i).getAttribute('data-state'),'missing');
 for(const id of ['PAYMENT_REQUEST_CXP','PAYMENT_REQUEST_OTROS'])assert.equal(await frame.locator(`[data-inventory-id="${id}"]`).getAttribute('data-state'),'automatic');
 for(const id of ['BUDGET_APPROVAL','BUDGET_OVERRIDE','QUADRATIC_RECONCILIATION'])assert.equal(await frame.locator(`[data-inventory-id="${id}"]`).getAttribute('data-state'),'module');
 assert.equal(await frame.locator('[data-inventory-id="EXPENSE_APPROVAL"]').getAttribute('data-state'),'manual');
 assert.ok((await frame.locator('#inventorySummary').innerText()).trim().length>0);
 assert.deepEqual(calls.map(call=>call.action),['options','workflows']);
 assert.deepEqual(writes(calls),[]);
 await capture(page,frame,'desktop.png');
});

test('CxP describe la ruta administrativa sin afirmar que verificó la configuración de la empresa',async t=>{
 const {frame,calls}=await fixture(t);
 const row=frame.locator('[data-inventory-id="PAYMENT_REQUEST_CXP"]'),text=await row.innerText();
 assert.equal(await row.count(),1);
 assert.equal(await row.getAttribute('data-state'),'automatic');
 assert.match(text,/Aprobador Administrativo/i);
 assert.match(text,/valid|verific|configuraci[oó]n/i);
 assert.doesNotMatch(text,/configuraci[oó]n (?:verificada|validada|correcta)|aprobador (?:verificado|validado)/i);
 assert.equal(await row.locator('[data-inventory-create],[data-inventory-edit]').count(),0);
 assert.deepEqual(writes(calls),[]);
});

test('un flujo activo sin niveles se identifica como incompleto en lugar de cobertura válida',async t=>{
 const incomplete={...workflow(21,'PURCHASE_ORDER'),rules:[]};
 const {frame,calls}=await fixture(t,{workflows:[incomplete]});
 const row=frame.locator('[data-inventory-id="PURCHASE_ORDER"]');
 assert.equal(await row.getAttribute('data-state'),'incomplete');
 assert.equal(await row.locator('[data-inventory-edit="21"]').count(),1);
 assert.deepEqual(writes(calls),[]);
});

test('crear desde una transacción preselecciona su tipo y editar conserva el flujo y su historial',async t=>{
 const {frame,calls}=await fixture(t,{workflows:[workflow(17,'SALES_ORDER')]});
 await frame.locator('[data-inventory-create="PURCHASE_ORDER"]').click();
 assert.equal(await frame.locator('#editor').isVisible(),true);
 assert.equal(await frame.locator('#entity').inputValue(),'PURCHASE_ORDER');
 assert.equal(await frame.locator('#entity').isEnabled(),true);
 assert.equal(await frame.locator('#name').inputValue(),'');
 await frame.locator('#cancel').click();
 await frame.locator('[data-inventory-edit="17"]').click();
 assert.equal(await frame.locator('#editor').isVisible(),true);
 assert.equal(await frame.locator('#entity').inputValue(),'SALES_ORDER');
 assert.equal(await frame.locator('#entity').isDisabled(),true);
 assert.equal(await frame.locator('#name').inputValue(),'Flujo sintético 17');
 assert.equal(await frame.locator('[data-k="userId"]').inputValue(),'42');
 assert.deepEqual(writes(calls),[]);
});

test('lectura muestra inventario completo sin controles de escritura aunque isAdmin sea true',async t=>{
 const {frame,calls}=await fixture(t,{write:false});
 assert.equal(await inventoryRows(frame).count(),9);
 assert.equal(await frame.locator('#new').isHidden(),true);
 assert.equal(await frame.locator('[data-inventory-create],[data-inventory-edit],[data-edit],[data-delete]').count(),0);
 assert.equal(await frame.locator('#editor').isHidden(),true);
 assert.deepEqual(writes(calls),[]);
});

test('acceso denegado bloquea inventario y no consulta flujos ni crea acciones',async t=>{
 const {frame,calls}=await fixture(t,{deny:true});
 assert.equal(await inventoryRows(frame).count(),0);
 assert.equal(await frame.locator('#new').isDisabled(),true);
 assert.equal(await frame.locator('#editor').isHidden(),true);
 assert.equal(await frame.locator('[data-inventory-create],[data-inventory-edit]').count(),0);
 assert.deepEqual(calls.map(call=>call.action),['options']);
 assert.deepEqual(writes(calls),[]);
});

test('inventario y editor caben en el espacio móvil sin desbordamiento horizontal',async t=>{
 const {page,frame,calls}=await fixture(t,{width:390,workflows:[]});
 assert.equal(await inventoryRows(frame).count(),9);
 assert.equal(await frame.locator('html').evaluate(element=>element.classList.contains('inside-erp-workspace')),true);
 assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 await capture(page,frame,'mobile.png');
 await frame.locator('[data-inventory-create="PURCHASE_ORDER"]').click();
 assert.equal(await frame.locator('#entity').inputValue(),'PURCHASE_ORDER');
 assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 assert.deepEqual(writes(calls),[]);
});
