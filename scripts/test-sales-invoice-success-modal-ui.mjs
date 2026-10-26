import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const shellSource=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
assert.match(
  shellSource,
  /handleWorkspaceRequest\s*\([^)]*\)\s*\{[\s\S]*?detail\.close[\s\S]*?closeWorkspace\s*\(/,
  'El shell debe reconocer la solicitud de cerrar el workspace.'
);
assert.match(
  shellSource,
  /detail\.refresh[\s\S]*?loadCatalog\s*\(/,
  'Al aceptar, el shell debe recargar el listado para mostrar la factura creada.'
);

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const responses={
  '/api/sales/invoices':[],
  '/api/sales/sales-invoice-lines':[],
  '/api/sales/sales-invoice-withholdings':[],
  '/api/entities/customers':[{customer_id:1,company_name:'Cliente de prueba',subsidiary_ids:[1],payment_term_id:1}],
  '/api/inventory/products':[{product_id:10,item_code:'SERV-001',display_name:'Servicio profesional',is_active:true,product_usage:'Venta',sales_price:1250,subsidiary_ids:[1]}],
  '/api/configuration/tax-codes':[],
  '/api/configuration/tax-types':[],
  '/api/configuration/payment-terms':[{term_id:1,term_name:'Contado'}],
  '/api/organization/accounting-periods':[{fiscal_period_id:1,period_name:'octubre 2026',start_date:'2026-10-01',end_date:'2026-10-31',subsidiary_id:1,is_closed:false,ar_closed:false}],
  '/api/core/currencies':[{currency_id:1,currency_code:'JMD',name:'Dólar jamaicano'}],
  '/api/core/countries':[{country_id:1,country_code_iso2:'JM',name:'Jamaica'}],
  '/api/organization/subsidiaries':[{subsidiary_id:1,name:'Empresa de pruebas',country_id:1,currency_id:1}],
  '/api/organization/locations':[{location_id:1,name:'Principal',subsidiary_id:1}],
  '/api/organization/departments':[],
  '/api/organization/cost-centers':[],
  '/api/organization/classes':[],
  '/api/accounting/chart-accounts':[{account_id:113001,account_number:'113001',account_name:'Cuentas por Cobrar Clientes',category:'Activo',accepts_entries:true,is_inactive:false,subsidiary_ids:[1]}],
  '/api/accounting/gl-impacts':[],
  '/api/accounting/journal-supports':[]
};

async function openScenario(name){
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  const errors=[];
  let saveCount=0;
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('nexo_token','test');
    localStorage.setItem('nexo_company','1');
  });
  await page.route('**/api/**',route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/sales/invoice-entry'&&request.method()==='POST'){
      saveCount++;
      return route.fulfill({json:{invoiceId:670,journalId:1812,transactionNumber:'FAC-00000670',total:1250}});
    }
    return route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify(responses[path]??[])
    });
  });
  await page.goto(`http://localhost:3000/?modal-test=${name}`);
  await page.setContent(`
    <main id="shell-marker">ERP activo</main>
    <iframe id="workspace" title="Factura de venta" style="width:1500px;height:900px;border:0"></iframe>
    <script>
      window.__workspaceEvents=[];
      window.addEventListener('nexo:open-workspace',event=>{
        window.__workspaceEvents.push(JSON.parse(JSON.stringify(event.detail)));
      });
    <\/script>
  `);
  const frame=page.frames().find(candidate=>candidate!==page.mainFrame());
  await frame.goto('http://localhost:3000/sales-invoice-entry.html');
  await frame.locator('#lines tr').waitFor();
  return{page,frame,errors,getSaveCount:()=>saveCount};
}

async function saveInvoice(scenario){
  const {frame}=scenario;
  await frame.locator('#customer').selectOption('1');
  await frame.locator('[data-k="product_id"]').selectOption('10');
  await frame.locator('#memo').fill('Factura para validar la confirmación');
  await frame.locator('#save').click();
  const modal=frame.locator('#successModal');
  await modal.waitFor({state:'visible'});
  assert.equal(await modal.getAttribute('role'),'dialog');
  assert.equal(await modal.getAttribute('aria-modal'),'true');
  const labelledBy=await modal.getAttribute('aria-labelledby');
  assert.ok(labelledBy,'El diálogo debe estar asociado a su título.');
  assert.match(await frame.locator(`#${labelledBy}`).textContent(),/Factura (generada|registrada) (exitosamente|correctamente)/i);
  assert.equal(await frame.locator('#successInvoiceNumber').textContent(),'FAC-00000670');
  assert.match(await frame.locator('#successInvoiceAmount').textContent(),/JMD\s+1[ .\u00a0]?250,00/);
  await frame.waitForFunction(()=>document.activeElement?.id==='acceptSuccess');
  assert.equal(await frame.evaluate(()=>document.activeElement?.id),'acceptSuccess','Aceptar debe recibir el foco inicial.');
  assert.equal(scenario.getSaveCount(),1);
}

try{
  const accept=await openScenario('accept');
  await saveInvoice(accept);
  if(process.env.CAPTURE_UI==='1')await accept.frame.locator('#successModal').screenshot({path:'.tmp/sales-invoice-success-modal.png'});
  const shellUrlBefore=accept.page.url();
  await accept.frame.locator('#acceptSuccess').click();
  await accept.page.waitForFunction(()=>window.__workspaceEvents.length===1);
  const [request]=await accept.page.evaluate(()=>window.__workspaceEvents);
  assert.deepEqual(request,{
    url:'/',
    module:'Ventas',
    section:'Facturas de venta',
    close:true,
    refresh:true
  });
  assert.equal(accept.page.url(),shellUrlBefore,'Aceptar no debe sacar al usuario del shell del ERP.');
  assert.equal(await accept.page.locator('#shell-marker').textContent(),'ERP activo');
  assert.deepEqual(accept.errors,[]);
  await accept.page.close();

  const fresh=await openScenario('new');
  await saveInvoice(fresh);
  const shellUrlBeforeNew=fresh.page.url();
  await fresh.page.keyboard.press('Shift+Tab');
  assert.equal(
    await fresh.frame.evaluate(()=>document.activeElement?.id),
    'successNew',
    'Shift+Tab desde la primera acción debe mantener el foco dentro del diálogo.'
  );
  await fresh.page.keyboard.press('Tab');
  assert.equal(
    await fresh.frame.evaluate(()=>document.activeElement?.id),
    'acceptSuccess',
    'Tab desde la última acción debe regresar a la primera.'
  );
  await Promise.all([
    fresh.frame.waitForNavigation({waitUntil:'domcontentloaded'}),
    fresh.frame.locator('#successNew').click()
  ]);
  await fresh.frame.locator('#lines tr').waitFor();
  assert.equal(new URL(fresh.frame.url()).pathname,'/sales-invoice-entry.html');
  assert.equal(new URL(fresh.frame.url()).search,'','Nueva factura no debe conservar el id ni parámetros anteriores.');
  assert.equal(fresh.page.url(),shellUrlBeforeNew,'Nueva factura debe permanecer dentro del workspace del ERP.');
  assert.equal(await fresh.frame.locator('#successModal').isHidden(),true);
  assert.equal(await fresh.frame.locator('#number').inputValue(),'Se asignará al guardar');
  assert.equal(await fresh.frame.locator('#customer').inputValue(),'');
  assert.equal(await fresh.frame.locator('#memo').inputValue(),'');
  assert.equal(await fresh.frame.locator('#lines tr').count(),1);
  assert.equal(fresh.getSaveCount(),1,'Abrir otra factura no debe duplicar la transacción guardada.');
  assert.deepEqual(fresh.errors,[]);
  await fresh.page.close();

  console.log(JSON.stringify({
    accessibleDialog:true,
    acceptKeepsErpShell:true,
    catalogRefreshRequested:true,
    newInvoiceUsesCleanForm:true,
    noDuplicateSave:true
  }));
}finally{
  await browser.close();
}
