import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
 const page=await browser.newPage({viewport:{width:1450,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{if(location.origin==='http://localhost:3000')localStorage.setItem('nexo_token','test');});
 let saved,resent,enabled=false;
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/notification-templates/get'))return route.fulfill({json:{subsidiary:{name:'Empresa de prueba'},transport:{enabled:false},defaults:{subject:'Pago {{referencia_pago}}',body:'<p>Estimado {{proveedor_nombre}}</p>'}}});
  if(path.endsWith('/notification-templates/preview'))return route.fulfill({json:{subject:'Pago TRF-001',html:'<h1>Notificación de Pago Realizado</h1><p>Total 980,00 USD</p>'}});
  if(path.endsWith('/notification-templates/save')){saved=route.request().postDataJSON();return route.fulfill({json:{template:{cuerpo_template:saved.body,updated_by_email:'admin@example.invalid',updated_at:new Date().toISOString()}}});}
  if(path.endsWith('/notifications/history'))return route.fulfill({json:{transport:{enabled},logs:[{id:'1',estado:resent?'PENDIENTE':'ERROR_SIN_CORREO',destinatario:'',created_at:new Date().toISOString(),ultimo_error:'Sin correo',history:[]}]}});
  if(path.endsWith('/notifications/resend')){resent=route.request().postDataJSON();return route.fulfill({json:{estado:'PENDIENTE'}});}
  if(path.endsWith('/supplier-payments/1'))return route.fulfill({json:{header:{payment_number:'PAG-001',amount_paid:680},advances:[{amount:300}],applications:[{invoiceNumber:'FAC-001',invoiceTotal:1500,amount:1000}],impact:[]}});
  return route.fulfill({json:[]});
 });
 await page.goto('http://localhost:3000/');await page.setContent('<iframe id="app" src="/notification-templates.html" style="width:100%;height:950px;border:0"></iframe>');let app=page.frameLocator('#app');
 await app.locator('#previewSubject').getByText('Pago TRF-001').waitFor();assert.match(await app.locator('#transport').textContent(),/desactivado/);
 await app.locator('#subject').fill('Pago ');await app.locator('#variables button').filter({hasText:'{{empresa_nombre}}'}).click();assert.equal(await app.locator('#subject').inputValue(),'Pago {{empresa_nombre}}');
 await app.locator('#editor').fill('Estimado proveedor');await app.locator('#active').check();await app.locator('#save').click();await app.locator('#message').getByText('Plantilla guardada.').waitFor();assert.equal(saved.active,true);assert.ok(saved.body.includes('Estimado proveedor'));
 await page.setViewportSize({width:450,height:900});assert.equal(await app.locator('body').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
 await page.setContent('<iframe id="app" src="/supplier-payment-view.html?id=1" style="width:100%;height:950px;border:0"></iframe>');app=page.frameLocator('#app');await app.getByText('Error de envío: Sin correo',{exact:true}).waitFor();assert.equal(await app.locator('#resendNotification button').isDisabled(),true);
 assert.match(await app.locator('#header').textContent(),/Desembolso bancario680,00/);
 enabled=true;await app.locator('body').evaluate(()=>location.reload());await app.locator('#notificationEmail').fill('corregido@example.invalid');await app.locator('#resendNotification button').click();await app.getByText('Pendiente de envío',{exact:true}).waitFor();assert.equal(resent.email,'corregido@example.invalid');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({templateEditor:true,variables:true,preview:true,save:true,responsive:true,disabledSmtp:true,correctedRecipient:true,receiptNetAmount:true,emailsSent:0}));
}finally{await browser.close();}
