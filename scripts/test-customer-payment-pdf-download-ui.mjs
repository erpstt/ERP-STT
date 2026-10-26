import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const paymentNumber='COB_CLI-20261026194153919';
const expectedFileName=`comprobante-cobro-${paymentNumber}.pdf`;
const detail={
  header:{
    payment_id:27,payment_number:paymentNumber,payment_date:'2026-10-22',
    subsidiary:'S.T.T. HOLDINGS LIMITED',customer:'EQUUS GLOBAL EXPANSION INC',
    bank:'JN Bank Limited',account:'2094351444',currency:'USD',exchange_rate:159.6451,
    bank_reference:'144410202601',memo:'Cobro de facturas de octubre',amount_received:35916.70,
    status:'APROBADO',created_by_name:'Danny Valderrama Zapata'
  },
  applications:[
    {invoiceNumber:'FAC-00000672',invoiceTotal:8259.18,amount:8259.18},
    {invoiceNumber:'FAC-00000669',invoiceTotal:27657.52,amount:27657.52}
  ],
  advances:[],
  bankFee:{amount:29.61,expenseAccountNumber:'631002',expenseAccountName:'Comisiones y Gastos Bancarios'},
  impact:[
    {accountNumber:'111005',accountName:'Bancos Cuentas Corrientes Moneda Extranjera',debit:35887.09,credit:0},
    {accountNumber:'113001',accountName:'Cuentas por Cobrar Clientes',debit:0,credit:35916.70},
    {accountNumber:'631002',accountName:'Comisiones y Gastos Bancarios',debit:29.61,credit:0}
  ]
};

try{
  const page=await browser.newPage({viewport:{width:1500,height:1000},acceptDownloads:true});
  page.setDefaultTimeout(15000);
  const pageErrors=[];
  let printCalled=false,popupOpened=false,pdfRequested=false;
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('popup',()=>{popupOpened=true;});
  await page.addInitScript(()=>{
    localStorage.setItem('nexo_token','customer-payment-pdf-token');
    localStorage.setItem('nexo_device_token','customer-payment-pdf-device-123456');
    window.print=()=>{window.__customerPaymentPrintCalled=true;};
  });
  await page.route('**/api/sales/customer-payments/27**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path.endsWith('/pdf')){
      pdfRequested=true;
      assert.equal(request.method(),'GET');
      return route.fulfill({
        status:200,contentType:'application/pdf',
        headers:{'Content-Disposition':`attachment; filename="${expectedFileName}"`},
        body:Buffer.from('%PDF-1.4\n%%EOF')
      });
    }
    return route.fulfill({json:detail});
  });

  await page.goto('http://localhost:3000/customer-payment-view.css',{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>{
    localStorage.setItem('nexo_token','customer-payment-pdf-token');
    localStorage.setItem('nexo_device_token','customer-payment-pdf-device-123456');
  });
  await page.setContent(`<iframe id="paymentView" src="http://localhost:3000/customer-payment-view.html?id=27" style="width:1460px;height:950px;border:0"></iframe>`);
  const view=page.frameLocator('#paymentView');
  await view.locator('#number').filter({hasText:paymentNumber}).waitFor();
  assert.equal(await view.locator('#loading').isHidden(),true,'El indicador de carga sigue visible después de preparar el comprobante.');
  assert.equal(await view.locator('#withholdingCard').isHidden(),true,'La comisión bancaria se presentó incorrectamente como retención.');
  assert.match(await view.locator('#bankNet').innerText(),/35\s?887,09/,'El ingreso bancario neto no descuenta correctamente la comisión.');
  assert.notEqual(await view.locator('.brand-monogram').evaluate(element=>getComputedStyle(element).backgroundImage),'none','La identidad visual del comprobante no tiene fondo corporativo.');
  assert.equal(await view.getByText('Imprimir / PDF',{exact:true}).count(),0,'La vista todavía ofrece el diálogo de impresión del navegador.');
  const button=view.locator('#downloadPdf');
  await assert.doesNotReject(()=>button.waitFor());
  await expectText(button,/Descargar PDF/i);
  if(process.env.CAPTURE_PAYMENT_PDF_VIEW==='1')await page.screenshot({path:'.tmp/customer-payment-professional-view.png',fullPage:true});

  const downloadPromise=page.waitForEvent('download');
  await button.click();
  const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),expectedFileName);
  await page.waitForTimeout(250);
  printCalled=await view.locator('body').evaluate(()=>Boolean(window.__customerPaymentPrintCalled));
  assert.equal(printCalled,false,'La descarga invocó window.print().');
  assert.equal(popupOpened,false,'La descarga abrió una ventana o vista de impresión.');
  assert.equal(pdfRequested,true,'No se solicitó el PDF binario del comprobante.');
  assert.deepEqual(pageErrors,[]);

  console.log(JSON.stringify({
    professionalTemplate:true,directDownload:true,fileName:download.suggestedFilename(),
    printDialog:false,popup:false,noPageErrors:true
  }));
}finally{
  await browser.close();
}

async function expectText(locator,pattern){
  assert.match((await locator.innerText()).trim(),pattern);
}
