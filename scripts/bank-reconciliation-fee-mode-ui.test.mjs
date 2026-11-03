import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {chromium,expect} from '@playwright/test';

// Serve only the public frontend; all financial API responses stay in this test.
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

const erp=(id,status='PENDIENTE_EN_TRANSITO')=>({id,date:'2026-10-03',value_date:'2026-10-03',reconciliation_status:status,transaction_type:'PAG',reference:`ERP-${id}`,beneficiary:'Proveedor',description:`Movimiento ERP ${id}`,note:`Movimiento ERP ${id}`,deposits:0,withdrawals:25,running_balance:1000});
const bank=(id,amount=-25,status='PENDIENTE',extra={})=>({statement_line_id:id,bank_date:'2026-10-03',reconciliation_status:status,reference:`BANK-${id}`,description:`Movimiento bancario ${id}`,amount,...extra});
const defaultStatement=()=>[
 bank(20),bank(21,100),bank(22,-10,'CONCILIADO'),bank(23,-15,'PENDIENTE',{bank_tran_id:99}),
 bank(24,-12.50),bank(25,-10,'REGISTRADA'),bank(26,-10,'MATCHED'),bank(27,0)
];

async function fixture({rows=[erp(11),erp(12,'CONCILIADO')],statement=defaultStatement(),productionTheme=false}={}){
 const state={rows:structuredClone(rows),statement:structuredClone(statement),reports:[],fees:[]};
 const context=await browser.newContext({viewport:{width:1600,height:1000}});
 await context.addInitScript(()=>{localStorage.setItem('nexo_token','isolated-bank-fee-mode-test');localStorage.setItem('nexo_company','1');});
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('dialog',dialog=>dialog.accept());
 await page.route('**/api/reports/accounting/options',route=>route.fulfill({json:{
  subsidiaries:[{id:1,name:'Empresa de prueba',currencyId:1}],currencies:[{id:1,code:'USD',symbol:'$'}],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],journalOptions:{canReverse:true,modules:[]},pendingInvoiceOptions:{customers:[]},
  bankOptions:{accounts:[7,8].map(id=>({id,number:`001-${id}`,name:`Banco Uno - 001-${id}`,bankId:2,bankName:'Banco Uno',subsidiaryId:1,currencyId:1,currencyCode:'USD',currencySymbol:'$'})),reconciliations:[]}
 }}));
 await page.route('**/api/reports/accounting/bank-reconciliation',route=>{
  const filters=route.request().postDataJSON();state.reports.push(filters);
  const pageNumber=Number(filters.page)||1,pageSize=Number(filters.pageSize)||50,start=(pageNumber-1)*pageSize;
  return route.fulfill({json:{rows:state.rows.slice(start,start+pageSize),statementLines:state.statement,summary:{bookBalance:1000,statementBalance:1000,transitPayments:0,transitDeposits:0},reconciliation:{status:'ABIERTA'},total:state.rows.length,page:pageNumber,pageSize}});
 });
 await page.route('**/api/reports/accounting/bank-reconciliation/bank-fees',route=>{
  const payload=route.request().postDataJSON();state.fees.push(payload);let totalAmount=0;
  for(const id of payload.p_statement_line_ids){const line=state.statement.find(item=>item.statement_line_id===id);if(line){totalAmount+=Math.abs(line.amount);line.reconciliation_status='CONCILIADO';state.rows.push(erp(1000+id,'CONCILIADO'));}}
  return route.fulfill({status:201,json:{result:{createdCount:payload.p_statement_line_ids.length,totalAmount,matchedStatementLineIds:payload.p_statement_line_ids}}});
 });
 await page.goto(base+'/accounting-reports.html');
 if(productionTheme){
  await page.evaluate(()=>document.documentElement.classList.add('inside-erp-workspace'));
  await page.addStyleTag({url:base+'/gentia-theme.css'});
 }
 await page.getByText('Bancos y Conciliaci\u00f3n',{exact:true}).click();
 await page.locator('#bankCutoff').fill('2026-10-31');await page.locator('#bankCutoff').press('Tab');
 await page.locator('#bankView').selectOption('WORKSPACE');
 await expect(page.locator('#bankPendingTab')).toHaveAttribute('aria-selected','true');
 await expect(page.locator('#bankFeeMode')).toBeVisible();
 return{page,state,close:()=>context.close()};
}

async function assertModeOff(page){
 await expect(page.getByRole('switch',{name:'Comisiones',exact:true})).not.toBeChecked();
 await expect(page.locator('[data-bank-fee-line],.bank-fee-panel')).toHaveCount(0);
}

test('las comisiones requieren activar el interruptor del encabezado y solo aparecen en salidas elegibles',{timeout:30000},async()=>{
 const app=await fixture();try{
  const {page}=app;
  await assertModeOff(page);
  await expect(page.locator('#thead th #bankFeeMode')).toHaveCount(1);
  await expect(page.locator('input[name="bankMatch"][value="20"]')).toBeVisible();
  await expect(page.locator('input[name="erpMatch"][value="11"]')).toBeVisible();
  await page.getByRole('switch',{name:'Comisiones',exact:true}).check();
  await expect(page.locator('.bank-fee-panel')).toBeVisible();
  await expect(page.locator('[data-bank-fee-line]')).toHaveCount(2);
  for(const id of [20,24]){
   const fee=page.locator(`[data-bank-fee-line][value="${id}"]`);
   await expect(fee).toBeVisible();await expect(fee.locator('xpath=ancestor::tr')).toContainText(`Movimiento bancario ${id}`);
  }
  for(const id of [21,22,23,25,26,27])await expect(page.locator(`[data-bank-fee-line][value="${id}"]`)).toHaveCount(0);
  await expect(page.locator('input[name="bankMatch"][value="20"]')).toBeVisible();
  await expect(page.locator('#registerBankFees')).toBeDisabled();
 }finally{await app.close();}
});

test('los interruptores Si/No quedan en linea y compactos con el tema de produccion',{timeout:30000},async()=>{
 const app=await fixture({productionTheme:true});try{
  const {page}=app,mode=page.getByRole('switch',{name:'Comisiones',exact:true}),modeLabel=page.locator('.bank-fee-mode-switch');
  await expect(mode).toHaveAttribute('type','checkbox');
  await expect(modeLabel.locator('.bank-fee-switch-state')).toHaveText('No');
  await mode.focus();await page.keyboard.press('Space');
  await expect(mode).toBeChecked();await expect(modeLabel.locator('.bank-fee-switch-state')).toHaveText('S\u00ed');
  await expect(page.getByRole('switch')).toHaveCount(3);
  const fee=page.locator('[data-bank-fee-line][value="20"]'),feeLabel=fee.locator('xpath=ancestor::label');
  await expect(fee).toHaveAttribute('type','checkbox');await expect(fee).toHaveAttribute('role','switch');
  await expect(feeLabel.locator('.bank-fee-switch-state')).toHaveText('No');
  const offColor=await feeLabel.locator('.bank-fee-switch-track').evaluate(track=>getComputedStyle(track).backgroundColor);
  await fee.focus();await page.keyboard.press('Space');
  await expect(fee).toBeChecked();await expect(feeLabel.locator('.bank-fee-switch-state')).toHaveText('S\u00ed');
  await expect(page.locator('#bankFeeSelectionCount')).toHaveText('1 movimiento seleccionado');
  await expect.poll(()=>feeLabel.locator('.bank-fee-switch-track').evaluate(track=>getComputedStyle(track).backgroundColor)).not.toBe(offColor);
  for(const width of [1640,1366]){
  await page.setViewportSize({width,height:1000});
  const geometry=await page.evaluate(()=>{
   const rect=element=>{const {x,y,width,height}=element.getBoundingClientRect();return{x,y,width,height,right:x+width,centerY:y+height/2}};
   const textRect=(root,text)=>{
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
    while(node=walker.nextNode())if(node.textContent.trim()&&(text===undefined||node.textContent.trim()===text)){const range=document.createRange();range.selectNodeContents(node);return rect(range)}
    throw new Error(`No se encontro el texto ${text??'del encabezado'}`);
   };
   const header=document.querySelector('#bankFeeMode').closest('th'),heading=header.querySelector('.bank-fee-column-heading'),label=header.querySelector('.bank-fee-mode-switch'),track=label.querySelector('.bank-fee-switch-track');
   const rowLabel=document.querySelector('[data-bank-fee-line][value="20"]').closest('label'),rowStyle=getComputedStyle(rowLabel),labelStyle=getComputedStyle(label);
   return{
    row:rect(header.closest('tr')),headingText:textRect(heading,'Conciliar'),caption:textRect(label,'Comisiones'),state:rect(label.querySelector('.bank-fee-switch-state')),track:rect(track),
    headerCenters:[...header.closest('tr').children].map(cell=>textRect(cell).centerY),
    headerLabel:{...rect(label),direction:labelStyle.flexDirection,wrap:labelStyle.flexWrap},
    rowLabel:{...rect(rowLabel),direction:rowStyle.flexDirection,wrap:rowStyle.flexWrap,borderWidth:rowStyle.borderTopWidth,background:rowStyle.backgroundColor},rowTrack:rect(rowLabel.querySelector('.bank-fee-switch-track')),rowRadio:rect(rowLabel.parentElement.querySelector('input[type="radio"]'))
   };
  });
  assert.ok(geometry.row.height<=46,`El encabezado debe ocupar una sola linea compacta: ${JSON.stringify(geometry)}`);
  assert.ok(Math.max(...geometry.headerCenters)-Math.min(...geometry.headerCenters)<=2,'Los titulos deben quedar alineados verticalmente.');
  assert.ok(geometry.headingText.right<geometry.track.x,'El interruptor debe seguir a Conciliar.');
  assert.ok(geometry.track.right<=geometry.state.x+1&&geometry.state.right<=geometry.caption.x+1,'El interruptor y su estado deben preceder a Comisiones.');
  for(const control of [geometry.headerLabel,geometry.rowLabel]){
   assert.equal(control.direction,'row');assert.equal(control.wrap,'nowrap');assert.ok(control.height<=32,'La etiqueta no debe convertirse en una capsula circular.');
  }
  assert.equal(geometry.rowLabel.borderWidth,'0px');assert.equal(geometry.rowLabel.background,'rgba(0, 0, 0, 0)');
  for(const track of [geometry.track,geometry.rowTrack]){
   assert.ok(track.width>=28&&track.width<=44&&track.height>=16&&track.height<=24&&track.width/track.height>=1.5,`La pista debe ser un interruptor horizontal compacto: ${JSON.stringify(track)}`);
  }
  assert.ok(Math.abs(geometry.track.centerY-geometry.caption.centerY)<=2&&Math.abs(geometry.state.centerY-geometry.caption.centerY)<=2,'El selector, Si/No y Comisiones deben compartir una linea.');
  assert.ok(Math.abs(geometry.rowRadio.centerY-geometry.rowTrack.centerY)<=2,`El radio de conciliacion y el interruptor de comision deben estar centrados en la misma linea: ${JSON.stringify(geometry)}`);
  if(process.env.BANK_FEE_SWITCH_SCREENSHOTS==='1'){
   const screenshots=resolve('.local-tools/commission-switches');await mkdir(screenshots,{recursive:true});
   await page.locator('#tbody').locator('xpath=ancestor::div[contains(@class,"table-wrap")]').screenshot({path:resolve(screenshots,`switches-${width}.png`)});
  }
  }
  await fee.uncheck();await expect(feeLabel.locator('.bank-fee-switch-state')).toHaveText('No');
  await expect(page.locator('#registerBankFees')).toBeDisabled();
  await mode.uncheck();await assertModeOff(page);await expect(modeLabel.locator('.bank-fee-switch-state')).toHaveText('No');
 }finally{await app.close();}
});

test('desactivar comisiones borra el lote y reactivarlo empieza sin selecciones, conservando la conciliacion manual',{timeout:30000},async()=>{
 const app=await fixture();try{
  const {page,state}=app;
  await page.locator('input[name="bankMatch"][value="20"]').check();
  await page.locator('#bankFeeMode').check();
  await page.locator('[data-bank-fee-line][value="20"]').check();await page.locator('[data-bank-fee-line][value="24"]').check();
  await expect(page.locator('#bankFeeSelectionCount')).toHaveText('2 movimientos seleccionados');
  await expect(page.locator('#bankFeeSelectionTotal')).toContainText('37,50');
  await expect(page.locator('#registerBankFees')).toBeEnabled();
  await page.locator('#bankFeeMode').uncheck();await assertModeOff(page);
  await expect(page.locator('input[name="bankMatch"][value="20"]')).toBeChecked();
  await page.locator('#bankFeeMode').check();
  await expect(page.locator('[data-bank-fee-line]:checked')).toHaveCount(0);
  await expect(page.locator('#bankFeeSelectionCount')).toHaveText('0 movimientos seleccionados');
  await expect(page.locator('#bankFeeSelectionTotal')).toContainText('0,00');
  await expect(page.locator('#registerBankFees')).toBeDisabled();assert.equal(state.fees.length,0);
 }finally{await app.close();}
});

test('cambiar cuenta o fecha desactiva comisiones y elimina las selecciones anteriores',{timeout:60000},async t=>{
 for(const change of ['account','cutoff'])await t.test(change,async()=>{
  const app=await fixture();try{
   const {page,state}=app;await page.locator('#bankFeeMode').check();await page.locator('[data-bank-fee-line][value="20"]').check();
   const reports=state.reports.length;
   if(change==='account')await page.locator('#bankAccount').selectOption('8');
   else{await page.locator('#bankCutoff').fill('2026-10-30');await page.locator('#bankCutoff').press('Tab');}
   await expect.poll(()=>state.reports.length).toBeGreaterThan(reports);await assertModeOff(page);
   await page.locator('#bankFeeMode').check();await expect(page.locator('[data-bank-fee-line]:checked')).toHaveCount(0);
   await expect(page.locator('#registerBankFees')).toBeDisabled();
  }finally{await app.close();}
 });
});

test('salir de pendientes desactiva comisiones y los conciliados no muestran acciones de registro',{timeout:30000},async()=>{
 const app=await fixture();try{
  const {page}=app;await page.locator('#bankFeeMode').check();await page.locator('[data-bank-fee-line][value="20"]').check();
  await page.locator('#bankReconciledTab').click();
  await expect(page.locator('#bankView')).toHaveValue('RECONCILED');
  await expect(page.locator('#bankFeeMode,[data-bank-fee-line],.bank-fee-panel,input[name="bankMatch"],input[name="erpMatch"]')).toHaveCount(0);
  await page.locator('#bankPendingTab').click();await assertModeOff(page);
  await page.locator('#bankFeeMode').check();await page.locator('#bankView').selectOption('AUXILIARY');
  await expect(page.locator('#bankFeeMode,[data-bank-fee-line],.bank-fee-panel')).toHaveCount(0);
  await page.locator('#bankView').selectOption('WORKSPACE');await assertModeOff(page);
 }finally{await app.close();}
});

test('la paginacion local conserva la activacion de comisiones para la misma cuenta y fecha',{timeout:30000},async()=>{
 const statement=Array.from({length:60},(_,index)=>bank(index+1));
 const app=await fixture({rows:[erp(11)],statement});try{
  const {page,state}=app;await page.locator('#bankFeeMode').check();
  await expect(page.locator('[data-bank-fee-line][value="1"]')).toBeVisible();
  const reports=state.reports.length;await page.locator('#next').click();
  await expect(page.locator('#bankFeeMode')).toBeChecked();await expect(page.locator('.bank-fee-panel')).toBeVisible();
  await expect(page.locator('[data-bank-fee-line][value="60"]')).toBeVisible();
  await expect(page.locator('[data-bank-fee-line][value="1"]')).toHaveCount(0);
  await page.locator('#prev').click();await expect(page.locator('#bankFeeMode')).toBeChecked();
  await expect(page.locator('[data-bank-fee-line][value="1"]')).toBeVisible();
  assert.equal(state.reports.length,reports,'Cambiar una pagina local no debe recargar ni cambiar el contexto.');
 }finally{await app.close();}
});

test('registrar comisiones conserva la confirmacion y los IDs seleccionados, y refresca con el modo desactivado',{timeout:30000},async()=>{
 const app=await fixture();try{
  const {page,state}=app;await page.locator('#bankFeeMode').check();
  await page.locator('[data-bank-fee-line][value="20"]').check();await page.locator('[data-bank-fee-line][value="24"]').check();
  await page.locator('#registerBankFees').click();await expect(page.locator('#bankFeeDialog')).toHaveAttribute('open','');
  await expect(page.locator('#bankFeeDialogSummary')).toContainText('001-7');await expect(page.locator('#bankFeeDialogSummary')).toContainText('37,50');
  assert.equal(state.fees.length,0,'Abrir la confirmacion no debe contabilizar.');
  await page.locator('#cancelBankFees').click();await expect(page.locator('#bankFeeDialog')).not.toHaveAttribute('open','');
  await expect(page.locator('[data-bank-fee-line]:checked')).toHaveCount(2);assert.equal(state.fees.length,0);
  await page.locator('#registerBankFees').click();await page.locator('#confirmBankFees').click();
  await expect.poll(()=>state.fees.length).toBe(1);
  assert.deepEqual(state.fees[0],{p_bank_account_id:7,p_cutoff:'2026-10-31',p_statement_line_ids:[20,24]});
  await assertModeOff(page);
  await expect(page.locator('#tbody')).not.toContainText('Movimiento bancario 20');await expect(page.locator('#tbody')).not.toContainText('Movimiento bancario 24');
  await page.locator('#bankReconciledTab').click();
  await expect(page.locator('#tbody')).toContainText('Movimiento bancario 20');await expect(page.locator('#tbody')).toContainText('Movimiento bancario 24');
  await expect(page.locator('#bankFeeMode,[data-bank-fee-line],.bank-fee-panel')).toHaveCount(0);
 }finally{await app.close();}
});
