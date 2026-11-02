import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,extname,sep} from 'node:path';
import {chromium} from '@playwright/test';
import {contentSecurityPolicy} from '../dist/core/security/content-security-policy.js';
import {vueArtifacts} from './build-vue-templates.mjs';

test('CSP: root scripts exclude inline/eval; legacy pages exclude eval',()=>{
 for(const path of ['/','/?v=1','/index.html','/index.html?workspace=1']){const p=contentSecurityPolicy(path);assert.match(p,/script-src 'self' https:\/\/challenges.cloudflare.com;/);assert.match(p,/script-src-attr 'none'/);assert.doesNotMatch(p,/unsafe-eval/);}
 for(const path of ['/supplier-invoice.html','/permission-catalog.html','/api/health','http://[','//[','/%']){const p=contentSecurityPolicy(path);assert.doesNotMatch(p,/unsafe-eval/);assert.match(p,/script-src 'self' 'unsafe-inline'/);assert.match(p,/object-src 'none'/);}
});

test('build artifacts match trusted templates and use runtime-only Vue',async()=>{
 for(const[file,expected]of await vueArtifacts())assert.equal(await readFile(file,'utf8'),expected,file);
 const server=await readFile('src/server.ts','utf8');assert.match(server,/setHeader\('Content-Security-Policy', contentSecurityPolicy\(request.url/);
 for(const n of ['app','permission-catalog','role-access-matrix']){const s=await readFile(`public/${n}.js`,'utf8');assert.match(s,/createApp\(\{render,/);assert.doesNotMatch(s,/compilerOptions/);}
});

test('Vue precompiled pages run under CSP with isolated synthetic APIs',{timeout:180000},async t=>{
 const root=resolve('public'),server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost'),file=resolve(root,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(root+sep))throw Error();res.setHeader('Content-Security-Policy',contentSecurityPolicy(u.pathname));res.setHeader('Content-Type',extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'text/html');let data=await readFile(file);if(u.pathname==='/')data=Buffer.from(data.toString().replace(/(<div[^>]+id="app"[^>]*>)/,'$1<span id="untrusted-template">{{ globalThis.__templateExecuted = true }}</span>'));res.end(data);}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const base=process.env.CSP_VUE_URL||`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const context=await browser.newContext();t.after(()=>context.close());
 await context.route('**/csp-synthetic-probe.js',r=>r.fulfill({contentType:'text/javascript',body:"try{new Function('return 42')();window.__evalBlocked=false}catch{window.__evalBlocked=true}"}));
 await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.fallback():r.abort());
 await context.route('**/csp-workbook-probe.js',r=>r.fulfill({contentType:'text/javascript',body:"import {reportWorkbook} from '/spreadsheet-safety.js'; const blob=await reportWorkbook({headers:['Code','Amount'],rows:[['=1+1',-123.45]],title:'Synthetic'});window.__syntheticWorkbook={size:blob.size,mime:blob.type};"}));
 const calls=[];const attack='{{ globalThis.__templateExecuted = true }} <img src=x onerror="window.__xss=true">';
 await context.route('**/api/**',async r=>{const req=r.request(),path=new URL(req.url()).pathname;calls.push({path,method:req.method()});let json=[];
  if(path==='/api/auth/turnstile-config')json={enabled:false};
  else if(path==='/api/security/permissions')json=[{permission_id:1,module:'Synthetic',description:attack,code:'SYNTHETIC.VIEW',is_operational:true}];
  else if(path==='/api/security/roles')json=[{role_id:2,role_name:'Synthetic'}];
  else if(path==='/api/security/role-permissions')json=[{role_id:2,permission_id:1}];
  else if(path==='/api/security/role-access-matrix')json={_revision:'SYNTHETIC',selectedRoleId:2,roles:[{roleId:2,name:'Synthetic'}],grants:[],specialPermissions:[],modules:[{key:'synthetic',name:attack,resources:[{key:'synthetic:view',optionName:'Synthetic resource',actions:['view','edit']}]}]};
  await r.fulfill({json});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await t.test('root mounts, binds inputs and toggles password without runtime compilation',async()=>{
  const response=await page.goto(base+'/');assert.doesNotMatch(response.headers()['content-security-policy'],/unsafe-eval/);
  await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
  assert.equal(await page.locator('#untrusted-template').count(),0);assert.equal(await page.evaluate(()=>Boolean(window.__templateExecuted)),false);
  const state=await page.evaluate(async()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.email='synthetic@example.invalid';v.password='synthetic';v.showPassword=true;await v.$nextTick();return{email:document.querySelector('input[type=email]')?.value,password:document.querySelector('#password')?.type};});assert.equal(state.email,'synthetic@example.invalid');assert.equal(state.password,'text');
 });
 await t.test('CSP blocks inline script, event attributes and new Function',async()=>{
  assert.deepEqual(await page.evaluate(async()=>{const probe=document.createElement('script');probe.src='/csp-synthetic-probe.js';await new Promise((resolve,reject)=>{probe.onload=resolve;probe.onerror=reject;document.head.append(probe);});const script=document.createElement('script');script.textContent='window.__inlineExecuted=true';document.body.append(script);const button=document.createElement('button');button.setAttribute('onclick','window.__eventExecuted=true');document.body.append(button);button.click();await new Promise(r=>setTimeout(r,30));return{eval:!window.__evalBlocked,inline:Boolean(window.__inlineExecuted),event:Boolean(window.__eventExecuted)};}),{eval:false,inline:false,event:false});
 });
 await t.test('matching runtime has no compiler and ignores DOM template input',async()=>{
  assert.deepEqual(await page.evaluate(async()=>{const Vue=await import('/assets/vue.js?v=20261102-a03-csp');const el=document.createElement('div');el.innerHTML='<p>{{ globalThis.__templateExecuted=true }}</p>';document.body.append(el);Vue.createApp({}).mount(el);return{version:Vue.version,hasCompiler:typeof Vue.compile('<p>never</p>')==='function',executed:Boolean(window.__templateExecuted),text:el.textContent};}),{version:'3.5.44',hasCompiler:false,executed:false,text:''});
 });
 for(const[file,id]of [['permission-catalog','permissionCatalog'],['role-access-matrix','matrixApp']])await t.test(file+' renders text and local interaction',async()=>{
  await page.evaluate(()=>localStorage.setItem('nexo_token','synthetic-csp-session'));
  const frame=await page.evaluateHandle(url=>{const f=document.createElement('iframe');f.src=url;document.body.append(f);return f;},base+'/'+file+'.html');const f=await frame.asElement().contentFrame();
  await f.waitForFunction(id=>{const v=document.getElementById(id)?.__vue_app__?._container?._vnode?.component?.proxy;return v&&!v.loading;},id);
  assert.ok((await f.locator('main').innerText()).includes(attack));assert.equal(await f.locator('main img[onerror]').count(),0);
  await f.evaluate(async id=>{const v=document.getElementById(id).__vue_app__._container._vnode.component.proxy;v.search='does-not-match';await v.$nextTick();},id);
  assert.equal(await f.evaluate(()=>Boolean(window.__templateExecuted||window.__xss)),false);
 });
 await t.test('ExcelJS lazy workbook generation works without unsafe-eval',async()=>{
  await page.evaluate(async()=>{const s=document.createElement('script');s.type='module';s.src='/csp-workbook-probe.js';await new Promise((resolve,reject)=>{s.onload=resolve;s.onerror=reject;document.head.append(s);});});await page.waitForFunction(()=>Boolean(window.__syntheticWorkbook));const result=await page.evaluate(()=>window.__syntheticWorkbook);assert.ok(result.size>1000);assert.match(result.mime,/spreadsheetml/);
 });
 assert.deepEqual(errors,[]);assert.ok(calls.every(c=>c.method==='GET'||(c.method==='POST'&&c.path==='/api/tax-calendar/list')));assert.ok(!calls.some(c=>c.path.includes('/pdf')||c.path.includes('/send')));
});
