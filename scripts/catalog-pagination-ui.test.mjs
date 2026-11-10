import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect} from '@playwright/test';
import {workspaceShellLayoutFixture} from './lib/workspace-shell-layout-fixture.mjs';
import {vueArtifacts} from './build-vue-templates.mjs';

// Compile trusted repository templates in memory. The existing shell fixture
// supplies real authentication/layout behavior with synthetic APIs only.
const artifacts=await vueArtifacts();
const currencies=[
  {currency_id:1,currency_code:'USD',name:'Dólar estadounidense'},
  {currency_id:2,currency_code:'CRC',name:'Colón costarricense'},
  {currency_id:3,currency_code:'PEN',name:'Sol peruano'}
];
function rateRows(count=548){
  return Array.from({length:count},(_,index)=>{
    const id=count-index,date=new Date(Date.UTC(2026,10,10-index)).toISOString().slice(0,10);
    return{exchange_rate_id:id,from_currency_id:1,to_currency_id:id===1?3:2,effective_date:date,spot_rate:500+id/1000,_revision:`SYN-${id}`};
  });
}
const invoices=Array.from({length:31},(_,index)=>{
  const id=(index*7)%31+1;
  return{invoice_id:id,invoice_number:`FAC-SYN-${String(id).padStart(4,'0')}`,transaction_id:1,customer_id:1,so_id:null,subsidiary_id:1,due_date:`2026-12-${String(id).padStart(2,'0')}`,total_amount:id*10};
});
const departments=Array.from({length:26},(_,index)=>({department_id:index+1,name:`Departamento sintético ${String(index+1).padStart(2,'0')}`,type:'Interno',parent_id:null,subsidiary_ids:[1],is_inactive:false}));
const statements=Array.from({length:14},(_,index)=>{
  const id=index+1,date=new Date(Date.UTC(2026,10-index,0)).toISOString().slice(0,10);
  return{statement_id:id,bank_account_id:7,statement_date:date,opening_balance:100,closing_balance:100};
}).reverse();
const bankAccounts=[{bank_account_id:7,subsidiary_id:1,bank_name:'Banco sintético',account_number:'SYN-007',currency_code:'USD'}];
const vue=async(page,callback,arg)=>{
  const handle=await page.evaluateHandle(()=>document.getElementById('app').__vue_app__._container._vnode.component.proxy);
  try{return await handle.evaluate(callback,arg);}finally{await handle.dispose();}
};
const visibleIds=page=>page.locator('.table-card tbody .id-cell').evaluateAll(elements=>elements.map(element=>Number(element.textContent.replace(/\D/g,''))));

async function fixture(t,{viewport={width:1440,height:900},rates=rateRows(),canDelete=false}={}){
  const result=await workspaceShellLayoutFixture(t,{viewport}),{page,baseURL}=result;
  const calls=[],unexpected=[],controls={rates:structuredClone(rates),canDelete};
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==baseURL)return route.fallback();
    const compiled=artifacts.get('public'+url.pathname);
    if(compiled!==undefined)return route.fulfill({contentType:'text/javascript; charset=utf-8',body:compiled});
    const path=url.pathname;
    const handled=path.startsWith('/api/configuration/rates/')||path.startsWith('/api/configuration/exchange-rates')||path==='/api/configuration/consolidated-exchange-rates'||path==='/api/sales/invoices'||path==='/api/organization/departments/export'||path.startsWith('/api/banking/bank-statements');
    if(!handled)return route.fallback();
    const call={path,method:request.method(),query:Object.fromEntries(url.searchParams),body:request.postDataJSON()};calls.push(call);
    if(request.method()==='DELETE'&&controls.canDelete&&/^\/api\/configuration\/exchange-rates\/[1-9]\d*$/.test(path)){
      const id=Number(path.split('/').at(-1)),existing=controls.rates.find(row=>row.exchange_rate_id===id);
      assert.ok(existing,'Only a known synthetic rate can be deleted');assert.deepEqual(call.body,{_revision:existing._revision});
      controls.rates=controls.rates.filter(row=>row.exchange_rate_id!==id);return route.fulfill({json:{deleted:true}});
    }
    if(request.method()!=='GET'){
      unexpected.push(request.method()+' '+path);return route.fulfill({status:501,json:{error:{message:'Synthetic pagination fixture blocked a write'}}});
    }
    if(path==='/api/organization/departments/export'){
      const rows=departments.filter(row=>!url.searchParams.get('search')||row.name.toLocaleLowerCase('es').includes(url.searchParams.get('search').toLocaleLowerCase('es')));
      return route.fulfill({contentType:'text/csv; charset=utf-8',headers:{'Content-Disposition':'attachment; filename="departamentos-sinteticos.csv"'},body:'id,nombre\r\n'+rows.map(row=>`${row.department_id},${row.name}`).join('\r\n')});
    }
    let json;
    if(path==='/api/configuration/rates/access')json={canView:true,canCreate:false,canEdit:false,canDelete:controls.canDelete,sourceCurrencies:[],references:{'core/currencies':currencies,'organization/subsidiaries':[{subsidiary_id:1,name:'Empresa sintética'}],'organization/accounting-periods':[]}};
    else if(path==='/api/configuration/exchange-rates')json=controls.rates.map(row=>({...row,_actions:{canEdit:false,canDelete:controls.canDelete}}));
    else if(path==='/api/configuration/consolidated-exchange-rates')json=[];
    else if(path==='/api/sales/invoices')json=invoices;
    else if(path==='/api/banking/bank-statements')json=statements;
    else if(path==='/api/banking/bank-statements/account-options')json=bankAccounts;
    if(json===undefined){unexpected.push(request.method()+' '+path);return route.fulfill({status:501,json:{error:{message:'Unexpected synthetic pagination API'}}});}
    return route.fulfill({json});
  });
  await page.reload();await result.ready();
  t.after(()=>assert.deepEqual(unexpected,[]));
  async function open(module,section){
    await vue(page,async(app,{module,section})=>{app.closeWorkspace();app.currentModule=module;app.currentSection=section;await app.loadCatalog();},{module,section});
    await page.getByRole('heading',{name:section,exact:true}).waitFor();
  }
  return{...result,calls,controls,open};
}

const pager=page=>page.locator('#catalogPagination');
const action=(page,name)=>pager(page).locator(`[data-pagination-action="${name}"]`);
async function capture(page,name){
  if(process.env.CATALOG_PAGINATION_CAPTURE!=='1')return;
  const folder=resolve('.local-tools/catalog-pagination-qa');await mkdir(folder,{recursive:true});
  await pager(page).scrollIntoViewIfNeeded();await page.screenshot({path:resolve(folder,name),animations:'disabled'});
}
async function assertPage(page,{page:current,pages,from,to,total}){
  await expect(page.locator('#catalogPageCaption')).toHaveText(`Página ${current} de ${pages}`);
  await expect(page.locator('#catalogPageRange')).toHaveText(`${from}–${to} de ${total} registros`);
}

test('548 tasas se recorren completas con diez filas iniciales y tamaños de página accesibles',{timeout:60000},async t=>{
  const{page,calls,open}=await fixture(t);await open('Configuración','Tipos de cambio');
  const reads=calls.length;
  await expect(page.locator('.record-count')).toHaveText('548 registros');
  await expect(page.locator('#catalogPageSize')).toHaveValue('10');
  assert.deepEqual(await page.locator('#catalogPageSize option').evaluateAll(options=>options.map(option=>option.value)),['10','25','50','100']);
  assert.deepEqual(await visibleIds(page),Array.from({length:10},(_,index)=>548-index));
  await assertPage(page,{page:1,pages:55,from:1,to:10,total:548});
  await capture(page,'exchange-rates-desktop-page-1.png');
  await expect(action(page,'first')).toBeDisabled();await expect(action(page,'previous')).toBeDisabled();
  await action(page,'next').click();assert.deepEqual(await visibleIds(page),Array.from({length:10},(_,index)=>538-index));
  await action(page,'previous').click();await assertPage(page,{page:1,pages:55,from:1,to:10,total:548});
  await action(page,'last').click();assert.deepEqual(await visibleIds(page),[8,7,6,5,4,3,2,1]);
  await assertPage(page,{page:55,pages:55,from:541,to:548,total:548});
  await capture(page,'exchange-rates-desktop-page-55.png');
  await expect(action(page,'next')).toBeDisabled();await expect(action(page,'last')).toBeDisabled();
  await action(page,'first').click();
  for(const size of[25,50,100,10]){
    await action(page,'last').click();await page.locator('#catalogPageSize').selectOption(String(size));
    await assertPage(page,{page:1,pages:Math.ceil(548/size),from:1,to:size,total:548});
    assert.equal((await visibleIds(page)).length,size);
  }
  assert.equal(calls.length,reads,'Changing pages and page size must not request more APIs');
  assert.ok(calls.every(call=>call.method==='GET'));
});

test('buscar en las 548 tasas encuentra la última fila y la fecha localizada y restablece páginas vacías',{timeout:60000},async t=>{
  const{page,calls,open}=await fixture(t);await open('Configuración','Tipos de cambio');
  const search=page.getByRole('textbox',{name:'Buscar registros'}),reads=calls.length,last=rateRows().at(-1);
  await action(page,'last').click();await search.fill('PEN');
  await expect.poll(()=>visibleIds(page)).toEqual([1]);await assertPage(page,{page:1,pages:1,from:1,to:1,total:1});
  const[year,month,day]=last.effective_date.split('-');await search.fill(`${day}/${month}/${year}`);
  await expect.poll(()=>visibleIds(page)).toEqual([1]);
  await search.fill('NINGUNA-TASA-SINTETICA');await expect.poll(()=>visibleIds(page)).toEqual([]);
  await expect(page.locator('.empty-row')).toHaveText('No se encontraron registros.');
  await assertPage(page,{page:1,pages:1,from:0,to:0,total:0});
  await expect(pager(page)).toBeVisible();
  for(const name of['first','previous','next','last'])await expect(action(page,name)).toBeDisabled();
  await search.fill('');await assertPage(page,{page:1,pages:55,from:1,to:10,total:548});
  await expect(page.locator('.record-count')).toHaveText('548 registros');
  assert.equal(calls.length,reads,'Searching all loaded rows must stay local');
});

test('ordenar facturas actúa sobre todas las filas antes de paginar y reinicia la página',{timeout:60000},async t=>{
  const{page,calls,open}=await fixture(t);await open('Ventas','Facturas de venta');
  const reads=calls.length;
  await action(page,'last').click();await expect(page.locator('#catalogPageCaption')).toHaveText('Página 4 de 4');
  const sort=page.locator('[data-sort-key="invoice_id"]');await sort.click();
  await assertPage(page,{page:1,pages:4,from:1,to:10,total:31});assert.deepEqual(await visibleIds(page),[1,2,3,4,5,6,7,8,9,10]);
  await expect(sort.locator('xpath=ancestor::th[1]')).toHaveAttribute('aria-sort','ascending');
  await action(page,'next').click();assert.deepEqual(await visibleIds(page),[11,12,13,14,15,16,17,18,19,20]);
  await sort.click();await assertPage(page,{page:1,pages:4,from:1,to:10,total:31});assert.deepEqual(await visibleIds(page),[31,30,29,28,27,26,25,24,23,22]);
  await expect(sort.locator('xpath=ancestor::th[1]')).toHaveAttribute('aria-sort','descending');
  await action(page,'last').click();await page.locator('[data-sort-key="total_amount"]').click();assert.deepEqual(await visibleIds(page),[1,2,3,4,5,6,7,8,9,10]);
  assert.equal(calls.length,reads,'Sorting and paging must not request or mutate documents');
});

test('cambiar catálogo, rol y empresa vuelve a la primera página y conserva el tamaño elegido',{timeout:60000},async t=>{
  const{page,open}=await fixture(t);await open('Configuración','Tipos de cambio');
  await page.locator('#catalogPageSize').selectOption('25');await action(page,'last').click();
  await open('Ventas','Facturas de venta');await assertPage(page,{page:1,pages:2,from:1,to:25,total:31});
  await action(page,'last').click();await vue(page,app=>{app.activeRole={roleId:3,name:'Otro rol sintético'};});
  await assertPage(page,{page:1,pages:2,from:1,to:25,total:31});
  await action(page,'last').click();await vue(page,app=>{app.activeCompany={subsidiaryId:2,name:'Otra empresa sintética'};});
  await assertPage(page,{page:1,pages:2,from:1,to:25,total:31});
  await expect(page.locator('#catalogPageSize')).toHaveValue('25');
});

test('eliminar la única fila de la última página ajusta al último rango válido tras recargar',{timeout:60000},async t=>{
  const{page,calls,controls,open}=await fixture(t,{rates:rateRows(21),canDelete:true});await open('Configuración','Tipos de cambio');
  await action(page,'last').click();await assertPage(page,{page:3,pages:3,from:21,to:21,total:21});assert.deepEqual(await visibleIds(page),[1]);
  await vue(page,async app=>{app.requestDelete(app.rows.find(row=>row.exchange_rate_id===1));await app.confirmDelete();});
  await assertPage(page,{page:2,pages:2,from:11,to:20,total:20});assert.deepEqual(await visibleIds(page),[11,10,9,8,7,6,5,4,3,2]);
  assert.equal(controls.rates.length,20);
  assert.deepEqual(calls.filter(call=>call.method!=='GET'),[{path:'/api/configuration/exchange-rates/1',method:'DELETE',query:{},body:{_revision:'SYN-1'}}]);
});

test('el paginador móvil cabe en el catálogo y consultar páginas no habilita mantenimiento',{timeout:60000},async t=>{
  const{page,calls,open}=await fixture(t,{viewport:{width:390,height:740}});await open('Configuración','Tipos de cambio');
  await expect(page.locator('.icon-action.edit:visible,.icon-action.delete:visible,.rate-query-menu:visible')).toHaveCount(0);
  const reads=calls.length;await pager(page).scrollIntoViewIfNeeded();
  const geometry=await pager(page).evaluate(element=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,box:element.getBoundingClientRect().toJSON(),controls:[...element.querySelectorAll('button,select')].map(control=>({rect:control.getBoundingClientRect().toJSON(),label:control.getAttribute('aria-label')||control.labels?.[0]?.textContent||''}))}));
  assert.ok(geometry.scrollWidth<=geometry.width+1,JSON.stringify(geometry));
  assert.ok(geometry.box.left>=0&&geometry.box.right<=geometry.width+1,JSON.stringify(geometry));
  for(const control of geometry.controls){assert.ok(control.label.trim(),'Every pager control must have an accessible name');assert.ok(control.rect.left>=0&&control.rect.right<=geometry.width+1,JSON.stringify(control));assert.ok(control.rect.height>=40,JSON.stringify(control));}
  await capture(page,'exchange-rates-mobile-page-1.png');
  await action(page,'next').click();await action(page,'last').click();await expect(page.locator('.icon-action.edit:visible,.icon-action.delete:visible')).toHaveCount(0);
  await capture(page,'exchange-rates-mobile-page-55.png');
  assert.equal(calls.length,reads);assert.ok(calls.every(call=>call.method==='GET'));
});

test('las exportaciones de catálogo conservan todas las filas filtradas e ignoran la página visible',{timeout:60000},async t=>{
  const{page,calls}=await fixture(t);
  await vue(page,(app,rows)=>{app.closeWorkspace();app.currentModule='Organización';app.currentSection='Departamentos';app.rows=rows;app.referenceOptions={'organization/subsidiaries':[{subsidiary_id:1,name:'Empresa sintética'}],'organization/departments':rows};},departments);
  await page.getByRole('heading',{name:'Departamentos',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Buscar registros'}).fill('Departamento');await action(page,'last').click();
  await assertPage(page,{page:3,pages:3,from:21,to:26,total:26});assert.equal((await visibleIds(page)).length,6);
  const downloadPromise=page.waitForEvent('download');await page.locator('.catalog-export-actions').getByRole('button',{name:/CSV$/}).click();
  const download=await downloadPromise,csv=await readFile(await download.path(),'utf8');
  assert.equal(download.suggestedFilename(),'departamentos-sinteticos.csv');assert.equal(csv.trim().split(/\r?\n/).length,27);assert.match(csv,/1,Departamento sintético 01/);assert.match(csv,/26,Departamento sintético 26/);
  assert.deepEqual(calls.filter(call=>call.path.endsWith('/export')),[{path:'/api/organization/departments/export',method:'GET',query:{format:'csv',search:'Departamento'},body:null}]);
});

test('los extractos se agrupan después del orden global y mantienen continuidad con otra página',{timeout:60000},async t=>{
  const{page,calls,open}=await fixture(t);await open('Bancos','Extractos bancarios');
  assert.deepEqual(await visibleIds(page),[1,2,3,4,5,6,7,8,9,10]);await assertPage(page,{page:1,pages:2,from:1,to:10,total:14});
  await expect(page.locator('tr[data-record-id="11"]')).toHaveCount(0);
  await expect(page.locator('tr[data-record-id="10"] .bank-statement-continuity')).toContainText('Continuidad correcta');
  await expect(page.getByRole('combobox',{name:'Filtrar extractos por mes'}).locator('option')).toHaveCount(15);
  const reads=calls.length;await action(page,'next').click();assert.deepEqual(await visibleIds(page),[11,12,13,14]);
  const month=statements.find(row=>row.statement_id===11).statement_date.slice(0,7);
  await page.getByRole('combobox',{name:'Filtrar extractos por mes'}).selectOption(month);await assertPage(page,{page:1,pages:1,from:1,to:1,total:1});assert.deepEqual(await visibleIds(page),[11]);
  await expect(page.locator('.bank-statement-account-group')).toHaveText('Banco sintético · SYN-007 · USD');
  assert.equal(calls.length,reads,'Filters and continuity must use all loaded statements without more reads');
});
