import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const shellSource=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
assert.match(shellSource,/handleWorkspaceRequest\s*\([^)]*\)\s*\{[\s\S]*?detail\.close[\s\S]*?closeWorkspace\s*\(/,
  'El shell debe poder cerrar el workspace sin abandonar el ERP.');
assert.match(shellSource,/detail\.refresh[\s\S]*?loadCatalog\s*\(/,
  'Al aceptar, el shell debe actualizar el catálogo de facturas de proveedor.');

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const responses={
  '/api/accounting/chart-accounts':[
    {account_id:10,account_number:'631001',account_name:'Servicios profesionales',category:'Gasto',accepts_entries:true,is_inactive:false,subsidiary_ids:[1]},
    {account_id:20,account_number:'211001',account_name:'Cuentas por Pagar Proveedores',category:'Pasivo',nature:'Acreedora',accepts_entries:true,is_inactive:false,subsidiary_ids:[1]}
  ],
  '/api/accounting/account-groups':[],
  '/api/configuration/tax-codes':[],
  '/api/configuration/tax-types':[],
  '/api/organization/departments':[],
  '/api/organization/classes':[],
  '/api/organization/cost-centers':[],
  '/api/organization/financial-creditors':[],
  '/api/organization/related-companies':[],
  '/api/entities/customers':[],
  '/api/entities/suppliers':[
    {supplier_id:1,company_name:'Proveedor de prueba',subsidiary_ids:[1],payment_term_id:1,is_intercompany:false}
  ],
  '/api/configuration/payment-terms':[
    {term_id:1,term_name:'Contado',days_due:0}
  ],
  '/api/organization/accounting-periods':[
    {fiscal_period_id:1,subsidiary_id:1,period_name:'octubre 2026',start_date:'2026-10-01',end_date:'2026-10-31',is_closed:false,ap_closed:false}
  ],
  '/api/core/currencies':[
    {currency_id:1,currency_code:'JMD',name:'Dólar jamaicano'}
  ],
  '/api/configuration/exchange-rates':[],
  '/api/core/countries':[
    {country_id:1,country_code_iso2:'JM',name:'Jamaica'}
  ],
  '/api/organization/subsidiaries':[
    {subsidiary_id:1,name:'Empresa de pruebas',country_id:1,currency_id:1}
  ],
  '/api/organization/locations':[
    {location_id:1,name:'Oficina principal',subsidiary_id:1}
  ],
  '/api/purchasing/supplier-invoice-lines':[],
  '/api/purchasing/supplier-invoices':[],
  '/api/accounting/journal-supports':[]
};

async function openScenario(name){
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  const errors=[];
  let saveCount=0;
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('nexo_token','supplier-success-test');
    localStorage.setItem('nexo_company','1');
    localStorage.setItem('nexo_device_token','supplier-success-device');
  });
  await page.route('**/api/**',route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/purchasing/supplier-invoice-entry'&&request.method()==='POST'){
      saveCount++;
      return route.fulfill({json:{invoiceId:1116,journalId:3016,total:200000}});
    }
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(responses[path]??[])});
  });
  await page.goto(`http://localhost:3000/?supplier-success-test=${name}`,{waitUntil:'domcontentloaded'});
  await page.setContent(`
    <main id="shell-marker">ERP activo</main>
    <iframe id="workspace" title="Factura de proveedor" style="width:1500px;height:900px;border:0"></iframe>
    <script>
      window.__workspaceEvents=[];
      window.addEventListener('nexo:open-workspace',event=>{
        window.__workspaceEvents.push(JSON.parse(JSON.stringify(event.detail)));
      });
    <\/script>
  `);
  const frame=page.frames().find(candidate=>candidate!==page.mainFrame());
  await frame.goto('http://localhost:3000/supplier-invoice-entry.html');
  await frame.locator('#lines tr').waitFor();
  return{page,frame,errors,getSaveCount:()=>saveCount};
}

async function saveInvoice(scenario){
  const{frame}=scenario;
  await frame.locator('#invoiceNumber').fill('1116');
  await frame.locator('#supplier').selectOption('1');
  await frame.locator('.account-search').fill('631001');
  await frame.locator('.account-search').dispatchEvent('change');
  await frame.locator('[data-key="unit_price"]').fill('200000');
  await frame.locator('[data-key="unit_price"]').dispatchEvent('blur');
  await frame.locator('#memo').fill('Factura para validar la confirmación profesional');
  await frame.locator('#save').click();

  const modal=frame.locator('#successModal');
  await modal.waitFor({state:'visible'});
  assert.equal(await modal.getAttribute('role'),'dialog');
  assert.equal(await modal.getAttribute('aria-modal'),'true');
  const labelledBy=await modal.getAttribute('aria-labelledby');
  const describedBy=await modal.getAttribute('aria-describedby');
  assert.ok(labelledBy&&describedBy,'El diálogo debe estar asociado a su título y explicación.');
  assert.match(await frame.locator(`#${labelledBy}`).textContent(),/Factura registrada correctamente/i);
  assert.equal(await frame.locator('#successInvoiceNumber').textContent(),'1116');
  assert.match(await frame.locator('#successInvoiceAmount').textContent(),/JMD\s+200[ .\u00a0]?000,00/);
  assert.match(await frame.locator(`#${describedBy}`).textContent(),/documento|asiento contable|registrad/i);
  assert.equal(await modal.evaluate(element=>element.classList.contains('supplier-success-modal')),true,
    'El modal debe usar su presentación profesional de factura de proveedor.');
  const visual=await frame.locator('.supplier-success-card').evaluate(element=>{
    const style=getComputedStyle(element),icon=element.querySelector('.success-icon'),iconStyle=getComputedStyle(icon);
    return{radius:parseFloat(style.borderRadius),shadow:style.boxShadow,iconWidth:parseFloat(iconStyle.width)};
  });
  assert.ok(visual.radius>=12,'La tarjeta debe tener acabado visual profesional.');
  assert.notEqual(visual.shadow,'none','La tarjeta debe diferenciarse visualmente del fondo.');
  assert.ok(visual.iconWidth>=50,'La confirmación debe mostrar un indicador de éxito claro.');
  await frame.waitForFunction(()=>document.activeElement?.id==='successAccept');
  assert.equal(scenario.getSaveCount(),1,'La factura debe enviarse una sola vez.');
}

try{
  const accept=await openScenario('accept');
  await saveInvoice(accept);
  if(process.env.CAPTURE_UI==='1'){
    await accept.frame.locator('#successModal').screenshot({path:'.tmp/supplier-invoice-success-modal.png'});
  }
  const shellUrl=accept.page.url();
  await accept.frame.locator('#successAccept').click();
  await accept.page.waitForFunction(()=>window.__workspaceEvents.length===1);
  assert.deepEqual((await accept.page.evaluate(()=>window.__workspaceEvents))[0],{
    url:'/',module:'Compras',section:'Facturas de proveedores',close:true,refresh:true
  });
  assert.equal(accept.page.url(),shellUrl,'Aceptar no debe sacar al usuario del shell del ERP.');
  assert.equal(await accept.page.locator('#shell-marker').textContent(),'ERP activo');
  assert.deepEqual(accept.errors,[]);
  await accept.page.close();

  const fresh=await openScenario('new');
  await saveInvoice(fresh);
  const freshShellUrl=fresh.page.url();
  await fresh.page.keyboard.press('Shift+Tab');
  assert.equal(await fresh.frame.evaluate(()=>document.activeElement?.id),'successNew',
    'Shift+Tab debe mantener el foco dentro del diálogo.');
  await fresh.page.keyboard.press('Tab');
  assert.equal(await fresh.frame.evaluate(()=>document.activeElement?.id),'successAccept',
    'Tab debe regresar el foco a la primera acción.');
  await Promise.all([
    fresh.frame.waitForNavigation({waitUntil:'domcontentloaded'}),
    fresh.frame.locator('#successNew').click()
  ]);
  await fresh.frame.locator('#lines tr').waitFor();
  assert.equal(new URL(fresh.frame.url()).pathname,'/supplier-invoice-entry.html');
  assert.equal(new URL(fresh.frame.url()).search,'','Nueva factura debe abrir un formulario limpio.');
  assert.equal(fresh.page.url(),freshShellUrl,'Nueva factura debe permanecer dentro del workspace.');
  assert.equal(await fresh.frame.locator('#successModal').isHidden(),true);
  assert.equal(await fresh.frame.locator('#invoiceNumber').inputValue(),'');
  assert.equal(await fresh.frame.locator('#supplier').inputValue(),'');
  assert.equal(await fresh.frame.locator('#memo').inputValue(),'');
  assert.equal(await fresh.frame.locator('#lines tr').count(),1);
  assert.equal(fresh.getSaveCount(),1,'Nueva factura no debe duplicar la factura guardada.');
  assert.deepEqual(fresh.errors,[]);
  await fresh.page.close();

  const escape=await openScenario('escape');
  await saveInvoice(escape);
  const escapeShellUrl=escape.page.url();
  await escape.page.keyboard.press('Escape');
  await escape.page.waitForFunction(()=>window.__workspaceEvents.length===1);
  assert.equal(escape.page.url(),escapeShellUrl,'Escape no debe abandonar el shell del ERP.');
  assert.equal(escape.getSaveCount(),1);
  assert.deepEqual(escape.errors,[]);
  await escape.page.close();

  console.log(JSON.stringify({
    professionalDialog:true,accessibleDialog:true,numberAndAmount:true,
    acceptKeepsErpShell:true,catalogRefreshRequested:true,
    newInvoiceUsesCleanForm:true,keyboardFocusTrapped:true,escapeHandled:true,
    noDuplicateSave:true,noPageErrors:true
  }));
}finally{
  await browser.close();
}
