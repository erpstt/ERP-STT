import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
  const page=await browser.newPage({viewport:{width:1500,height:1000}});page.setDefaultTimeout(12000);
  await page.addInitScript(()=>{localStorage.setItem('nexo_token','customer-payment-edit-token');localStorage.setItem('nexo_device_token','customer-payment-edit-device-token-123456')});
  const common={subsidiary:{id:1,name:'EMPRESA DE PRUEBAS',currencyId:1},location:{id:1,name:'Jamaica'},customers:[{id:1,name:'Cliente 1'}],accounts:[{id:1,bank:'JN Bank Limited',number:'123445685961',currencyId:1,currency:'JMD',balance:100000}],periods:[{id:1,name:'septiembre 2026',start:'2026-09-01',end:'2026-09-30'}],rates:[],advances:[]};
  const pending={id:3,number:'FAC_VEN-00000003',customerId:1,date:'2026-09-09',dueDate:'2026-10-09',currencyId:1,currency:'JMD',total:100,receivable:100,debitNotes:0,creditNotes:0,paid:0,currentApplied:0,balance:100,editableBalance:100};
  const applied={id:2,number:'FAC_VEN-00000002',customerId:1,date:'2026-09-03',dueDate:'2026-10-03',currencyId:1,currency:'JMD',total:172500,receivable:172500,debitNotes:28750,creditNotes:75000,paid:172500,currentApplied:94985,balance:0,editableBalance:48735};
  const detail={header:{payment_id:27,payment_number:'COB_CLI-20260930225322167',customer_id:1,currency_id:1,bank_account_id:1,payment_date:'2026-09-30',exchange_rate:1,bank_reference:'12345',memo:'pago'},applications:[{application_id:30,payment_id:27,invoice_id:2,amount:94985,application_date:'2026-09-30',invoiceNumber:'FAC_VEN-00000002',invoiceTotal:172500}],advances:[],impact:[]};
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(path==='/api/sales/customer-payments/options')return route.fulfill({json:{...common,invoices:url.searchParams.get('paymentId')?[applied,pending]:[pending]}});
    if(path==='/api/sales/customer-payments/report')return route.fulfill({json:{rows:[{id:27,date:'2026-09-30',number:'COB_CLI-20260930225322167',customer:'Cliente 1',bank:'JN Bank Limited',account:'123445685961',reference:'12345',currency:'JMD',amount:94985,advanceTotal:0}]}});
    if(path==='/api/sales/customer-payments/27')return route.fulfill({json:detail});
    return route.fulfill({json:[]});
  });
  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await page.setContent('<iframe id="payment" src="http://localhost:3000/customer-payments.html" style="width:1460px;height:950px;border:0"></iframe>');
  const app=page.frameLocator('#payment');
  await app.getByText('COB_CLI-20260930225322167',{exact:true}).waitFor();
  await app.locator('[data-edit="27"]').click();
  await app.locator('#modal:not([hidden])').waitFor();
  assert.equal((await app.locator('#entryMode').innerText()).trim(),'EDITAR · COB_CLI');
  assert.equal((await app.locator('#save').innerText()).trim(),'Guardar cambios');
  const appliedRow=app.locator('#invoiceRows tr').filter({hasText:'FAC_VEN-00000002'});await appliedRow.waitFor();
  const input=appliedRow.locator('.apply');assert.equal(await input.inputValue(),'94985');assert.equal(await input.getAttribute('max'),'48735');
  assert.match(await appliedRow.innerText(),/Aplicado actual: 94\s985,00/);assert.match(await appliedRow.innerText(),/Máximo permitido: 48\s735,00/);assert.match(await appliedRow.innerText(),/Reduzca el importe para poder guardar/);
  assert.match((await app.locator('#total').innerText()).trim(),/94\s985,00/);
  assert.equal(await app.locator('#invoiceRows tr').count(),2);
  assert.equal(await app.locator('#entry').evaluate(form=>form.checkValidity()),false);
  await page.screenshot({path:'.tmp/customer-payment-edit-ui.png',fullPage:true});
  console.log(JSON.stringify({ui:true,editMode:true,appliedInvoiceVisible:true,appliedAmount:94985,editableBalance:48735,overapplicationVisible:true,pendingInvoicePreserved:true}));
}finally{await browser.close()}

