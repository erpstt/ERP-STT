import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
import {vueArtifacts} from './build-vue-templates.mjs';

// Compile repository templates in memory; never change generated/product files.
const artifacts=await vueArtifacts(),server=await readFile('src/server.ts','utf8');
const renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(renewal,'The real served session injection must be represented.');
// serveFile excludes index.html from workspace-guard injection. Its theme and
// branding links already exist in the shell itself.
const served=html=>html.replace('<head>','<head>'+renewal[1]);
const accounts=[
 {bank_account_id:7,subsidiary_id:1,bank_name:'Banco Águila',account_number:'001-000777',currency_code:'USD'},
 {bank_account_id:8,subsidiary_id:1,bank_name:'Banco Águila',account_number:'001-000888',currency_code:'CRC'},
 {bank_account_id:9,subsidiary_id:1,bank_name:'Banco Zafiro',account_number:'002-000999',currency_code:'EUR'}
];
const statement=(id,account,date)=>({statement_id:id,bank_account_id:account,statement_date:date,opening_balance:'100.00',closing_balance:'125.50'});
// Equal balances/months remain distinct rows. Input order deliberately differs.
const statements=[statement(5,8,'2026-10-31'),statement(2,7,'2026-09-30'),statement(3,7,'2026-10-31'),statement(1,9,'2025-10-31'),statement(4,7,'2026-10-31'),statement(6,7,'2026-11-30')];
const otherAccounts=[{bank_account_id:17,subsidiary_id:2,bank_name:'Banco Empresa Dos',account_number:'002-000017',currency_code:'USD'}];
const otherStatements=[statement(17,17,'2026-08-31')];
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};

async function fixture(t,{width=1536,load=true,holdFirst=false}={}){
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000}),calls=[],errors=[],unexpected=[],controls={company:1},gate=deferred(),seen=deferred();let catalogCalls=0;
 t.after(()=>gate.resolve());page.on('pageerror',error=>errors.push(error.message));const failed=[];page.on('requestfailed',request=>failed.push(request.url()));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/index.html'){await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/index.html','utf8'))});return;}
  const generated=artifacts.get('public'+url.pathname);if(generated!==undefined){await route.fulfill({contentType:'text/javascript; charset=utf-8',body:generated});return;}
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  calls.push({path:url.pathname,method:request.method()});
  if(request.method()!=='GET'){unexpected.push(request.method()+' '+url.pathname);await route.fulfill({status:501,json:{error:{message:'Synthetic fixture blocks every write'}}});return;}
  let json;
  if(url.pathname==='/api/security/turnstile/config')json={enabled:false};
  else if(url.pathname==='/api/banking/bank-statements'){
   const company=controls.company;catalogCalls++;
   if(holdFirst&&catalogCalls===1){seen.resolve();await gate.promise;}
   json=company===1?(controls.rows??statements):otherStatements;
  }else if(url.pathname==='/api/banking/bank-statements/account-options')json=controls.company===1?accounts:otherAccounts;
  else{unexpected.push(request.method()+' '+url.pathname);await route.fulfill({status:501,json:{error:{message:'Unexpected synthetic API'}}});return;}
  await route.fulfill({json});
 });
 await page.goto(baseURL+'/index.html');
 await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady).catch(async error=>{throw Error(`${error.message}; page errors: ${JSON.stringify(errors)}; failed: ${JSON.stringify(failed)}; state: ${await page.evaluate(()=>JSON.stringify({root:!!document.getElementById('app'),app:!!document.getElementById('app')?.__vue_app__,scripts:[...document.scripts].map(s=>s.src)}))}`);});
 await page.evaluate(()=>{
  localStorage.setItem('nexo_token','synthetic-statement-list-token');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');
  const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;
  v.authenticated=true;v.sessionReady=true;v.selectingCompany=false;v.activeCompany={subsidiaryId:1,name:'Empresa sintética'};v.activeRole={roleId:2,name:'Rol sintético'};v.roleAccess={loaded:true,isAdmin:true,grants:{},modules:[]};v.currentModule='Bancos';v.currentSection='Extractos bancarios';v.closeWorkspace();
 });
 const loadCatalog=()=>page.evaluate(async()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;await v.loadCatalog();});
 if(load)await loadCatalog();
 assert.equal(await page.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.ok(calls.every(call=>call.method==='GET'));});
 return{page,calls,controls,loadCatalog,gate,seen};
}
const rows=page=>page.locator('.bank-statement-table-card tr[data-record-id]');
const ids=page=>rows(page).evaluateAll(items=>items.map(row=>Number(row.dataset.recordId)));
async function capture(page,name){if(process.env.BANK_STATEMENT_LIST_CAPTURE!=='1')return;const folder=resolve('..','bank-statement-list-qa-20261107');await mkdir(folder,{recursive:true});await page.screenshot({path:resolve(folder,name),animations:'disabled'});}

for(const width of[1536,390])test(`extractos ${width}: cuenta/mes ordenados, búsqueda inteligente y filtros conservan cada registro`,{timeout:40000},async t=>{
 const{page,calls}=await fixture(t,{width}),card=page.locator('.bank-statement-table-card'),search=page.getByRole('textbox',{name:'Buscar registros'});
 await expect(rows(page)).toHaveCount(6);
 assert.deepEqual(await ids(page),[6,4,3,2,5,1]);
 assert.deepEqual(await card.locator('.bank-statement-account-group').allTextContents(),accounts.map(account=>`${account.bank_name} · ${account.account_number} · ${account.currency_code}`));
 assert.deepEqual(await card.locator('.bank-statement-month-group span').allTextContents(),['noviembre de 2026','octubre de 2026','septiembre de 2026','octubre de 2026','octubre de 2025']);
 await expect(card.locator('.record-count')).toHaveText('6 registros');
 const queries=[['31/10/2026',[4,3,5]],['31-10-2026',[4,3,5]],['octubre 2026',[4,3,5]],['2026-10',[4,3,5]],['001-000777',[6,4,3,2]],['001000777',[6,4,3,2]],['banco aguila',[6,4,3,2,5]],['ÁGUILA usd octubre 2026',[4,3]],['zafiro 2026',[]]];
 for(const[query,expected]of queries){await search.fill(query);await expect.poll(()=>ids(page)).toEqual(expected);}
 await search.fill('');
 const account=page.getByRole('combobox',{name:'Filtrar extractos por cuenta'}),month=page.getByRole('combobox',{name:'Filtrar extractos por mes'});
 await account.selectOption('7');await month.selectOption('2026-10');assert.deepEqual(await ids(page),[4,3]);
 assert.deepEqual(await rows(page).locator('.field-closing_balance').allTextContents(),['125,50','125,50'],'Neither equal row may be merged or summed.');
 await page.getByRole('button',{name:'Limpiar filtros',exact:true}).click();assert.deepEqual(await ids(page),[6,4,3,2,5,1]);
 const before=calls.length;await search.fill('aguila');await search.fill('');assert.equal(calls.length,before,'Searching/filtering stays local without additional API requests.');
 const geometry=await page.locator('.bank-statement-filters').evaluate(element=>({width:window.innerWidth,card:element.closest('.table-card').getBoundingClientRect().right,controls:[...element.querySelectorAll('select,button')].map(control=>({left:control.getBoundingClientRect().left,right:control.getBoundingClientRect().right,height:control.getBoundingClientRect().height})),table:element.closest('.table-card').querySelector('.table-scroll').getBoundingClientRect().right}));
 assert.ok(geometry.card<=width+1,JSON.stringify(geometry));assert.ok(geometry.table<=width+1,JSON.stringify(geometry));for(const control of geometry.controls){assert.ok(control.left>=0&&control.right<=width+1,JSON.stringify(geometry));assert.ok(control.height>=40);}
 await capture(page,`bank-statements-${width}.png`);
});

test('editar, autoría y eliminar conservan ID de cada extracto y respetan el rol lector',{timeout:30000},async t=>{
 const{page}=await fixture(t);await expect(rows(page)).toHaveCount(6);
 await page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;window.statementActions=[];v.openRecordForm=row=>window.statementActions.push(['edit',row.statement_id]);v.openRecordAudit=row=>window.statementActions.push(['audit',row.statement_id]);v.requestDelete=row=>window.statementActions.push(['delete',row.statement_id]);});
 const row=page.locator('tr[data-record-id="3"]');await row.getByRole('button',{name:'Editar registro',exact:true}).click();await row.getByRole('button',{name:'Autoría',exact:true}).click();await row.getByRole('button',{name:/Eliminar/}).click();assert.deepEqual(await page.evaluate(()=>window.statementActions),[['edit',3],['audit',3],['delete',3]]);
 await page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.roleAccess={loaded:true,isAdmin:false,grants:{'banking:bank-statements':{canView:true,canCreate:false,canEdit:false,canDelete:false}},modules:[{name:'Bancos',resources:[{optionName:'Extractos bancarios',key:'banking:bank-statements'}]}]};});
 await expect(page.getByRole('button',{name:'Editar registro',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:/Eliminar/})).toHaveCount(0);await expect(page.getByRole('button',{name:/Crear extracto/})).toHaveCount(0);await expect(row.getByRole('button',{name:'Autoría',exact:true})).toBeVisible();await row.getByRole('button',{name:'Autoría',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.statementActions.at(-1)),['audit',3]);
});

test('respuesta tardía de otra empresa/rol no restaura grupos, referencias ni filtros anteriores',{timeout:30000},async t=>{
 const{page,controls,loadCatalog,gate,seen}=await fixture(t,{load:false,holdFirst:true});
 // Simulate a transport that has already queued the obsolete response.
 await page.evaluate(()=>{const realFetch=window.fetch.bind(window);window.fetch=(resource,init={})=>{if(String(resource)==='/api/banking/bank-statements'){const{signal,...withoutAbort}=init;return realFetch(resource,withoutAbort);}return realFetch(resource,init);};const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;window.oldStatementLoad=v.loadCatalog();});
 await seen.promise;controls.company=2;
 await page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.bankStatementFilters={account:'7',month:'2026-10'};localStorage.setItem('nexo_company','2');localStorage.setItem('nexo_role','3');v.activeCompany={subsidiaryId:2,name:'Empresa sintética dos'};v.activeRole={roleId:3,name:'Otro rol'};});
 await loadCatalog();assert.deepEqual(await ids(page),[17]);gate.resolve();await page.evaluate(()=>window.oldStatementLoad);
 assert.deepEqual(await ids(page),[17]);await expect(page.locator('.bank-statement-account-group')).toHaveText('Banco Empresa Dos · 002-000017 · USD');await expect(page.getByRole('combobox',{name:'Filtrar extractos por cuenta'})).toHaveValue('');await expect(page.getByRole('combobox',{name:'Filtrar extractos por mes'})).toHaveValue('');await expect(page.getByRole('combobox',{name:'Filtrar extractos por cuenta'}).locator('option[value="7"]')).toHaveCount(0);
});

test('continuidad usa el cierre exacto del mes anterior de la misma cuenta, incluso oculto por filtros, sin modificar saldos',{timeout:30000},async t=>{
 const{page,controls,loadCatalog,calls}=await fixture(t,{load:false});
 controls.rows=[{...statement(21,7,'2026-09-30'),closing_balance:'102.00'},statement(22,7,'2026-10-31'),{...statement(23,7,'2026-11-30'),opening_balance:'125.50'},statement(24,8,'2026-09-30'),{...statement(25,8,'2026-10-31'),opening_balance:'125.50'},statement(26,9,'2026-10-31'),statement(27,9,'2026-08-31'),{...statement(31,7,'2026-04-30'),closing_balance:1},{...statement(32,7,'2026-05-31'),opening_balance:1.005},{...statement(33,8,'2026-04-30'),closing_balance:1},{...statement(34,8,'2026-05-31'),opening_balance:0.995}];
 await loadCatalog();
 // This continuity regression intentionally inspects all eleven synthetic rows.
 // Pagination has separate coverage, so select a range containing every case.
 await page.locator('#catalogPageSize').selectOption('25');
 const warning=page.locator('tr[data-record-id="22"] .bank-statement-continuity');await expect(warning).toContainText('Revisar continuidad');await expect(warning).toContainText('Esperado: 102,00 USD · Diferencia: -2,00 USD');await expect(page.locator('tr[data-record-id="22"] .field-opening_balance .bank-statement-amount')).toHaveText('100,00');
 await expect(page.locator('tr[data-record-id="23"] .bank-statement-continuity')).toContainText('Continuidad correcta');await expect(page.locator('tr[data-record-id="25"] .bank-statement-continuity')).toContainText('Continuidad correcta');const missing=page.locator('tr[data-record-id="26"] .bank-statement-continuity');await expect(missing).toContainText('Sin extracto anterior');await expect(missing).not.toContainText('Esperado:');
 for(const[id,difference]of[[32,'0,01 USD'],[34,'-0,01 CRC']]){const edge=page.locator(`tr[data-record-id="${id}"] .bank-statement-continuity`);await expect(edge).toContainText('Revisar continuidad');await expect(edge).toContainText(`Diferencia: ${difference}`);}
 const before=calls.length;await page.getByRole('combobox',{name:'Filtrar extractos por mes'}).selectOption('2026-10');await page.getByRole('textbox',{name:'Buscar registros'}).fill('aguila usd');await expect(rows(page)).toHaveCount(1);await expect(page.locator('tr[data-record-id="21"]')).toHaveCount(0);await expect(warning).toContainText('Esperado: 102,00 USD · Diferencia: -2,00 USD');assert.equal(calls.length,before);assert.deepEqual(await page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;return v.rows.find(row=>row.statement_id===22);}),statement(22,7,'2026-10-31'));
});
