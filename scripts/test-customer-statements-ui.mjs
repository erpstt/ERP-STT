import{chromium}from'../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
import assert from'node:assert/strict';
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
 const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{if(location.origin==='http://localhost:3000')localStorage.setItem('nexo_token','test')});
 let sent,settings,enabled=false;
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/notification-templates/get'))return route.fulfill({json:{subsidiary:{name:'Empresa'},transport:{enabled:false},defaults:{subject:'Estado {{cliente_nombre}}',body:'<p>Saldo {{saldo_total}}</p>'}}});
  if(path.endsWith('/notification-templates/preview'))return route.fulfill({json:{subject:'Estado de cuenta',html:'<p>Estado PDF adjunto</p>'}});
  if(path.endsWith('/notification-templates/save')){settings=route.request().postDataJSON();return route.fulfill({json:{template:{cuerpo_template:settings.body,updated_by_email:'admin@example.invalid',updated_at:new Date().toISOString()}}});}
  if(path.endsWith('/statement/get'))return route.fulfill({json:{statement:{cliente_nombre:'Cliente de prueba',fecha_corte:'2026-08-31',saldo_total:1000,moneda:'USD',email:'cliente@example.invalid'},history:sent?[{estado:'PENDIENTE',fecha_corte:'2026-08-31',created_at:new Date().toISOString(),destinatario:'cliente@example.invalid'}]:[],transport:{enabled}}});
  if(path.endsWith('/statement/send')){sent=route.request().postDataJSON();return route.fulfill({json:{estado:'PENDIENTE'}});}
  return route.fulfill({json:[]});
 });
 await page.goto('http://localhost:3000/');await page.setContent('<iframe id="app" src="/notification-templates.html?kind=ESTADO_CUENTA" style="width:100%;height:950px"></iframe>');let app=page.frameLocator('#app');await app.locator('#previewSubject').getByText('Estado de cuenta',{exact:true}).waitFor();assert.equal(await app.locator('#notificationType').inputValue(),'ESTADO_CUENTA');assert.equal(await app.locator('#variables button').count(),5);await app.locator('#sendDay').fill('17');await app.locator('#sendTime').fill('14:35');await app.locator('#save').click();await app.getByText('Plantilla guardada.',{exact:true}).waitFor();assert.equal(settings.kind,'ESTADO_CUENTA');assert.equal(settings.day,17);assert.equal(settings.time,'14:35');
 await page.setContent('<iframe id="app" src="/customer-statement-notifications.html?id=1&cutoff=2026-08-31" style="width:100%;height:950px"></iframe>');app=page.frameLocator('#app');await app.getByText('Cliente de prueba',{exact:true}).waitFor();assert.equal(await app.locator('#compose').isDisabled(),true);assert.equal(await app.locator('#pdf').isDisabled(),false);
 enabled=true;await app.locator('#refresh').click();await app.locator('#compose').click();assert.equal(await app.locator('#recipient').textContent(),'cliente@example.invalid');await app.locator('#note').fill('Gracias por su atención.');await app.locator('#confirmSend').click();await app.getByText('PENDIENTE',{exact:true}).waitFor();assert.equal(sent.note,'Gracias por su atención.');assert.equal(sent.cutoff,'2026-08-31');assert.match(sent.requestId,/^[a-f0-9-]{36}$/);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({statementTemplate:true,variables:true,save:true,disabledSmtp:true,manualConfirmation:true,recipient:true,additionalNote:true,history:true,emailsSent:0}));
}finally{await browser.close()}
