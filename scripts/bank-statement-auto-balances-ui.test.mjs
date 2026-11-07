import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {chromium,expect} from '@playwright/test';

const publicRoot=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};
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

const lines=[{date:'2026-10-03',valueDate:'2026-10-03',reference:'DEP-1',description:'Depósito recibido, factura FAC-001',beneficiary:'Cliente',amount:800},{date:'2026-10-12',valueDate:'',reference:'PAG-1',description:'Comisión bancaria',beneficiary:'Banco',amount:-25.5}];
const parsed={lines,openingBalance:100,closingBalance:874.5,balanceSource:'Extracto bancario'};
const csv='fecha,referencia,nota,monto,saldo\n2026-10-03,DEP-1,"Depósito recibido, factura FAC-001",800,900\n2026-10-12,PAG-1,Comisión bancaria,-25.5,874.5\n';
const file=(name='extracto.csv',content=csv)=>({name,mimeType:name.endsWith('.xlsx')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv',buffer:Buffer.from(content)});

async function fixture(){
  const context=await browser.newContext({viewport:{width:1500,height:950}});
  await context.addInitScript(()=>{localStorage.setItem('nexo_token','bank-auto-balances-test');localStorage.setItem('nexo_company','1');});
  const page=await context.newPage(),previewCalls=[],imports=[],controls={};
  page.setDefaultTimeout(8000);
  page.on('dialog',dialog=>dialog.accept());
  await page.route('**/api/reports/accounting/options',route=>route.fulfill({json:{
    subsidiaries:[{id:1,name:'Empresa de prueba',currencyId:1}],currencies:[{id:1,code:'USD',symbol:'$'}],
    books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],
    journalOptions:{canReverse:true,modules:[]},pendingInvoiceOptions:{customers:[]},
    bankOptions:{accounts:[7,8].map(id=>({id,number:`001-12${id}`,name:`Banco Uno - 001-12${id}`,bankId:2,bankName:'Banco Uno',subsidiaryId:1,currencyId:1,currencyCode:'USD',currencySymbol:'$'})),reconciliations:[{id:3,bankAccountId:7,accountNumber:'001-127',bankName:'Banco Uno',currencyCode:'USD',currencySymbol:'$',date:'2026-09-30',period:'Septiembre 2026',status:'CERRADA',bookBalance:100,statementBalance:100,transitPayments:0,transitDeposits:0,adjustments:0,difference:0,closedBy:'Contador de prueba',closedAt:'2026-10-01'}]}
  }}));
  await page.route('**/api/reports/accounting/bank-reconciliation',route=>route.fulfill({json:{rows:[],statementLines:[],summary:{bookBalance:999999,transitPayments:0,transitDeposits:0},reconciliation:{status:'ABIERTA'},total:0,page:1,pageSize:50}}));
  await page.route('**/api/reports/accounting/bank-reconciliation/preview',async route=>{
    const payload=route.request().postDataJSON();
    previewCalls.push(payload);
    if(controls.preview){await controls.preview(route,payload);return;}
    await route.fulfill({json:{result:parsed}});
  });
  await page.route('**/api/reports/accounting/bank-reconciliation/import',async route=>{
    imports.push(route.request().postDataJSON());
    await route.fulfill({json:{result:1,statementBalances:{openingBalance:100,closingBalance:874.5}}});
  });
  await page.goto(base+'/accounting-reports.html');
  await page.getByText('Bancos y Conciliación',{exact:true}).click();
  await page.locator('#bankCutoff').fill('2026-10-31');
  await page.locator('#bankCutoff').press('Tab');
  await expect(page.locator('#bankAccount')).toHaveValue('7');
  return{page,previewCalls,imports,controls,close:()=>context.close()};
}

async function populated(page,opening=100,closing=874.5){
  await expect(page.locator('#statementOpening')).not.toHaveValue('');
  await expect(page.locator('#statementClosing')).not.toHaveValue('');
  await expect.poll(async()=>Number(await page.locator('#statementOpening').inputValue())).toBe(opening);
  await expect.poll(async()=>Number(await page.locator('#statementClosing').inputValue())).toBe(closing);
}
async function cleared(page){
  await expect(page.locator('#statementOpening')).toHaveValue('');
  await expect(page.locator('#statementClosing')).toHaveValue('');
}

test('identifica el cierre del extracto anterior como origen y admite saldo inicial cero',{timeout:30000},async()=>{
 const app=await fixture();
 try{
  app.controls.preview=route=>route.fulfill({json:{result:{...parsed,openingBalance:0,closingBalance:774.5,openingBalanceSource:'PREVIOUS_STATEMENT',previousDate:'2026-09-30',previousStatement:{id:10,date:'2026-09-30',closingBalance:0}}}});
  await app.page.locator('#statementFile').setInputFiles(file());
  await populated(app.page,0,774.5);
  await expect(app.page.locator('#statementFileStatus')).toContainText('cierre del extracto anterior (2026-09-30)');
  await expect(app.page.locator('#statementFileStatus')).toContainText('saldo final calculado con los movimientos');
  await expect(app.page.locator('#importStatement')).toBeEnabled();
  assert.equal(app.imports.length,0);
 }finally{await app.close();}
});

test('una diferencia de continuidad muestra la revisión necesaria y no permite importar',{timeout:30000},async()=>{
 const app=await fixture();
 try{
  app.controls.preview=route=>route.fulfill({status:400,json:{error:{message:'El saldo final del archivo no coincide con la continuidad del extracto anterior (2026-09-30). Esperado: 25.67; archivo: 23.670000; diferencia: -2.000000. Revise los movimientos y saldos del archivo antes de importarlo.'}}});
  await app.page.locator('#statementFile').setInputFiles(file());
  await expect(app.page.locator('#statementFileStatus')).toHaveClass(/error/);
  await expect(app.page.locator('#statementFileStatus')).toContainText('Esperado: 25.67');
  await expect(app.page.locator('#statementFileStatus')).toContainText('archivo: 23.670000');
  await expect(app.page.locator('#statementFileStatus')).toContainText('diferencia: -2.000000');
  await cleared(app.page);await expect(app.page.locator('#importStatement')).toBeDisabled();
  assert.equal(app.imports.length,0);
 }finally{await app.close();}
});

test('completa ambos saldos desde la vista previa y usa esos valores al importar CSV y Excel',{timeout:30000},async()=>{
  const app=await fixture();
  try{
    const {page}=app;
    assert.equal(await page.locator('#statementOpening').evaluate(input=>input.readOnly),true);
    assert.equal(await page.locator('#statementClosing').evaluate(input=>input.readOnly),true);
    await page.locator('#statementFile').setInputFiles(file());
    await populated(page);
    assert.deepEqual(app.previewCalls[0],{p_bank_account_id:7,p_statement_date:'2026-10-31',p_file_name:'extracto.csv',p_file_text:csv});
    await page.locator('#statementOpening').evaluate(input=>{input.value='999999';});
    await page.locator('#statementClosing').evaluate(input=>{input.value='999999';});
    await page.locator('#importStatement').click();
    await expect.poll(()=>app.imports.length).toBe(1);
    assert.equal(app.imports[0].p_opening_balance,100);
    assert.equal(app.imports[0].p_closing_balance,874.5);
    assert.equal(app.imports[0].p_file_text,csv);
    assert.equal(app.imports[0].p_lines,undefined,'El servidor vuelve a leer el archivo original; no se deben duplicar sus movimientos en el payload.');
    await populated(page);

    const bytes='spreadsheet fixture validated by mocked backend';
    await page.locator('#statementFile').setInputFiles(file('extracto.xlsx',bytes));
    await expect.poll(()=>app.previewCalls.length).toBe(2);
    await populated(page);
    assert.equal(app.previewCalls[1].p_file_base64,Buffer.from(bytes).toString('base64'));
    assert.equal(app.previewCalls[1].p_file_text,undefined);
    await page.locator('#importStatement').click();
    await expect.poll(()=>app.imports.length).toBe(2);
    assert.equal(app.imports[1].p_file_base64,Buffer.from(bytes).toString('base64'));
    assert.equal(app.imports[1].p_opening_balance,100);
    assert.equal(app.imports[1].p_closing_balance,874.5);
  }finally{await app.close();}
});

test('limpia los saldos al cambiar cuenta, fecha o archivo y descarta respuestas tardías',{timeout:30000},async()=>{
  const app=await fixture();
  let release;
  try{
    const {page}=app;
    await page.locator('#statementFile').setInputFiles(file());
    await populated(page);
    await page.locator('#bankAccount').selectOption('8');
    await cleared(page);

    await page.locator('#statementFile').setInputFiles(file());
    await populated(page);
    await page.locator('#bankCutoff').fill('2026-09-30');
    await page.locator('#bankCutoff').press('Tab');
    await cleared(page);

    await page.locator('#statementFile').setInputFiles(file());
    await populated(page);
    await page.locator('#statementFile').setInputFiles([]);
    await cleared(page);

    app.controls.preview=route=>route.fulfill({status:400,json:{error:{message:'El archivo no incluye saldos y no existe un extracto bancario anterior para calcularlos.'}}});
    await page.locator('#statementFile').setInputFiles(file('sin-saldos.csv'));
    await expect(page.locator('#statementFileStatus')).toContainText('no existe un extracto bancario anterior');
    await cleared(page);
    assert.equal(app.imports.length,0);

    const delayed=new Promise(resolve=>{release=resolve;});
    app.controls.preview=async route=>{
      await delayed;
      await route.fulfill({json:{result:{...parsed,openingBalance:555,closingBalance:777}}});
    };
    const isDelayed=request=>request.url().endsWith('/bank-reconciliation/preview')&&request.postDataJSON().p_file_name==='lento.csv';
    const requested=page.waitForRequest(isDelayed);
    const settled=Promise.race([page.waitForEvent('requestfinished',{predicate:isDelayed}),page.waitForEvent('requestfailed',{predicate:isDelayed})]);
    await page.locator('#statementFile').setInputFiles(file('lento.csv'));
    await requested;
    await page.locator('#bankAccount').selectOption('7');
    await cleared(page);
    release();
    await settled;
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(page.locator('#statementFileStatus')).not.toContainText('movimientos listos');
    await cleared(page);
    assert.equal(app.imports.length,0);
  }finally{release?.();await app.close();}
});

test('descarta el extracto preparado al abrir otra fecha desde el historial',{timeout:20000},async()=>{
  const app=await fixture();
  try{
    const {page}=app;
    await page.locator('#statementFile').setInputFiles(file());
    await populated(page);
    await expect(page.locator('#importStatement')).toBeEnabled();
    await page.locator('#bankView').selectOption('HISTORY');
    await page.getByRole('button',{name:'Ver reporte de cierre'}).click();
    await expect(page.locator('#bankView')).toHaveValue('CLOSED');
    await expect(page.locator('#bankCutoff')).toHaveValue('2026-09-30');
    await cleared(page);
    await expect(page.locator('#statementFile')).toHaveValue('');
    await expect(page.locator('#importStatement')).toBeDisabled();
    assert.equal(app.imports.length,0);
  }finally{await app.close();}
});
