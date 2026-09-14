import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage();page.setDefaultTimeout(7000);
await page.addInitScript(()=>localStorage.setItem('nexo_token','ui-check'));
let reversalPayload=null;
await page.route('**/api/reports/accounting/options',route=>route.fulfill({json:{subsidiaries:[{id:1,name:'Empresa',currencyId:1}],currencies:[{id:1,code:'USD',symbol:'$'}],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],journalOptions:{canReverse:true,modules:[]},pendingInvoiceOptions:{customers:[{id:5,name:'Cliente Uno'}]}}}));
await page.route('**/api/reports/accounting/pending-invoice-control',route=>route.fulfill({json:{rows:[{journal_id:7,journal_number:'ASI_PEN-00000001',date:'2026-09-01',customer_id:5,customer:'Cliente Uno',initial:1000,reversed:250,balance:750,status:'REVERSADO_PARCIAL',reversals:[{journalId:8,number:'ASI_REV_PEN-00000001',date:'2026-09-10',amount:250,type:'FACTURACION',reference:'FAC_VEN-25',user:'Usuario Prueba'}]}],total:1,summary:{initial:1000,reversed:250,balance:750}}}));
await page.route('**/api/reports/accounting/pending-invoices/7/reversal-options',route=>route.fulfill({json:{journal:{id:7,number:'ASI_PEN-00000001',initialLocal:1000,reversedLocal:250,balanceLocal:750,status:'REVERSADO_PARCIAL'},invoices:[{id:9,number:'FAC_VEN-25',customer:'Cliente Uno',total:800}],reversals:[]}}));
await page.route('**/api/reports/accounting/pending-invoices/7/reverse',async route=>{reversalPayload=route.request().postDataJSON();await route.fulfill({status:201,json:{journalId:10,number:'ASI_REV_PEN-00000002',amount:200,remaining:550}})});
await page.goto('http://localhost:3000/');await page.setContent('<iframe id="app" src="http://localhost:3000/accounting-reports.html" style="width:1400px;height:900px"></iframe>');const app=page.frameLocator('#app');
await app.getByText('Control de Pendientes de Facturar',{exact:true}).click();await app.locator('#tbody tr').first().waitFor();
if(await app.locator('#pendingCustomer option').count()!==2)throw Error('No se cargÃ³ el filtro de clientes.');
if(!(await app.getByText('REVERSADO PARCIAL',{exact:true}).count()))throw Error('No se mostrÃ³ el estado del pendiente.');
await app.getByRole('button',{name:'Reversar Pendiente'}).click();await app.locator('#pendingReversalModal[open]').waitFor();
await app.locator('#pendingReversalType').selectOption('ERROR_CORRECCION');if(await app.locator('#pendingErrorLabel').isHidden())throw Error('No apareciÃ³ el campo de justificaciÃ³n.');
await app.locator('#pendingReversalAmount').fill('200');await app.locator('#pendingErrorDescription').fill('CorrecciÃ³n de estimaciÃ³n duplicada');const invalid=await app.locator('#pendingReversalForm').evaluate(form=>[...form.elements].filter(element=>element.willValidate&&!element.checkValidity()).map(element=>({id:element.id,message:element.validationMessage,value:element.value})));if(invalid.length)throw Error(`Formulario invÃ¡lido: ${JSON.stringify(invalid)}`);await app.locator('#pendingReversalForm button[type=submit]').click();
for(let attempt=0;attempt<20&&!reversalPayload;attempt++)await page.waitForTimeout(100);if(!reversalPayload||reversalPayload.type!=='ERROR_CORRECCION'||Number(reversalPayload.amount)!==200)throw Error(`El modal no enviÃ³ la reversiÃ³n esperada: ${await app.locator('#pendingReversalError').textContent()}`);
await app.locator('#pendingReversalSuccess[open]').waitFor();
if(await app.locator('#pendingSuccessNumber').textContent()!=='ASI_REV_PEN-00000002')throw Error('No se mostró el número del asiento generado.');
if(!(await app.locator('#pendingSuccessAmount').textContent()).includes('200'))throw Error('No se mostró el monto reversado.');
if(!(await app.locator('#pendingSuccessRemaining').textContent()).includes('550'))throw Error('No se mostró el saldo pendiente.');
if(!(await app.locator('#viewPendingSuccessJournal').getAttribute('href')).includes('/journal-view.html?id=10'))throw Error('El acceso al asiento generado es incorrecto.');
console.log(JSON.stringify({report:true,history:true,modal:true,dynamicReason:true,payload:true,successDialog:true,journalLink:true}));await browser.close();


