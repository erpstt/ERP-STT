import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {chromium} from '@playwright/test';
test('statement controls follow permissions and clear stale access after denial',{timeout:90000},async t=>{
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const base=process.env.A73_UI_URL||`http://127.0.0.1:${port}`;
 if(!process.env.A73_UI_URL){const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true'},stdio:'ignore'});t.after(()=>child.kill());for(let n=0;n<100;n++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}}
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const sender of [false,true]){
  const context=await browser.newContext();t.after(()=>context.close());let denied=false;const calls=[],attack='<img data-attack src=x onerror=unsafe()> & literal';
  await context.addInitScript(()=>{if(location.pathname.includes('customer-statement')){localStorage.setItem('nexo_token','synthetic-statement');localStorage.setItem('nexo_device_token','synthetic-statement-device');}});
  await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.fallback():r.abort());
  await context.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname;if(!path.includes('/statement/'))return r.fulfill({json:[]});calls.push({path,body:r.request().postDataJSON()});if(denied)return r.fulfill({status:403,json:{error:{message:'Synthetic denied'}}});return r.fulfill({json:path.endsWith('/send')?{estado:'PENDIENTE'}:{statement:{cliente_nombre:attack,email:'fixture@example.invalid',saldo_total:95,moneda:'USD',fecha_corte:'2026-10-31'},transport:{enabled:true},access:{canDownload:true,canSend:sender},history:[{created_at:'2026-10-31',fecha_corte:'2026-10-31',destinatario:attack,estado:'ENVIADO'}]}});});
  const page=await context.newPage();await page.goto(base+'/index.html');await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
  await page.evaluate(url=>{document.getElementById('app').hidden=true;const f=document.createElement('iframe');f.id='statement-test';f.src=url;document.body.append(f);},base+'/customer-statement-notifications.html?id=1&cutoff=2026-10-31&subsidiaryId=2');
  const frame=await(await page.locator('#statement-test').elementHandle()).contentFrame();await frame.locator('#name').filter({hasText:attack}).waitFor();assert.equal(await frame.locator('#compose').isDisabled(),!sender);assert.equal(await frame.locator('#pdf').isDisabled(),false);assert.equal(await frame.locator('[data-attack]').count(),0);
  if(sender){await frame.locator('#compose').click();await frame.locator('#note').fill('Synthetic note');await frame.locator('#confirmSend').click();await frame.locator('#message').filter({hasText:'Envío registrado'}).waitFor();const send=calls.find(c=>c.path.endsWith('/send'));assert.equal(send.body.subsidiaryId,'2');assert.equal(send.body.note,'Synthetic note');assert.match(send.body.requestId,/^[0-9a-f-]{36}$/);}
  denied=true;await frame.locator('#refresh').click();await frame.locator('#message').filter({hasText:'Synthetic denied'}).waitFor();assert.equal(await frame.locator('#compose').isDisabled(),true);assert.equal(await frame.locator('#pdf').isDisabled(),true);assert.ok(!calls.some(c=>c.path.endsWith('/pdf')));
  await context.close();
 }
});
