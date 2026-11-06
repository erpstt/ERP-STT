import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

const kind='SOLICITUD_PAGO_RECORDATORIO_APROBACION';
const label='Solicitud de pago pendiente · Recordatorio al aprobador';
const tags=['empresa_nombre','numero_solicitud','moneda','monto_total','beneficiario_nombre','concepto','fecha_solicitud','fecha_pago_programada','solicitante_nombre','aprobador_nombre','fecha_inicio_aprobacion','fecha_limite_recordatorio','tipo_solicitud','enlace_solicitud'];
const defaults={subject:'Recordatorio: solicitud {{numero_solicitud}} pendiente de aprobación · {{empresa_nombre}}',body:'<p>La solicitud de pago <strong>{{numero_solicitud}}</strong> continúa pendiente de su aprobación después de 48 horas de lunes a viernes.</p><p>El cómputo excluye los sábados y domingos completos. Consulte el estado actual en GENTIA para revisar y aprobar o rechazar la solicitud.</p>'};
const server=await readFile('src/server.ts','utf8');
const injection=server.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/),renewal=server.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(injection&&renewal,'Real serveFile branding/session injection must be represented');
function served(raw){const[,guard,assets]=injection,branded=raw.includes('</head>')?raw.replace('</head>',assets+'</head>'):assets+raw,html=branded.includes('<head>')?branded.replace('<head>','<head>'+guard):guard+branded;return /<head\b[^>]*>/i.test(html)?html.replace(/<head\b[^>]*>/i,head=>head+renewal[1]):renewal[1]+html;}

// Only template get/save/preview are mocked. The preview is deliberately hostile
// to prove that the existing sandbox cannot execute code in the ERP workspace.
async function fixture(t,{canEdit=true,denied=false,saveDenied=false,companyId=1,transport=true,startKind=kind,saved=null,realPreview=false}={}){
 let renderer;
 if(realPreview){process.env.GENTIA_APP_URL='https://erp-preview.example.invalid';renderer=await import('../dist/modules/notifications/payment-request-approval-reminder-email.js');}
 const{page,baseURL}=await bankBrowserFixture(t,{viewport:{width:1536,height:1000},timeout:10000}),calls=[],errors=[],unexpected=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(({companyId})=>{try{localStorage.setItem('nexo_token','synthetic-reminder-template-token');localStorage.setItem('nexo_device_token','synthetic-reminder-template-device');localStorage.setItem('nexo_company',String(companyId));localStorage.setItem('nexo_role','2');window.NexoSessionRenewal={current:()=>({generation:'synthetic-reminder-template-generation'})};}catch{/* The opaque preview sandbox must not receive ERP storage. */}},{companyId});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==baseURL){await route.fallback();return;}
  if(url.pathname==='/notification-templates.html'){await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public/notification-templates.html','utf8'))});return;}
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  const action=url.pathname.split('/').at(-1),payload=request.postDataJSON();calls.push({action,payload,path:url.pathname,method:request.method()});
  assert.equal(url.pathname,'/api/configuration/notification-templates/'+action);assert.equal(request.method(),'POST');assert.equal(request.headers().authorization,'Bearer synthetic-reminder-template-token');assert.ok([kind,'SOLICITUD_PAGO_APROBADA'].includes(payload.kind));
  if(action==='get'){
   if(denied){await route.fulfill({status:403,json:{error:{message:'Sin permiso de consulta de recordatorios.'}}});return;}
   await route.fulfill({json:{canEdit,subsidiary:{id:companyId,name:'Synthetic subsidiary '+companyId},transport:{enabled:transport},template:saved,defaults}});return;
  }
  if(action==='save'){
   if(saveDenied){await route.fulfill({status:403,json:{error:{message:'Ya no tiene permiso para editar esta plantilla.'}}});return;}
   await route.fulfill({json:{template:{cuerpo_template:'<p>Mensaje sanitizado para {{aprobador_nombre}}.</p>',updated_by_email:'editor@example.invalid',updated_at:'2026-11-06T01:00:00Z'}}});return;
  }
  if(action==='preview'){
   if(renderer){
    const rendered=renderer.renderPaymentRequestApprovalReminderEmail(payload.subject,payload.body,{requestId:421,subsidiaryId:companyId,instanceId:42,approvalVersion:3,approvalLevelId:7,approverUserId:9,assignmentId:'00000000-0000-4000-8000-000000000421',reminderCycle:'assignment:00000000-0000-4000-8000-000000000421',companyUtcOffsetMinutes:-360,empresa_nombre:'Synthetic subsidiary '+companyId,numero_solicitud:'SOL-SYN-421',moneda:'USD',monto_total:'1234.123456',beneficiario_nombre:'Beneficiario sintético',concepto:'Servicios profesionales sintéticos',fecha_solicitud:'2026-10-30',fecha_pago_programada:'2026-11-10',solicitante_nombre:'Solicitante sintético',aprobador_nombre:'Aprobador sintético',fecha_inicio_aprobacion:'2026-10-30T16:00:00Z',fecha_limite_recordatorio:'2026-11-03T16:00:00Z',tipo_solicitud:'Otros Pagos',empresa_zona_horaria:'América / Costa Rica'});
    await route.fulfill({json:rendered});return;
   }
   await route.fulfill({json:{subject:'Recordatorio SOL-SYN-421 · Synthetic subsidiary '+companyId,html:'<!doctype html><html><body><h1>Solicitud SOL-SYN-421 pendiente de aprobación</h1><p>Subsidiaria: Synthetic subsidiary '+companyId+'</p><p>Aprobador: Aprobador sintético</p><p>48 horas de lunes a viernes; sábados y domingos completos excluidos.</p><a href="https://erp-preview.example.invalid/payment-requests.html?id=421&amp;subsidiaryId='+companyId+'">Consultar solicitud</a><script>parent.parent.syntheticReminderPreviewExecuted=true</script></body></html>'}});return;
  }
  unexpected.push(action);await route.fulfill({status:501,json:{error:{message:'Unmocked template API is blocked'}}});
 });
 await page.goto(baseURL);await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/notification-templates.html?kind='+startKind+'"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();
 if(denied)await frame.locator('#message').filter({hasText:'Sin permiso de consulta'}).waitFor();else await frame.locator('#previewSubject').filter({hasText:'SOL-SYN-421'}).waitFor();
 assert.equal(await frame.locator('html').evaluate(el=>el.classList.contains('inside-erp-workspace')),true);
 assert.equal(await frame.evaluate(()=>[...document.styleSheets].some(sheet=>sheet.href?.includes('/gentia-theme.css')&&sheet.cssRules.length)),true);
 t.after(()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});return{page,frame,calls,baseURL};
}

test('recordatorio: tipo, variables y criterio48h explican aprobador/empresa/asignación sin programar envíos manuales',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t);assert.equal(await frame.locator('#notificationType').inputValue(),kind);assert.equal(await frame.locator('#typeTitle').textContent(),label);assert.deepEqual(await frame.locator('#variables button').allTextContents(),tags.map(tag=>'{{'+tag+'}}'));
 assert.match(await frame.locator('#schedule').innerText(),/48 horas de reloj de lunes a viernes.*dos días hábiles.*sábados.*domingos completos.*zona horaria.*etapa o asignación vigente/);
 assert.match(await frame.locator('#activeHelp').innerText(),/aprobador asignado.*sigue pendiente/);assert.match(await frame.locator('#automaticHelp').innerText(),/número.*subsidiaria.*aprobador.*fechas.*consulta autenticada/);assert.match(await frame.locator('#previewHelp').innerText(),/no envía correos.*no aprueba.*ni ejecuta pagos/);
 assert.equal(await frame.locator('#scheduleFields').isHidden(),true);assert.equal(await frame.locator('#active').isChecked(),false);assert.equal(await frame.locator('#subject').inputValue(),defaults.subject);assert.deepEqual(calls.map(call=>call.action),['get','preview']);
});

test('recordatorio: asunto/mensaje/activo se guardan conkind correcto y cuerpo sanitizado; preview sigue inerte',{timeout:30000},async t=>{
 const{page,frame,calls}=await fixture(t);
 assert.equal(await frame.locator('#preview').getAttribute('sandbox'),'');const preview=frame.frameLocator('#preview');await preview.getByRole('link',{name:'Consultar solicitud'}).waitFor();assert.equal(await preview.getByRole('link').getAttribute('href'),'https://erp-preview.example.invalid/payment-requests.html?id=421&subsidiaryId=1');assert.equal(await page.evaluate(()=>window.syntheticReminderPreviewExecuted),undefined);assert.equal(await frame.evaluate(()=>window.syntheticReminderPreviewExecuted),undefined);
 await frame.locator('#subject').fill('Recordatorio ');await frame.locator('#subject').focus();await frame.locator('#variables button').getByText('{{numero_solicitud}}',{exact:true}).click();assert.equal(await frame.locator('#subject').inputValue(),'Recordatorio {{numero_solicitud}}');
 await frame.locator('#editor').fill('Estimado {{aprobador_nombre}}: revise {{enlace_solicitud}}.');await frame.locator('.gentia-switch-track').click();assert.equal(await frame.locator('#active').isChecked(),true);await frame.locator('#save').click();await frame.locator('#message').filter({hasText:'Plantilla guardada.'}).waitFor();
 const saved=calls.filter(call=>call.action==='save');assert.equal(saved.length,1);assert.equal(saved[0].payload.kind,kind);assert.equal(saved[0].payload.subject,'Recordatorio {{numero_solicitud}}');assert.match(saved[0].payload.body,/aprobador_nombre.*enlace_solicitud/);assert.equal(saved[0].payload.active,true);assert.equal(Object.hasOwn(saved[0].payload,'day'),false);assert.equal(Object.hasOwn(saved[0].payload,'time'),false);assert.equal(Object.hasOwn(saved[0].payload,'subsidiaryId'),false);assert.equal(await frame.locator('#editor').innerHTML(),'<p>Mensaje sanitizado para {{aprobador_nombre}}.</p>');assert.match(await frame.locator('#audit').innerText(),/editor@example\.invalid/);assert.ok(calls.every(call=>['get','save','preview'].includes(call.action)));
});

test('recordatorio: rol de consulta permite preview y bloquea edición/submit programático',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t,{canEdit:false});await frame.locator('#message').filter({hasText:'Modo de solo lectura'}).waitFor();assert.equal(await frame.locator('#subject').getAttribute('readonly'),'');assert.equal(await frame.locator('#editor').getAttribute('contenteditable'),'false');assert.equal(await frame.locator('#editor').getAttribute('aria-readonly'),'true');
 for(const selector of['#active','#save','#variables button','#addLink','[data-command]'])assert.equal(await frame.locator(selector).evaluateAll(controls=>controls.every(control=>control.disabled)),true);
 await frame.locator('#previewButton').click();await frame.locator('#message').filter({hasText:'Vista previa actualizada.'}).waitFor();await frame.locator('#form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await frame.locator('#message').filter({hasText:'no modificarla'}).waitFor();assert.equal(calls.filter(call=>call.action==='save').length,0);assert.equal(calls.filter(call=>call.action==='preview').length,2);
});

test('recordatorio: acceso denegado no obtiene preview ni habilita guardado',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t,{denied:true});assert.equal(await frame.locator('#save').isDisabled(),true);await frame.locator('#form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.deepEqual(calls.map(call=>call.action),['get']);
});

test('recordatorio: configuración de otra empresa y SMTP apagado conserva edición sin prometer envío',{timeout:30000},async t=>{
 const saved={activo:true,asunto_template:'Empresa dos {{numero_solicitud}}',cuerpo_template:'<p>Empresa dos para {{aprobador_nombre}}</p>'};
 const{frame,calls}=await fixture(t,{companyId:2,transport:false,saved});assert.equal(await frame.locator('#company').textContent(),'Synthetic subsidiary 2');assert.equal(await frame.locator('#subject').inputValue(),saved.asunto_template);assert.equal(await frame.locator('#active').isChecked(),true);assert.match(await frame.locator('#transport').innerText(),/Envío desactivado.*preparar y guardar/);
 await frame.locator('.gentia-switch-track').click();assert.equal(await frame.locator('#active').isChecked(),false);await frame.locator('#save').click();await frame.locator('#message').filter({hasText:'Plantilla guardada.'}).waitFor();assert.equal(calls.find(call=>call.action==='save').payload.active,false);assert.ok(calls.every(call=>call.payload.kind===kind));
});

test('recordatorio: rechazo de permisos al guardar mantiene el borrador y no reintenta automáticamente',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t,{saveDenied:true});await frame.locator('#subject').fill('Mantener borrador {{numero_solicitud}}');await frame.locator('#editor').fill('Texto pendiente de guardar');await frame.locator('#save').click();await frame.locator('#message').filter({hasText:'Ya no tiene permiso'}).waitFor();assert.equal(await frame.locator('#subject').inputValue(),'Mantener borrador {{numero_solicitud}}');assert.equal(await frame.locator('#editor').innerText(),'Texto pendiente de guardar');assert.equal(calls.filter(call=>call.action==='save').length,1);assert.equal(calls.filter(call=>call.action==='preview').length,1);
});

test('recordatorio: navegación desde plantilla aprobada carga el tipo nuevo sin mezclar sus variables',{timeout:30000},async t=>{
 const{frame,calls}=await fixture(t,{startKind:'SOLICITUD_PAGO_APROBADA'});assert.match(await frame.locator('#typeTitle').textContent(),/aprobada.*Tesorería/);await frame.locator('#notificationType').selectOption(kind);await frame.waitForURL('**/notification-templates.html?kind='+kind);await frame.locator('#previewSubject').filter({hasText:'SOL-SYN-421'}).waitFor();assert.equal(await frame.locator('#typeTitle').textContent(),label);assert.deepEqual(await frame.locator('#variables button').allTextContents(),tags.map(tag=>'{{'+tag+'}}'));assert.equal(calls.filter(call=>call.action==='save').length,0);assert.deepEqual(calls.filter(call=>call.action==='get').map(call=>call.payload.kind),['SOLICITUD_PAGO_APROBADA',kind]);
});

for(const width of [1536,390])test(`recordatorio visual ${width}: editor y vista previa accesibles con tema real sin desbordamiento`,{timeout:30000},async t=>{
 const{page,frame}=await fixture(t,{realPreview:true});await page.setViewportSize({width,height:1000});
 assert.ok(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(await frame.locator('#subject').isVisible(),true);assert.equal(await frame.locator('#previewButton').isVisible(),true);
 const directory=resolve('..','payment-request-reminder-qa-20261105');if(process.env.PAYMENT_REMINDER_CAPTURE==='1'){await mkdir(directory,{recursive:true});await page.screenshot({path:resolve(directory,`settings-${width}.png`),fullPage:true});}
 await frame.locator('#preview').scrollIntoViewIfNeeded();const preview=frame.frameLocator('#preview');await preview.getByRole('heading',{name:'SOL-SYN-421',exact:true}).waitFor();const text=await preview.locator('body').innerText();assert.match(text,/Synthetic subsidiary 1/);assert.match(text,/Aprobador sintético/);assert.match(text,/48 horas de lunes a viernes/);assert.match(text,/30\/10\/2026.*UTC-06:00/);assert.match(text,/03\/11\/2026.*UTC-06:00/);assert.match(text,/1\s?234,123456 USD/);assert.equal(await preview.getByRole('link',{name:'Revisar solicitud pendiente'}).getAttribute('href'),'https://erp-preview.example.invalid/payment-requests.html?id=421&subsidiaryId=1');assert.ok(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await preview.locator('body').evaluate(()=>window.scrollTo(0,document.scrollingElement.scrollHeight));
 if(process.env.PAYMENT_REMINDER_CAPTURE==='1')await page.screenshot({path:resolve(directory,`preview-${width}.png`),fullPage:true});
});
