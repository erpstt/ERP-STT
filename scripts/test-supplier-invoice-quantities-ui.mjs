import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','test');localStorage.setItem('nexo_company','1')});
 const data={
 'chart-accounts':[{account_id:10,account_number:'1204',account_name:'Equipo',category:'Activo',account_group_id:1,subsidiary_id:1,accepts_entries:true}],
 'account-groups':[{group_id:1,group_name:'Propiedad, Planta y Equipo'}],
 suppliers:[{supplier_id:1,company_name:'Proveedor',subsidiary_id:1,payment_term_id:1}],
 'payment-terms':[{term_id:1,term_name:'Contado',days_due:0}],
 subsidiaries:[{subsidiary_id:1,name:'Empresa',currency_id:1}],
 locations:[{location_id:1,name:'Oficina',subsidiary_id:1}],
 currencies:[{currency_id:1,currency_code:'USD',name:'Dólar'}],
 'accounting-periods':[{fiscal_period_id:1,subsidiary_id:1,period_name:'Abierto',start_date:'2020-01-01',end_date:'2099-12-31'}],
 'tax-codes':[{tax_code_id:1,code_name:'IVA',rate_percentage:13,subsidiary_id:1}]
 };let payload;
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;if(path==='/api/purchasing/supplier-invoice-entry'){payload=route.request().postDataJSON();return route.fulfill({json:{invoiceId:1,journalId:1,total:16950}})}return route.fulfill({json:data[path.split('/').at(-1)]||[]})});
 await page.goto('http://localhost:3000/');await page.setContent('<iframe id="app" src="/supplier-invoice-entry.html" style="width:100%;height:950px;border:0"></iframe>');const app=page.frameLocator('#app');
 await app.locator('[data-key=quantity]').waitFor();assert.equal(await app.locator('[data-key=quantity]').inputValue(),'1,00');assert.equal(await app.locator('[data-key=unit_price]').inputValue(),'0,00');assert.equal(await app.locator('[data-key=amount]').inputValue(),'0,00');
 await app.locator('#invoiceType').selectOption('Factura Activos Fijos');await app.locator('.account-search').fill('1204');await app.locator('.account-search').dispatchEvent('change');
 await app.locator('[data-key=quantity]').fill('10');await app.locator('[data-key=unit_price]').fill('1500');await app.locator('[data-key=tax_code_id]').selectOption('1');assert.equal(await app.locator('[data-key=amount]').inputValue(),'15\u00a0000,00');assert.equal(await app.locator('[data-key=tax_amount]').inputValue(),'1\u00a0950,00');
 await app.locator('#invoiceType').selectOption('Factura estándar');assert.equal(await app.locator('[data-key=quantity]').inputValue(),'10,00');assert.equal(await app.locator('[data-key=amount]').inputValue(),'15\u00a0000,00');
 await app.locator('#invoiceNumber').fill('QTY-TEST');await app.locator('#supplier').selectOption('1');await app.locator('#save').click();await app.locator('#successModal').waitFor({state:'visible'});assert.equal(payload.lines[0].quantity,10);assert.equal(payload.lines[0].unit_price,1500);assert.equal(payload.lines[0].amount,15000);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({quantity:true,unitPrice:true,automaticAmount:true,tax:true,typeChangePreservesQuantity:true,payload:true,noNaN:true}));
}finally{await browser.close()}
