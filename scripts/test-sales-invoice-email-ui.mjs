import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});

const baseResponses=({edit=false,supports=[]}={})=>({
  '/api/sales/invoices':edit?[{invoice_id:77,invoice_number:'FAC-VEN-77',subsidiary_id:1,customer_id:1,payment_term_id:1,invoice_date:'2026-09-15',due_date:'2026-09-30',fiscal_period_id:1,currency_id:1,exchange_rate:1,memo:'Servicio regional',transaction_id:500,journal_id:600,total_amount:113,receivable_amount:113}]:[],
  '/api/sales/sales-invoice-lines':edit?[{line_id:88,invoice_id:77,product_id:10,quantity:1,unit_price:100,amount:100,tax_code_id:5,tax_rate:13,tax_amount:13,gross_amount:113,service_month:'2026-09',service_country_id:1,note:'Servicio en Costa Rica'}]:[],
  '/api/sales/sales-invoice-withholdings':[],
  '/api/entities/customers':[{customer_id:1,company_name:'Cliente regional',email:'facturas@cliente.test',phone:'2222-2222',tax_id:'3-101-123456',address:'San José',subsidiary_ids:[1],payment_term_id:1}],
  '/api/inventory/products':[{product_id:10,item_code:'SERV-REG',display_name:'Servicio regional',is_active:true,product_usage:'Venta',sales_price:100,subsidiary_ids:[1]}],
  '/api/configuration/tax-codes':[{tax_code_id:5,code_name:'IVA 13%',rate_percentage:13,is_withholding:false,subsidiary_ids:[1]}],
  '/api/configuration/tax-types':[],
  '/api/configuration/payment-terms':[{term_id:1,term_name:'Contado'}],
  '/api/organization/accounting-periods':[{fiscal_period_id:1,period_name:'Septiembre 2026',start_date:'2026-09-01',end_date:'2026-09-30',subsidiary_id:1,is_closed:false,ar_closed:false}],
  '/api/core/currencies':[{currency_id:1,currency_code:'USD',symbol:'US$',name:'Dólar estadounidense'}],
  '/api/core/countries':[{country_id:1,name:'Costa Rica'}],
  '/api/organization/subsidiaries':[{subsidiary_id:1,name:'Empresa de pruebas',country_id:1,currency_id:1,address:'San José'}],
  '/api/organization/locations':[{location_id:1,name:'Principal',subsidiary_id:1}],
  '/api/organization/departments':[],
  '/api/organization/cost-centers':[],
  '/api/organization/classes':[],
  '/api/accounting/chart-accounts':[],
  '/api/accounting/gl-impacts':[],
  '/api/accounting/journal-supports':supports,
  '/api/configuration/uom':[]
});

async function framePage({edit=false,supports=[]}={}){
  const owner=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[],requests=[],responses=baseResponses({edit,supports});
  owner.on('pageerror',error=>errors.push(error.message));
  await owner.addInitScript(()=>{localStorage.setItem('nexo_token','test-session');localStorage.setItem('nexo_device_token','test-device');localStorage.setItem('nexo_company','1');window.__printCalls=0;window.print=()=>window.__printCalls++});
  await owner.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
    requests.push({path,method,body:request.postDataJSON?.()});
    if(path==='/api/sales/invoice-entry'&&method==='POST')return route.fulfill({json:{invoiceId:91,journalId:600,transactionNumber:'FAC-VEN-91',total:113}});
    if(path==='/api/sales/invoice-entry/77'&&method==='PUT')return route.fulfill({json:{invoiceId:77,journalId:600,transactionNumber:'FAC-VEN-77',total:113}});
    if(path==='/api/accounting/journal-supports'&&method==='POST')return route.fulfill({json:{support_id:900,...request.postDataJSON()}});
    if(path.startsWith('/api/accounting/journal-supports/')&&method==='DELETE')return route.fulfill({json:{deleted:true}});
    return route.fulfill({json:responses[path]??[]});
  });
  await owner.goto('http://localhost:3000/');
  await owner.setContent('<iframe id="app"></iframe>');
  const frame=owner.frames().find(item=>item!==owner.mainFrame());
  await frame.goto(`http://localhost:3000/sales-invoice-entry.html${edit?'?id=77':''}`);
  await frame.locator('#supportsTab').waitFor();
  return{owner,frame,errors,requests};
}

try{
  const create=await framePage();
  await create.frame.locator('#supportsTab').click();
  await create.frame.locator('#salesSupportFiles').setInputFiles({name:'orden-cliente.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 respaldo')});
  await create.frame.locator('#salesSupportLinkName').fill('Portal del cliente');
  await create.frame.locator('#salesSupportLinkUrl').fill('https://cliente.test/respaldo');
  await create.frame.locator('#addSalesSupportLink').click();
  assert.equal(await create.frame.locator('#supportCount').textContent(),'2');
  assert.match(await create.frame.locator('#salesSupports').textContent(),/orden-cliente\.pdf/);
  assert.match(await create.frame.locator('#salesSupports').textContent(),/Portal del cliente/);
  await create.frame.locator('#customer').selectOption('1');
  await create.frame.locator('#linesTab').click();
  await create.frame.locator('[data-k="product_id"]').selectOption('10');
  await create.frame.locator('#save').click();
  await create.frame.locator('#successModal').waitFor({state:'visible'});
  const createdSupports=create.requests.filter(item=>item.path==='/api/accounting/journal-supports'&&item.method==='POST');
  assert.equal(createdSupports.length,2);
  assert.ok(createdSupports.every(item=>String(item.body.journal_id)==='600'));
  assert.equal(createdSupports.find(item=>item.body.support_type==='Archivo').body.file_name,'orden-cliente.pdf');
  assert.equal(createdSupports.find(item=>item.body.support_type==='Enlace').body.support_url,'https://cliente.test/respaldo');
  assert.deepEqual(create.errors,[]);
  await create.owner.close();

  const edit=await framePage({edit:true,supports:[{support_id:701,journal_id:600,support_type:'Enlace',display_name:'Contrato original',support_url:'https://cliente.test/contrato'}]});
  await edit.frame.locator('#supportsTab').click();
  assert.match(await edit.frame.locator('#salesSupports').textContent(),/Contrato original/);
  await edit.frame.locator('.support-item-actions button').click();
  await edit.frame.locator('#salesSupportFiles').setInputFiles({name:'aceptacion.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 aceptacion')});
  await edit.frame.locator('#save').click();
  await edit.frame.locator('#successModal').waitFor({state:'visible'});
  assert.ok(edit.requests.some(item=>item.path==='/api/accounting/journal-supports/701'&&item.method==='DELETE'));
  assert.ok(edit.requests.some(item=>item.path==='/api/accounting/journal-supports'&&item.method==='POST'&&item.body.file_name==='aceptacion.pdf'));
  assert.deepEqual(edit.errors,[]);
  await edit.owner.close();

  const supports=[
    {support_id:702,journal_id:600,support_type:'Archivo',display_name:'Acta.pdf',file_name:'acta.pdf',mime_type:'application/pdf',file_size:18,file_data:'data:application/pdf;base64,JVBERi0xLjQ='},
    {support_id:703,journal_id:600,support_type:'Enlace',display_name:'Portal',support_url:'https://cliente.test/portal'}
  ];
  const owner=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[],requests=[],responses=baseResponses({edit:true,supports});
  owner.on('pageerror',error=>errors.push(error.message));
  await owner.addInitScript(()=>{localStorage.setItem('nexo_token','test-session');localStorage.setItem('nexo_device_token','test-device');localStorage.setItem('nexo_company','1');window.__printCalls=0;window.print=()=>window.__printCalls++});
  await owner.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    requests.push({path,method:request.method(),headers:request.headers()});
    if(path==='/api/sales/invoices/77/pdf')return route.fulfill({status:200,contentType:'application/pdf',headers:{'Content-Disposition':"attachment; filename*=UTF-8''factura-FAC-VEN-77.pdf"},body:Buffer.from('%PDF-1.4\nNEXO\n%%EOF')});
    if(path==='/api/sales/invoices/77/email')return route.fulfill({json:{status:'ENVIADO',recipient:'facturas@cliente.test',messageId:'mock-1',attachments:['factura.pdf','acta.pdf'],links:1}});
    return route.fulfill({json:responses[path]??[]});
  });
  await owner.goto('http://localhost:3000/');
  await owner.setContent('<iframe id="view"></iframe>');
  const view=owner.frames().find(item=>item!==owner.mainFrame());
  await view.goto('http://localhost:3000/sales-invoice-view.html?id=77');
  await view.locator('#invoice:not([hidden])').waitFor();
  assert.equal(await view.locator('#viewSupportCount').textContent(),'2');
  assert.match(await view.locator('#viewSupports').textContent(),/Acta\.pdf/);
  assert.match(await view.locator('#viewSupports').textContent(),/Portal/);
  const downloadPromise=owner.waitForEvent('download');
  await view.locator('#print').click();
  const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),'factura-FAC-VEN-77.pdf');
  assert.equal(await view.evaluate(()=>window.__printCalls),0,'Descargar PDF no debe abrir el diálogo de impresión.');
  await view.locator('#sendEmail').click();
  assert.equal(await view.locator('#emailRecipient').textContent(),'facturas@cliente.test');
  assert.match(await view.locator('#emailAttachmentSummary').textContent(),/PDF de la factura \+ 1 archivo de respaldo · 1 enlace en el mensaje/);
  await view.locator('#confirmEmail').click();
  await view.locator('#actionMessage:not([hidden])').waitFor();
  assert.match(await view.locator('#actionMessage').textContent(),/facturas@cliente\.test/);
  assert.ok(requests.some(item=>item.path==='/api/sales/invoices/77/email'&&item.method==='POST'));
  assert.deepEqual(errors,[]);
  await owner.close();

  console.log(JSON.stringify({passed:true,supportsOnCreate:true,supportsOnEdit:true,supportsVisible:true,directPdfDownload:true,emailConfirmation:true}));
}finally{await browser.close()}
