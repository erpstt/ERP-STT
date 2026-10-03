import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const context=await browser.newContext({acceptDownloads:true,viewport:{width:1680,height:1100}});
const page=await context.newPage();
page.setDefaultTimeout(12000);
await page.addInitScript(()=>{
 localStorage.setItem('nexo_token','payment-request-report-ui-token');
 localStorage.setItem('nexo_device_token','payment-request-report-ui-device-20261002');
});

const options={
 subsidiary:{id:3,name:'EMPRESA DE PRUEBAS',legalName:'EMPRESA DE PRUEBAS S.A.',taxId:'TEST-001',baseCurrencyId:5,baseCurrencyCode:'JMD',baseCurrencySymbol:'J$'},
 requestTypes:[{id:'CXP',name:'Pago de CxP'},{id:'OTROS',name:'Otros pagos'}],
 statuses:[{id:'APROBADO',name:'Aprobado · pendiente de pago'},{id:'APLICADO',name:'Pagado / aplicado'}],
 currencies:[{id:5,code:'JMD',name:'Dólar jamaiquino',symbol:'J$'}],
 thirdParties:[{key:'Proveedor:1',id:1,type:'Proveedor',name:'Proveedor Global',taxId:'SUP-1'},{key:'Empleado:1',id:1,type:'Empleado',name:'Ana Responsable',taxId:'EMP-1'}],
 departments:[{id:7,name:'Operaciones',type:'Interno'}],costCenters:[{id:9,code:'CC-01',name:'Proyecto Central',departmentId:7}],
 accounts:[{id:34,number:'133005',name:'Anticipos a proveedores',category:'Activo'}],
 requesters:[{id:4,name:'Danny Valderrama',email:'danny@example.com'}],approvers:[{id:8,name:'María Aprobadora',email:'maria@example.com'}],
 methods:[{value:'TRANSFERENCIA',label:'Transferencia'},{value:'CHEQUE',label:'Cheque'}]
};
const report={
 header:{subsidiaryId:3,subsidiaryName:'EMPRESA DE PRUEBAS',legalName:'EMPRESA DE PRUEBAS S.A.',taxId:'TEST-001',dateFrom:'2026-01-01',dateTo:'2026-10-02',dateField:'REQUEST'},
 summary:{requestCount:2,lineCount:2,supportCount:1,cxpCount:1,otherCount:1,approvedCount:1,appliedCount:1,totalsByCurrency:[{currencyId:5,currency:'JMD',currencyCode:'JMD',symbol:'J$',requestCount:2,amount:15000,requestAmount:15000,analyzedAmount:15000}],byType:[{type:'CXP',label:'Pago de CxP',count:1},{type:'OTROS',label:'Otros pagos',count:1}],byStatus:[{status:'APLICADO',label:'Pagado / aplicado',count:1},{status:'APROBADO',label:'Aprobado · pendiente de pago',count:1}]},
 rows:[
  {id:18,requestId:18,number:'SOL_PAG-000018',type:'CXP',typeLabel:'Pago de CxP',status:'APROBADO',statusLabel:'Aprobado · pendiente de pago',requestDate:'2026-09-10',plannedDate:'2026-09-12',concept:'Pago de factura de proveedor',total:14000,currency:{id:5,code:'JMD',symbol:'J$'},requester:{id:4,name:'Danny Valderrama',email:'danny@example.com'},approver:{id:8,name:'María Aprobadora'},thirdParties:[{key:'Proveedor:1',id:1,type:'Proveedor',name:'Proveedor Global',taxId:'SUP-1'}],departments:[{id:7,name:'Operaciones',type:'Interno'}],costCenters:[{id:9,code:'CC-01',name:'Proyecto Central'}],accounts:[{id:34,number:'511001',name:'Servicios'}],approval:{approvedAt:'2026-09-11T14:00:00Z',approvedBy:'María Aprobadora',workflowStatus:'APROBADO'},payment:{method:null,reference:null},supports:[{id:1,type:'Enlace',name:'Orden aprobada',url:'https://example.com/respaldo'}],lines:[{id:18,amount:14000,concept:'Factura septiembre',partyType:'Proveedor',partyName:'Proveedor Global',invoiceNumber:'FAC-PRO-889',invoiceDate:'2026-09-10',invoiceDueDate:'2026-10-10',accountNumber:'511001',accountName:'Servicios',departments:[{id:7,name:'Operaciones'}],costCenters:[{id:9,code:'CC-01',name:'Proyecto Central'}]}]},
  {id:29,requestId:29,number:'SOL_PAG-000029',type:'OTROS',typeLabel:'Otros pagos',status:'APLICADO',statusLabel:'Pagado / aplicado',requestDate:'2026-09-23',plannedDate:'2026-09-23',appliedDate:'2026-09-24',concept:'Reembolso de gastos',total:1000,currency:{id:5,code:'JMD',symbol:'J$'},requester:{id:4,name:'Danny Valderrama',email:'danny@example.com'},thirdParties:[{key:'Empleado:1',id:1,type:'Empleado',name:'Ana Responsable',taxId:'EMP-1'}],departments:[{id:7,name:'Operaciones',type:'Interno'}],costCenters:[],accounts:[{id:34,number:'133005',name:'Anticipos a empleados'}],approval:{approvedAt:'2026-09-24T12:00:00Z',approvedBy:'María Aprobadora',workflowStatus:'APROBADO'},payment:{method:'TRANSFERENCIA',reference:'TRX-2026-99',appliedAt:'2026-09-24T15:00:00Z',appliedBy:'Tesorería',journalId:211},supports:[],lines:[{id:29,amount:1000,concept:'Reembolso',partyType:'Empleado',partyName:'Ana Responsable',accountNumber:'133005',accountName:'Anticipos a empleados',departments:[{id:7,name:'Operaciones'}],costCenters:[]}]}
 ],total:2,page:1,pageSize:50
};

let lastFilters=null;
await page.route('**/api/v1/reports/treasury/payment-requests/options',route=>route.fulfill({json:options}));
await page.route('**/api/v1/reports/treasury/payment-requests',route=>{lastFilters=route.request().postDataJSON();return route.fulfill({json:report});});
await page.route('**/api/v1/reports/treasury/payment-requests/pdf',route=>route.fulfill({status:200,headers:{'content-type':'application/pdf','content-disposition':'attachment; filename="solicitudes-de-pago.pdf"'},body:Buffer.from('%PDF-1.4\nUI fixture')}));
await page.route('**/api/v1/reports/treasury/payment-requests/excel',route=>route.fulfill({status:200,headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','content-disposition':'attachment; filename="solicitudes-de-pago.xlsx"'},body:Buffer.from('PK UI fixture')}));

const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.goto('http://localhost:3000/');
await page.evaluate(()=>{localStorage.setItem('nexo_token','payment-request-report-ui-token');localStorage.setItem('nexo_device_token','payment-request-report-ui-device-20261002')});
await page.setContent('<iframe id="report" src="http://localhost:3000/payment-request-report.html" style="width:1680px;height:1100px;border:0"></iframe>');
const app=page.frameLocator('#report');
await app.getByText('SOL_PAG-000018').waitFor();
assert.equal(await app.locator('.request-record').count(),2);
const summaryText=await app.locator('#summary').innerText();
assert.ok(summaryText.includes('J$')&&/15[.\s]000,00/.test(summaryText),summaryText);
assert.ok((await app.locator('#approver option').allTextContents()).some(text=>text.includes('María Aprobadora')));
assert.ok((await app.locator('#method option').allTextContents()).some(text=>text.includes('Transferencia')));
await app.locator('#groupBy').selectOption('TYPE');
assert.equal(await app.locator('.group-section').count(),2);
await app.locator('[data-expand="18"]').click();
await app.getByText('FAC-PRO-889').waitFor();
assert.ok((await app.locator('.detail-row:not([hidden]) .detail-panel').innerText()).includes('Orden aprobada'));
await app.locator('#approver').selectOption('8');
await app.locator('#method').selectOption('TRANSFERENCIA');
await app.locator('#generate').click();
await app.getByText('SOL_PAG-000018').waitFor();
assert.equal(String(lastFilters.approverId),'8');
assert.equal(lastFilters.method,'TRANSFERENCIA');
assert.equal(lastFilters.subsidiaryId,3);
const downloadPromise=page.waitForEvent('download');
await app.locator('#downloadPdf').click();
const download=await downloadPromise;
assert.equal(download.suggestedFilename(),'solicitudes-de-pago.pdf');
await app.getByText('La descarga se generó correctamente.').waitFor();
const bodyText=await app.locator('body').innerText();
assert.deepEqual(['Ã','Â','â€','�'].filter(token=>bodyText.includes(token)),[]);
assert.deepEqual(errors,[]);
await page.screenshot({path:'.tmp/payment-request-report-ui.png',fullPage:true});
console.log(JSON.stringify({rows:2,groups:2,detail:true,approverFilter:true,methodFilter:true,directDownload:true,utf8:true,screenshot:'.tmp/payment-request-report-ui.png'},null,2));
await browser.close();
