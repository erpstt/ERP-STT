import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true}),errors=[],calls=[];let schedules=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/test-schedules-container',route=>route.fulfill({contentType:'text/html',body:'<iframe src="/scheduled-reports.html" style="border:0;width:100%;height:950px"></iframe>'}));
 await page.route('**/api/reports/schedules/**',route=>{
  const action=new URL(route.request().url()).pathname.split('/').pop(),p=route.request().postDataJSON();calls.push({action,p});let data={};
  if(action==='list')data={company:{id:3,name:'Sociedad de pruebas'},schedules,history:[],transport:{configured:false,enabled:false}};
  if(action==='save'){const s={id:1,revision:1,subsidiary_id:3,name:p.name,report_kind:p.report,frequency:p.frequency,weekday:p.weekday,month_day:p.monthDay,send_time:p.time+':00',cutoff_rule:p.cutoff,recipients:p.recipients,format:p.format,active:p.active,next_run_at:'2026-10-31T15:30:00Z'};schedules=[s];data=s;}
  if(action==='toggle'){schedules[0].active=p.active;schedules[0].revision++;data=schedules[0];}
  if(action==='delete')schedules=[];
  if(action==='preview')data={file:{fileName:'cxp.csv',mimeType:'text/csv',base64:Buffer.from('Documento,Saldo\nFAC-1,100').toString('base64')},cutoff:'2026-08-31'};
  return route.fulfill({json:data});
 });
 await page.goto('http://localhost:3000/test-schedules-container');const f=page.frameLocator('iframe');
 await f.locator('#empty').waitFor({state:'visible'});assert.match(await f.locator('#transport').innerText(),/todavía no está activo/);
 await f.locator('#new').click();await f.locator('#name').fill('CxP mensual');await f.locator('#report').selectOption('AP');await f.locator('#frequency').selectOption('MONTHLY');assert.equal(await f.locator('#weekdayLabel').isVisible(),false);assert.equal(await f.locator('#monthDayLabel').isVisible(),true);
 await f.locator('#monthDay').fill('31');await f.locator('#time').fill('09:30');await f.locator('#format').selectOption('CSV');await f.locator('#recipients').fill('finanzas@example.invalid\ngerencia@example.invalid');await f.locator('#save').click();await f.locator('#editor').waitFor({state:'hidden'});
 const saved=calls.find(c=>c.action==='save').p;assert.equal(saved.cutoff,'PREVIOUS_MONTH_END');assert.equal(saved.monthDay,31);assert.equal(saved.time,'09:30');assert.equal(saved.recipients.length,2);assert.match(await f.locator('#schedules').innerText(),/09:30/);
 await f.locator('[data-toggle]').click();await f.locator('[data-toggle]').filter({hasText:'Activar'}).waitFor();assert.equal(schedules[0].active,false);
 await f.locator('[data-edit]').click();assert.equal(await f.locator('#monthDay').inputValue(),'31');assert.equal(await f.locator('#active').isChecked(),false);
 const downloaded=page.waitForEvent('download');await f.locator('#preview').click();assert.equal((await downloaded).suggestedFilename(),'cxp.csv');
 await f.locator('#recipients').fill('invalid-email');await f.locator('#save').click();await f.locator('#editor .dialogError').filter({hasText:'correos válidos'}).waitFor();assert.equal(calls.filter(c=>c.action==='save').length,1);await f.locator('#cancel').click();
 await f.locator('[data-delete]').click();await f.locator('#cancelDelete').click();assert.equal(calls.filter(c=>c.action==='delete').length,0);await f.locator('[data-delete]').click();await f.locator('#deleteConfirm').click();await f.locator('#empty').waitFor({state:'visible'});
 await page.setViewportSize({width:390,height:844});assert.equal(await f.locator('html').evaluate(el=>el.scrollWidth<=window.innerWidth),true);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({menuPage:true,monthlyFields:true,cutoff:true,multipleRecipients:true,smtpNotice:true,edit:true,pause:true,previewDownload:true,emailValidation:true,deleteConfirmation:true,mobile:true}));
}finally{await browser.close();}
