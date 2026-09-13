import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({channel:'chrome',headless:true});
const context = await browser.newContext({viewport:{width:1280,height:900}});
const actor = {created_by_name:'Ana Pérez',created_by_email:'ana@example.invalid',actor_type:'HUMAN',actor_source:'Nexo Web App',
  execution_context_id:'create-test',updated_by_name:'Agente de compras',updated_by_email:'agent@example.invalid',updated_actor_type:'AI_AGENT',updated_actor_source:'Integración de compras'};
const requested=[];
await context.route('**/api/**', async route => {
  const url=new URL(route.request().url());
  if(url.pathname==='/api/audit/record-actor') {
    requested.push(Object.fromEntries(url.searchParams));
    const id=url.searchParams.get('id');
    const row=id==='2'?{...actor,created_by_name:'Registro histórico',created_by_email:'legacy-unknown@nexo.invalid',updated_by_name:null,updated_by_email:null}
      :id==='3'?{...actor,updated_by_name:null,updated_by_email:null}:id==='4'?{...actor,created_by_name:'<img src=x onerror=alert(1)>'}:actor;
    return route.fulfill({json:row});
  }
  return route.fulfill({json:[]});
});
// Keep the actual shell and widget. Isolate unrelated business data for page layout tests.
await context.route('**/*.js', async route => {
  if(route.request().frame().parentFrame() && !route.request().url().endsWith('/record-audit.js')) return route.fulfill({body:'',contentType:'application/javascript'});
  return route.continue();
});
const page=await context.newPage();
try {
  await page.goto('http://localhost:3000');
  await page.evaluate(()=>{localStorage.setItem('nexo_token','ui-fixture');localStorage.setItem('nexo_device_token','ui-fixture-device');});
  const staticPages={
    'supplier-invoice-view.html':'supplier_invoice','supplier-invoice-entry.html':'supplier_invoice',
    'sales-invoice-view.html':'invoice','sales-invoice-entry.html':'invoice','journal-view.html':'journal','journal-entry.html':'journal',
    'purchase-document-view.html':'purchase_document','sales-document-view.html':'sales_document',
    'supplier-payment-view.html':'supplier_payment','customer-payment-view.html':'customer_payment',
    'bank-check-view.html':'bank_check','bank-check-entry.html':'bank_check','bank-deposit-view.html':'bank_deposit',
    'bank-deposit-entry.html':'bank_deposit','bank-fee-view.html':'bank_fee','fixed-asset-view.html':'asset',
    'supplier-note-view.html':'supplier_credit_note','supplier-note-entry.html':'supplier_credit_note',
    'sales-note-view.html':'credit_note','sales-note-entry.html':'credit_note','pdf-template-builder.html':'pdf_templates'
  };
  for (const [file,table] of Object.entries(staticPages)) {
    await page.evaluate(file=>{document.querySelector('#test-frame')?.remove();const frame=document.createElement('iframe');frame.id='test-frame';frame.src=`/${file}?id=1`;frame.style.cssText='width:100%;height:700px';document.body.append(frame);},file);
    const frame=page.frameLocator('#test-frame');
    await frame.locator('record-audit').getByText('Ana Pérez',{exact:true}).waitFor({state:'attached'});
    // Business modules normally reveal their document after loading the record.
    await frame.locator('record-audit').evaluate(panel=>{for(let node=panel;node;node=node.parentElement)node.hidden=false;});
    await frame.locator('record-audit').getByText('Ana Pérez',{exact:true}).waitFor();
    assert.equal(await frame.locator('record-audit').getAttribute('table'),table);
    assert.ok(await frame.locator('record-audit').getByText('Agente IA / LLM',{exact:true}).count());
  }
  const child=page.frames().find(frame=>frame.parentFrame());
  await child.evaluate(()=>document.querySelector('record-audit').setAttribute('record-id','2'));
  await child.getByText('Autor original no disponible.',{exact:false}).waitFor();
  await child.evaluate(()=>document.querySelector('record-audit').setAttribute('record-id','3'));
  await child.getByText('Sin modificaciones registradas.',{exact:true}).waitFor();
  await child.evaluate(()=>document.querySelector('record-audit').setAttribute('record-id','4'));
  await child.getByText('<img src=x onerror=alert(1)>',{exact:true}).waitFor();
  assert.equal(await child.locator('record-audit img').count(),0);
  await child.evaluate(()=>document.querySelector('record-audit').setAttribute('record-id',''));
  await child.getByText('El creador se registrará automáticamente al guardar.',{exact:true}).waitFor();
  const dynamicPages={
    'purchase-documents.html':['purchase_document','#entry'],'sales-documents.html':['sales_document','#entry'],
    'fixed-assets.html':['asset','#entry'],'asset-categories.html':['asset_category','#entry'],
    'asset-operations.html':['asset_transfer','#entry'],'supplier-payments.html':['supplier_payment','#entry'],
    'customer-payments.html':['customer_payment','#entry'],'payment-requests.html':['solicitudes_pago','#editor'],
    'bank-transfers.html':['bank_transfer','#journalModal .modal'],'bank-fees.html':['bank_fee','#entry'],
    'fx-revaluation.html':['fx_revaluation_runs','#detailPanel'],'opening-balances.html':['opening_balance_runs','main']
  };
  for(const [file,[table,selector]] of Object.entries(dynamicPages)) {
    await page.evaluate(file=>{document.querySelector('#test-frame')?.remove();const frame=document.createElement('iframe');frame.id='test-frame';frame.src=`/${file}`;document.body.append(frame);},file);
    const frame=page.frameLocator('#test-frame');
    await frame.locator(selector).evaluate((container,table)=>{
      window.NexoRecordAudit.show(table,1,container);
      for(let node=container;node;node=node.parentElement)node.hidden=false;
    },table);
    await frame.locator('record-audit').getByText('Ana Pérez',{exact:true}).waitFor();
  }
  // Exercise the Vue custom element inside the actual generic record modal.
  await page.evaluate(()=>document.querySelector('#test-frame').remove());
  const found=await page.evaluate(()=>{
    const root=document.querySelector('#app')._vnode?.component?.proxy;
    if(!root)return false;
    root.authenticated=true;root.sessionReady=true;root.currentModule='CORE';root.currentSection='Países';
    root.activeCompany={subsidiaryId:1,name:'Prueba'};
    root.rows=[{country_id:1,name:'Registro de prueba'}];
    return true;
  });
  assert.ok(found,'Vue root available for generic modal test');
  await page.getByRole('button',{name:'Autoría',exact:true}).click();
  await page.locator('record-audit').getByText('Ana Pérez',{exact:true}).waitFor();
  assert.equal(await page.locator('record-audit').getAttribute('table'),'countries');
  await page.screenshot({path:'.tmp/record-audit-validation/catalog-author.png'});
  console.log(JSON.stringify({passed:true,staticPages:Object.keys(staticPages).length,dynamicPages:Object.keys(dynamicPages).length,genericCatalog:true,legacy:true,unsaved:true,xssEscaped:true,requests:requested.length}));
} catch(error) {
  console.log(await page.evaluate(()=>({text:document.body.innerText.slice(-1800),panels:document.querySelectorAll('record-audit').length,dialog:document.querySelector('#app')._vnode?.component?.proxy?.recordDialog,activeCatalog:document.querySelector('#app')._vnode?.component?.proxy?.activeCatalog?.table})));
  await page.screenshot({path:'.tmp/record-audit-validation/failure.png'});
  throw error;
} finally {await browser.close();}
