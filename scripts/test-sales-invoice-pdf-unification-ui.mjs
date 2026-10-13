import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const invoice={
  invoice_id:77,invoice_number:'FAC-VEN-77',subsidiary_id:1,customer_id:1,
  payment_term_id:1,invoice_date:'2026-10-10',due_date:'2026-10-25',
  fiscal_period_id:1,currency_id:1,exchange_rate:1,memo:'Servicios profesionales',
  transaction_id:500,journal_id:600,location_id:1,total_amount:113,
  receivable_amount:113,unificar_lineas_pdf:true
};

const invoiceLine={
  line_id:88,invoice_id:77,product_id:10,quantity:1,unit_price:100,amount:100,
  tax_code_id:5,tax_rate:13,tax_amount:13,gross_amount:113,
  service_country_id:1,service_month:'2026-10',note:'Servicio de octubre'
};

const baseResponses=edit=>({
  '/api/sales/invoices':edit?[invoice]:[],
  '/api/sales/sales-invoice-lines':edit?[invoiceLine]:[],
  '/api/sales/sales-invoice-withholdings':[],
  '/api/entities/customers':[{customer_id:1,company_name:'Cliente de pruebas',email:'cliente@example.test',subsidiary_ids:[1],payment_term_id:1}],
  '/api/inventory/products':[{product_id:10,item_code:'SERV-01',display_name:'Servicio profesional',is_active:true,product_usage:'Venta',sales_price:100,subsidiary_ids:[1]}],
  '/api/configuration/tax-codes':[{tax_code_id:5,code_name:'IVA 13%',rate_percentage:13,is_withholding:false,subsidiary_ids:[1]}],
  '/api/configuration/tax-types':[],
  '/api/configuration/payment-terms':[{term_id:1,term_name:'Neto 15'}],
  '/api/configuration/uom':[],
  '/api/organization/accounting-periods':[{fiscal_period_id:1,period_name:'Octubre 2026',start_date:'2026-10-01',end_date:'2026-10-31',subsidiary_id:1,is_closed:false,ar_closed:false}],
  '/api/core/currencies':[{currency_id:1,currency_code:'USD',symbol:'US$',name:'Dólar estadounidense'}],
  '/api/core/countries':[{country_id:1,name:'Costa Rica'}],
  '/api/organization/subsidiaries':[{subsidiary_id:1,name:'Empresa de pruebas',country_id:1,currency_id:1,address:'San José'}],
  '/api/organization/locations':[{location_id:1,name:'Principal',subsidiary_id:1}],
  '/api/organization/departments':[],
  '/api/organization/cost-centers':[],
  '/api/organization/classes':[],
  '/api/accounting/chart-accounts':[],
  '/api/accounting/gl-impacts':[],
  '/api/accounting/journal-supports':[]
});

async function openInvoice({edit=false}={}){
  const owner=await browser.newPage({viewport:{width:1500,height:1000}});
  const errors=[],requests=[],responses=baseResponses(edit);
  owner.on('pageerror',error=>errors.push(error.message));
  await owner.addInitScript(()=>{
    localStorage.setItem('nexo_token','test-session');
    localStorage.setItem('nexo_device_token','test-device');
    localStorage.setItem('nexo_company','1');
  });
  await owner.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
    const body=request.postData()?request.postDataJSON():undefined;
    requests.push({path,method,body});
    if(path==='/api/sales/invoice-entry'&&method==='POST'){
      return route.fulfill({json:{invoiceId:91,journalId:691,transactionNumber:'FAC-VEN-91',total:113}});
    }
    if(path==='/api/sales/invoices/77/pdf-line-unification'&&method==='PUT'){
      return route.fulfill({json:{invoiceId:77,unifyLinesPdf:body.unificar_lineas_pdf}});
    }
    if(path==='/api/sales/invoice-entry/77'&&method==='PUT'){
      return route.fulfill({json:{invoiceId:77,journalId:600,transactionNumber:'FAC-VEN-77',total:113}});
    }
    return route.fulfill({json:responses[path]??[]});
  });
  await owner.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await owner.setContent('<iframe id="invoice"></iframe>');
  const frame=owner.frames().find(item=>item!==owner.mainFrame());
  await frame.goto(`http://localhost:3000/sales-invoice-entry.html${edit?'?id=77':''}`);
  await frame.locator('#customer option[value="1"]').waitFor({state:'attached'});
  await frame.locator('[data-k="product_id"] option[value="10"]').first().waitFor({state:'attached'});
  return{owner,frame,errors,requests};
}

async function completeNewInvoice(page){
  await page.frame.locator('#date').fill('2026-10-10');
  await page.frame.locator('#date').dispatchEvent('change');
  await page.frame.locator('#customer').selectOption('1');
  await page.frame.locator('[data-k="product_id"]').first().selectOption('10');
}

async function saveAndPayload(page,path,method){
  await page.frame.locator('#save').click();
  await page.frame.locator('#successModal').waitFor({state:'visible'});
  const request=page.requests.find(item=>item.path===path&&item.method===method);
  assert.ok(request,`No se registró la solicitud ${method} ${path}.`);
  return request.body;
}

try{
  const normal=await openInvoice();
  const toggle=normal.frame.locator('#unifyPdfLines');
  assert.equal(await toggle.getAttribute('role'),'switch');
  assert.equal(await toggle.isChecked(),false,'La opción debe iniciar desactivada en una factura nueva.');
  assert.equal(
    (await normal.frame.locator('label[for="unifyPdfLines"] strong').textContent()).trim(),
    'Unificar líneas en el PDF por tipo de impuesto'
  );
  assert.match(
    await normal.frame.locator('.invoice-pdf-option-copy>small').textContent(),
    /Solo cambia la presentación del PDF.*líneas originales.*contabilización.*intactas/i
  );
  await completeNewInvoice(normal);
  const normalPayload=await saveAndPayload(normal,'/api/sales/invoice-entry','POST');
  assert.equal(normalPayload.unificar_lineas_pdf,false);
  assert.equal(typeof normalPayload.unificar_lineas_pdf,'boolean');
  assert.deepEqual(normal.errors,[]);
  await normal.owner.close();

  const unified=await openInvoice();
  await completeNewInvoice(unified);
  await unified.frame.locator('label[for="unifyPdfLines"] .gentia-switch-track').click();
  assert.equal(await unified.frame.locator('#unifyPdfLines').isChecked(),true);
  const unifiedPayload=await saveAndPayload(unified,'/api/sales/invoice-entry','POST');
  assert.equal(unifiedPayload.unificar_lineas_pdf,true);
  assert.equal(typeof unifiedPayload.unificar_lineas_pdf,'boolean');
  assert.deepEqual(unified.errors,[]);
  await unified.owner.close();

  const edited=await openInvoice({edit:true});
  const editToggle=edited.frame.locator('#unifyPdfLines');
  assert.equal(await editToggle.isChecked(),true,'La edición debe cargar la opción guardada en la factura.');
  await edited.frame.locator('label[for="unifyPdfLines"] .gentia-switch-track').click();
  await edited.frame.locator('#unifyPdfStatus.success').waitFor({state:'visible'});
  assert.equal(await editToggle.isChecked(),false);
  const preferenceRequest=edited.requests.find(item=>item.path==='/api/sales/invoices/77/pdf-line-unification'&&item.method==='PUT');
  assert.ok(preferenceRequest,'Cambiar la preferencia debe usar el endpoint dedicado.');
  assert.deepEqual(preferenceRequest.body,{unificar_lineas_pdf:false});
  assert.equal(edited.requests.some(item=>item.path==='/api/sales/invoice-entry/77'&&item.method==='PUT'),false,'La preferencia no debe recontabilizar la factura.');
  const editedPayload=await saveAndPayload(edited,'/api/sales/invoice-entry/77','PUT');
  assert.equal(editedPayload.unificar_lineas_pdf,false);
  assert.equal(typeof editedPayload.unificar_lineas_pdf,'boolean');
  assert.deepEqual(edited.errors,[]);
  await edited.owner.close();

  console.log(JSON.stringify({
    passed:true,professionalSwitch:true,defaultOff:true,createFalse:true,
    createTrue:true,editLoad:true,editUpdate:true,dedicatedEditPersistence:true,booleanPayload:true
  }));
}finally{
  await browser.close();
}
