import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const countries=[
  {country_id:57,country_code_iso2:'CO',country_code_iso3:'COL',name:'Colombia'},
  {country_id:188,country_code_iso2:'CR',country_code_iso3:'CRI',name:'Costa Rica'}
];
const subsidiary={subsidiary_id:7,name:'Empresa Colombia',legal_name:'Empresa Colombia SAS',parent_id:null,country_id:57,currency_id:1,secondary_currency_ids:[],timezone_id:1,fiscal_calendar_id:1,tax_id:'900123456',email:'contabilidad@example.test',phone:'6010000000',is_elimination:false,is_active:true,project_approver:null,administrative_approver:null,tax_supervisor_user_id:null,applies_income_autorent:true,autorent_active_account_id:101,autorent_passive_account_id:201,autorent_percentage:0.011};
const accounts=[
  {account_id:101,account_number:'135515',account_name:'Anticipo Autorretención',financial_statement:'Balance General',category:'Activo',nature:'Deudora',level:4,accepts_entries:true,is_inactive:false,subsidiary_ids:[7]},
  {account_id:102,account_number:'135516',account_name:'Activo compatible global',financial_statement:'Balance General',category:'Activo',nature:'Deudora',level:4,accepts_entries:true,is_inactive:false,subsidiary_ids:[8]},
  {account_id:201,account_number:'236575',account_name:'Autorretenciones por Pagar',financial_statement:'Balance General',category:'Pasivo',nature:'Acreedora',level:4,accepts_entries:true,is_inactive:false,subsidiary_ids:[7]}
];
const fixtures={
  '/api/auth/roles':[{roleId:1,name:'Administrador'}],
  '/api/auth/select-role':{roleId:1,name:'Administrador'},
  '/api/auth/companies':[{subsidiaryId:7,name:'Empresa Colombia',legalName:'Empresa Colombia SAS',logoUrl:null,currencyCode:'COP'}],
  '/api/auth/select-company':{subsidiaryId:7,name:'Empresa Colombia',legalName:'Empresa Colombia SAS',logoUrl:null,currencyCode:'COP'},
  '/api/organization/subsidiaries':[subsidiary],
  '/api/core/countries':countries,
  '/api/core/currencies':[{currency_id:1,currency_code:'COP',name:'Peso colombiano',symbol:'$'}],
  '/api/core/timezones':[{timezone_id:1,name:'America/Bogota'}],
  '/api/organization/fiscal-calendars':[{fiscal_calendar_id:1,calendar_name:'Colombia'}],
  '/api/organization/approver-options':[],
  '/api/security/users':[],
  '/api/accounting/chart-accounts':accounts
};

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage();
page.setDefaultTimeout(8000);
let saved;
const apiPaths=[];
await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  apiPaths.push(path);
  if(path==='/api/organization/subsidiaries/7'&&request.method()==='PATCH')saved=JSON.parse(request.postData()||'{}');
  const body=path==='/api/organization/subsidiaries/7'?saved??subsidiary:fixtures[path]??[];
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
});
await page.addInitScript(()=>{
  const payload=btoa(JSON.stringify({email:'demo@nexo.test',exp:Math.floor(Date.now()/1000)+3600})).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  localStorage.setItem('nexo_token',`e30.${payload}.test`);
  localStorage.setItem('nexo_company','7');
  localStorage.setItem('nexo_role','1');
});

try{
  await page.goto('http://localhost:3000/');
  await page.getByText('Organización',{exact:true}).first().click();
  await page.getByText('Subsidiarias',{exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.table-message'));
  assert.equal(apiPaths.filter(path=>path==='/api/accounting/chart-accounts').length,0,'El listado no debe descargar el plan contable.');
  await page.getByRole('button',{name:'Crear subsidiaria'}).click();
  assert.equal(await page.locator('.subsidiary-form-tabs [role="tab"]').count(),3);
  assert.equal(await page.locator('[data-field-key="is_active"] input').isChecked(),true);
  assert.equal(await page.locator('[data-field-key="is_elimination"] input').isChecked(),false);
  await page.locator('[data-field-key="country_id"] select').selectOption('57');
  assert.equal(await page.locator('.subsidiary-form-tabs [role="tab"]').count(),4);
  await page.getByRole('tab',{name:/Tributación · Colombia/}).click();
  assert.equal(await page.locator('.autorent-toggle input').isDisabled(),true);
  await page.getByRole('button',{name:'Cerrar',exact:true}).click();
  await page.getByRole('button',{name:'Editar registro'}).click();
  const tabs=page.locator('.subsidiary-form-tabs [role="tab"]');
  assert.equal(await tabs.count(),4);
  assert.deepEqual(await tabs.locator('strong').allTextContents(),['Información de la empresa','Monedas y operación','Aprobadores','Tributación · Colombia']);
  if(process.env.SUBSIDIARY_SCREENSHOT)await page.screenshot({path:'.tmp/subsidiary-tabs-company.png',fullPage:true});
  await page.getByRole('tab',{name:/Tributación · Colombia/}).click();
  const panel=page.locator('.autorent-editor');
  await panel.waitFor();
  if(process.env.SUBSIDIARY_SCREENSHOT)await page.screenshot({path:'.tmp/subsidiary-tabs-tax.png',fullPage:true});
  assert.equal(await panel.locator('#autorent-title').textContent(),'Autorretención a título de renta');
  assert.equal(await panel.locator('input[placeholder="1,10"]').inputValue(),'1,10');
  assert.deepEqual(await panel.locator('select').nth(0).locator('option').allTextContents(),['Seleccione la cuenta de activo','135515 · Anticipo Autorretención','135516 · Activo compatible global']);
  assert.deepEqual(await panel.locator('select').nth(1).locator('option').allTextContents(),['Seleccione la cuenta de pasivo','236575 · Autorretenciones por Pagar']);
  await page.getByRole('tab',{name:/Información de la empresa/}).click();
  const countrySelect=page.locator('.form-grid label').filter({hasText:'País'}).locator('select').first();
  await countrySelect.selectOption('188');
  assert.equal(await page.locator('.autorent-editor').count(),0);
  assert.equal(await page.getByRole('tab',{name:/Tributación · Colombia/}).count(),0);
  await countrySelect.selectOption('57');
  await page.getByRole('tab',{name:/Tributación · Colombia/}).click();
  await page.locator('.autorent-editor .autorent-switch').click();
  await page.locator('.autorent-editor select').nth(0).selectOption('101');
  await page.locator('.autorent-editor select').nth(1).selectOption('201');
  await page.locator('.autorent-editor input[placeholder="1,10"]').fill('1,10');
  await page.getByRole('button',{name:'Guardar cambios'}).click();
  await page.waitForFunction(()=>!document.querySelector('.autorent-editor'));
  assert.equal(saved.autorent_percentage,0.011);
  assert.equal(saved.autorent_active_account_id,101);
  assert.equal(saved.autorent_passive_account_id,201);
  assert.equal(apiPaths.filter(path=>path==='/api/accounting/chart-accounts').length,1,'El plan contable debe cargarse una sola vez al abrir el formulario.');
  console.log(JSON.stringify({passed:true,tabs:true,colombiaOnly:true,lazyAccountLoad:true,percentageShown:'1,10%',percentageSaved:0.011,globalAccountOptions:true}));
}finally{
  await browser.close();
}
