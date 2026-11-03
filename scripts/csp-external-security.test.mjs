import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import vm from 'node:vm';
import {chromium} from '@playwright/test';

test('public HTML contains no executable inline scripts or event attributes',async()=>{
 const pages=(await readdir('public')).filter(n=>n.endsWith('.html'));
 assert.ok(pages.length>50);
 for(const f of pages){const source=await readFile('public/'+f,'utf8');assert.doesNotMatch(source,/\son[a-z]+\s*=/i,f);for(const m of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi))assert.ok(/\bsrc\s*=/.test(m[1])||!m[2].trim(),f);}
 const server=await readFile('src/server.ts','utf8'),guard=server.match(/const guard=`([^`]+)`;/)[1];assert.doesNotMatch(guard,/<script>/);assert.match(guard,/<script src="\/workspace-guard.js\?v=20261102-a03-external"><\/script>/);assert.ok(!/workspace-guard[^>]*(?:defer|async)/.test(guard));
});

test('external document actions preserve print, close and both payment history branches',async()=>{
 const source=await readFile('public/document-actions.js','utf8');
 for(const length of [1,2]){const calls=[],buttons=['print','close','back-to-erp','back-to-payments','constructor','unknown'].map(action=>({dataset:{documentAction:action},addEventListener(type,callback){assert.equal(type,'click');this.callback=callback;}}));vm.runInNewContext(source,{document:{querySelectorAll:()=>buttons},window:{print:()=>calls.push('print'),close:()=>calls.push('close'),location:{assign:path=>calls.push(path)},history:{length,back:()=>calls.push('back')}}});buttons.forEach(b=>b.callback?.());assert.deepEqual(calls,['print','close','/',length===1?'/supplier-payments.html':'back']);assert.equal(buttons[4].callback,undefined);assert.equal(buttons[5].callback,undefined);}
});

test('global CSP and external guard/actions in actual HTTP delivery',{timeout:180000},async t=>{
 let base=process.env.EXTERNAL_CSP_URL;
 if(!base){const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base=`http://127.0.0.1:${port}`;const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true'},stdio:'ignore'});t.after(()=>child.kill());let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base,{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'isolated static server ready');}
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const context=await browser.newContext();t.after(()=>context.close());
 await context.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-csp-external');window.__printed=0;window.__closed=0;window.print=()=>window.__printed++;window.close=()=>window.__closed++;});
 await context.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==new URL(base).origin)return r.abort();if(u.pathname.startsWith('/api/'))return r.fulfill({json:{}});if(u.pathname.endsWith('.js')&&!['/workspace-guard.js','/document-actions.js'].includes(u.pathname))return r.fulfill({contentType:'text/javascript',body:"window.__guardBeforeBusiness=document.documentElement.classList.contains('inside-erp-workspace');"});return r.continue();});
 const page=await context.newPage();
 await t.test('all public pages and API health have strict script headers',async()=>{
  for(const f of ['/',...(await readdir('public')).filter(n=>n.endsWith('.html')).map(n=>'/'+n),'/api/health']){const r=await fetch(base+f,{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200,f);const p=r.headers.get('content-security-policy')||'';assert.match(p,/script-src 'self' https:\/\/challenges.cloudflare.com;/,f);assert.match(p,/script-src-attr 'none'/,f);assert.doesNotMatch(p,/unsafe-eval/,f);if(f.endsWith('.html')&&f!=='/index.html'){const h=await r.text();assert.match(h,/workspace-guard.js\?v=20261102-a03-external/);assert.doesNotMatch(h,/<script>/);}}
 });
 await t.test('direct navigation preserves query/hash in pending workspace then redirects',async()=>{
  await page.goto(base+'/purchase-document-view.html?id=123&kind=ORDER#synthetic');await page.waitForURL(base+'/');const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('nexo_workspace_redirect')));assert.equal(pending.path,'/purchase-document-view.html?id=123&kind=ORDER#synthetic');assert.ok(Math.abs(Date.now()-pending.createdAt)<30000);
 });
 for(const f of ['purchase-document-view','supplier-payment-view','consolidation'])await t.test(f+' external buttons and CSP attack rejection',async()=>{
  await page.goto(base+'/');await page.evaluate(url=>{document.body.replaceChildren();const f=document.createElement('iframe');f.id='test-workspace';f.style.width='1200px';f.style.height='900px';f.src=url;document.body.append(f);},base+'/'+f+'.html?id=123');const frame=await(await page.locator('#test-workspace').elementHandle()).contentFrame();await frame.waitForLoadState('load');await frame.waitForFunction(()=>document.querySelector('[data-document-action]')&&window.__guardBeforeBusiness===true);assert.equal(await frame.locator('html.inside-erp-workspace').count(),1);
  await frame.evaluate(()=>{window.__violations=[];document.addEventListener('securitypolicyviolation',e=>window.__violations.push(e.effectiveDirective));const script=document.createElement('script');script.textContent='window.__inlineRan=true';document.body.append(script);const b=document.createElement('button');b.setAttribute('onclick','window.__inlineRan=true');document.body.append(b);b.click();});await frame.waitForFunction(()=>window.__violations.length>=2);assert.equal(await frame.evaluate(()=>Boolean(window.__inlineRan)),false);
  if(f!=='consolidation'){await frame.locator('[data-document-action=print]').click();assert.equal(await frame.evaluate(()=>window.__printed),1);}
  if(f==='purchase-document-view'){await frame.locator('[data-document-action=close]').click();assert.equal(await frame.evaluate(()=>window.__closed),1);}
  if(f==='supplier-payment-view'){await frame.evaluate(()=>{history.pushState({},'','#history-test');window.__back=0;history.back=()=>window.__back++;});await frame.locator('[data-document-action=back-to-payments]').click();assert.equal(await frame.evaluate(()=>window.__back),1);}
  if(f==='consolidation'){await frame.locator('[data-document-action=back-to-erp]').click();await frame.waitForURL(base+'/');}
 });
});
