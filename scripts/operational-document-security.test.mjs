import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {chromium} from '@playwright/test';

const attack='"><img data-operational-attack src="/synthetic-invalid-image" onerror="window.__operationalXss=true"> & <b data-operational-attack>Dato</b>';
const pages=['purchase-document-view','sales-document-view','fixed-asset-view'];

test('operational documents preserve literal text, numbers and actions',{timeout:240000},async t=>{
 const root=resolve('public'),server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost'),p=resolve(root,'.'+u.pathname);if(!p.startsWith(root+sep))throw Error();res.setHeader('Content-Type',extname(p)==='.js'?'text/javascript':extname(p)==='.css'?'text/css':'text/html');res.end(await readFile(p));}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const base=process.env.OPERATIONAL_UI_URL||`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 async function open(st,name,type,{failure=false,negative=false}={}){
  const context=await browser.newContext();st.after(()=>context.close());let tainted=true;const calls=[],errors=[];
  await context.addInitScript(()=>{if(/\/(?:purchase-document-view|sales-document-view|fixed-asset-view)\.html$/.test(location.pathname)){localStorage.setItem('nexo_token','synthetic-operational-session');localStorage.setItem('nexo_device_token','synthetic-operational-device');}window.__printed=0;window.__closed=0;window.print=()=>window.__printed++;window.close=()=>window.__closed++;});
  await context.route('**/*',r=>{const u=new URL(r.request().url());return u.origin===new URL(base).origin&&u.pathname!=='/synthetic-invalid-image'?r.fallback():r.abort();});
  if(negative)await context.route('**/purchase-document-view.js*',async r=>{const source=process.env.OPERATIONAL_UI_URL?await(await fetch(new URL('/purchase-document-view.js',base))).text():await readFile('public/purchase-document-view.js','utf8');assert.ok(source.includes('${esc(l.line_number)}'));await r.fulfill({contentType:'text/javascript',body:source.replace('${esc(l.line_number)}','${l.line_number}')});});
  await context.route('**/api/**',async r=>{const req=r.request(),path=new URL(req.url()).pathname;calls.push({path,method:req.method()});
   if(failure&&(path.startsWith('/api/purchasing/workflow/')||path.startsWith('/api/sales/workflow/')||path.startsWith('/api/fixed-assets/workflow-manage/')))return r.fulfill({status:503,json:{error:{message:attack}}});
   const line={line_number:tainted?attack:2,product_id:1,account_id:10,description:attack,quantity:2,unit_cost:50,unit_price:50,tax_amount:13,gross_amount:113};
   const header={document_type:type,document_number:attack,document_date:'2026-11-02',supplier_id:1,customer_id:1,currency_id:1,location_id:1,source_document_id:1,exchange_rate:1,status:'APROBADO',memo:attack};
   const refs={subsidiary:{name:attack},suppliers:[{id:1,name:attack}],customers:[{id:1,name:attack}],currencies:[{id:1,code:'USD'}],locations:[{id:1,name:attack}],sources:[{id:1,number:attack}],products:[{id:1,code:'00123',name:attack}],accounts:[{account_id:10,account_number:'00123',account_name:attack}]};
   let json=[];
   if(path==='/api/purchasing/workflow/123')json={header,lines:[line]};
   else if(path==='/api/purchasing/workflow/options')json=refs;
   else if(path==='/api/sales/workflow/123')json={header,lines:[line],refs};
   else if(path==='/api/fixed-assets/workflow-manage/123')json={asset:{number:'00123',name:attack,category:attack,method:attack,life:24,residual:0,serial:attack,location:attack,currency:'USD',purchaseDate:'2026-01-01',serviceDate:'2026-01-01',department:attack,costCenter:attack,class:attack,status:'ACTIVO',description:attack,cost:100},schedule:[{month:tainted?attack:1,period:attack,date:'2026-11-02',amount:10,accumulated:10,bookValue:90,status:'CONTABILIZADA'}],origins:[{journalId:77,document:attack,invoice:attack,date:'2026-11-02',supplier:attack,amount:100,currency:'USD',foreignAmount:100}]};
   else if(path==='/api/approval-engine/detail')json={instance:{status:'APROBADO',current_level:1},steps:[{status:'APROBADO',nivel:1,nombre_nivel:attack}],history:[{accion_tomada:attack,user:attack,fecha_hora:'2026-11-02T12:00:00Z',comentario_motivo:attack}]};
   else if(path==='/api/auth/turnstile-config')json={enabled:false};
   await r.fulfill({json});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/index.html');await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
  await page.evaluate(url=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.authenticated=true;v.selectingCompany=false;v.selectingRole=false;v.activeCompany={subsidiaryId:1,name:'Synthetic'};v.activeRole={roleId:1,name:'Synthetic'};v.recordDialog.open=false;const f=document.createElement('iframe');f.id='operational-test-frame';f.style.width='1200px';f.style.height='950px';f.src=url;document.body.append(f);},base+'/'+name+'.html?id=123');
  const frame=await(await page.locator('#operational-test-frame').elementHandle()).contentFrame();await frame.waitForLoadState('load');
  return{frame,calls,errors,clean:()=>{tainted=false;}};
 }
 const cases=[...['REQUISITION','QUOTE','ORDER','RECEIPT'].map(type=>[pages[0],type]),...['QUOTE','ORDER','DELIVERY'].map(type=>[pages[1],type]),[pages[2],'ASSET']];
 for(const[name,type]of cases)await t.test(name+' '+type,{timeout:25000},async st=>{
  const {frame,calls,errors,clean}=await open(st,name,type),rows=name===pages[2]?'#rows':'#lines';await frame.locator(rows+' tr').waitFor();
  assert.equal(await frame.locator(rows+' tr td').first().textContent(),attack);assert.equal(await frame.locator('[data-operational-attack],img[onerror],script:not([src])').count(),0);assert.equal(await frame.evaluate(()=>Boolean(window.__operationalXss)),false);assert.equal(await frame.evaluate(()=>localStorage.getItem('nexo_token')),'synthetic-operational-session');
  const cells=await frame.locator(rows+' tr td').allTextContents();if(name===pages[2]){assert.equal(cells[3],'10,00');assert.equal(cells[4],'10,00');assert.equal(cells[5],'90,00');assert.equal(await frame.locator('#cost').textContent(),'USD 100,00');assert.equal(await frame.locator('a[href="/journal-view.html?id=77"]').textContent(),attack);}else{assert.equal(cells[3],'2,00');assert.equal(cells[4],'50,00');assert.equal(cells[5],'13,00');assert.equal(cells[6],'113,00');assert.ok(cells[1].includes('00123'));}
  await frame.locator(name===pages[0]?'[data-document-action=print]':'#print').click();assert.equal(await frame.evaluate(()=>window.__printed),1);
  clean();await frame.goto(frame.url());await frame.locator(rows+' tr').waitFor();
  assert.equal(await frame.locator(rows+' tr td').first().textContent(),name===pages[2]?'1':'2');
  assert.deepEqual(errors,[]);
  const readPosts=['/api/approval-engine/detail','/api/tax-calendar/list'];
  assert.ok(calls.every(c=>c.method==='GET'||c.method==='POST'&&readPosts.includes(c.path)),JSON.stringify(calls.filter(c=>c.method!=='GET')));
  assert.ok(!calls.some(c=>/\/pdf|\/send|\/resend/.test(c.path)));
 });
 for(const name of pages)await t.test(name+' error message remains literal',{timeout:20000},async st=>{const{frame}=await open(st,name,'ORDER',{failure:true});const message=name===pages[2]?'#message':'main p';await frame.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent===text,{selector:message,text:attack});assert.equal(await frame.locator('[data-operational-attack]').count(),0);});
 await t.test('negative control detects markup from previous purchase line renderer',{timeout:20000},async st=>{const{frame}=await open(st,pages[0],'ORDER',{negative:true});await frame.locator('#lines [data-operational-attack]').first().waitFor();assert.equal(await frame.locator('#lines [data-operational-attack]').count(),2);});
});
