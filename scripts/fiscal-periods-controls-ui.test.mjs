import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
import {vueArtifacts} from './build-vue-templates.mjs';

const artifacts=await vueArtifacts(),server=await readFile('src/server.ts','utf8');
const renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);assert.ok(renewal);
const controls=['checklist_completed','ap_closed','ar_closed','gl_closed','is_closed','is_inactive'];
const switchField=(page,key)=>page.locator(`.modal [data-field-key="${key}"] input[role="switch"]`);
const field=(page,key)=>page.locator(`.modal [data-field-key="${key}"] input`).first();
const initialRows=[6,7,8,10,11,12].map((month,index)=>({fiscal_period_id:31+index,fiscal_year_id:9,period_name:['Junio','Julio','Agosto','Octubre','Noviembre','Diciembre'][index]+' sintético',subsidiary_id:1,start_date:`2028-${String(month).padStart(2,'0')}-01`,end_date:`2028-${String(month).padStart(2,'0')}-${new Date(Date.UTC(2028,month,0)).getUTCDate()}`,checklist_completed:false,ap_closed:month===11,ar_closed:month===11,gl_closed:month===11,is_closed:month===11,is_inactive:false,_revision:'syn-'+(31+index),_actions:{canEdit:true,canDelete:[6,7,12].includes(month),deleteBlockedReason:month===11?'CLOSED':[8,10].includes(month)?'REFERENCED':null}}));

async function fixture(t,{width=1536,manager=false,reader=false,configure=false}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),state={rows:structuredClone(initialRows),attempts:[],writes:[],manager,reader,configure,roleId:2,configRevision:'a'.repeat(32),permissionReads:0,optionsReads:0,permissionAttempts:[],permissionWrites:[],pendingSave:null,pendingOptions:null,pendingConfigRead:null,pendingConfigPost:null},errors=[],unexpected=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL)return route.fallback();
  if(url.pathname==='/index.html')return route.fulfill({contentType:'text/html; charset=utf-8',body:(await readFile('public/index.html','utf8')).replace('<head>','<head>'+renewal[1])});
  const generated=artifacts.get('public'+url.pathname);if(generated!==undefined)return route.fulfill({contentType:'text/javascript; charset=utf-8',body:generated});
  if(!url.pathname.startsWith('/api/'))return route.fallback();
  if(url.pathname==='/api/security/turnstile/config')return route.fulfill({json:{enabled:false}});
  if(url.pathname==='/api/organization/master/options'){
   state.optionsReads++;
   const data={canView:true,canCreate:!state.reader,canEdit:!state.reader,canDelete:!state.reader,canManageClosure:state.manager,canConfigureClosurePermission:state.configure,requiredClosurePermission:{code:'CONF_PERIODOS_FISCALES_CERRAR',label:'Cerrar y reabrir períodos fiscales'},closureBlockedReason:state.manager?null:'MISSING_CLOSURE_PERMISSION',references:{'organization/subsidiaries':[{subsidiary_id:1,name:'Empresa sintética'}],'organization/fiscal-years':[{fiscal_year_id:9,year_name:'Año sintético 2028',start_date:'2028-01-01',end_date:'2028-12-31',is_closed:false}]}};
   const pending=state.pendingOptions;state.pendingOptions=null;if(pending)await pending;return route.fulfill({json:data});
  }
  if(url.pathname==='/api/organization/fiscal-closure-permission'){
   const role={id:state.roleId,name:'Rol central sintético'};
   if(request.method()==='GET'){state.permissionReads++;const value=state.configure?{canConfigure:true,enabled:state.manager,revision:state.configRevision,role}:{canConfigure:false},pending=state.pendingConfigRead;state.pendingConfigRead=null;if(pending)await pending;return route.fulfill({json:value});}
   if(request.method()==='POST'){
    const payload=request.postDataJSON();state.permissionAttempts.push(payload);assert.deepEqual(Object.keys(payload).sort(),['enabled','revision']);assert.equal(typeof payload.enabled,'boolean');if(state.pendingConfigPost)await state.pendingConfigPost;
    if(!state.configure)return route.fulfill({status:403,json:{error:{message:'No autorizado para configurar el permiso del rol activo.'}}});
    if(payload.revision!==state.configRevision)return route.fulfill({status:409,json:{error:{message:'La configuración cambió. Consulte nuevamente el permiso.'}}});
    state.manager=payload.enabled;state.configRevision='b'.repeat(32);state.permissionWrites.push(payload);if(state.permissionResponseOverride)return route.fulfill(state.permissionResponseOverride);return route.fulfill({json:{canConfigure:true,enabled:state.manager,revision:state.configRevision,role}});
   }
  }
  if(url.pathname==='/api/organization/accounting-periods'&&request.method()==='GET')return route.fulfill({json:state.rows});
  if(/^\/api\/organization\/accounting-periods\/[1-9][0-9]*$/.test(url.pathname)&&request.method()==='PATCH'){
   const id=Number(url.pathname.split('/').at(-1)),payload=request.postDataJSON();state.attempts.push({id,payload});
   if(state.pendingSave)await state.pendingSave;
   const current=state.rows.find(row=>row.fiscal_period_id===id);assert.ok(current);
   if(state.reader||!state.manager&&controls.some(key=>Object.hasOwn(payload,key)))return route.fulfill({status:403,json:{error:{message:'Requiere permiso para gestionar el bloqueo y cierre de períodos fiscales.'}}});
   if(payload._revision!==current._revision)return route.fulfill({status:409,json:{error:{message:'El período cambió. Recargue antes de guardar.'}}});
   const saved={...current,...payload};
   if(saved.gl_closed&&(!saved.ap_closed||!saved.ar_closed))return route.fulfill({status:409,json:{error:{message:'Bloquee Compras/CxP y Ventas/CxC antes del Libro Mayor.'}}});
   if(saved.is_closed&&(!saved.ap_closed||!saved.ar_closed||!saved.gl_closed))return route.fulfill({status:409,json:{error:{message:'Bloquee los tres módulos antes de cerrar el período.'}}});
   if(saved.is_closed)saved.checklist_completed=true;saved._revision=current._revision+'-saved';state.rows[state.rows.indexOf(current)]=saved;state.writes.push({id,payload});return route.fulfill({json:saved});
  }
  if(url.pathname==='/api/audit/record-actor')return route.fulfill({json:{}});
  unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:501,json:{error:{message:'Unexpected synthetic request'}}});
 });
 await page.goto(baseURL+'/index.html');await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
 await page.evaluate(()=>{localStorage.setItem('nexo_token','synthetic-fiscal-token');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.authenticated=true;v.sessionReady=true;v.selectingCompany=false;v.selectingRole=false;v.activeCompany={subsidiaryId:1,name:'Empresa sintética'};v.activeRole={roleId:2,name:'Administrador sintético'};v.roleAccess={loaded:true,isAdmin:true,grants:{},modules:[]};v.closeWorkspace();v.currentModule='Organización';v.currentSection=v.catalogs.find(c=>c.slug==='accounting-periods').title;});
 const load=()=>page.evaluate(async()=>{await document.getElementById('app').__vue_app__._container._vnode.component.proxy.loadCatalog();});await load();
 const row=id=>page.locator('tbody tr').filter({has:page.locator('.id-cell').filter({hasText:new RegExp('^#'+id+'$')})});
 const edit=async id=>{await row(id).getByRole('button',{name:'Editar registro',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();};
 const save=()=>page.getByRole('button',{name:'Guardar cambios',exact:true}).click();
 assert.equal(await page.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);});return{page,state,load,row,edit,save};
}

test('administrador sin permiso de cierre conserva switches bloqueados y guarda sólo datos editables',{timeout:45000},async t=>{
 const{page,state,edit,save}=await fixture(t);await edit(33);for(const key of controls)await expect(switchField(page,key)).toBeDisabled();
 assert.equal(state.permissionReads,0);await expect(page.getByRole('button',{name:'Configurar permiso de cierre para mi rol',exact:true})).toHaveCount(0);
 assert.equal(state.attempts.length,0);await field(page,'period_name').fill('Agosto actualizado');await save();await expect(page.getByRole('dialog')).toHaveCount(0);
 assert.equal(state.writes.length,1);assert.equal(state.writes[0].id,33);assert.equal(state.writes[0].payload._revision,'syn-33');for(const key of controls)assert.equal(Object.hasOwn(state.writes[0].payload,key),false);
});

test('ayuda distingue revisión humana, permiso y Guardar; campos de cierre no se activan por ser administrador',{timeout:45000},async t=>{
 const{page,state,edit}=await fixture(t);await edit(33);
 await expect(page.locator('#fiscalPeriodPermissionHelp')).toContainText('permiso');await expect(page.locator('#fiscalPeriodControlsHelp')).toContainText('Guardar');
 await expect(page.locator('[data-field-key="checklist_completed"]')).toContainText('manual');await expect(page.locator('[data-field-key="checklist_completed"]')).toContainText('automáticas');
 for(const key of controls){const input=switchField(page,key);await expect(input).toBeDisabled();assert.ok(await input.getAttribute('aria-describedby'));}
 assert.equal(state.attempts.length,0);
});

test('gestor cambia bloqueos sin autosave, guarda una vez y checklist false no impide un cierre válido',{timeout:45000},async t=>{
 const{page,state,edit,save}=await fixture(t,{manager:true});await edit(33);
 for(const key of ['ap_closed','ar_closed','gl_closed','is_closed']){await expect(switchField(page,key)).toBeEnabled();await switchField(page,key).focus();await page.keyboard.press('Space');await expect(switchField(page,key)).toBeChecked();}
 await expect(switchField(page,'checklist_completed')).not.toBeChecked();assert.equal(state.attempts.length,0);
 let release;state.pendingSave=new Promise(resolve=>{release=resolve;});await save();await expect.poll(()=>state.attempts.length).toBe(1);for(const key of controls)await expect(switchField(page,key)).toBeDisabled();
 release();await expect(page.getByRole('dialog')).toHaveCount(0);assert.equal(state.writes.length,1);assert.equal(state.writes[0].payload.checklist_completed,false);assert.equal(state.rows.find(row=>row.fiscal_period_id===33).checklist_completed,true);assert.equal(state.rows.find(row=>row.fiscal_period_id===33).is_closed,true);
});

test('secuencia rechazada conserva formulario y error; el usuario corrige antes de guardar otra vez',{timeout:45000},async t=>{
 const{page,state,edit,save}=await fixture(t,{manager:true});await edit(34);await page.locator('label[for="fiscalPeriodInput-gl_closed"] .gentia-switch-track').click();await save();await expect(page.locator('.dialog-error')).toContainText('antes del Libro Mayor');
 await expect(page.getByRole('dialog')).toBeVisible();await expect(switchField(page,'gl_closed')).toBeChecked();assert.equal(state.writes.length,0);assert.equal(state.attempts.length,1);
 await page.locator('label[for="fiscalPeriodInput-ap_closed"] .gentia-switch-track').click();await page.locator('label[for="fiscalPeriodInput-ar_closed"]').click();await save();await expect(page.getByRole('dialog')).toHaveCount(0);assert.equal(state.attempts.length,2);assert.equal(state.writes.length,1);assert.equal(state.writes[0].id,34);
});

test('acciones usan razón del servidor e IDs reales, sin eliminar períodos con referencias ni cerrados',{timeout:45000},async t=>{
 const{page,state,row}=await fixture(t);await expect(row(31).getByRole('button',{name:/Eliminar/})).toHaveCount(1);await expect(row(33).getByRole('button',{name:/Eliminar/})).toHaveCount(0);await expect(row(33).locator('.fiscal-period-delete-reason')).toHaveText('Con referencias');await expect(row(35).locator('.fiscal-period-delete-reason')).toHaveText('Cerrado');
 await expect(row(33).getByRole('button',{name:'Autoría',exact:true})).toBeVisible();const positions=await Promise.all([31,33].map(id=>row(id).getByRole('button',{name:'Editar registro',exact:true}).boundingBox()));assert.ok(Math.abs(positions[0].x-positions[1].x)<1);
 await row(31).getByRole('button',{name:/Eliminar/}).click();assert.equal(await page.evaluate(()=>document.getElementById('app').__vue_app__._container._vnode.component.proxy.recordDialog.id),31);await page.getByRole('button',{name:'Cancelar',exact:true}).click();assert.equal(state.attempts.length,0);assert.equal(state.permissionAttempts.length,0);
});

for(const width of [1536,390])test(`tema real ${width}: controles legibles y configuración del permiso caben sin desbordar modal`,{timeout:45000},async t=>{
 const{page,state,edit}=await fixture(t,{width,configure:true});await edit(33);await page.locator('#fiscalPeriodControlsHelp').scrollIntoViewIfNeeded();
 const dimensions=await page.locator('.fiscal-period-modal').evaluate(element=>({modal:element.getBoundingClientRect().toJSON(),width:innerWidth,cards:[...element.querySelectorAll('.fiscal-period-control-card')].map(card=>card.getBoundingClientRect().toJSON())}));assert.ok(dimensions.modal.left>=0&&dimensions.modal.right<=width+1);assert.ok(dimensions.cards.every(card=>card.left>=dimensions.modal.left&&card.right<=dimensions.modal.right+1));
 if(process.env.FISCAL_PERIODS_CAPTURE==='1'){const dir=resolve('..','fiscal-periods-controls-qa-20261110');await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,`fiscal-period-${width}.png`),animations:'disabled'});}
 await page.getByRole('button',{name:'Cancelar',exact:true}).click();await page.getByRole('button',{name:'Configurar permiso de cierre para mi rol',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Configurar permiso de cierre para mi rol',exact:true});await expect(dialog.getByRole('switch')).toBeVisible();await expect(dialog).toContainText('todos los usuarios');
 const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1));
 if(process.env.FISCAL_PERIODS_CAPTURE==='1'){const dir=resolve('..','fiscal-periods-controls-qa-20261110');await page.screenshot({path:resolve(dir,`fiscal-permission-${width}.png`),animations:'disabled'});}
 assert.equal(state.attempts.length,0);assert.equal(state.permissionAttempts.length,0);
});

test('configuración exige cambio y confirmación; POST sólo enabled/revision y no cambia flags de períodos',{timeout:45000},async t=>{
 const{page,state,edit}=await fixture(t,{configure:true}),original=structuredClone(state.rows);assert.equal(state.permissionAttempts.length,0);
 await page.getByRole('button',{name:'Configurar permiso de cierre para mi rol',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Configurar permiso de cierre para mi rol',exact:true});await expect(dialog.getByRole('switch')).not.toBeChecked();await expect(dialog.getByRole('button',{name:'Guardar permiso',exact:true})).toBeDisabled();
 await dialog.getByRole('switch').focus();await page.keyboard.press('Space');await expect(dialog.getByRole('button',{name:'Guardar permiso',exact:true})).toBeEnabled();
 let release;state.pendingConfigPost=new Promise(resolve=>{release=resolve;});await dialog.getByRole('button',{name:'Guardar permiso',exact:true}).dblclick();await expect.poll(()=>state.permissionAttempts.length).toBe(1);await expect(dialog.getByRole('switch')).toBeDisabled();await expect(dialog.getByRole('button',{name:'Guardando permiso…',exact:true})).toBeDisabled();release();await expect(dialog).toHaveCount(0);
 assert.deepEqual(state.permissionWrites,[{enabled:true,revision:'a'.repeat(32)}]);assert.deepEqual(state.rows,original);assert.equal(state.attempts.length,0);await edit(33);await expect(switchField(page,'ap_closed')).toBeEnabled();
});

test('cancelar y Escape no asignan el permiso y devuelven foco al botón',{timeout:45000},async t=>{
 const{page,state}=await fixture(t,{configure:true}),button=page.getByRole('button',{name:'Configurar permiso de cierre para mi rol',exact:true});
 for(const cancel of ['button','escape']){await button.click();const dialog=page.getByRole('dialog',{name:'Configurar permiso de cierre para mi rol',exact:true});await expect(dialog.getByRole('switch')).toBeVisible();await dialog.locator('label[for="fiscalPermissionEnabled"] .gentia-switch-track').click();await expect(dialog.getByRole('switch')).toBeChecked();if(cancel==='button')await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();else await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(button).toBeFocused();}
 assert.equal(state.permissionAttempts.length,0);
});

test('revisión obsoleta exige GET explícito y no repite el POST automáticamente',{timeout:45000},async t=>{
 const{page,state}=await fixture(t,{configure:true});await page.getByRole('button',{name:'Configurar permiso de cierre para mi rol',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Configurar permiso de cierre para mi rol',exact:true});await expect(dialog.getByRole('switch')).toBeVisible();await dialog.locator('label[for="fiscalPermissionEnabled"]').click();await expect(dialog.getByRole('switch')).toBeChecked();state.configRevision='c'.repeat(32);await dialog.getByRole('button',{name:'Guardar permiso',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('configuración cambió');await expect(dialog.getByRole('button',{name:'Guardar permiso',exact:true})).toBeDisabled();assert.equal(state.permissionAttempts.length,1);assert.equal(state.permissionWrites.length,0);
 await dialog.getByRole('button',{name:'Consultar estado del permiso',exact:true}).click();await expect(dialog.getByRole('switch')).not.toBeChecked();assert.equal(state.permissionAttempts.length,1);
});

test('cambio de rol descarta GET de permiso y respuesta tardía de opciones sin reactivar controles',{timeout:45000},async t=>{
 const{page,state,load,edit}=await fixture(t,{configure:true});let releaseRead;state.pendingConfigRead=new Promise(resolve=>{releaseRead=resolve;});await page.getByRole('button',{name:'Configurar permiso de cierre para mi rol',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect.poll(()=>state.permissionReads).toBe(1);
 await page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.activeRole={roleId:3,name:'Otro rol sintético'};localStorage.setItem('nexo_role','3');});await expect(page.getByRole('dialog')).toHaveCount(0);releaseRead();await expect(page.getByRole('button',{name:'Configurar permiso de cierre para mi rol',exact:true})).toHaveCount(0);assert.equal(state.permissionAttempts.length,0);
 state.configure=false;state.manager=true;const oldReads=state.optionsReads;let releaseOptions;state.pendingOptions=new Promise(resolve=>{releaseOptions=resolve;});await page.evaluate(()=>{void document.getElementById('app').__vue_app__._container._vnode.component.proxy.loadCatalog();});await expect.poll(()=>state.optionsReads).toBe(oldReads+1);state.manager=false;await load();releaseOptions();await edit(33);await expect(switchField(page,'ap_closed')).toBeDisabled();
 const other=await fixture(t,{configure:true});let releasePost;other.state.pendingConfigPost=new Promise(resolve=>{releasePost=resolve;});await other.page.getByRole('button',{name:'Configurar permiso de cierre para mi rol',exact:true}).click();const dialog=other.page.getByRole('dialog',{name:'Configurar permiso de cierre para mi rol',exact:true});await expect(dialog.getByRole('switch')).toBeVisible();await dialog.getByRole('switch').focus();await other.page.keyboard.press('Space');await dialog.getByRole('button',{name:'Guardar permiso',exact:true}).click();await expect.poll(()=>other.state.permissionAttempts.length).toBe(1);
 await other.page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.activeCompany={subsidiaryId:2,name:'Otra empresa sintética'};localStorage.setItem('nexo_company','2');});await expect(dialog).toHaveCount(0);releasePost();await expect(other.page.getByRole('button',{name:'Configurar permiso de cierre para mi rol',exact:true})).toHaveCount(0);await expect.poll(()=>other.state.permissionWrites.length).toBe(1);assert.equal(other.state.attempts.length,0);assert.equal(await other.page.evaluate(()=>document.getElementById('app').__vue_app__._container._vnode.component.proxy.tableNotice.includes('Permiso de cierre actualizado')),false);
});

test('respuesta incierta tras guardar exige consulta explícita y nunca repite la asignación',{timeout:45000},async t=>{
 for(const response of [{status:503,json:{error:{message:'Respuesta interrumpida; consulte el permiso actual.'}}},{status:200,json:{}}]){
  const{page,state}=await fixture(t,{configure:true});await page.getByRole('button',{name:'Configurar permiso de cierre para mi rol',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Configurar permiso de cierre para mi rol',exact:true});await expect(dialog.getByRole('switch')).toBeVisible();await dialog.getByRole('switch').focus();await page.keyboard.press('Space');state.permissionResponseOverride=response;await dialog.getByRole('button',{name:'Guardar permiso',exact:true}).click();await expect(dialog.getByRole('alert')).toBeVisible();await expect(dialog.getByRole('button',{name:'Guardar permiso',exact:true})).toBeDisabled();assert.equal(state.permissionAttempts.length,1);assert.equal(state.permissionWrites.length,1);
  await dialog.getByRole('button',{name:'Consultar estado del permiso',exact:true}).click();await expect(dialog.getByRole('switch')).toBeChecked();await expect(dialog.getByRole('button',{name:'Guardar permiso',exact:true})).toBeDisabled();assert.equal(state.permissionAttempts.length,1);assert.equal(state.attempts.length,0);
 }
});
