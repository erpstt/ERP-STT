import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
import {vueArtifacts} from './build-vue-templates.mjs';

const artifacts=await vueArtifacts(),server=await readFile('src/server.ts','utf8');
const renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(renewal,'Represent the real synchronous session injection in the served shell.');
const groups=[
 {group_id:81,group_code:'214',group_name:'Pasivo sintético revaluable',level:3,nature:'Acreedora',financial_statement:'Balance General',category:'Pasivo',full_ifrs_only:false,pending_fx_revaluation:true},
 {group_id:82,group_code:'215',group_name:'Pasivo sintético histórico',level:3,nature:'Acreedora',financial_statement:'Balance General',category:'Pasivo',full_ifrs_only:false,pending_fx_revaluation:false},
 {group_id:83,group_code:'410',group_name:'Ingreso sintético',level:3,nature:'Acreedora',financial_statement:'Estado de Resultados',category:'Ingreso',full_ifrs_only:false,pending_fx_revaluation:false}
];
const initialAccounts=[
 {account_id:51,account_group_id:81,account_number:'214991',account_name:'Cuenta heredada sintética',level:4,subsidiary_ids:[1,2],nature:'Acreedora',financial_statement:'Balance General',category:'Pasivo',accepts_entries:true,payment_request_enabled:false,full_ifrs_only:false,pending_fx_revaluation:true,pending_fx_revaluation_override:null,is_inactive:false},
 {account_id:52,account_group_id:81,account_number:'214992',account_name:'Cuenta manual sintética',level:4,subsidiary_ids:[1],nature:'Acreedora',financial_statement:'Balance General',category:'Pasivo',accepts_entries:true,payment_request_enabled:false,full_ifrs_only:false,pending_fx_revaluation:false,pending_fx_revaluation_override:false,is_inactive:false}
];
const subsidiaries=[{subsidiary_id:1,name:'Empresa sintética uno'},{subsidiary_id:2,name:'Empresa sintética dos'}];
const selector='[data-field-key="pending_fx_revaluation"]';
const fx=page=>page.getByRole('switch',{name:'Revaluación de saldo pendiente para transacciones en moneda extranjera',exact:true});
const field=(page,key)=>page.locator(`.modal [data-field-key="${key}"] input, .modal [data-field-key="${key}"] select`).first();

async function fixture(t,{width=1536,reader=false}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000});
 const state={accounts:structuredClone(initialAccounts),writes:[],reads:0},errors=[],unexpected=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL)return route.fallback();
  if(url.pathname==='/index.html')return route.fulfill({contentType:'text/html; charset=utf-8',body:(await readFile('public/index.html','utf8')).replace('<head>','<head>'+renewal[1])});
  const generated=artifacts.get('public'+url.pathname);if(generated!==undefined)return route.fulfill({contentType:'text/javascript; charset=utf-8',body:generated});
  if(!url.pathname.startsWith('/api/'))return route.fallback();
  if(url.pathname==='/api/accounting/chart-accounts'&&request.method()==='GET'){state.reads++;return route.fulfill({json:state.accounts});}
  if(/^\/api\/accounting\/chart-accounts(?:\/[1-9][0-9]*)?$/.test(url.pathname)&&['POST','PATCH'].includes(request.method())){
   if(reader){unexpected.push('Reader attempted a mutation');return route.fulfill({status:403,json:{error:{message:'Synthetic reader cannot edit'}}});}
   const payload=request.postDataJSON();state.writes.push({method:request.method(),path:url.pathname,payload});
   // Persist the independent nullable-override contract, never infer an override
   // from the effective value that the old form used to submit.
   assert.equal(Object.hasOwn(payload,'pending_fx_revaluation'),false);
   assert.ok(payload.pending_fx_revaluation_override===null||typeof payload.pending_fx_revaluation_override==='boolean');
   const id=request.method()==='POST'?53:Number(url.pathname.split('/').at(-1)),old=state.accounts.find(row=>row.account_id===id),group=groups.find(row=>String(row.group_id)===String(payload.account_group_id));
   assert.ok(group);
   const eligible=['Activo','Pasivo'].includes(group.category),override=eligible?payload.pending_fx_revaluation_override:null;
   const saved={...old,...payload,account_id:id,account_group_id:group.group_id,account_number:old?.account_number??'215991',pending_fx_revaluation_override:override,pending_fx_revaluation:eligible?(override??group.pending_fx_revaluation):false};
   if(old)state.accounts[state.accounts.indexOf(old)]=saved;else state.accounts.push(saved);
   return route.fulfill({status:request.method()==='POST'?201:200,json:saved});
  }
  if(request.method()==='GET'){
   const data={
    '/api/security/turnstile/config':{enabled:false},
    '/api/accounting/account-groups':groups,
    '/api/organization/subsidiaries':subsidiaries,
    '/api/audit/record-actor':{}
   };
   if(Object.hasOwn(data,url.pathname))return route.fulfill({json:data[url.pathname]});
  }
  unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:501,json:{error:{message:'Unexpected synthetic API'}}});
 });
 await page.goto(baseURL+'/index.html');
 await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
 await page.evaluate(reader=>{
  localStorage.setItem('nexo_token','synthetic-chart-fx-token');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');
  const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;
  v.authenticated=true;v.sessionReady=true;v.selectingCompany=false;v.activeCompany={subsidiaryId:1,name:'Empresa sintética uno'};v.activeRole={roleId:2,name:reader?'Lector sintético':'Administrador sintético'};
  v.roleAccess={loaded:true,isAdmin:!reader,grants:{'accounting:chart-accounts':{canView:true,canCreate:false,canEdit:false,canDelete:false}},modules:[{name:'Contabilidad',resources:[{key:'accounting:chart-accounts',optionName:'Plan de cuentas'}]}]};v.currentModule='Contabilidad';v.currentSection='Plan de cuentas';v.closeWorkspace();
 },reader);
 const load=()=>page.evaluate(async()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;await v.loadCatalog();});
 const edit=async id=>{const row=page.locator('tbody tr').filter({has:page.locator('td',{hasText:String(id===51?'214991':id===52?'214992':'215991')})});await row.getByRole('button',{name:'Editar registro',exact:true}).click();await expect(page.getByRole('dialog',{name:'Editar cuenta',exact:true})).toBeVisible();};
 const save=async()=>{await page.getByRole('button',{name:/^(Guardar cambios|Crear registro)$/}).click();await expect(page.getByRole('dialog')).toHaveCount(0);};
 await load();
 state.documentWidthBeforeForm=await page.evaluate(()=>document.documentElement.scrollWidth);
 assert.equal(await page.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);});
 return{page,state,load,edit,save};
}

test('cuenta heredada permite apagar y encender; PATCH conserva la elección al recargar',{timeout:40000},async t=>{
 const{page,state,edit,save,load}=await fixture(t);await edit(51);
 await expect(fx(page)).toBeEnabled();await expect(fx(page)).toBeChecked();await expect(page.locator('#chartAccountFxHelp')).toContainText('valor del grupo: activado');
 assert.equal(await fx(page).getAttribute('aria-describedby'),'chartAccountFxHelp');
 await fx(page).focus();await page.keyboard.press('Space');await expect(fx(page)).not.toBeChecked();await expect(page.locator('#chartAccountFxHelp')).toContainText('Valor elegido');
 await expect(page.locator(selector)).toContainText('todas las subsidiarias');
 if(process.env.CHART_FX_OVERRIDE_CAPTURE==='1'){const dir=resolve('..','chart-account-fx-override-qa-20261109');await mkdir(dir,{recursive:true});await page.getByRole('button',{name:'Usar valor del grupo',exact:true}).evaluate(element=>element.scrollIntoView({block:'center'}));await page.screenshot({path:resolve(dir,'chart-fx-override-1536.png'),animations:'disabled'});}
 await save();
 assert.equal(state.writes[0].payload.pending_fx_revaluation_override,false);await load();await edit(51);await expect(fx(page)).not.toBeChecked();
 await fx(page).focus();await page.keyboard.press('Space');await expect(fx(page)).toBeChecked();await save();
 assert.equal(state.writes[1].payload.pending_fx_revaluation_override,true);await load();await edit(51);await expect(fx(page)).toBeChecked();await expect(page.locator('#chartAccountFxHelp')).toContainText('Valor elegido');
 assert.deepEqual(state.writes[1].payload.subsidiary_ids,[1,2]);
});

test('guardar otro campo conserva herencia null o excepción false sin convertirlas',{timeout:40000},async t=>{
 const{page,state,edit,save,load}=await fixture(t);
 for(const[id,expected]of[[51,null],[52,false]]){
  await edit(id);await field(page,'account_name').fill('Nombre actualizado '+id);await save();
  assert.equal(state.writes.at(-1).payload.pending_fx_revaluation_override,expected);await load();await edit(id);
  await expect(fx(page)).toBeChecked({checked:id===51});
  await expect(page.getByRole('button',{name:'Usar valor del grupo',exact:true})).toHaveCount(expected===null?0:1);await page.getByRole('button',{name:'Cerrar',exact:true}).click();
 }
});

test('cuenta nueva hereda cada grupo, conserva elección explícita y permite volver al valor del grupo',{timeout:40000},async t=>{
 const{page,state,save}=await fixture(t);await page.evaluate(async()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;await v.openRecordForm();});
 const group=field(page,'account_group_id');await group.selectOption('81');await expect(fx(page)).toBeChecked();await group.selectOption('82');await expect(fx(page)).not.toBeChecked();
 await fx(page).focus();await page.keyboard.press('Space');await expect(fx(page)).toBeChecked();await group.selectOption('81');await group.selectOption('82');await expect(fx(page)).toBeChecked();
 await page.getByRole('button',{name:'Usar valor del grupo',exact:true}).click();await expect(fx(page)).not.toBeChecked();await expect(page.locator('#chartAccountFxHelp')).toContainText('valor del grupo: desactivado');
 await expect(page.getByRole('button',{name:'Usar valor del grupo',exact:true})).toHaveCount(0);
 await field(page,'account_name').fill('Cuenta nueva sintética');await save();assert.equal(state.writes[0].method,'POST');assert.equal(state.writes[0].payload.pending_fx_revaluation_override,null);assert.equal(state.accounts.at(-1).pending_fx_revaluation,false);
 assert.deepEqual([...state.writes[0].payload.subsidiary_ids].sort(),[1,2]);
});

test('reset explícito se guarda null y cambiar a categoría no monetaria limpia la excepción',{timeout:40000},async t=>{
 const{page,state,edit,save,load}=await fixture(t);await edit(52);await expect(fx(page)).not.toBeChecked();await page.getByRole('button',{name:'Usar valor del grupo',exact:true}).click();await expect(fx(page)).toBeChecked();await save();
 assert.equal(state.writes[0].payload.pending_fx_revaluation_override,null);await load();await edit(52);await expect(fx(page)).toBeChecked();await expect(page.locator('#chartAccountFxHelp')).toContainText('valor del grupo');
 await fx(page).focus();await page.keyboard.press('Space');await field(page,'account_group_id').selectOption('83');await expect(fx(page)).toHaveCount(0);await save();
 assert.equal(state.writes[1].payload.pending_fx_revaluation_override,null);assert.equal(state.accounts.find(row=>row.account_id===52).pending_fx_revaluation,false);
});

test('móvil y lector: ayuda, control y reset caben con tema real; el rol lector no ofrece edición',{timeout:40000},async t=>{
 const{page,state,edit}=await fixture(t,{width:390});await edit(51);await fx(page).focus();await page.keyboard.press('Space');
 await page.locator(selector).scrollIntoViewIfNeeded();await expect(page.getByRole('button',{name:'Usar valor del grupo',exact:true})).toBeVisible();
 const dimensions=await page.locator(selector).evaluate(element=>({window:innerWidth,scroll:document.documentElement.scrollWidth,modal:element.closest('.modal').getBoundingClientRect().toJSON(),rect:element.getBoundingClientRect().toJSON(),button:element.querySelector('button').getBoundingClientRect().toJSON(),switch:element.querySelector('input').getBoundingClientRect().toJSON()}));
 // The catalog behind the dialog has its own wide table. The new field must
 // fit the viewport and must not add horizontal overflow to that baseline.
 assert.ok(dimensions.scroll<=Math.max(dimensions.window,state.documentWidthBeforeForm),JSON.stringify({...dimensions,beforeForm:state.documentWidthBeforeForm}));assert.ok(dimensions.modal.left>=0&&dimensions.modal.right<=391,JSON.stringify(dimensions));assert.ok(dimensions.rect.left>=0&&dimensions.rect.right<=391,JSON.stringify(dimensions));assert.ok(dimensions.button.left>=0&&dimensions.button.right<=391,JSON.stringify(dimensions));
 if(process.env.CHART_FX_OVERRIDE_CAPTURE==='1'){const dir=resolve('..','chart-account-fx-override-qa-20261109');await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'chart-fx-override-390.png'),animations:'disabled'});}
 assert.equal(state.writes.length,0);
 await page.getByRole('button',{name:'Cerrar',exact:true}).click();
 await page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.activeRole={roleId:3,name:'Lector sintético'};v.roleAccess={loaded:true,isAdmin:false,grants:{'accounting:chart-accounts':{canView:true,canCreate:false,canEdit:false,canDelete:false}},modules:[{name:'Contabilidad',resources:[{key:'accounting:chart-accounts',optionName:'Plan de cuentas'}]}]};});
 await expect(page.getByRole('button',{name:'Editar registro',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:/Nuevo registro|Crear cuenta/})).toHaveCount(0);assert.equal(state.writes.length,0);
});
