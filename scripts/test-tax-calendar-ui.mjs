import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const [shellSource,alertsSource]=await Promise.all([
  readFile(new URL('../public/app.js',import.meta.url),'utf8'),
  readFile(new URL('../public/approval-notifications.js',import.meta.url),'utf8')
]);
assert.match(shellSource,/addEventListener\('nexo:open-workspace'/);
assert.doesNotMatch(alertsSource,/location\.assign\('\/tax-calendar\.html/);

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
  const page=await browser.newPage({viewport:{width:1500,height:1050}});
  page.setDefaultTimeout(20000);
  await page.addInitScript(()=>{
    localStorage.setItem('nexo_token','tax-calendar-ui-test');
    localStorage.setItem('nexo_device_token','tax-calendar-device-test');
  });
  const today=new Date(),iso=new Date(Date.UTC(today.getFullYear(),today.getMonth(),today.getDate())).toISOString().slice(0,10);
  const eventId='11111111-1111-4111-8111-111111111111',notificationId='22222222-2222-4222-8222-222222222222';
  let savedPayload=null,notificationRead=false;
  const event={id:eventId,subsidiaryId:1,subsidiaryName:'Empresa de Pruebas',taxTypeCode:'CRI_IVA_13%',taxTypeName:'IVA',period:iso.slice(0,7),dueDate:iso,assignedUserId:10,assignedUserName:'Ana Contadora',assignedUserEmail:'ana@example.com',status:'in_review',documentType:'file_upload',documentUrl:`/api/tax-calendar/events/${eventId}/document`,externalLink:null,filingDate:null,filingReferenceNumber:null,notes:'Declaración mensual',followersCount:1,reminderDays:[7,3,1,0],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const notification=()=>({id:notificationId,eventId,kind:'reminder',priority:'normal',title:'Recordatorio tributario · CRI_IVA_13%',message:'La declaración vence hoy.',deepLink:`/tax-calendar.html?event=${eventId}`,readAt:notificationRead?new Date().toISOString():null,createdAt:new Date().toISOString(),taxTypeCode:event.taxTypeCode,dueDate:iso,subsidiaryName:event.subsidiaryName});
  await page.route('**/api/tax-calendar/**',async route=>{
    const url=new URL(route.request().url()),action=url.pathname.split('/').at(-1);
    if(route.request().method()==='GET'&&action==='document')return route.fulfill({status:200,contentType:'application/pdf',headers:{'Content-Disposition':"attachment; filename*=UTF-8''declaracion.pdf"},body:Buffer.from('%PDF-1.4\n%%EOF')});
    const payload=route.request().postDataJSON?.()||{};
    if(action==='options')return route.fulfill({json:{activeSubsidiaryId:1,permissions:{view:true,manage:true,file:true},subsidiaries:[{id:1,name:'Empresa de Pruebas',countryId:1}],users:[{id:10,name:'Ana Contadora',email:'ana@example.com',subsidiaryIds:[1]},{id:11,name:'Luis Auditor',email:'luis@example.com',subsidiaryIds:[1]}],taxTypes:[{code:'CRI_IVA_13%',name:'CRI_IVA_13% · IVA · 13%',subsidiaryIds:[1]}]}});
    if(action==='list')return route.fulfill({json:{events:[event],metrics:{total:1,pending:0,inReview:1,upcoming:1,overdue:0,filed:0,exempt:0},notifications:[notification()]}});
    if(action==='get')return route.fulfill({json:{event,followers:[{id:'f',userId:11,notificationChannel:'both',name:'Luis Auditor',email:'luis@example.com'}],reminders:[7,3,1,0].map(daysBeforeDue=>({id:String(daysBeforeDue),daysBeforeDue,isSent:false,sentAt:null})),document:{id:'d',fileName:'declaracion.pdf',mimeType:'application/pdf',fileSize:1200,createdAt:new Date().toISOString()}}});
    if(action==='save'){savedPayload=payload;return route.fulfill({json:{success:true,id:eventId}});}
    if(action==='mark-read'){notificationRead=true;return route.fulfill({json:{success:true,updated:1}});}
    if(action==='delete')return route.fulfill({json:{success:true,id:eventId}});
    return route.fulfill({status:404,json:{error:'Ruta de prueba no definida'}});
  });

  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded',timeout:30000});
  await page.setContent('<iframe id="tax" src="http://localhost:3000/tax-calendar.html" style="width:1480px;height:1030px"></iframe>');
  const app=page.frameLocator('#tax');
  await app.getByRole('heading',{name:'Calendario tributario'}).waitFor();
  assert.equal(await app.locator('#metricReview').textContent(),'1');
  assert.equal(await app.locator('#notificationBadge').textContent(),'1');
  await app.locator('#newEvent').click();
  await app.locator('#editorDialog[open]').waitFor();
  assert.match(await app.locator('#editorTitle').textContent(),/Nueva obligaci/);
  assert.equal(await app.locator('#eventSubsidiary').inputValue(),'1');
  await app.locator('#cancelEditor').click();
  await app.locator('#editorDialog').waitFor({state:'hidden'});
  await app.getByRole('button',{name:'Nueva obligación'}).click();
  await app.locator('#editorDialog[open]').waitFor();
  assert.equal(await app.locator('#editorTitle').textContent(),'Nueva obligación');
  assert.equal(await app.locator('#eventSubsidiary').inputValue(),'1');
  await app.locator('#cancelEditor').click();
  await app.locator('#editorDialog').waitFor({state:'hidden'});
  if(process.argv.includes('--screenshot'))await page.screenshot({path:`${process.env.TEMP}/nexo-tax-calendar.png`,fullPage:true});
  await app.getByRole('tab',{name:'Tabla'}).click();
  await app.locator('#eventRows').getByText('Empresa de Pruebas',{exact:true}).waitFor();
  assert.match(await app.locator('#eventRows').innerText(),/CRI_IVA_13%/);
  await app.getByRole('tab',{name:'Mes'}).click();
  await app.locator('#monthGrid [data-event]').waitFor();
  await app.getByRole('tab',{name:'Semana'}).click();
  assert.equal(await app.locator('#weekGrid .week-day').count(),7);
  await app.locator('#weekGrid [data-event]').waitFor();
  await app.getByRole('tab',{name:'Mes'}).click();
  await app.locator('#monthGrid [data-event]').first().click();
  await app.locator('#editorDialog[open]').waitFor();
  assert.equal(await app.locator('#eventPeriod').inputValue(),iso.slice(0,7));
  assert.equal(await app.locator('.follower-row').count(),1);
  await app.locator('#eventStatus').selectOption('filed');
  await app.locator('#filingDate').fill(`${iso}T09:15`);
  await app.locator('#filingReference').fill('RAD-UI-001');
  await app.locator('#documentFile').setInputFiles({name:'nuevo.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nUI TEST\n%%EOF')});
  await app.locator('#saveEvent').click();
  await app.locator('#editorDialog').waitFor({state:'hidden'});
  assert.ok(savedPayload);assert.equal(savedPayload.status,'filed');assert.equal(savedPayload.filingReferenceNumber,'RAD-UI-001');
  assert.match(savedPayload.file.dataUrl,/^data:application\/pdf;base64,/);assert.equal(savedPayload.followers[0].userId,11);assert.deepEqual(savedPayload.reminders.map(item=>item.daysBeforeDue),[7,3,1,0]);
  await app.locator('#openNotifications').click();
  await app.locator('#notificationsDialog[open]').waitFor();
  await app.locator('#markAllRead').click();
  await app.locator('#notificationBadge').waitFor({state:'hidden'});
  assert.equal(notificationRead,true);
  await page.setContent('<iframe id="tax-alerts" src="http://localhost:3000/tax-calendar.html?notifications=1" style="width:1480px;height:1030px"></iframe>');
  const alerts=page.frameLocator('#tax-alerts');
  await alerts.locator('#notificationsDialog[open]').waitFor();
  notificationRead=false;
  await page.route('**/api/approval-engine/inbox',route=>route.fulfill({json:[]}));
  await page.setContent('<!doctype html><html><head></head><body></body></html>');
  await page.evaluate(()=>{localStorage.setItem('nexo_token','tax-calendar-ui-test');localStorage.setItem('nexo_device_token','tax-calendar-device-test');});
  await page.addScriptTag({url:'http://localhost:3000/approval-notifications.js?v=3'});
  await page.locator('.nexo-tax-bell').waitFor({state:'visible'});
  assert.equal(await page.locator('.nexo-tax-bell b').textContent(),'1');
  await page.evaluate(()=>{window.__taxNavigation=null;window.addEventListener('nexo:open-workspace',event=>window.__taxNavigation=event.detail,{once:true});});
  await page.locator('.nexo-tax-bell').click();
  assert.deepEqual(await page.evaluate(()=>window.__taxNavigation),{url:'/tax-calendar.html?notifications=1',module:'Fiscal',section:'Calendario tributario'});
  assert.equal(new URL(page.url()).pathname,'/');
  console.log(JSON.stringify({monthView:true,weekAndTableTabs:true,filters:true,metrics:true,newEventDialog:true,manageDialog:true,followers:true,reminders:true,fileUpload:true,filedValidation:true,inAppNotifications:true,globalTaxAlert:true,alertWorkspaceNavigation:true,alertDialog:true,responsivePage:true}));
}finally{await browser.close();}
