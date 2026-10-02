import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});

const journal={
  journal_id:77,journal_number:'ASI_PEN-00000077',journal_type:'Asientos Pendientes de Facturar',
  journal_date:'2026-09-15',subsidiary_id:1,currency_id:1,fiscal_period_id:1,exchange_rate:1,
  memo:'Servicios regionales pendientes',location_id:1,total_debit:10,total_credit:10,transaction_id:500
};
const journalLines=[
  {journal_line_id:1,journal_id:77,account_id:10,debit:10,credit:0,gross_amount:10,service_month:'2026-09',service_country_id:1,note:'Servicio CR'},
  {journal_line_id:2,journal_id:77,account_id:20,debit:0,credit:10,gross_amount:10,service_month:'2026-09',service_country_id:3,note:'Servicio PA'}
];
const reversalJournal={
  ...journal,
  journal_id:88,
  journal_number:'ASI_REV_PEN-00000088',
  journal_type:'Reversión de Pendiente de Facturar',
  memo:'Reversión de servicios regionales pendientes',
  transaction_id:501,
  reversed_from_journal_id:77
};
const reversalLines=journalLines.map((line,index)=>(
  {
    ...line,
    journal_line_id:index+11,
    journal_id:88,
    debit:line.credit,
    credit:line.debit,
    note:`Reversión ${line.note}`
  }
));
const common={
  '/api/accounting/chart-accounts':[
    {account_id:10,account_number:'1000',account_name:'Cuenta débito',accepts_entries:true,subsidiary_ids:[1]},
    {account_id:20,account_number:'2000',account_name:'Cuenta crédito',accepts_entries:true,subsidiary_ids:[1]}
  ],
  '/api/configuration/tax-codes':[],
  '/api/configuration/tax-types':[],
  '/api/organization/departments':[],
  '/api/organization/classes':[],
  '/api/organization/cost-centers':[],
  '/api/organization/financial-creditors':[],
  '/api/organization/related-companies':[],
  '/api/entities/customers':[],
  '/api/entities/suppliers':[],
  '/api/entities/employees':[],
  '/api/organization/accounting-periods':[{fiscal_period_id:1,subsidiary_id:1,period_name:'Ejercicio 2026',start_date:'2026-01-01',end_date:'2026-12-31',is_inactive:false}],
  '/api/core/currencies':[{currency_id:1,currency_code:'USD',name:'Dólar estadounidense'}],
  '/api/core/transaction-types':[
    {transaction_type_id:1,abbreviation:'ASI_DIA',name:'Asiento de Diario General'},
    {transaction_type_id:2,abbreviation:'ASI_PEN',name:'Asientos Pendientes de Facturar'}
  ],
  '/api/configuration/exchange-rates':[],
  '/api/core/countries':[
    {country_id:1,country_code_iso2:'CR',name:'Costa Rica'},
    {country_id:2,country_code_iso2:'JM',name:'Jamaica'},
    {country_id:3,country_code_iso2:'PA',name:'Panamá'}
  ],
  '/api/organization/subsidiaries':[{subsidiary_id:1,name:'Empresa prueba',country_id:2,currency_id:1}],
  '/api/organization/locations':[{location_id:1,name:'Principal',subsidiary_id:1}],
  '/api/accounting/journal-supports':[],
  '/api/auth/companies':[{subsidiaryId:1,name:'Empresa prueba'}],
  '/api/accounting/gl-impacts':[]
};

async function open(path,{edit=false,capture=false,reversal=false}={}){
  const page=await browser.newPage({viewport:{width:1700,height:1000}}),errors=[];
  let payload;
  const selectedJournal=reversal?reversalJournal:journal,selectedLines=reversal?reversalLines:journalLines;
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('nexo_token','test');
    localStorage.setItem('nexo_device_token','device');
    localStorage.setItem('nexo_company','1');
    localStorage.setItem('nexo_company_name','Empresa prueba');
  });
  await page.route('**/api/**',route=>{
    const request=route.request(),url=new URL(request.url()),pathname=url.pathname;
    if(capture&&(/^\/api\/accounting\/journal-entry(?:\/77)?$/.test(pathname))&&['POST','PUT'].includes(request.method())){
      payload=request.postDataJSON();
      return route.fulfill({json:{journalId:request.method()==='PUT'?77:99}});
    }
    const response=pathname==='/api/accounting/journals'?(edit?[selectedJournal]:[]):
      pathname==='/api/accounting/journal-lines'?(edit?selectedLines:[]):common[pathname]??[];
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});
  });
  await page.goto('http://localhost:3000/');
  await page.setContent('<iframe id="journal-test"></iframe>');
  const frame=page.frames().find(item=>item!==page.mainFrame());
  await frame.goto(`http://localhost:3000${path}`);
  return{page:frame,ownerPage:page,errors,getPayload:()=>payload};
}

try{
  const created=await open('/journal-entry.html',{capture:true});
  try{await created.page.locator('#lines tr').first().waitFor({timeout:7000});}
  catch(error){console.error(JSON.stringify({url:created.page.url(),errors:created.errors,body:await created.page.locator('body').innerText()}));throw error;}
  assert.equal(await created.page.locator('.service-country-column').first().isHidden(),true);
  assert.equal(await created.page.locator('.service-month-column').first().isHidden(),true);
  await created.page.locator('#journalType').selectOption({label:'Asientos Pendientes de Facturar'});
  const countryFields=created.page.locator('[data-key="service_country_id"]');
  const monthFields=created.page.locator('[data-key="service_month"]');
  assert.equal(await created.page.locator('.service-country-column').first().isVisible(),true);
  assert.equal(await created.page.locator('.service-month-column').first().isVisible(),true);
  assert.deepEqual(await countryFields.first().locator('option').allTextContents(),['Seleccione un país','Costa Rica','Jamaica','Panamá']);
  assert.deepEqual(await countryFields.evaluateAll(fields=>fields.map(field=>field.value)),['2','2']);

  const rows=created.page.locator('#lines tr');
  await rows.nth(0).locator('.account-search').fill('1000 - Cuenta débito');
  await rows.nth(1).locator('.account-search').fill('2000 - Cuenta crédito');
  await rows.nth(0).locator('[data-key="debit"]').fill('10');
  await rows.nth(1).locator('[data-key="credit"]').fill('10');
  await monthFields.nth(0).fill('2026-08');
  await monthFields.nth(1).fill('2026-09');
  await countryFields.nth(0).selectOption('');
  await countryFields.nth(1).selectOption('3');
  await created.page.locator('#save').click();
  assert.match(await created.page.locator('#error').textContent(),/Seleccione el País de servicio/);
  await countryFields.nth(0).selectOption('1');
  await created.page.locator('#save').click();
  await created.page.locator('#successModal').waitFor({state:'visible'});
  assert.deepEqual(created.getPayload().lines.map(line=>line.service_month),['2026-08','2026-09']);
  assert.deepEqual(created.getPayload().lines.map(line=>String(line.service_country_id)),['1','3']);
  assert.deepEqual(created.errors,[]);
  await created.ownerPage.close();

  const edited=await open('/journal-entry.html?id=77',{edit:true,capture:true});
  await edited.page.locator('[data-key="service_month"]').first().waitFor();
  await edited.page.locator('[data-key="service_country_id"]').first().waitFor();
  assert.deepEqual(await edited.page.locator('[data-key="service_month"]').evaluateAll(fields=>fields.map(field=>field.value)),['2026-09','2026-09']);
  assert.deepEqual(await edited.page.locator('[data-key="service_country_id"]').evaluateAll(fields=>fields.map(field=>field.value)),['1','3']);
  await edited.page.locator('[data-key="service_month"]').first().fill('2026-10');
  await edited.page.locator('#save').click();
  await edited.page.locator('#successModal').waitFor({state:'visible'});
  assert.deepEqual(edited.getPayload().lines.map(line=>line.service_month),['2026-10','2026-09']);
  assert.deepEqual(edited.getPayload().lines.map(line=>String(line.service_country_id)),['1','3']);
  assert.deepEqual(edited.errors,[]);
  await edited.ownerPage.close();

  const viewed=await open('/journal-view.html?id=77',{edit:true});
  await viewed.page.locator('#document:not([hidden])').waitFor();
  assert.equal(await viewed.page.locator('th.service-dimension-column',{hasText:'Mes de servicio'}).isVisible(),true);
  assert.equal(await viewed.page.locator('th.service-dimension-column',{hasText:'País de servicio'}).isVisible(),true);
  assert.match(await viewed.page.locator('#lines').textContent(),/2026-09/);
  assert.match(await viewed.page.locator('#lines').textContent(),/Costa Rica/);
  assert.match(await viewed.page.locator('#lines').textContent(),/Panamá/);
  assert.deepEqual(viewed.errors,[]);
  await viewed.ownerPage.close();

  const reversalViewed=await open('/journal-view.html?id=88',{edit:true,reversal:true});
  await reversalViewed.page.locator('#document:not([hidden])').waitFor();
  assert.equal(await reversalViewed.page.locator('th.service-dimension-column',{hasText:'Mes de servicio'}).isVisible(),true);
  assert.equal(await reversalViewed.page.locator('th.service-dimension-column',{hasText:'País de servicio'}).isVisible(),true);
  assert.match(await reversalViewed.page.locator('#lines').textContent(),/2026-09/);
  assert.match(await reversalViewed.page.locator('#lines').textContent(),/Costa Rica/);
  assert.match(await reversalViewed.page.locator('#lines').textContent(),/Panamá/);
  assert.deepEqual(reversalViewed.errors,[]);
  await reversalViewed.ownerPage.close();

  console.log(JSON.stringify({passed:true,conditionalColumns:true,coreCatalog:true,subsidiaryDefault:true,requiredCountry:true,createPayload:true,editPersistence:true,pendingView:true,reversalView:true}));
}finally{
  await browser.close();
}
