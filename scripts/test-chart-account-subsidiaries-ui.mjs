import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const subsidiaries=Array.from({length:26},(_,index)=>({
  subsidiary_id:index+1,
  name:`Empresa ${String(index+1).padStart(2,'0')}`,
  legal_name:`Empresa ${String(index+1).padStart(2,'0')} S.A.`,
  currency_id:1,
  allowed_currency_ids:[1],
  secondary_currency_ids:[],
  is_active:true
}));
const group={group_id:10,group_code:'110',group_name:'Efectivo',level:3,nature:'Deudora',financial_statement:'Balance General',category:'Activo',full_ifrs_only:false,pending_fx_revaluation:false,is_inactive:false};
const account={account_id:50,account_group_id:10,account_number:'110001',account_name:'Caja principal',level:4,subsidiary_ids:[1,2],nature:'Deudora',financial_statement:'Balance General',category:'Activo',cash_flow_activity:'EFECTIVO_EQUIVALENTE',accepts_entries:true,payment_request_enabled:false,full_ifrs_only:false,pending_fx_revaluation:false,is_inactive:false,account_group_code:'110',account_group_name:'Efectivo'};
const accounts=[
  account,
  {...account,account_id:51,account_number:'110002',account_name:'Cuenta solo empresa 1',subsidiary_ids:[1]},
  {...account,account_id:52,account_number:'110003',account_name:'Cuenta solo empresa 2',subsidiary_ids:[2]},
  {...account,account_id:53,account_number:'110004',account_name:'Cuenta compartida',subsidiary_ids:[1,2]},
  {...account,account_id:60,account_number:'410001',account_name:'Ingreso solo empresa 1',subsidiary_ids:[1],nature:'Acreedora',financial_statement:'Estado de Resultados',category:'Ingreso',cash_flow_activity:'OPERACION'},
  {...account,account_id:61,account_number:'410002',account_name:'Ingreso solo empresa 2',subsidiary_ids:[2],nature:'Acreedora',financial_statement:'Estado de Resultados',category:'Ingreso',cash_flow_activity:'OPERACION'},
  {...account,account_id:62,account_number:'410003',account_name:'Ingreso compartido',subsidiary_ids:[1,2],nature:'Acreedora',financial_statement:'Estado de Resultados',category:'Ingreso',cash_flow_activity:'OPERACION'},
  {...account,account_id:63,account_number:'410004',account_name:'Ingreso inactivo',subsidiary_ids:[1,2],nature:'Acreedora',financial_statement:'Estado de Resultados',category:'Ingreso',cash_flow_activity:'OPERACION',is_inactive:true},
  {...account,account_id:64,account_number:'410005',account_name:'Ingreso no transaccional',subsidiary_ids:[1,2],nature:'Acreedora',financial_statement:'Estado de Resultados',category:'Ingreso',cash_flow_activity:'OPERACION',accepts_entries:false}
];
const legacyAllocation={rule_id:70,rule_name:'Regla con cuenta histórica',subsidiary_id:1,source_account_id:52,target_account_id:53,allocation_percentage:50};
const fixtures={
  '/api/auth/roles':[{roleId:1,name:'Administrador'}],
  '/api/auth/select-role':{roleId:1,name:'Administrador'},
  '/api/auth/companies':subsidiaries.map(row=>({subsidiaryId:row.subsidiary_id,name:row.name,legalName:row.legal_name,currencyCode:'USD'})),
  '/api/auth/select-company':{subsidiaryId:1,name:'Empresa 01',legalName:'Empresa 01 S.A.',currencyCode:'USD'},
  '/api/organization/subsidiaries':subsidiaries,
  '/api/accounting/chart-accounts':accounts,
  '/api/accounting/account-groups':[group],
  '/api/accounting/allocation-rules':[legacyAllocation],
  '/api/inventory/products':[],
  '/api/inventory/item-types':[{item_type_id:1,type_code:'SERVICE',type_name:'Servicio',is_inventory:false,is_assembled:false}],
  '/api/inventory/product-categories':[],
  '/api/inventory/product-brands':[],
  '/api/configuration/uom':[{uom_id:1,code:'UND',name:'Unidad'}]
};

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(10_000);
const apiCalls=[];
let createdPayload;
let updatedPayload;
await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  apiCalls.push({path,method});
  if(path==='/api/accounting/chart-accounts'&&method==='POST'){
    createdPayload=JSON.parse(request.postData()||'{}');
    return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({...account,account_id:51,account_name:createdPayload.account_name,subsidiary_ids:createdPayload.subsidiary_ids})});
  }
  if(path==='/api/accounting/chart-accounts/50'&&method==='PATCH'){
    updatedPayload=JSON.parse(request.postData()||'{}');
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...account,...updatedPayload})});
  }
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fixtures[path]??[])});
});
await page.addInitScript(()=>{
  const payload=btoa(JSON.stringify({email:'admin@example.test',exp:Math.floor(Date.now()/1000)+3600})).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  localStorage.setItem('nexo_token',`e30.${payload}.test`);
  localStorage.setItem('nexo_company','1');
  localStorage.setItem('nexo_role','1');
});

try{
  await page.goto('http://localhost:3000/');
  await page.getByText('Contabilidad',{exact:true}).first().click();
  assert.equal(await page.getByText('Cuentas por subsidiaria',{exact:true}).count(),0,'La matriz técnica no debe aparecer como un catálogo editable separado.');
  await page.getByText('Plan de cuentas',{exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.record-count')?.textContent?.includes('9 registros'));
  assert.equal(apiCalls.some(call=>call.path==='/api/accounting/account-subsidiaries'),false,'La pantalla no debe descargar la matriz cuenta-subsidiaria.');

  await page.getByRole('button',{name:/Crear cuenta/}).click();
  const modal=page.locator('.account-master-modal');
  await modal.waitFor();
  await modal.getByText('26 de 26',{exact:true}).waitFor();
  assert.equal(await modal.locator('.multi-option input[type="checkbox"]:checked').count(),26,'El alta debe seleccionar todas las subsidiarias disponibles.');
  await modal.locator('[data-field-key="account_group_id"] select').selectOption('10');
  await modal.locator('[data-field-key="account_name"] input').fill('Caja secundaria');
  await modal.getByRole('button',{name:'Crear registro'}).click();
  await page.waitForFunction(()=>!document.querySelector('.account-master-modal'));
  assert.deepEqual(createdPayload.subsidiary_ids,subsidiaries.map(row=>row.subsidiary_id),'El alta no envió las 26 subsidiarias.');

  await page.locator('tbody tr').filter({hasText:'Caja principal'}).getByRole('button',{name:'Editar registro'}).click();
  await modal.waitFor();
  await modal.getByText('2 de 26',{exact:true}).waitFor();
  assert.equal(await modal.locator('.multi-option input[type="checkbox"]:checked').count(),2,'La edición debe conservar solamente el subconjunto asignado.');
  await modal.locator('.multi-option input[type="checkbox"][value="1"]').uncheck();
  await modal.locator('.multi-option input[type="checkbox"][value="2"]').uncheck();
  const patchCountBefore=apiCalls.filter(call=>call.path==='/api/accounting/chart-accounts/50'&&call.method==='PATCH').length;
  await modal.getByRole('button',{name:'Guardar cambios'}).click();
  await modal.getByText('Seleccione al menos una subsidiaria para utilizar la cuenta.').waitFor();
  assert.equal(apiCalls.filter(call=>call.path==='/api/accounting/chart-accounts/50'&&call.method==='PATCH').length,patchCountBefore,'La selección vacía no debe llegar al API.');

  await modal.locator('.multi-option input[type="checkbox"]').nth(2).check();
  await modal.getByRole('button',{name:'Guardar cambios'}).click();
  await page.waitForFunction(()=>!document.querySelector('.account-master-modal'));
  assert.deepEqual(updatedPayload.subsidiary_ids,[3],'La edición no envió el nuevo subconjunto.');

  await page.getByText('Reglas de asignación',{exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.record-count')?.textContent?.includes('1 registro'));
  await page.getByRole('button',{name:'Editar registro'}).click();
  await page.locator('.modal').waitFor();
  const subsidiary=page.locator('[data-field-key="subsidiary_id"] select');
  const sourceAccount=page.locator('[data-field-key="source_account_id"] select');
  const targetAccount=page.locator('[data-field-key="target_account_id"] select');
  assert.equal(await sourceAccount.inputValue(),'52','La edición debe conservar la cuenta histórica seleccionada.');
  const historicalOption=sourceAccount.locator('option[value="52"]');
  assert.equal(await historicalOption.count(),1,'La cuenta histórica deshabilitada debe permanecer visible.');
  assert.equal(await historicalOption.evaluate(option=>option.disabled),true,'La cuenta histórica deshabilitada no debe poder seleccionarse nuevamente.');
  assert.match(await historicalOption.textContent(),/No disponible para la subsidiaria/,'La cuenta histórica debe explicar por qué está deshabilitada.');
  assert.equal(await sourceAccount.locator('option[value="51"]').count(),1,'Debe mostrar cuentas habilitadas para la subsidiaria del registro.');
  assert.equal(await sourceAccount.locator('option[value="53"]').count(),1,'Debe mostrar cuentas compartidas con la subsidiaria del registro.');
  const allocationPatchCount=apiCalls.filter(call=>call.path==='/api/accounting/allocation-rules/70'&&call.method==='PATCH').length;
  await page.getByRole('button',{name:'Guardar cambios'}).click();
  await page.getByText('Cuenta origen no está habilitada para las subsidiarias seleccionadas.').waitFor();
  assert.equal(apiCalls.filter(call=>call.path==='/api/accounting/allocation-rules/70'&&call.method==='PATCH').length,allocationPatchCount,'Una referencia histórica inválida no debe llegar al API.');
  await subsidiary.selectOption('2');
  assert.equal(await sourceAccount.inputValue(),'52','La referencia debe ser válida al cambiar al alcance que la habilita.');
  assert.equal(await targetAccount.inputValue(),'53','Una cuenta compartida debe conservarse al cambiar de subsidiaria.');
  await subsidiary.selectOption('1');
  assert.equal(await sourceAccount.inputValue(),'','La selección incompatible debe limpiarse al cambiar la subsidiaria.');
  assert.equal(await targetAccount.inputValue(),'53','La selección compatible no debe limpiarse.');
  await page.locator('.modal').getByRole('button',{name:'Cerrar',exact:true}).click();

  await page.getByRole('button',{name:/Crear regla de asignación/}).click();
  await page.locator('.modal').waitFor();
  const newSubsidiary=page.locator('[data-field-key="subsidiary_id"] select');
  const newSource=page.locator('[data-field-key="source_account_id"] select');
  assert.equal(await newSource.locator('option[value="51"]').count(),1,'Sin alcance explícito debe usar la empresa activa.');
  assert.equal(await newSource.locator('option[value="52"]').count(),0,'No debe mostrar cuentas de otra empresa en un alta.');
  await newSubsidiary.selectOption('2');
  assert.equal(await newSource.locator('option[value="51"]').count(),0,'Al elegir otra subsidiaria debe retirar las cuentas incompatibles.');
  assert.equal(await newSource.locator('option[value="52"]').count(),1,'Al elegir otra subsidiaria debe mostrar sus cuentas habilitadas.');
  await newSource.selectOption('52');
  await newSubsidiary.selectOption('1');
  assert.equal(await newSource.inputValue(),'','La cuenta elegida debe limpiarse al cambiar a un alcance incompatible.');
  await page.locator('.modal').getByRole('button',{name:'Cerrar',exact:true}).click();

  await page.getByText('Inventario',{exact:true}).first().click();
  await page.getByText('Productos',{exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.record-count')?.textContent?.includes('0 registros'));
  await page.getByRole('button',{name:/Crear producto/}).click();
  await page.locator('.modal').waitFor();
  const salesAccount=page.locator('[data-field-key="sales_account_id"] select');
  assert.equal(await salesAccount.locator('option[value="60"]').count(),1,'Antes de elegir subsidiarias debe permitir configurar la cuenta.');
  assert.equal(await salesAccount.locator('option[value="63"]').count(),0,'Una cuenta inactiva no debe ofrecerse en una referencia nueva.');
  assert.equal(await salesAccount.locator('option[value="64"]').count(),0,'Una cuenta que no recibe movimientos no debe ofrecerse en una referencia nueva.');
  await salesAccount.selectOption('60');
  await page.locator('[data-field-key="subsidiary_ids"] input[type="checkbox"][value="1"]').check();
  assert.equal(await salesAccount.inputValue(),'60','La cuenta debe mantenerse mientras sea válida para todas las subsidiarias elegidas.');
  await page.locator('[data-field-key="subsidiary_ids"] input[type="checkbox"][value="2"]').check();
  assert.equal(await salesAccount.inputValue(),'','La cuenta debe limpiarse cuando no cubre todas las subsidiarias elegidas.');
  assert.equal(await salesAccount.locator('option[value="60"]').count(),0,'El alcance múltiple debe excluir cuentas parciales.');
  assert.equal(await salesAccount.locator('option[value="61"]').count(),0,'El alcance múltiple debe excluir cuentas de una sola subsidiaria.');
  assert.equal(await salesAccount.locator('option[value="62"]').count(),1,'El alcance múltiple debe conservar cuentas disponibles en todas las subsidiarias.');

  console.log(JSON.stringify({ui:true,defaultSubsidiaries:26,editSubset:true,emptyBlocked:true,singleSubsidiaryScope:true,multiSubsidiaryScope:true,historicalReferenceGuard:true,inactiveAccountsExcluded:true,incompatibleSelectionCleared:true,legacyMatrixRequests:0,legacyMatrixCatalogHidden:true}));
}finally{
  await browser.close();
}
