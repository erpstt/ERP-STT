import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
test('comisiones del extracto mantienen selección confirmación y registro aislados',{timeout:60000},async t=>{
const {page,baseURL:BASE_URL,cleanup}=await bankBrowserFixture(t);
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
  await page.goto(`${BASE_URL}/`);
  await page.setContent(`<iframe id="app" src="${BASE_URL}/accounting-reports.html" style="width:1500px;height:950px"></iframe>`);
  const app=page.frameLocator('#app');
  await app.getByText('Bancos y Conciliación',{exact:true}).click();
  await app.locator('#bankCutoff').fill('2026-10-27');
  await app.locator('#bankCutoff').press('Tab');
  await app.locator('#bankView').selectOption('WORKSPACE');
  await app.locator('#bankFeeMode').waitFor();
  assert.equal(await app.locator('#bankFeeMode').isChecked(),false,'El modo de comisiones debe iniciar desactivado.');
  assert.equal(await app.locator('[data-bank-fee-line],.bank-fee-panel').count(),0,'Los controles de comisiones se muestran solo al activar el encabezado.');
  await app.locator('#bankFeeMode').check();
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
  assert.equal(await app.locator('#bankFeeMode').isChecked(),false,'El modo de comisiones se desactiva después de registrar y refrescar.');
  assert.equal(await app.locator('.bank-fee-panel').count(),0,'El panel queda oculto después de registrar.');
  assert.equal(await app.locator('[data-bank-fee-line]').count(),0,'La línea conciliada no debe quedar disponible para reproceso.');
  console.log('PASS: selección, confirmación y registro masivo de comisiones verificados en navegador.');
}finally{
  await cleanup();
}
});
