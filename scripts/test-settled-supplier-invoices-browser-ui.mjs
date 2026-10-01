import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
  const page=await browser.newPage({viewport:{width:1600,height:1100}});
  page.setDefaultTimeout(12000);
  const requests=[];
  await page.addInitScript(()=>{
    localStorage.setItem('nexo_token','settled-supplier-ui-token');
    localStorage.setItem('nexo_device_token','settled-supplier-ui-device-token-123456');
  });

  const options={
    subsidiary:{id:1,name:'EMPRESA DE PRUEBAS',legalName:'Empresa de Pruebas S.A.',taxId:'TEST-001',currency:'JMD',currencyName:'Dólar jamaiquino',symbol:'J$'},
    suppliers:[{id:21,name:'Proveedor Uno',taxId:'ID-001'},{id:22,name:'Proveedor Dos',taxId:'ID-002'}]
  };
  const rows=[
    {invoiceId:1,invoiceNumber:'FAC-PRO-001',supplierId:21,supplierName:'Proveedor Uno',supplierTaxId:'ID-001',dueDate:'2026-09-15',issueDate:'2026-09-01',invoiceAmount:100,payableAmount:90,invoiceWithholdingAmount:10,settlementBaseAmount:90,currency:'JMD',symbol:'J$',exchangeRate:1,exchangeDifferenceAmount:0,settlementDate:'2026-09-04',settlementType:'PAYMENT',settlementTypeLabel:'Pago a proveedor',settlementReferences:'PAG-PRO-001 / REF-01',paymentAmount:90,creditNoteAmount:0,debitNoteAmount:0,cashAmount:65,advanceAmount:20,withholdingAmount:5,totalWithholdingAmount:15,otherFundingAmount:0,grossAppliedAmount:90,netAppliedAmount:90,appliedAmount:90,balanceDue:0,rawBalance:0,overappliedAmount:0,daysToPay:3,applications:[{date:'2026-09-04',type:'PAYMENT',typeLabel:'Pago a proveedor',reference:'PAG-PRO-001',secondaryReference:'REF-01',method:'Banco Uno',amount:90,cashAmount:65,advanceAmount:20,withholdingAmount:5,otherFundingAmount:0}]},
    {invoiceId:2,invoiceNumber:'FAC-PRO-002',supplierId:22,supplierName:'Proveedor Dos',supplierTaxId:'ID-002',dueDate:'2026-09-16',issueDate:'2026-09-01',invoiceAmount:200,payableAmount:200,invoiceWithholdingAmount:0,settlementBaseAmount:200,currency:'JMD',symbol:'J$',exchangeRate:1,exchangeDifferenceAmount:0,settlementDate:'2026-09-05',settlementType:'CREDIT_NOTE',settlementTypeLabel:'Nota de Crédito',settlementReferences:'NC-PRO-001',paymentAmount:0,creditNoteAmount:200,debitNoteAmount:0,cashAmount:0,advanceAmount:0,withholdingAmount:0,totalWithholdingAmount:0,otherFundingAmount:0,grossAppliedAmount:200,netAppliedAmount:200,appliedAmount:200,balanceDue:0,rawBalance:0,overappliedAmount:0,daysToPay:4,applications:[{date:'2026-09-05',type:'CREDIT_NOTE',typeLabel:'Nota de Crédito',reference:'NC-PRO-001',method:'Compensación',amount:200,cashAmount:0,advanceAmount:0,withholdingAmount:0,otherFundingAmount:0}]},
    {invoiceId:3,invoiceNumber:'FAC-PRO-003',supplierId:21,supplierName:'Proveedor Uno',supplierTaxId:'ID-001',dueDate:'2026-09-15',issueDate:'2026-09-01',invoiceAmount:100,payableAmount:100,invoiceWithholdingAmount:0,settlementBaseAmount:120,currency:'JMD',symbol:'J$',exchangeRate:1,exchangeDifferenceAmount:0,settlementDate:'2026-09-09',settlementType:'MIXED',settlementTypeLabel:'Mixto',settlementReferences:'PAG-PRO-002 · NC-PRO-002 · PAG-PRO-003',paymentAmount:80,creditNoteAmount:50,debitNoteAmount:20,cashAmount:70,advanceAmount:5,withholdingAmount:5,totalWithholdingAmount:5,otherFundingAmount:0,grossAppliedAmount:130,netAppliedAmount:110,appliedAmount:130,balanceDue:0,rawBalance:-10,overappliedAmount:10,daysToPay:8,applications:[{date:'2026-09-06',type:'PAYMENT',typeLabel:'Pago a proveedor',reference:'PAG-PRO-002',method:'Banco Uno',amount:60,cashAmount:50,advanceAmount:5,withholdingAmount:5,otherFundingAmount:0},{date:'2026-09-07',type:'CREDIT_NOTE',typeLabel:'Nota de Crédito',reference:'NC-PRO-002',method:'Compensación',amount:50,cashAmount:0,advanceAmount:0,withholdingAmount:0,otherFundingAmount:0},{date:'2026-09-08',type:'DEBIT_NOTE',typeLabel:'Nota de Débito',reference:'ND-PRO-001',method:'Reapertura de saldo',amount:-20,cashAmount:0,advanceAmount:0,withholdingAmount:0,otherFundingAmount:0},{date:'2026-09-09',type:'PAYMENT',typeLabel:'Pago a proveedor',reference:'PAG-PRO-003',method:'Banco Uno',amount:20,cashAmount:20,advanceAmount:0,withholdingAmount:0,otherFundingAmount:0}]}
  ];
  const report={
    header:{...options.subsidiary,subsidiary:'EMPRESA DE PRUEBAS',periodMonth:'2026-09',periodStart:'2026-09-01',periodEnd:'2026-09-30',settlementType:'ALL',groupBySettlementType:true,generatedAt:'2026-09-30T14:00:00Z'},
    summary:{invoiceCount:3,invoiceAmount:400,payableAmount:390,invoiceWithholdingAmount:10,settlementBaseAmount:410,paymentAppliedAmount:170,cashAmount:135,advanceAmount:25,withholdingAmount:10,totalWithholdingAmount:20,otherFundingAmount:0,creditNoteAmount:250,debitNoteAmount:20,appliedAmount:420,netAppliedAmount:400,exchangeDifferenceAmount:0,overappliedAmount:10,paymentCount:1,creditNoteCount:1,mixedCount:1,overappliedCount:1,averageDpo:5},
    rows,total:3,page:1,pageSize:50
  };

  await page.route('**/api/v1/reports/purchases/settled-invoices**',async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;
    if(pathname.endsWith('/options'))return route.fulfill({json:options});
    if(pathname.endsWith('/pdf'))return route.fulfill({status:200,contentType:'application/pdf',headers:{'Content-Disposition':"attachment; filename*=UTF-8''facturas-proveedor-liquidadas-2026-09.pdf"},body:Buffer.from('%PDF-1.4\n%%EOF')});
    if(pathname.endsWith('/excel'))return route.fulfill({status:200,contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',headers:{'Content-Disposition':"attachment; filename*=UTF-8''facturas-proveedor-liquidadas-2026-09.xlsx"},body:Buffer.from('PK\u0003\u0004TEST')});
    requests.push(request.postDataJSON());
    return route.fulfill({json:report});
  });

  await page.goto('http://localhost:3000/gentia-theme.css',{waitUntil:'domcontentloaded'});
  await page.setContent('<iframe id="report" src="http://localhost:3000/settled-supplier-invoices.html" style="width:1560px;height:1050px;border:0"></iframe>');
  const app=page.frameLocator('#report');
  if(!await app.getByText('Facturas de proveedor liquidadas',{exact:true}).isVisible().catch(()=>false)){
    throw new Error(`La vista no cargó. URL=${page.url()} BODY=${(await page.locator('body').innerText().catch(()=>'' )).slice(0,500)}`);
  }
  await app.getByText('Facturas de proveedor liquidadas',{exact:true}).waitFor();
  await app.getByText('Conciliación de la liquidación',{exact:true}).waitFor();
  assert.equal(await app.locator('.group-section').count(),3);
  const summaryText=await app.locator('#summary').innerText();
  assert.match(summaryText,/retención en origen/i);
  assert.match(summaryText,/Dif\. cambiaria/);
  assert.match(summaryText,/Caja \/ Banco/);
  assert.match(summaryText,/Anticipos aplicados/);
  assert.match(summaryText,/Retenciones al pagar/);
  assert.match(summaryText,/J\$ 410,00/);
  assert.match(await app.locator('#overappliedWarning').innerText(),/J\$ 10,00/);
  assert.match(await app.locator('#reportGroups').innerText(),/Liquidaciones Mixtas/);

  const mixedRow=app.locator('tr').filter({hasText:'FAC-PRO-003'}).first();
  await mixedRow.locator('[data-expand]').click();
  await app.getByText('Reapertura de saldo',{exact:true}).waitFor();
  const detailText=await app.locator('.application-panel').last().innerText();
  assert.match(detailText,/Nota de Débito/);
  assert.match(detailText,/Anticipos/);
  assert.match(detailText,/Retenciones/);

  await app.locator('#supplierPicker').evaluate(element=>element.open=true);
  await app.locator('#supplierOptions input[value="21"]').check();
  await app.locator('#generate').click();
  await app.getByText('Proveedor Uno',{exact:true}).first().waitFor();
  assert.deepEqual(requests.at(-1).supplierIds,[21]);
  await app.locator('#groupBySettlementType').uncheck();
  assert.equal(await app.locator('.group-section').count(),0);
  await app.locator('#groupBySettlementType').check();
  assert.equal(await app.locator('.group-section').count(),3);

  const pdfDownload=page.waitForEvent('download');
  await app.locator('#downloadPdf').click();
  assert.equal((await pdfDownload).suggestedFilename(),'facturas-proveedor-liquidadas-2026-09.pdf');
  const excelDownload=page.waitForEvent('download');
  await app.locator('#downloadExcel').click();
  assert.equal((await excelDownload).suggestedFilename(),'facturas-proveedor-liquidadas-2026-09.xlsx');
  await page.screenshot({path:'.tmp/settled-supplier-invoices-ui.png',fullPage:true});
  console.log(JSON.stringify({ui:true,professionalLayout:true,activeCompany:true,supplierMultiSelect:true,groupedSections:true,expandableTrace:true,directPdf:true,directExcel:true,responsiveViewport:true}));
}finally{
  await browser.close();
}
