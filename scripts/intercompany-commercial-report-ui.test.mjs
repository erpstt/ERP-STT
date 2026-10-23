import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
  const page=await browser.newPage({viewport:{width:1560,height:1100},acceptDownloads:true});
  page.setDefaultTimeout(15_000);
  await page.addInitScript(()=>{localStorage.setItem('nexo_token','commercial-ui-test');localStorage.setItem('nexo_company','24')});
  const payloads=[],exports=[];
  await page.route('**/api/v1/reports/accounting/intercompany-commercial/options',route=>route.fulfill({json:{
    subsidiaries:[{id:24,name:'S.T.T. HOLDINGS LIMITED'}],
    intercompanyBooks:[{id:9,name:'Fiscal local',subsidiaryId:24}],
    currencies:[{id:1,code:'JMD',name:'Dólar jamaicano',symbol:'J$'},{id:2,code:'USD',name:'Dólar estadounidense',symbol:'US$'}],
    intercompanyCommercialParties:[
      {partyKey:'CUSTOMER:10',id:10,thirdPartyType:'CUSTOMER',code:'CLI-00000010',name:'STT PANAMÁ CLIENTE',identification:'RUC-C10',subsidiaryIds:[24]},
      {partyKey:'SUPPLIER:20',id:20,thirdPartyType:'SUPPLIER',code:'PRO-00000020',name:'STT PANAMÁ PROVEEDOR',identification:'RUC-P20',subsidiaryIds:[24]}
    ]
  }}));
  await page.route('**/api/v1/reports/accounting/intercompany-commercial',route=>{
    if(route.request().url().endsWith('/excel')||route.request().url().endsWith('/pdf'))return route.fallback();
    payloads.push(route.request().postDataJSON());
    return route.fulfill({json:{
      report:'intercompany-commercial',dateFrom:'2026-01-01',dateTo:'2026-10-23',
      receivables:[{partyId:10,partyKey:'CUSTOMER:10',partyType:'CUSTOMER',partyCode:'CLI-00000010',partyName:'STT PANAMÁ CLIENTE',identification:'RUC-C10',currencyId:2,currencyCode:'USD',currencyName:'Dólar estadounidense',currencySymbol:'US$',openingBalance:1000,debits:500,credits:200,closingBalance:1300,documentBalance:1300,openDocumentCount:1,difference:0,accountNumber:'113002',accountName:'Cuentas por Cobrar Clientes Intercompany'}],
      payables:[{partyId:20,partyKey:'SUPPLIER:20',partyType:'SUPPLIER',partyCode:'PRO-00000020',partyName:'STT PANAMÁ PROVEEDOR',identification:'RUC-P20',currencyId:1,currencyCode:'JMD',currencyName:'Dólar jamaicano',currencySymbol:'J$',openingBalance:3000,debits:400,credits:1400,closingBalance:4000,documentBalance:4000,openDocumentCount:1,difference:0,accountNumber:'211002',accountName:'Cuentas por Pagar Proveedores Intercompany'}],
      currencySummaries:[
        {currencyId:2,currencyCode:'USD',currencyName:'Dólar estadounidense',currencySymbol:'US$',receivableClosing:1300,payableClosing:0,netPosition:1300,partyCount:1},
        {currencyId:1,currencyCode:'JMD',currencyName:'Dólar jamaicano',currencySymbol:'J$',receivableClosing:0,payableClosing:4000,netPosition:-4000,partyCount:1}
      ],
      localPositions:[{subsidiaryId:24,subsidiaryName:'S.T.T. HOLDINGS LIMITED',partyId:10,partyKey:'CUSTOMER:10',partyType:'CUSTOMER',partyCode:'CLI-00000010',partyName:'STT PANAMÁ CLIENTE',identification:'RUC-C10',originalCurrencyId:2,originalCurrencyCode:'USD',originalCurrencyName:'Dólar estadounidense',originalCurrencySymbol:'US$',localCurrencyId:1,localCurrencyCode:'JMD',localCurrencyName:'Dólar jamaicano',localCurrencySymbol:'J$',receivableClosing:208000,payableClosing:0,netPosition:208000}],
      quality:{valid:true,partyCount:2,unassignedPartyMovementCount:0,reconciliationDifferenceCount:0,classificationMismatchCount:0},
      documents:[
        {id:'AR:1',issueDate:'2026-09-01',postingDate:'2026-09-01',dueDate:'2026-10-01',direction:'RECEIVABLE',documentNumber:'=FAC-VEN-10',journalId:101,partyId:10,partyKey:'CUSTOMER:10',partyType:'CUSTOMER',partyCode:'CLI-00000010',partyName:'STT PANAMÁ CLIENTE',identification:'RUC-C10',currencyId:2,currencyCode:'USD',currencyName:'Dólar estadounidense',currencySymbol:'US$',accountNumber:'113002',accountName:'Cuentas por Cobrar Clientes Intercompany',agingBucket:'1_30',originalAmount:1500,appliedAmount:185,creditAmount:25,debitAmount:10,outstanding:1300},
        {id:'AP:2',issueDate:'2026-08-15',postingDate:'2026-08-15',dueDate:'2026-09-14',direction:'PAYABLE',documentNumber:'FAC-PRO-20',journalId:102,partyId:20,partyKey:'SUPPLIER:20',partyType:'SUPPLIER',partyCode:'PRO-00000020',partyName:'STT PANAMÁ PROVEEDOR',identification:'RUC-P20',currencyId:1,currencyCode:'JMD',currencyName:'Dólar jamaicano',currencySymbol:'J$',accountNumber:'211002',accountName:'Cuentas por Pagar Proveedores Intercompany',agingBucket:'31_60',originalAmount:5000,appliedAmount:900,creditAmount:100,debitAmount:0,outstanding:4000}
      ]
    }});
  });
  for(const format of['excel','pdf'])await page.route(`**/api/v1/reports/accounting/intercompany-commercial/${format}`,route=>{exports.push({format,payload:route.request().postDataJSON()});const extension=format==='excel'?'xlsx':'pdf',type=format==='excel'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/pdf';return route.fulfill({status:200,contentType:type,headers:{'Content-Disposition':`attachment; filename="commercial-test.${extension}"`},body:format==='pdf'?'%PDF-test':'xlsx-test'})});

  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded',timeout:30_000});
  await page.evaluate(()=>{localStorage.setItem('nexo_token','commercial-ui-test');localStorage.setItem('nexo_company','24')});
  await page.setContent('<iframe id="report" src="http://localhost:3000/intercompany-commercial-report.html" style="width:1520px;height:1060px"></iframe>');
  const app=page.frameLocator('#report');
  await app.locator('.currency-card').first().waitFor();

  assert.deepEqual(payloads[0].subsidiaryIds,[24]);
  assert.equal(payloads[0].partyKey,null);
  assert.equal(payloads[0].direction,'ALL');
  assert.equal(payloads[0].onlyPending,true);
  assert.deepEqual(payloads[0].currencyIds,[]);
  assert.equal(await app.locator('#thirdParty option').count(),3);
  assert.match(await app.locator('#thirdParty').innerText(),/Cliente · CLI-00000010/);
  assert.match(await app.locator('#thirdParty').innerText(),/Proveedor · PRO-00000020/);
  assert.match(await app.locator('#receivablesRows').innerText(),/STT PANAMÁ CLIENTE/);
  assert.match(await app.locator('#receivablesRows').innerText(),/US\$\s*1\s*300[,.]00/);
  assert.match(await app.locator('#receivablesRows').innerText(),/\b1\b/,'Debe mostrar la cantidad de documentos pendientes.');
  assert.match(await app.locator('#payablesRows').innerText(),/STT PANAMÁ PROVEEDOR/);
  assert.match(await app.locator('#payablesRows').innerText(),/J\$\s*4\s*000[,.]00/);
  assert.doesNotMatch(await app.locator('#receivablesSection').innerText(),/Compañía relacionada/);
  assert.match(await app.locator('#netSection').innerText(),/Diferencia informativa/);
  assert.match(await app.locator('#summary').innerText(),/2 clientes y proveedores/);
  assert.match(await app.locator('#detailRows').innerText(),/FAC-VEN-10/);
  assert.match(await app.locator('#detailRows').innerText(),/01 oct 2026/);
  assert.match(await app.locator('#detailRows').innerText(),/1 - 30 días/);
  assert.match(await app.locator('#detailRows').innerText(),/US\$\s*1\s*500[,.]00/);
  assert.match(await app.locator('#detailRows').innerText(),/US\$\s*185[,.]00/);
  assert.match(await app.locator('#detailRows').innerText(),/US\$\s*25[,.]00/);
  assert.match(await app.locator('#detailRows').innerText(),/US\$\s*10[,.]00/);
  assert.match(await app.locator('#detailRows').innerText(),/US\$\s*1\s*300[,.]00/);
  assert.match(await app.locator('#localRows').innerText(),/STT PANAMÁ CLIENTE/);

  await app.locator('#direction').selectOption('RECEIVABLE');
  assert.equal(await app.locator('#thirdParty option').count(),2,'Al consultar CxC solo debe ofrecer clientes.');
  assert.doesNotMatch(await app.locator('#thirdParty').innerText(),/PRO-00000020/);
  await app.locator('#thirdParty').selectOption('CUSTOMER:10');
  await app.locator('#onlyPending').uncheck();
  await app.locator('#generate').click();
  await app.getByText('Reporte generado correctamente.').waitFor();
  assert.equal(payloads.at(-1).partyKey,'CUSTOMER:10');
  assert.equal(payloads.at(-1).direction,'RECEIVABLE');
  assert.equal(payloads.at(-1).onlyPending,false);
  assert.equal(await app.locator('#payablesSection').isHidden(),true);
  assert.equal(await app.locator('#netSection').isHidden(),true);

  const csvPromise=page.waitForEvent('download');
  await app.locator('#downloadCsv').click();
  const csvDownload=await csvPromise,csv=await fs.readFile(await csvDownload.path(),'utf8');
  assert.match(csv,/"Cliente \/ proveedor"/);
  assert.match(csv,/"113002"/);
  assert.match(csv,/"211002"/);
  assert.match(csv,/"Saldo pendiente"/);
  assert.match(csv,/"'=FAC-VEN-10"/);
  assert.doesNotMatch(csv,/Compañía relacionada/);
  const excelPromise=page.waitForEvent('download');await app.locator('#downloadExcel').click();await excelPromise;
  const pdfPromise=page.waitForEvent('download');await app.locator('#downloadPdf').click();await pdfPromise;
  assert.deepEqual(exports.map(item=>item.format),['excel','pdf']);
  assert.ok(exports.every(item=>item.payload.partyKey==='CUSTOMER:10'&&item.payload.onlyPending===false));

  console.log(JSON.stringify({contractFilters:true,partySelector:true,receivables113002:true,payables211002:true,currenciesSeparated:true,noFalseRelatedCompany:true,informativeDifference:true,documentAging:true,localEquivalence:true,csv:true,excel:true,pdf:true}));
}finally{
  await browser.close();
}
