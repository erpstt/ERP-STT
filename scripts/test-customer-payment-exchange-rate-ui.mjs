import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const options={
  subsidiary:{id:1,name:'S.T.T. HOLDINGS LIMITED',currencyId:1},
  location:{id:1,name:'Jamaica'},
  customers:[{id:1,name:'EQUUS GLOBAL EXPANSION INC'}],
  accounts:[
    {id:10,bank:'JN Bank Limited',number:'JMD-001',currencyId:1,currency:'JMD',balance:100000},
    {id:20,bank:'JN Bank Limited',number:'USD-001',currencyId:2,currency:'USD',balance:100000},
    {id:30,bank:'JN Bank Limited',number:'EUR-001',currencyId:3,currency:'EUR',balance:100000},
    {id:40,bank:'JN Bank Limited',number:'GBP-001',currencyId:4,currency:'GBP',balance:100000}
  ],
  invoices:[
    {id:101,number:'FAC-JMD',customerId:1,date:'2026-10-01',dueDate:'2026-10-31',currencyId:1,currency:'JMD',balance:100},
    {id:102,number:'FAC-USD',customerId:1,date:'2026-10-01',dueDate:'2026-10-31',currencyId:2,currency:'USD',balance:100},
    {id:103,number:'FAC-EUR',customerId:1,date:'2026-10-01',dueDate:'2026-10-31',currencyId:3,currency:'EUR',balance:100},
    {id:104,number:'FAC-GBP',customerId:1,date:'2026-10-01',dueDate:'2026-10-31',currencyId:4,currency:'GBP',balance:100}
  ],
  periods:[
    {id:9,name:'septiembre 2026',start:'2026-09-01',end:'2026-09-30'},
    {id:10,name:'octubre 2026',start:'2026-10-01',end:'2026-10-31'}
  ],
  rates:[
    {fromCurrencyId:2,toCurrencyId:1,date:'2026-10-01',rate:155},
    {fromCurrencyId:2,toCurrencyId:1,date:'2026-10-20',rate:157.5},
    {fromCurrencyId:2,toCurrencyId:1,date:'2026-10-30',rate:160},
    {fromCurrencyId:1,toCurrencyId:3,date:'2026-10-10',rate:.005}
  ],
  advances:[],
  bankFeeAccount:{id:91,number:'629001',name:'Comisiones bancarias'}
};

const page=await browser.newPage({viewport:{width:1500,height:1000}});
page.setDefaultTimeout(15000);
const pageErrors=[];
page.on('pageerror',error=>pageErrors.push(error.message));
await page.addInitScript(()=>{
  localStorage.setItem('nexo_token','customer-payment-fx-token');
  localStorage.setItem('nexo_device_token','customer-payment-fx-device-123456');
});
await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/api/sales/customer-payments/options')return route.fulfill({json:options});
  if(path==='/api/sales/customer-payments/report')return route.fulfill({json:{rows:[]}});
  return route.fulfill({json:[]});
});

try{
  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await page.setContent('<iframe id="payment" src="http://localhost:3000/customer-payments.html?v=20261026-auto-exchange-rate" style="width:1460px;height:950px;border:0"></iframe>');
  const app=page.frameLocator('#payment');
  await app.locator('#new').click();
  await app.locator('#modal:not([hidden])').waitFor();

  const rate=app.locator('#rate'),date=app.locator('#date'),currency=app.locator('#currency');
  await date.fill('2026-10-24');
  await date.dispatchEvent('change');

  // La moneda funcional siempre se contabiliza a tasa 1.
  assert.equal(await currency.inputValue(),'1');
  assert.equal(Number(await rate.inputValue()),1,'La moneda funcional debe cargar tasa 1.');

  // Debe usar la tasa directa más reciente que no sea posterior a la fecha.
  await currency.selectOption('2');
  assert.equal(Number(await rate.inputValue()),157.5,'No se tomó la tasa USD→JMD vigente al 24/10/2026.');
  assert.equal(await rate.getAttribute('readonly'),'','La tasa oficial no debe poder modificarse manualmente.');
  const fallbackHelp=await app.locator('#rateHelp').textContent();
  assert.match(fallbackHelp,/(2026-10-24|24\/10\/2026)/,'El aviso no indica la fecha seleccionada que carece de tasa exacta.');
  assert.match(fallbackHelp,/(2026-10-20|20\/10\/2026)/,'El aviso no indica la fecha de la tasa anterior aplicada.');
  assert.match(fallbackHelp,/tasa (exacta|anterior)|anterior más cercana/i,'El aviso no explica que se usó la tasa anterior más cercana.');
  assert.equal(await app.locator('#rateField').evaluate(field=>field.classList.contains('rate-fallback')),true,'La tasa anterior debe mostrarse con estado visual de advertencia.');
  await date.fill('2026-10-15');
  await date.dispatchEvent('change');
  assert.equal(Number(await rate.inputValue()),155,'Cambiar la fecha no recalculó la tasa vigente.');

  // Cuando solo existe la cotización inversa, debe invertirla.
  await currency.selectOption('3');
  assert.equal(Number(await rate.inputValue()),200,'No se calculó la tasa inversa JMD→EUR.');

  // Cambiar nuevamente a la moneda funcional debe restablecer 1.
  await currency.selectOption('1');
  assert.equal(Number(await rate.inputValue()),1);

  // Sin tasa vigente el formulario debe quedar claramente bloqueado.
  await currency.selectOption('4');
  await app.locator('#customer').selectOption('1');
  await app.locator('#account').selectOption('40');
  await app.locator('#invoiceRows .apply[data-id="104"]').fill('100');
  assert.equal(await rate.inputValue(),'','Una moneda sin tasa no debe conservar una tasa anterior.');
  assert.match(await app.locator('#rateHelp').textContent(),/No existe un tipo de cambio/,'No se explica por qué falta la tasa.');
  assert.equal(await app.locator('#save').isDisabled(),true,'Guardar debe bloquearse cuando no existe tipo de cambio.');
  assert.equal(await app.locator('#entry').evaluate(form=>form.checkValidity()),false,'El formulario sin tasa no debe ser válido.');

  // Una fecha anterior a la primera cotización tampoco puede usar tasas futuras.
  await currency.selectOption('2');
  await date.fill('2026-09-15');
  await date.dispatchEvent('change');
  assert.equal(await rate.inputValue(),'','No debe utilizarse una tasa con fecha futura.');

  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({
    localCurrencyRate:true,directRateByDate:true,inverseRate:true,
    fallbackRateWarning:true,dateRecalculation:true,futureRateExcluded:true,
    missingRateBlocked:true,noPageErrors:true
  }));
}finally{
  await browser.close();
}
