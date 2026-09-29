import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
 const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{if(location.origin==='http://localhost:3000')localStorage.setItem('nexo_token','test');});
 let saved;
 await page.route('**/api/configuration/notification-templates/**',async route=>{
  const path=new URL(route.request().url()).pathname,request=route.request().postDataJSON();
  assert.equal(request.kind,'FACTURA_VENTA');
  if(path.endsWith('/get'))return route.fulfill({json:{subsidiary:{name:'Empresa de prueba'},transport:{enabled:true},template:{asunto_template:'Factura {{numero_factura}}',cuerpo_template:'<p>Estimado {{cliente_nombre}}</p>',activo:true}}});
  if(path.endsWith('/preview'))return route.fulfill({json:{subject:'Factura FAC-VEN-001',html:'<h1>Factura de venta</h1><p>PDF y respaldos adjuntos</p>'}});
  if(path.endsWith('/save')){saved=request;return route.fulfill({json:{template:{cuerpo_template:request.body,updated_by_email:'admin@example.invalid',updated_at:new Date().toISOString()}}});}
  return route.abort();
 });
 await page.goto('http://localhost:3000/');
 await page.setContent('<iframe id="app" src="/notification-templates.html?kind=FACTURA_VENTA" style="width:100%;height:950px"></iframe>');
 const app=page.frameLocator('#app');
 await app.locator('#previewSubject').getByText('Factura FAC-VEN-001',{exact:true}).waitFor();
 assert.equal(await app.locator('#notificationType').inputValue(),'FACTURA_VENTA');
 assert.equal(await app.locator('#variables button').count(),7);
 assert.match(await app.locator('#automaticHelp').textContent(),/PDF de la factura/);
 assert.match(await app.locator('#automaticHelp').textContent(),/archivos de respaldo/);
 assert.match(await app.locator('#schedule').textContent(),/Envío manual/);
 assert.equal(await app.locator('#active').isChecked(),true);
 await app.locator('#subject').fill('Factura ');
 await app.locator('#variables button').filter({hasText:'{{numero_factura}}'}).click();
 assert.equal(await app.locator('#subject').inputValue(),'Factura {{numero_factura}}');
 await app.locator('#save').click();
 await app.getByText('Plantilla guardada.',{exact:true}).waitFor();
 assert.equal(saved.kind,'FACTURA_VENTA');
 assert.equal(saved.active,true);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({selector:true,variables:7,preview:true,save:true,invoiceAttachmentsHelp:true}));
}finally{await browser.close();}
