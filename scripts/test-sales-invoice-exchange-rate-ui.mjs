import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});
const page=await browser.newPage({viewport:{width:1500,height:1000}});
page.setDefaultTimeout(15000);
const pageErrors=[];
let savedPayload=null;
page.on('pageerror',error=>pageErrors.push(error.message));
await page.addInitScript(()=>{
  localStorage.setItem('nexo_token','sales-invoice-fx-token');
  localStorage.setItem('nexo_device_token','sales-invoice-fx-device');
  localStorage.setItem('nexo_company','24');
});

const fixtures={
  '/api/sales/invoices':[],
  '/api/sales/sales-invoice-lines':[],
  '/api/sales/sales-invoice-withholdings':[],
  '/api/entities/customers':[{customer_id:7,company_name:'CLIENTE PRUEBA',payment_term_id:2,department_id:3,subsidiary_ids:[24]}],
  '/api/inventory/products':[{product_id:9,item_code:'SERV',display_name:'Servicio',sales_price:100,sales_account_id:31,is_active:true,product_usage:'Venta',subsidiary_ids:[24]}],
  '/api/configuration/tax-codes':[],
  '/api/configuration/tax-types':[],
  '/api/configuration/payment-terms':[{term_id:2,term_name:'Neto 30'}],
  '/api/organization/accounting-periods':[{fiscal_period_id:10,period_name:'octubre 2026',start_date:'2026-10-01',end_date:'2026-10-31',subsidiary_id:24,is_closed:false,ar_closed:false}],
  '/api/core/currencies':[
    {currency_id:1,currency_code:'JMD',name:'Dólar jamaicano'},
    {currency_id:2,currency_code:'USD',name:'Dólar estadounidense'},
    {currency_id:3,currency_code:'EUR',name:'Euro'},
    {currency_id:4,currency_code:'GBP',name:'Libra esterlina'}
  ],
  '/api/configuration/exchange-rates':[
    {from_currency_id:2,to_currency_id:1,effective_date:'2026-10-01',spot_rate:155},
    {from_currency_id:2,to_currency_id:1,effective_date:'2026-10-20',spot_rate:157.5},
    {from_currency_id:2,to_currency_id:1,effective_date:'2026-10-30',spot_rate:160},
    {from_currency_id:1,to_currency_id:3,effective_date:'2026-10-10',spot_rate:.005}
  ],
  '/api/core/countries':[{country_id:1,name:'Jamaica'}],
  '/api/organization/subsidiaries':[{subsidiary_id:24,name:'S.T.T. HOLDINGS LIMITED',currency_id:1,country_id:1,allowed_currency_ids:[1,2,3,4]}],
  '/api/organization/locations':[{location_id:5,name:'Jamaica',subsidiary_ids:[24]}],
  '/api/organization/departments':[{department_id:3,name:'VENTAS',subsidiary_ids:[24]}],
  '/api/organization/cost-centers':[],
  '/api/organization/classes':[],
  '/api/accounting/chart-accounts':[{account_id:30,account_number:'113001',account_name:'Cuentas por Cobrar Clientes',category:'Activo',nature:'Deudora',financial_statement:'Balance General',accepts_entries:true,is_inactive:false,subsidiary_ids:[24]}],
  '/api/accounting/gl-impacts':[],
  '/api/accounting/journal-supports':[]
};

await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/api/sales/invoice-entry'&&request.method()==='POST'){
    savedPayload=request.postDataJSON();
    return route.fulfill({json:{invoiceId:99,journalId:88,transactionNumber:'FAC-00000679',total:100}});
  }
  return route.fulfill({json:fixtures[path]??[]});
});

try{
  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await page.setContent('<iframe id="invoice" src="http://localhost:3000/sales-invoice-entry.html?v=20261026-official-fx" style="width:1460px;height:950px;border:0"></iframe>');
  const app=page.frameLocator('#invoice');
  await app.locator('#rateHelp').waitFor();
  const date=app.locator('#date'),currency=app.locator('#currency'),rate=app.locator('#rate');

  await date.fill('2026-10-24');
  await date.dispatchEvent('change');
  assert.equal(Number(await rate.inputValue()),1,'La moneda funcional debe usar tasa 1.');

  await currency.selectOption('2');
  assert.equal(Number(await rate.inputValue()),157.5,'No tomó la tasa USD→JMD anterior más cercana.');
  assert.equal(await rate.getAttribute('readonly'),'','La tasa oficial debe ser de solo lectura.');
  assert.match(await app.locator('#rateHelp').textContent(),/24\/10\/2026/,'El aviso no muestra la fecha de la factura.');
  assert.match(await app.locator('#rateHelp').textContent(),/20\/10\/2026/,'El aviso no muestra la fecha de la tasa aplicada.');
  assert.equal(await app.locator('#rateField').evaluate(node=>node.classList.contains('rate-fallback')),true);

  await date.fill('2026-10-20');
  await date.dispatchEvent('change');
  assert.equal(Number(await rate.inputValue()),157.5,'No tomó la tasa exacta.');
  assert.match(await app.locator('#rateHelp').textContent(),/Tasa configurada/i);
  assert.equal(await app.locator('#rateField').evaluate(node=>node.classList.contains('rate-ready')),true);

  await currency.selectOption('3');
  assert.equal(Number(await rate.inputValue()),200,'No calculó correctamente una cotización inversa.');
  assert.match(await app.locator('#rateHelp').textContent(),/cotización inversa/i);

  await currency.selectOption('4');
  assert.equal(await rate.inputValue(),'','Una moneda sin tasa no debe conservar el valor anterior.');
  assert.match(await app.locator('#rateHelp').textContent(),/No existe un tipo de cambio/i);
  assert.equal(await app.locator('#save').isDisabled(),true,'Guardar debe quedar bloqueado sin tasa.');

  await currency.selectOption('2');
  await date.fill('2026-09-15');
  await date.dispatchEvent('change');
  assert.equal(await rate.inputValue(),'','No debe utilizar tasas futuras.');

  await date.fill('2026-10-20');
  await date.dispatchEvent('change');
  await app.locator('#customer').selectOption('7');
  await app.locator('#lines [data-k="product_id"]').selectOption('9');
  await app.locator('#lines [data-k="unit_price"]').fill('100');
  await app.locator('#lines [data-k="unit_price"]').dispatchEvent('blur');
  await app.locator('#save').click();
  await app.locator('#successModal:not([hidden])').waitFor();
  assert.equal(Number(savedPayload.exchange_rate),157.5,'El payload no envió la tasa oficial mostrada.');
  assert.deepEqual(pageErrors,[]);

  console.log(JSON.stringify({
    localCurrencyRate:true,directRateByDate:true,inverseRate:true,
    fallbackWarning:true,dateAndCurrencyRecalculation:true,
    missingRateBlocked:true,futureRateExcluded:true,readonly:true,
    officialRateSubmitted:true,noPageErrors:true
  }));
}finally{
  await browser.close();
}
