import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {chromium} from '@playwright/test';

test('template list and designer honor independent permissions with isolated APIs',{timeout:180000},async t=>{
 let base=process.env.A05_UI_URL;
 if(!base){const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base=`http://127.0.0.1:${port}`;const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true'},stdio:'ignore'});t.after(()=>child.kill());let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);}
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const role of ['reader','creator','editor','deleter','denied'])await t.test(role,{timeout:30000},async st=>{
  const context=await browser.newContext();st.after(()=>context.close());const calls=[],attack='"><img data-template-attack src=x onerror="window.__unsafe=true"> & literal';
  await context.addInitScript(()=>{if(/^\/pdf-template/.test(location.pathname)){localStorage.setItem('nexo_token','synthetic-template-token');localStorage.setItem('nexo_device_token','synthetic-template-device');}});
  await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.fallback():r.abort());
  const access={canView:role!=='denied',canCreate:role==='creator',canEdit:role==='editor',canDelete:role==='deleter'};
  await context.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname,p=r.request().postDataJSON();calls.push({path,p});let json=[];
   if(path==='/api/pdf-templates/options'){if(role==='denied')return r.fulfill({status:403,json:{error:{message:'Synthetic access denied'}}});json={access,subsidiary:{id:1,name:'Synthetic company'},branches:[],templates:[{id:1,name:attack,documentType:'FAC_VEN',pageSize:'A4',orientation:'PORTRAIT',isSystem:false,isDefault:false,schema:{version:1,margins:{top:12,bottom:12,left:12,right:12},zones:{header:[],body:[{id:'one',type:'text',content:attack,style:{}}],footer:[]}}}]};}
   else if(path==='/api/pdf-templates/render')json={html:'<h1>Synthetic preview</h1><script>window.parent.__unsafe=true</script>'};
   else if(path==='/api/pdf-templates/save'||path==='/api/pdf-templates/clone')json={id:2};
   else if(path==='/api/auth/turnstile-config')json={enabled:false};
   await r.fulfill({json});
  });
  const page=await context.newPage();await page.goto(base+'/index.html');await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
  const open=async file=>{await page.evaluate(url=>{document.getElementById('app').hidden=true;document.getElementById('template-test-frame')?.remove();const f=document.createElement('iframe');f.id='template-test-frame';f.style.width='1250px';f.style.height='1200px';f.src=url;document.body.append(f);},base+'/'+file);const frame=await(await page.locator('#template-test-frame').elementHandle()).contentFrame();await frame.waitForLoadState('load');return frame;};
  let frame=await open('pdf-templates.html');
  if(role==='denied'){await frame.locator('#message').filter({hasText:'Synthetic access denied'}).waitFor();assert.equal(await frame.locator('#create').isVisible(),false);frame=await open('pdf-template-builder.html?id=1');await frame.waitForFunction(()=>document.body.textContent.includes('Synthetic access denied'));assert.equal(await frame.locator('#save').isDisabled(),true);assert.equal(calls.filter(c=>/\/(save|clone|delete)$/.test(c.path)).length,0);return;}
  await frame.locator('[data-edit]').waitFor();assert.equal(await frame.locator('#create').isVisible(),access.canCreate);assert.equal(await frame.locator('[data-clone]').count(),Number(access.canCreate));assert.equal(await frame.locator('[data-delete]').count(),Number(access.canDelete));assert.equal(await frame.locator('[data-edit]').textContent(),access.canEdit?'Diseñar':'Consultar');assert.equal(await frame.locator('[data-template-attack]').count(),0);
  frame=await open('pdf-template-builder.html'+(role==='creator'?'':'?id=1'));await frame.waitForFunction(()=>document.querySelector('#name')?.value);
  const writable=access.canCreate||access.canEdit;assert.equal(await frame.locator('#save').isDisabled(),!writable);assert.equal(await frame.locator('#name').isDisabled(),!writable);
  if(writable){await frame.locator('#name').fill('Synthetic updated');await frame.locator('#save').click();await frame.waitForFunction(()=>location.search==='?id=2');const save=calls.find(c=>c.path==='/api/pdf-templates/save');assert.ok(save);assert.equal('compiled'in save.p,false);assert.equal(Boolean(save.p.id),role==='editor');}
  await frame.locator('#preview').click();await frame.locator('#previewDialog[open]').waitFor();assert.ok(!(await frame.locator('#previewFrame').getAttribute('sandbox')).split(/\s+/).includes('allow-scripts'));const preview=await(await frame.locator('#previewFrame').elementHandle()).contentFrame();await preview.locator('h1').waitFor();assert.equal(await preview.locator('h1').textContent(),'Synthetic preview');assert.equal(await frame.evaluate(()=>Boolean(window.__unsafe)),false);assert.equal(await page.evaluate(()=>Boolean(window.__unsafe)),false);
  assert.equal(await frame.locator('[data-template-attack]').count(),0);assert.ok(!calls.some(c=>/\/resend|\/email|\/pdf$/.test(c.path)));
 });
});
