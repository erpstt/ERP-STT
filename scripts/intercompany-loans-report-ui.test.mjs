import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
  const page=await browser.newPage({viewport:{width:1560,height:1100},acceptDownloads:true});
  page.setDefaultTimeout(15_000);
  await page.addInitScript(()=>{localStorage.setItem('nexo_token','intercompany-ui-test');localStorage.setItem('nexo_company','24')});
  const payloads=[],exports=[];let legacyQuality=false;
  await page.route('**/api/v1/reports/accounting/intercompany-loans/options',route=>route.fulfill({json:{
    subsidiaries:[{id:24,name:'S.T.T. HOLDINGS LIMITED'}],
    books:[{id:88,name:'Libro secundario no permitido',subsidiaryId:24}],
    intercompanyBooks:[{id:9,name:'Fiscal local',subsidiaryId:24}],
    currencies:[{id:1,code:'JMD',name:'Dólar jamaicano',symbol:'J$'},{id:2,code:'USD',name:'Dólar estadounidense',symbol:'US$'},{id:3,code:'EUR',name:'Euro',symbol:'€'}],
    relatedCompanies:[{id:7,code:'INT-00000007',name:'STT PANAMÁ',identification:'RUC-7',subsidiaryIds:[24]}],
    accounts:[{id:11,code:'119001',name:'Préstamos por cobrar relacionadas',subsidiaryId:24},{id:12,code:'219001',name:'Préstamos por pagar relacionadas',subsidiaryId:24},{id:13,code:'110001',name:'Caja',subsidiaryId:24}]
  }}));
  await page.route('**/api/v1/reports/accounting/intercompany-loans',route=>{
    if(route.request().url().endsWith('/excel')||route.request().url().endsWith('/pdf'))return route.fallback();
    payloads.push(route.request().postDataJSON());
    return route.fulfill({json:{
      report:'intercompany-loans',generatedAt:'2026-10-23T15:00:00Z',dateFrom:'2026-01-01',dateTo:'2026-10-23',
      accountGroups:[{id:1,code:'119',name:'Cuentas por Cobrar Compañías Relacionadas',direction:'RECEIVABLE'},{id:2,code:'219',name:'Cuentas por Pagar Compañías Relacionadas',direction:'PAYABLE'}],
      receivables:[{relatedCompanyId:7,relatedCompanyCode:'INT-00000007',relatedCompanyName:'STT PANAMÁ',currencyId:2,currencyCode:'USD',currencyName:'Dólar estadounidense',currencySymbol:'US$',openingBalance:1000,debits:500,credits:200,closingBalance:1300},{relatedCompanyId:7,relatedCompanyCode:'INT-00000007',relatedCompanyName:'STT PANAMÁ',currencyId:3,currencyCode:'EUR',currencyName:'Euro',currencySymbol:'€',openingBalance:300,debits:100,credits:0,closingBalance:400}],
      payables:[{relatedCompanyId:7,relatedCompanyCode:'INT-00000007',relatedCompanyName:'STT PANAMÁ',currencyId:2,currencyCode:'USD',currencyName:'Dólar estadounidense',currencySymbol:'US$',openingBalance:400,debits:50,credits:150,closingBalance:500},{relatedCompanyId:7,relatedCompanyCode:'INT-00000007',relatedCompanyName:'STT PANAMÁ',currencyId:3,currencyCode:'EUR',currencyName:'Euro',currencySymbol:'€',openingBalance:70,debits:0,credits:30,closingBalance:100},{relatedCompanyId:null,relatedCompanyCode:'SIN-ASIGNAR',relatedCompanyName:'Sin compañía relacionada',currencyId:1,currencyCode:'JMD',currencyName:'Dólar jamaicano',currencySymbol:'J$',openingBalance:0,debits:0,credits:3000,closingBalance:3000}],
      netPositions:[{relatedCompanyId:7,relatedCompanyCode:'INT-00000007',relatedCompanyName:'STT PANAMÁ',currencyId:2,currencyCode:'USD',currencyName:'Dólar estadounidense',currencySymbol:'US$',receivableClosing:1300,payableClosing:500,netPosition:800},{relatedCompanyId:7,relatedCompanyCode:'INT-00000007',relatedCompanyName:'STT PANAMÁ',currencyId:3,currencyCode:'EUR',currencyName:'Euro',currencySymbol:'€',receivableClosing:400,payableClosing:100,netPosition:300},{relatedCompanyId:null,relatedCompanyCode:'SIN-ASIGNAR',relatedCompanyName:'Sin compañía relacionada',currencyId:1,currencyCode:'JMD',currencyName:'Dólar jamaicano',currencySymbol:'J$',receivableClosing:0,payableClosing:3000,netPosition:-3000}],
      localPositions:[{subsidiaryId:24,subsidiaryName:'S.T.T. HOLDINGS LIMITED',relatedCompanyId:7,relatedCompanyCode:'INT-00000007',relatedCompanyName:'STT PANAMÁ',originalCurrencyId:2,originalCurrencyCode:'USD',originalCurrencyName:'Dólar estadounidense',originalCurrencySymbol:'US$',localCurrencyId:1,localCurrencyCode:'JMD',localCurrencyName:'Dólar jamaicano',localCurrencySymbol:'J$',receivableClosing:208000,payableClosing:80000,netPosition:128000},{subsidiaryId:24,subsidiaryName:'S.T.T. HOLDINGS LIMITED',relatedCompanyId:7,relatedCompanyCode:'INT-00000007',relatedCompanyName:'STT PANAMÁ',originalCurrencyId:3,originalCurrencyCode:'EUR',originalCurrencyName:'Euro',originalCurrencySymbol:'€',localCurrencyId:1,localCurrencyCode:'JMD',localCurrencyName:'Dólar jamaicano',localCurrencySymbol:'J$',receivableClosing:64000,payableClosing:16000,netPosition:48000},{subsidiaryId:24,subsidiaryName:'S.T.T. HOLDINGS LIMITED',relatedCompanyId:null,relatedCompanyCode:'SIN-ASIGNAR',relatedCompanyName:'Sin compañía relacionada',originalCurrencyId:1,originalCurrencyCode:'JMD',originalCurrencyName:'Dólar jamaicano',originalCurrencySymbol:'J$',localCurrencyId:1,localCurrencyCode:'JMD',localCurrencyName:'Dólar jamaicano',localCurrencySymbol:'J$',receivableClosing:0,payableClosing:3000,netPosition:-3000}],
      currencySummaries:[{currencyId:2,currencyCode:'USD',currencyName:'Dólar estadounidense',currencySymbol:'US$',receivableClosing:1300,payableClosing:500,netPosition:800},{currencyId:3,currencyCode:'EUR',currencyName:'Euro',currencySymbol:'€',receivableClosing:400,payableClosing:100,netPosition:300},{currencyId:1,currencyCode:'JMD',currencyName:'Dólar jamaicano',currencySymbol:'J$',receivableClosing:0,payableClosing:3000,netPosition:-3000}],
      localCurrencySummaries:[{subsidiaryId:24,subsidiaryName:'S.T.T. HOLDINGS LIMITED',currencyId:1,currencyCode:'JMD',currencyName:'Dólar jamaicano',currencySymbol:'J$',receivableClosing:272000,payableClosing:99000,netPosition:173000}],
      quality:legacyQuality?{movementCount:3,accountCount:2,relatedCompanyCount:1,currencyCount:2,unassignedMovementCount:2,hasUnassignedDimensions:true}:{movementCount:3,accountCount:2,relatedCompanyCount:1,currencyCount:2,unassignedMovementCount:2,unassignedOpeningMovementCount:1,unassignedPeriodMovementCount:1,fxAdjustmentMovementCount:1,hasUnassignedDimensions:true},
      details:[
        {id:'1',date:'2026-09-01',transactionNumber:'ASI-100',transactionType:'Asiento',journalId:101,journalNumber:'ASI-100',memo:'Revaluación del préstamo',direction:'RECEIVABLE',accountNumber:'119001',accountName:'Préstamos por cobrar relacionadas',relatedCompanyId:7,relatedCompanyCode:'INT-00000007',relatedCompanyName:'STT PANAMÁ',relatedCompanyIdentification:'RUC-7',dimensionAssigned:true,currencyId:2,currencyCode:'USD',currencyName:'Dólar estadounidense',currencySymbol:'US$',originalDebit:0,originalCredit:0,originalRunningBalance:0,localCurrencyCode:'JMD',localCurrencyName:'Dólar jamaicano',localCurrencySymbol:'J$',localDebit:7500,localCredit:0,localMovement:7500,isFxRevaluation:true},
        {id:'2',date:'2026-09-02',transactionNumber:'ASI-101',transactionType:'Asiento',journalId:102,journalNumber:'ASI-101',memo:'Préstamo recibido',direction:'PAYABLE',accountNumber:'219001',accountName:'Préstamos por pagar relacionadas',relatedCompanyId:7,relatedCompanyCode:'INT-00000007',relatedCompanyName:'STT PANAMÁ',relatedCompanyIdentification:'RUC-7',dimensionAssigned:true,currencyId:2,currencyCode:'USD',currencyName:'Dólar estadounidense',currencySymbol:'US$',originalDebit:0,originalCredit:150,originalRunningBalance:500},
        {id:'3',date:'2026-09-03',transactionNumber:'ASI-102',transactionType:'Asiento',journalId:103,journalNumber:'ASI-102',memo:'Dimensión pendiente',direction:'PAYABLE',accountNumber:'219001',accountName:'Préstamos por pagar relacionadas',relatedCompanyId:null,relatedCompanyCode:'SIN-ASIGNAR',relatedCompanyName:'Sin compañía relacionada',dimensionAssigned:false,currencyId:1,currencyCode:'JMD',currencyName:'Dólar jamaicano',currencySymbol:'J$',originalDebit:0,originalCredit:3000,originalRunningBalance:3000}
      ]
    }});
  });
  for(const format of['excel','pdf'])await page.route(`**/api/v1/reports/accounting/intercompany-loans/${format}`,route=>{exports.push({format,payload:route.request().postDataJSON()});const extension=format==='excel'?'xlsx':'pdf',type=format==='excel'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/pdf';return route.fulfill({status:200,contentType:type,headers:{'Content-Disposition':`attachment; filename="intercompany-test.${extension}"`},body:format==='pdf'?'%PDF-test':'xlsx-test'})});

  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded',timeout:30_000});
  await page.evaluate(()=>{localStorage.setItem('nexo_token','intercompany-ui-test');localStorage.setItem('nexo_company','24')});
  await page.setContent('<iframe id="report" src="http://localhost:3000/intercompany-loans-report.html" style="width:1520px;height:1060px"></iframe>');
  const app=page.frameLocator('#report');
  await app.locator('.currency-card').first().waitFor();

  assert.deepEqual(payloads[0].subsidiaryIds,[24]);
  assert.deepEqual(payloads[0].currencyIds,[]);
  assert.equal(payloads[0].direction,'ALL');
  assert.equal(payloads[0].relatedCompanyState,'ALL');
  assert.equal('includeZero' in payloads[0],false,'No debe ofrecer un filtro de saldos cero que el reporte no puede materializar.');
  assert.match(await app.locator('#summary').innerText(),/USD/);
  assert.match(await app.locator('#summary').innerText(),/JMD/);
  assert.doesNotMatch(await app.locator('#summary').innerText(),/4[ .]?300[,.]00/,'No debe sumar monedas distintas.');
  assert.match(await app.locator('#receivablesRows').innerText(),/US\$\s*1\s*300[,.]00/);
  assert.match(await app.locator('#payablesRows').innerText(),/J\$\s*3\s*000[,.]00/);
  assert.match(await app.locator('#netRows').innerText(),/Posición por cobrar/);
  assert.match(await app.locator('#netRows').innerText(),/Posición por pagar/);
  const localRows=app.locator('#localRows tr'),localText=await app.locator('#localRows').innerText(),localAmounts=(await app.locator('#localRows td.number').allInnerTexts()).join(' ');
  assert.equal(await localRows.count(),3,'Debe conservar una fila por subsidiaria, compañía y moneda original.');
  assert.equal(await localRows.filter({hasText:'STT PANAMÁ'}).count(),2,'USD y EUR de la misma compañía no deben mezclarse aunque compartan JMD como moneda funcional.');
  assert.match(localText,/S\.T\.T\. HOLDINGS LIMITED/);assert.match(localText,/USD/);assert.match(localText,/EUR/);assert.match(localText,/JMD/);
  assert.match(localAmounts,/J\$\s*208\s*000[,.]00/);assert.match(localAmounts,/J\$\s*64\s*000[,.]00/);
  assert.doesNotMatch(localAmounts,/US\$|€/,'Los importes equivalentes deben usar exclusivamente la moneda funcional.');
  const fxRowText=await app.locator('#detailRows tr.fx-row').innerText();
  assert.match(fxRowText,/US\$\s*0[,.]00/,'Debe conservar los importes originales del contrato aunque el ajuste FX no tenga movimiento original.');
  assert.match(fxRowText,/Débito local:\s*J\$\s*7\s*500[,.]00/,'Debe mostrar el débito local de la revaluación FX.');
  assert.match(fxRowText,/Crédito local:\s*J\$\s*0[,.]00/,'Debe mostrar el crédito local de la revaluación FX.');
  assert.match(fxRowText,/Movimiento local:\s*J\$\s*7\s*500[,.]00/,'Debe mostrar el movimiento local de la revaluación FX.');
  assert.equal(await app.locator('#detailRows tr:not(.fx-row) .fx-local').count(),0,'Los importes locales auxiliares deben aparecer solo en ajustes FX.');
  const qualityText=await app.locator('#quality').innerText();
  assert.match(qualityText,/2 movimiento/);
  assert.match(qualityText,/1 Sin compañía en el período/);
  assert.match(qualityText,/1 Sin compañía desde saldos iniciales/);
  assert.match(qualityText,/1 ajustes de revaluación FX/);
  assert.equal(await app.locator('#detailRows tr.fx-row').count(),1);
  assert.match(await app.locator('#detailRows .fx-badge').innerText(),/FX · Revaluación/);
  assert.equal(await app.locator('#account option').count(),3,'Debe mostrar placeholder y solo las cuentas 119*/219*.');
  assert.doesNotMatch(await app.locator('#account').innerText(),/110001/);
  assert.equal(await app.locator('#book option').count(),2,'Debe usar el catálogo restringido intercompanyBooks más el placeholder.');
  assert.match(await app.locator('#book').innerText(),/Fiscal local/);assert.doesNotMatch(await app.locator('#book').innerText(),/secundario/);
  assert.match(await app.locator('#reportMeta').innerText(),/Libro:\s*Libro principal/);

  await app.locator('#currency').selectOption('2');
  assert.equal(await app.locator('#downloadCsv').isDisabled(),true,'Una modificación debe invalidar las exportaciones del reporte anterior.');
  assert.match(await app.locator('#message').innerText(),/Genere nuevamente/);
  await app.locator('#generate').click();
  await app.getByText('Reporte generado correctamente.').waitFor();
  assert.deepEqual(payloads.at(-1).currencyIds,[2]);
  assert.equal(await app.locator('#downloadCsv').isEnabled(),true);

  await app.locator('#relatedCompanyState').selectOption('UNASSIGNED');
  assert.equal(await app.locator('#relatedCompany').isDisabled(),true);
  await app.locator('#generate').click();
  await app.getByText('Reporte generado correctamente.').waitFor();
  assert.equal(payloads.at(-1).relatedCompanyState,'UNASSIGNED');

  const csvPromise=page.waitForEvent('download');await app.locator('#downloadCsv').click();const csvDownload=await csvPromise,csv=await fs.readFile(await csvDownload.path(),'utf8');
  assert.match(csv,/"Tipo de saldo"/);assert.match(csv,/"Naturaleza"/);assert.match(csv,/"REVALUACIÓN FX"/);assert.match(csv,/"CUENTAS POR PAGAR"/);assert.match(csv,/"INT-00000007"/);assert.match(csv,/"3000"/);
  const excelPromise=page.waitForEvent('download');await app.locator('#downloadExcel').click();await excelPromise;
  const pdfPromise=page.waitForEvent('download');await app.locator('#downloadPdf').click();await pdfPromise;
  assert.deepEqual(exports.map(item=>item.format),['excel','pdf']);
  assert.ok(exports.every(item=>item.payload.relatedCompanyState==='UNASSIGNED'));

  legacyQuality=true;
  await app.locator('#generate').click();
  await app.getByText('Reporte generado correctamente.').waitFor();
  assert.match(await app.locator('#quality').innerText(),/2 Movimientos sin compañía relacionada/,'Debe conservar compatibilidad cuando el backend solo entregue unassignedMovementCount.');

  const catalogSource=await fs.readFile(new URL('../public/accounting-reports.js',import.meta.url),'utf8');
  assert.match(catalogSource,/Préstamos intercompany/);assert.match(catalogSource,/intercompany-loans-report\.html/);
  const serviceSource=await fs.readFile(new URL('../src/modules/reports/intercompany-loans-report.service.ts',import.meta.url),'utf8');
  assert.match(serviceSource,/localPositions:\s*list\(source\.localPositions\)\.map\(localPosition\)/);assert.match(serviceSource,/addWorksheet\('Equivalencia local'/);assert.match(serviceSource,/Equivalencia en moneda local por compañía y moneda original/);
  console.log(JSON.stringify({contractFilters:true,currenciesSeparated:true,receivables:true,payables:true,netPositions:true,localPositions:true,localExports:true,restrictedBooks:true,qualityBreakdown:true,legacyQualityCompatible:true,fxDetail:true,originalDetail:true,dirtyFiltersProtected:true,csv:true,excel:true,pdf:true,catalogCard:true}));
}finally{await browser.close()}
