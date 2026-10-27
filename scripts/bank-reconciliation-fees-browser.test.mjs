import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});
const page=await browser.newPage({viewport:{width:1500,height:950}});
page.setDefaultTimeout(10000);
await page.addInitScript(()=>localStorage.setItem('nexo_token','bank-fee-browser-test'));

let registered=false;
let requestBody=null;
await page.route('**/api/reports/accounting/options',route=>route.fulfill({json:{
  subsidiaries:[{id:1,name:'Empresa de prueba',currencyId:1}],
  currencies:[{id:1,code:'USD',symbol:'$'}],
  books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],
  journalOptions:{canReverse:true,modules:[]},pendingInvoiceOptions:{customers:[]},
  bankOptions:{accounts:[{id:7,number:'001-123',name:'Banco Uno - 001-123',bankId:2,bankName:'Banco Uno',subsidiaryId:1,currencyId:1,currencyCode:'USD',currencySymbol:'$'}],reconciliations:[]}
}}));
await page.route('**/api/reports/accounting/bank-reconciliation',route=>route.fulfill({json:{
  rows:[],
  statementLines:[
    {statement_line_id:20,bank_date:'2026-10-27',reconciliation_status:registered?'CONCILIADO':'PENDIENTE',reference:'FEE-20',description:'Comisión transferencia',amount:-29.61},
    {statement_line_id:21,bank_date:'2026-10-27',reconciliation_status:'PENDIENTE',reference:'DEP-21',description:'Depósito de cliente',amount:500},
    {statement_line_id:22,bank_date:'2026-10-27',reconciliation_status:'CONCILIADO',reference:'FEE-22',description:'Comisión ya conciliada',amount:-10}
  ],
  summary:{bookBalance:470.39,statementBalance:470.39,transitPayments:0,transitDeposits:0},
  reconciliation:{status:'ABIERTA'},total:0,page:1,pageSize:50
}}));
await page.route('**/api/reports/accounting/bank-reconciliation/bank-fees',async route=>{
  requestBody=route.request().postDataJSON();
  registered=true;
  await route.fulfill({status:201,json:{result:{createdCount:1,totalAmount:29.61,matchedStatementLineIds:[20]}}});
});

try{
  await page.goto('http://localhost:3000/');
  await page.setContent('<iframe id="app" src="http://localhost:3000/accounting-reports.html" style="width:1500px;height:950px"></iframe>');
  const app=page.frameLocator('#app');
  await app.getByText('Bancos y Conciliación',{exact:true}).click();
  await app.locator('#bankView').selectOption('WORKSPACE');
  await app.getByText('Registrar comisiones desde el extracto',{exact:true}).waitFor();

  const choices=app.locator('[data-bank-fee-line]');
  assert.equal(await choices.count(),1,'Solo la salida negativa pendiente debe poder marcarse.');
  await choices.check();
  assert.match(await app.locator('#bankFeeSelectionCount').textContent(),/^1 movimiento seleccionado$/);
  assert.match(await app.locator('#bankFeeSelectionTotal').textContent(),/29,61/);

  await app.locator('#registerBankFees').click();
  await app.locator('#bankFeeDialog[open]').waitFor();
  assert.match(await app.locator('#bankFeeDialogSummary').textContent(),/29,61/);
  await app.locator('#confirmBankFees').click();
  await app.getByText(/1 comisión bancaria registrada/).waitFor();

  assert.deepEqual(requestBody,{
    p_bank_account_id:7,
    p_cutoff:'2026-10-27',
    p_statement_line_ids:[20]
  });
  assert.equal(await app.locator('[data-bank-fee-line]').count(),0,'La línea conciliada no debe quedar disponible para reproceso.');
  console.log('PASS: selección, confirmación y registro masivo de comisiones verificados en navegador.');
}finally{
  await browser.close();
}
