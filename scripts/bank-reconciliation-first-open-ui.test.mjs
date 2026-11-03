import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {chromium,expect} from '@playwright/test';

const publicRoot=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
let server,browser,base;

test.before(async()=>{
  server=createServer(async(request,response)=>{
    try{
      const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
      const file=resolve(publicRoot,`.${pathname==='/'?'/accounting-reports.html':pathname}`);
      if(!file.startsWith(publicRoot+sep)){response.writeHead(403);response.end();return;}
      const content=await readFile(file);
      response.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});
      response.end(content);
    }catch{response.writeHead(404);response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser=await chromium.launch({headless:true,...(existsSync(chrome)?{executablePath:chrome}:{})});
});

test.after(async()=>{
  await browser?.close();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

const options={
  subsidiaries:[{id:1,name:'Empresa de prueba',currencyId:1},{id:2,name:'Segunda empresa',currencyId:2}],currencies:[{id:1,code:'USD',symbol:'$'},{id:2,code:'EUR',symbol:'€'}],
  books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],
  journalOptions:{canReverse:true,modules:[]},pendingInvoiceOptions:{customers:[]},
  bankOptions:{accounts:[
    {id:7,number:'001-123',name:'Banco Uno - 001-123',bankId:2,bankName:'Banco Uno',subsidiaryId:1,currencyId:1,currencyCode:'USD',currencySymbol:'$'},
    {id:8,number:'002-456',name:'Banco Dos - 002-456',bankId:3,bankName:'Banco Dos',subsidiaryId:1,currencyId:1,currencyCode:'USD',currencySymbol:'$'},
    {id:9,number:'001-789',name:'Banco Uno - 001-789',bankId:2,bankName:'Banco Uno',subsidiaryId:1,currencyId:2,currencyCode:'EUR',currencySymbol:'€'},
    {id:10,number:'003-012',name:'Banco Tres - 003-012',bankId:4,bankName:'Banco Tres',subsidiaryId:2,currencyId:2,currencyCode:'EUR',currencySymbol:'€'}
  ],reconciliations:[]}
};
const bankReport={
  rows:[{id:11,date:'2026-10-03',value_date:'2026-10-03',reconciliation_status:'CONCILIADO',transaction_type:'PAG',reference:'ERP-11',beneficiary:'Proveedor de prueba',description:'Pago bancario',note:'Pago bancario',deposits:0,withdrawals:25,running_balance:1000}],
  statementLines:[],summary:{bookBalance:1000,statementBalance:1000,transitPayments:0,transitDeposits:0},
  reconciliation:{status:'ABIERTA'},total:1,page:1,pageSize:50
};

async function fixture(query=''){
  const context=await browser.newContext({viewport:{width:1500,height:950}});
  await context.addInitScript(()=>{localStorage.setItem('nexo_token','bank-first-open-test');localStorage.setItem('nexo_company','1');});
  const page=await context.newPage(),errors=[],reportCalls=[];
  page.setDefaultTimeout(8000);
  page.on('pageerror',error=>errors.push(error.message));
  let releaseOptions,resolveOptionsRequested;
  const optionsResponse=new Promise(resolve=>{releaseOptions=resolve;});
  const optionsRequested=new Promise(resolve=>{resolveOptionsRequested=resolve;});
  await page.route('**/api/reports/accounting/*',async route=>{
    const report=new URL(route.request().url()).pathname.split('/').at(-1);
    if(report==='options'){
      resolveOptionsRequested();
      await route.fulfill(await optionsResponse);
      return;
    }
    reportCalls.push({report,filters:route.request().postDataJSON()});
    await route.fulfill({json:report==='bank-reconciliation'?bankReport:{rows:[],total:0,summary:{}}});
  });
  await page.goto(`${base}/accounting-reports.html${query}`,{waitUntil:'commit'});
  await optionsRequested;
  const card=key=>page.locator('.card').filter({has:page.locator(`[data-i18n="reports.catalog.${key}.title"]`)});
  await card('bank-reconciliation').waitFor();
  return{
    page,card,errors,reportCalls,
    loadOptions:()=>releaseOptions({json:options}),
    failOptions:message=>releaseOptions({status:503,json:{error:{message}}}),
    close:async()=>{releaseOptions({json:options});await context.close();}
  };
}

async function waitingForOptions(app){
  const {page,reportCalls,errors}=app;
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('#reportsInitializationMessage')).toBeVisible();
  await expect(page.locator('#reportsInitializationMessage')).not.toHaveText('');
  assert.equal(reportCalls.length,0,'No debe consultar informes antes de cargar los filtros.');
  assert.deepEqual(errors,[]);
}

async function settled(page){
  await page.waitForLoadState('load');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}

async function completeBankView(app,expectedCalls=1,bankContext={bank:'2',currency:'1',account:'7'}){
  const {page,reportCalls,errors}=app;
  await expect(page.locator('#dashboard')).toBeHidden();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#bankControls')).toBeVisible();
  for(const id of ['bankView','bankFilter','bankCurrency','bankAccount','bankCutoff','statementOpening','statementClosing','statementFile','importStatement','autoMatch','closeReconciliation']){
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
  await expect(page.locator('#bankView')).toHaveValue('AUXILIARY');
  await expect(page.locator('#bankFilter')).toHaveValue(bankContext.bank);
  await expect(page.locator('#bankCurrency')).toHaveValue(bankContext.currency);
  await expect(page.locator('#bankAccount')).toHaveValue(bankContext.account);
  await expect(page.locator('#bankCutoff')).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  await expect(page.locator('#tbody')).toContainText('ERP-11');
  await expect(page.locator('#summary')).toContainText('Saldo según libros ERP');
  await expect(page.locator('#reportsInitializationMessage')).toBeHidden();
  await expect.poll(()=>reportCalls.length).toBe(expectedCalls);
  await settled(page);
  assert.equal(reportCalls.length,expectedCalls,'Cada apertura debe consultar el informe una sola vez.');
  assert.ok(reportCalls.every(call=>call.report==='bank-reconciliation'));
  const last=reportCalls.at(-1).filters;
  assert.equal(last.bankAccountId,bankContext.account);
  assert.equal(last.bankView,'AUXILIARY');
  assert.equal(last.currencyId,bankContext.currency);
  assert.equal(last.dateTo,await page.locator('#bankCutoff').inputValue());
  assert.deepEqual(errors,[]);
}

test('espera las opciones en la primera entrada y muestra todos los controles sin reabrir',{timeout:20000},async()=>{
  const app=await fixture();
  try{
    await app.card('bank-reconciliation').click();
    await waitingForOptions(app);
    app.loadOptions();
    await completeBankView(app);

    await app.page.locator('#catalog').click();
    await expect(app.page.locator('#dashboard')).toBeVisible();
    await app.card('bank-reconciliation').click();
    await completeBankView(app,2);
  }finally{await app.close();}
});

test('abre solamente Bancos cuando es el último informe solicitado durante la carga',{timeout:20000},async()=>{
  const app=await fixture();
  try{
    await app.card('trial-balance').click();
    await app.card('bank-reconciliation').click();
    await waitingForOptions(app);
    app.loadOptions();
    await completeBankView(app);
  }finally{await app.close();}
});

test('respeta la selección más reciente si el usuario cambia de Bancos a otro informe',{timeout:20000},async()=>{
  const app=await fixture();
  try{
    await app.card('bank-reconciliation').click();
    await app.card('trial-balance').click();
    await waitingForOptions(app);
    app.loadOptions();
    await expect(app.page.locator('#reportTitle')).toHaveText('Balance de Comprobación');
    await expect(app.page.locator('#workspace')).toBeVisible();
    await expect(app.page.locator('#bankControls')).toBeHidden();
    await expect(app.page.locator('#summary')).toContainText('Auditoría de partida doble');
    await expect(app.page.locator('#reportsInitializationMessage')).toBeHidden();
    await settled(app.page);
    assert.deepEqual(app.reportCalls.map(call=>call.report),['trial-balance']);
    assert.deepEqual(app.errors,[]);
  }finally{await app.close();}
});

test('la URL directa espera las opciones y abre Bancos completo una sola vez',{timeout:20000},async()=>{
  const app=await fixture('?reporte=bank-reconciliation');
  try{
    await waitingForOptions(app);
    app.loadOptions();
    await completeBankView(app);
  }finally{await app.close();}
});

test('la primera consulta de una URL directa usa la empresa solicitada',{timeout:20000},async()=>{
  const app=await fixture('?reporte=bank-reconciliation&subsidiaryId=2');
  try{
    await waitingForOptions(app);
    app.loadOptions();
    await completeBankView(app,1,{bank:'4',currency:'2',account:'10'});
    await expect(app.page.locator('#subsidiaries')).toHaveValue('2');
    assert.deepEqual(app.reportCalls[0].filters.subsidiaryIds,[2]);
  }finally{await app.close();}
});

test('cambiar banco o moneda sigue actualizando el informe después de la apertura',{timeout:20000},async()=>{
  const app=await fixture('?reporte=bank-reconciliation');
  try{
    app.loadOptions();
    await completeBankView(app);
    await app.page.locator('#bankFilter').selectOption('3');
    await expect.poll(()=>app.reportCalls.length).toBe(2);
    await expect(app.page.locator('#bankAccount')).toHaveValue('8');
    assert.equal(app.reportCalls.at(-1).filters.bankAccountId,'8');

    await app.page.locator('#bankFilter').selectOption('2');
    await expect.poll(()=>app.reportCalls.length).toBe(3);
    await app.page.locator('#bankCurrency').selectOption('2');
    await expect.poll(()=>app.reportCalls.length).toBe(4);
    await expect(app.page.locator('#bankAccount')).toHaveValue('9');
    assert.equal(app.reportCalls.at(-1).filters.bankAccountId,'9');
    assert.equal(app.reportCalls.at(-1).filters.currencyId,'2');
    await settled(app.page);
    assert.equal(app.reportCalls.length,4);
    assert.deepEqual(app.errors,[]);
  }finally{await app.close();}
});

test('un error al cargar opciones conserva el catálogo y explica el fallo sin un informe parcial',{timeout:20000},async()=>{
  const app=await fixture();
  try{
    await app.card('bank-reconciliation').click();
    await waitingForOptions(app);
    const message='No fue posible cargar los filtros bancarios de prueba.';
    app.failOptions(message);
    await expect(app.page.locator('#reportsInitializationMessage')).toBeVisible();
    await expect(app.page.locator('#reportsInitializationMessage')).toContainText(message);
    await expect(app.page.locator('#dashboard')).toBeVisible();
    await expect(app.page.locator('#workspace')).toBeHidden();
    await app.card('bank-reconciliation').click();
    await expect(app.page.locator('#reportsInitializationMessage')).toContainText(message);
    await expect(app.page.locator('#workspace')).toBeHidden();
    await settled(app.page);
    assert.equal(app.reportCalls.length,0);
    assert.deepEqual(app.errors,[]);
  }finally{await app.close();}
});
