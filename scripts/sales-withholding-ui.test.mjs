import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage();page.setDefaultTimeout(7000);
const responses={
 '/api/sales/invoices':[], '/api/sales/sales-invoice-lines':[], '/api/sales/sales-invoice-withholdings':[],
 '/api/entities/customers':[{customer_id:1,company_name:'Cliente con retención',subsidiary_ids:[1],payment_term_id:1,withholding_rules:[{subsidiary_id:1,tax_code_id:20}]}],
 '/api/inventory/products':[{product_id:1,item_code:'SERV',display_name:'Servicio',is_active:true,product_usage:'Venta',sales_price:100,subsidiary_ids:[1]}],
 '/api/configuration/tax-codes':[{tax_code_id:10,code_name:'IVA 13',rate_percentage:13,is_withholding:false,subsidiary_ids:[1]},{tax_code_id:20,tax_type_id:2,code_name:'RET VENTAS 2',rate_percentage:2,is_withholding:true,withholding_calculation_base:'Total de la factura con impuestos',withholding_application_moment:'Al registrar la factura',subsidiary_ids:[1]}],
 '/api/configuration/tax-types':[{tax_type_id:2,type_name:'Retención de renta',asset_account_id:50}],
 '/api/configuration/payment-terms':[{term_id:1,term_name:'Contado'}],
 '/api/organization/accounting-periods':[{fiscal_period_id:1,period_name:'Septiembre 2026',start_date:'2026-09-01',end_date:'2026-09-30',subsidiary_id:1,is_closed:false,ar_closed:false}],
 '/api/core/currencies':[{currency_id:1,currency_code:'CRC',name:'Colón'}],
 '/api/organization/subsidiaries':[{subsidiary_id:1,name:'Empresa',currency_id:1}],
 '/api/organization/locations':[{location_id:1,name:'Principal',subsidiary_id:1}],
 '/api/organization/departments':[], '/api/organization/cost-centers':[], '/api/organization/classes':[],
 '/api/accounting/chart-accounts':[{account_id:50,account_number:'1350',account_name:'Retenciones por cobrar',subsidiary_id:1}],
 '/api/accounting/gl-impacts':[], '/api/accounting/journal-supports':[]
};
await page.route('**/api/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(responses[new URL(route.request().url()).pathname]??[])}));
try{
 await page.goto('http://localhost:3000/');await page.evaluate(()=>{localStorage.setItem('nexo_token','test');localStorage.setItem('nexo_company','1')});
 await page.setContent('<iframe id="app"></iframe>');const frame=page.frames().find(item=>item!==page.mainFrame());await frame.goto('http://localhost:3000/sales-invoice-entry.html');
 await frame.selectOption('#customer','1');await frame.selectOption('[data-k=product_id]','1');await frame.selectOption('[data-k=tax_code_id]','10');
 assert.equal(await frame.locator('#withholdingCount').textContent(),'1');
 assert.equal(await frame.locator('#total').textContent(),'113,00');
 assert.equal(await frame.locator('#withholdingTotal').textContent(),'2,26');
 assert.equal(await frame.locator('#receivableTotal').textContent(),'110,74');
 await frame.click('#withholdingsTab');
 assert.match(await frame.locator('#withholdingLines').textContent(),/Sobre el total de la factura \(incluye impuestos\)/);
 assert.match(await frame.locator('#withholdingLines').textContent(),/Retenciones por cobrar/);
 console.log(JSON.stringify({passed:true,total:113,withholding:2.26,receivable:110.74,understandableBase:true}));
}finally{await browser.close()}
