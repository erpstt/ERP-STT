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
   const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname),file=resolve(publicRoot,`.${pathname==='/'?'/accounting-reports.html':pathname}`);
   if(!file.startsWith(publicRoot+sep)){response.writeHead(403);response.end();return;}
   const content=await readFile(file);response.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});response.end(content);
  }catch{response.writeHead(404);response.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
 const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
 browser=await chromium.launch({headless:true,...(existsSync(chrome)?{executablePath:chrome}:{})});
});
test.after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});

const erp=(id,status,note,amount=-25)=>({id,date:'2026-10-03',value_date:'2026-10-03',reconciliation_status:status,transaction_type:'PAG',reference:`ERP-${id}`,beneficiary:'Proveedor',description:note,note,deposits:Math.max(0,amount),withdrawals:Math.max(0,-amount),running_balance:1000});
const bank=(id,status,description,amount=-25)=>({statement_line_id:id,bank_date:'2026-10-03',reconciliation_status:status,reference:`BANK-${id}`,description,amount});
const defaultRows=()=>[erp(10,'CONCILIADO','ERP conciliado anterior'),erp(11,'PENDIENTE_EN_TRANSITO','ERP pendiente para conciliar'),erp(12,'CONCILIADO','ERP conciliado posterior')];
const defaultStatement=()=>[bank(19,'CONCILIADO','Banco conciliado anterior'),bank(20,'PENDIENTE','Comisión pendiente correcta'),bank(21,'CONCILIADO','Banco conciliado posterior'),bank(22,'PENDIENTE','Depósito pendiente',100)];

async function fixture({rows=defaultRows(),statement=defaultStatement()}={}){
 const state={rows:structuredClone(rows),statement:structuredClone(statement),reports:[],manual:[],automatic:[],fees:[]};
 const context=await browser.newContext({viewport:{width:1600,height:1000}});
 await context.addInitScript(()=>{localStorage.setItem('nexo_token','bank-pending-views-test');localStorage.setItem('nexo_company','1');});
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('dialog',dialog=>dialog.accept());
 await page.route('**/api/reports/accounting/options',route=>route.fulfill({json:{
  subsidiaries:[{id:1,name:'Empresa de prueba',currencyId:1}],currencies:[{id:1,code:'USD',symbol:'$'}],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],journalOptions:{canReverse:true,modules:[]},pendingInvoiceOptions:{customers:[]},
  bankOptions:{accounts:[{id:7,number:'001-123',name:'Banco Uno - 001-123',bankId:2,bankName:'Banco Uno',subsidiaryId:1,currencyId:1,currencyCode:'USD',currencySymbol:'$'}],reconciliations:[]}
 }}));
 await page.route('**/api/reports/accounting/bank-reconciliation',route=>{
  const filters=route.request().postDataJSON();state.reports.push(filters);
  const pageNumber=Number(filters.page)||1,pageSize=Number(filters.pageSize)||50,start=(pageNumber-1)*pageSize;
  return route.fulfill({json:{rows:state.rows.slice(start,start+pageSize),statementLines:state.statement,summary:{bookBalance:1000,statementBalance:1000,transitPayments:0,transitDeposits:0},reconciliation:{status:'ABIERTA'},total:state.rows.length,page:pageNumber,pageSize}});
 });
 const complete=(erpId=11,statementId=20)=>{
  const erpRow=state.rows.find(row=>row.id===erpId),statementRow=state.statement.find(row=>row.statement_line_id===statementId);
  if(erpRow)erpRow.reconciliation_status='CONCILIADO';if(statementRow)statementRow.reconciliation_status='CONCILIADO';
 };
 await page.route('**/api/reports/accounting/bank-reconciliation/match',route=>{
  const payload=route.request().postDataJSON();state.manual.push(payload);complete(payload.p_bank_tran_id,payload.p_statement_line_id);return route.fulfill({json:{result:1}});
 });
 await page.route('**/api/reports/accounting/bank-reconciliation/auto',route=>{
  state.automatic.push(route.request().postDataJSON());complete();return route.fulfill({json:{result:1}});
 });
 await page.route('**/api/reports/accounting/bank-reconciliation/bank-fees',route=>{
  const payload=route.request().postDataJSON();state.fees.push(payload);
  for(const id of payload.p_statement_line_ids){const line=state.statement.find(row=>row.statement_line_id===id);if(line){line.reconciliation_status='CONCILIADO';state.rows.push(erp(1000+id,'CONCILIADO',`ERP comisión registrada ${id}`,line.amount));}}
  return route.fulfill({status:201,json:{result:{createdCount:payload.p_statement_line_ids.length,totalAmount:25,matchedStatementLineIds:payload.p_statement_line_ids}}});
 });
 await page.goto(base+'/accounting-reports.html');await page.getByText('Bancos y Conciliación',{exact:true}).click();
 await page.locator('#bankCutoff').fill('2026-10-31');await page.locator('#bankCutoff').press('Tab');
 await page.locator('#bankView').selectOption('WORKSPACE');
 await expect(page.locator('#bankPendingTab')).toHaveAttribute('aria-selected','true');
 return{page,state,close:()=>context.close()};
}

async function assertReadOnlyCompleted(page){
 await expect(page.locator('#bankView')).toHaveValue('RECONCILED');
 await expect(page.locator('#bankReconciledTab')).toHaveAttribute('aria-selected','true');
 await expect(page.locator('input[name="erpMatch"],input[name="bankMatch"],[data-bank-fee-line]')).toHaveCount(0);
 await expect(page.locator('#bankFeeMode')).toHaveCount(0);
 await expect(page.locator('.manual-match,.bank-match-hint,.bank-fee-panel')).toHaveCount(0);
}

test('separa pendientes y conciliados y conserva la casilla de comisión en su movimiento correcto',{timeout:30000},async()=>{
 const app=await fixture();try{
  const {page}=app;
  await expect(page.locator('#tbody')).toContainText('ERP pendiente para conciliar');
  await expect(page.locator('#tbody')).toContainText('Comisión pendiente correcta');
  await expect(page.locator('#tbody')).not.toContainText('ERP conciliado anterior');
  await expect(page.locator('#tbody')).not.toContainText('Banco conciliado posterior');
  await expect(page.locator('input[name="erpMatch"]')).toHaveCount(1);
  await expect(page.locator('input[name="bankMatch"]')).toHaveCount(2);
  await page.locator('input[name="erpMatch"][value="11"]').check();
  await page.locator('input[name="bankMatch"][value="20"]').check();
  await expect(page.locator('#bankFeeMode')).not.toBeChecked();
  await expect(page.locator('[data-bank-fee-line],.bank-fee-panel')).toHaveCount(0);
  await page.locator('#bankFeeMode').check();
  const fee=page.locator('[data-bank-fee-line][value="20"]');await expect(fee).toHaveCount(1);
  await expect(fee.locator('xpath=ancestor::tr')).toContainText('Comisión pendiente correcta');
  await expect(page.locator('[data-bank-fee-line][value="19"],[data-bank-fee-line][value="21"]')).toHaveCount(0);
  await fee.check();await page.locator('#bankFeeMode').uncheck();
  await expect(page.locator('[data-bank-fee-line],.bank-fee-panel')).toHaveCount(0);
  await expect(page.locator('input[name="erpMatch"][value="11"]')).toBeChecked();
  await expect(page.locator('input[name="bankMatch"][value="20"]')).toBeChecked();
  await expect(page.getByRole('button',{name:'Conciliar los dos movimientos seleccionados',exact:true})).toBeEnabled();
  await page.locator('#bankReconciledTab').click();await assertReadOnlyCompleted(page);
  await expect(page.locator('#tbody')).toContainText('ERP conciliado anterior');
  await expect(page.locator('#tbody')).toContainText('Banco conciliado posterior');
  await expect(page.locator('#tbody')).not.toContainText('Comisión pendiente correcta');
  await page.locator('#bankPendingTab').click();
  await expect(page.locator('#bankView')).toHaveValue('WORKSPACE');
  await expect(page.locator('#bankFeeMode')).not.toBeChecked();
  await expect(page.locator('[data-bank-fee-line],.bank-fee-panel')).toHaveCount(0);
  await expect(page.locator('#tbody')).toContainText('ERP pendiente para conciliar');
  await expect(page.locator('#tbody')).not.toContainText('ERP conciliado posterior');
 }finally{await app.close();}
});

test('las conciliaciones manuales, automáticas y las comisiones salen de pendientes al refrescar',{timeout:60000},async t=>{
 for(const mode of ['manual','automatic','fees'])await t.test(mode,async()=>{
  const app=await fixture();try{
   const {page,state}=app;
   await expect(page.locator('#tbody')).toContainText('Comisión pendiente correcta');
   if(mode==='manual'){
    await page.locator('input[name="erpMatch"][value="11"]').check();await page.locator('input[name="bankMatch"][value="20"]').check();
    await page.getByRole('button',{name:'Conciliar los dos movimientos seleccionados',exact:true}).click();
    await expect.poll(()=>state.manual.length).toBe(1);assert.equal(state.manual[0].p_bank_tran_id,11);assert.equal(state.manual[0].p_statement_line_id,20);
   }else if(mode==='automatic'){
    await page.locator('#autoMatch').click();await expect.poll(()=>state.automatic.length).toBe(1);
   }else{
    await page.locator('#bankFeeMode').check();
    await page.locator('[data-bank-fee-line][value="20"]').check();await page.locator('#registerBankFees').click();
    await expect(page.locator('#bankFeeDialog')).toHaveAttribute('open','');await page.locator('#confirmBankFees').click();
    await expect.poll(()=>state.fees.length).toBe(1);assert.deepEqual(state.fees[0].p_statement_line_ids,[20]);
   }
   await expect(page.locator('#tbody')).not.toContainText('Comisión pendiente correcta');
   await expect(page.locator('[data-bank-fee-line][value="20"]')).toHaveCount(0);
   await expect(page.locator('#bankFeeMode')).not.toBeChecked();
   await expect(page.locator('.bank-fee-panel')).toHaveCount(0);
   await page.locator('#bankReconciledTab').click();await assertReadOnlyCompleted(page);
   await expect(page.locator('#tbody')).toContainText('Comisión pendiente correcta');
   if(mode!=='fees')await expect(page.locator('#tbody')).toContainText('ERP pendiente para conciliar');
   else await expect(page.locator('#tbody')).toContainText('ERP comisión registrada 20');
  }finally{await app.close();}
 });
});

test('recupera pendientes posteriores a la primera página fuente y pagina cada apartado sin mezclarlo',{timeout:30000},async()=>{
 const rows=Array.from({length:250},(_,index)=>erp(index+100,'CONCILIADO',`ERP cerrado ${String(index+1).padStart(3,'0')}`));
 rows.push(erp(999,'PENDIENTE_EN_TRANSITO','ERP pendiente después de página fuente'));
 const app=await fixture({rows,statement:[bank(20,'PENDIENTE','Banco pendiente visible')]});try{
  const {page,state}=app;
  await expect(page.locator('#tbody')).toContainText('ERP pendiente después de página fuente');
  assert.ok(state.reports.some(filters=>filters.bankView==='WORKSPACE'&&Number(filters.page)===2&&Number(filters.pageSize)===250),'Debe recuperar la segunda página ERP antes de filtrar.');
  await expect(page.locator('#tbody')).not.toContainText('ERP cerrado 001');
  await page.locator('#bankReconciledTab').click();await assertReadOnlyCompleted(page);
  await expect(page.locator('#tbody')).toContainText('ERP cerrado 001');
  await expect(page.locator('#tbody')).not.toContainText('ERP pendiente después de página fuente');
  await expect(page.locator('#next')).toBeEnabled();await page.locator('#next').click();
  await expect(page.locator('#page')).toContainText('Página 2');
  await expect(page.locator('#tbody')).not.toContainText('ERP cerrado 001');
  await page.locator('#bankPendingTab').click();await expect(page.locator('#page')).toContainText('Página 1');
  await expect(page.locator('#tbody')).toContainText('ERP pendiente después de página fuente');
 }finally{await app.close();}
});

test('muestra un estado vacío claro cuando un apartado no tiene movimientos',{timeout:30000},async()=>{
 for(const completed of [false,true]){
  const status=completed?'CONCILIADO':'PENDIENTE',app=await fixture({rows:[erp(11,status,'Único ERP')],statement:[bank(20,status,'Único banco')]});
  try{
   if(!completed)await app.page.locator('#bankReconciledTab').click();
   await expect(app.page.locator('#tbody')).not.toContainText('Único ERP');await expect(app.page.locator('#tbody')).not.toContainText('Único banco');
   await expect(app.page.locator('#tbody')).toContainText(completed?/pendient/i:/conciliad/i);
   await expect(app.page.locator('input[name="erpMatch"],input[name="bankMatch"],[data-bank-fee-line]')).toHaveCount(0);
  }finally{await app.close();}
 }
});

test('conserva la selección ERP al cambiar de página para conciliarla con otra página del banco',{timeout:30000},async()=>{
 const statement=Array.from({length:60},(_,index)=>bank(index+1,'PENDIENTE',`Banco pendiente ${index+1}`));
 const app=await fixture({rows:[erp(11,'PENDIENTE_EN_TRANSITO','ERP elegido en la primera página')],statement});
 try{
  const {page,state}=app;
  await page.locator('input[name="erpMatch"][value="11"]').check();
  await expect(page.locator('#next')).toBeEnabled();await page.locator('#next').click();
  await expect(page.locator('#page')).toContainText('Página 2');
  await expect(page.locator('input[name="erpMatch"]')).toHaveCount(0);
  await page.locator('input[name="bankMatch"][value="60"]').check();
  await expect(page.locator('.bank-match-hint')).toContainText('ERP-11');
  const submit=page.getByRole('button',{name:'Conciliar los dos movimientos seleccionados',exact:true});
  await expect(submit).toBeEnabled();await submit.click();
  await expect.poll(()=>state.manual.length).toBe(1);
  assert.deepEqual(state.manual[0],{p_bank_tran_id:11,p_statement_line_id:60,p_cutoff:'2026-10-31'});
  await expect(page.locator('#tbody')).not.toContainText('Banco pendiente 60');
  await expect(page.locator('input[name="erpMatch"]:checked,input[name="bankMatch"]:checked')).toHaveCount(0);
  await page.locator('#bankReconciledTab').click();await assertReadOnlyCompleted(page);
  await expect(page.locator('#tbody')).toContainText('ERP elegido en la primera página');
  await expect(page.locator('#tbody')).toContainText('Banco pendiente 60');
 }finally{await app.close();}
});

async function csvDownload(page){
 const downloaded=page.waitForEvent('download');await page.locator('#csv').click();
 const stream=await(await downloaded).createReadStream(),chunks=[];
 for await(const chunk of stream)chunks.push(chunk);
 return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,'');
}

test('el CSV exporta solo el apartado elegido e incluye los movimientos del ERP y del extracto',{timeout:30000},async()=>{
 const app=await fixture();try{
  const {page}=app;
  await expect(page.locator('#tbody')).toContainText('Comisión pendiente correcta');
  const pending=await csvDownload(page);
  assert.deepEqual(pending.split(/\r?\n/)[0].split(',').map(cell=>cell.replace(/^"|"$/g,'')),['Origen','Estado','Fecha','Referencia','Nota','Monto']);
  assert.match(pending,/ERP pendiente para conciliar/);assert.match(pending,/Comisión pendiente correcta/);assert.match(pending,/Depósito pendiente/);
  assert.doesNotMatch(pending,/ERP conciliado anterior|ERP conciliado posterior|Banco conciliado anterior|Banco conciliado posterior/);
  await page.locator('#bankReconciledTab').click();await assertReadOnlyCompleted(page);
  const completed=await csvDownload(page);
  assert.match(completed,/ERP conciliado anterior/);assert.match(completed,/Banco conciliado posterior/);
  assert.doesNotMatch(completed,/ERP pendiente para conciliar|Comisión pendiente correcta|Depósito pendiente/);
 }finally{await app.close();}
 const bankOnly=await fixture({rows:[],statement:[bank(20,'PENDIENTE','Solo existe el movimiento bancario')]});
 try{
  await expect(bankOnly.page.locator('#tbody')).toContainText('Solo existe el movimiento bancario');
  const result=await csvDownload(bankOnly.page);assert.match(result,/Solo existe el movimiento bancario/);
 }finally{await bankOnly.close();}
});
