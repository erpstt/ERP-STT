import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium} from '@playwright/test';

const currencies=[{currency_id:1,currency_code:'USD',name:'Dólar estadounidense'},{currency_id:2,currency_code:'CRC',name:'Colón costarricense'},{currency_id:3,currency_code:'PEN',name:'Sol peruano'}];
const daily=[{exchange_rate_id:12,from_currency_id:1,to_currency_id:2,effective_date:'2026-11-02',spot_rate:500,_revision:'D12',_actions:{canEdit:false,canDelete:false}},{exchange_rate_id:11,from_currency_id:1,to_currency_id:3,effective_date:'2026-11-01',spot_rate:3.45,_revision:'D11',_actions:{canEdit:false,canDelete:false}}];
const consolidated=[{rate_id:8,holding_subsidiary_id:1,source_subsidiary_id:2,fiscal_period_id:1,period:'2026-11',fiscal_year:'2026',month_name:'noviembre',from_currency_id:2,to_currency_id:1,closing_rate:.002,average_rate:.002,historical_rate:.002,is_locked:false,_revision:'C8',_actions:{canEdit:false,canDelete:false}}];
const access={canView:true,canCreate:false,canEdit:false,canDelete:false,sourceCurrencies:[],references:{'core/currencies':currencies,'organization/subsidiaries':[{subsidiary_id:1,name:'Synthetic holding'},{subsidiary_id:2,name:'Synthetic source'}],'organization/accounting-periods':[{fiscal_period_id:1,period_name:'Synthetic period'}]}};

test('tipos de cambio terminan la carga, permiten reintentar y descartan respuestas de otro catálogo o contexto', {timeout:120000}, async t=>{
 const root=resolve('public'),server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+new URL(req.url,'http://fixture').pathname);if(!path.startsWith(root+sep))throw Error('Invalid path');res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const localOrigin=`http://127.0.0.1:${server.address().port}`,target=process.env.RATE_CATALOG_LOADING_UI_URL||localOrigin+'/index.html',origin=new URL(target).origin;
 const allCalls=[];await mkdir('.local-tools',{recursive:true});
 async function fixture({holdStage=null,deny=false,nextRows=daily,lateUnauthorized=false}={}){
  const page=await browser.newPage({viewport:{width:1450,height:1000}}),calls=[],errors=[];
  let release,seen;const gate=new Promise(done=>release=done),heldSeen=new Promise(done=>seen=done),attempts={access:0,daily:0,consolidated:0};
  t.after(()=>release());
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
   const call={path:url.pathname,method:request.method(),catalog:url.searchParams.get('catalog')};calls.push(call);allCalls.push(call);
   if(!['GET','HEAD'].includes(request.method()))return route.fulfill({status:400,json:{error:{message:'Unexpected write in read-only fixture'}}});
   let json=[];
   if(url.pathname==='/api/security/turnstile/config')json={enabled:false};
   else if(url.pathname==='/api/configuration/rates/access'){
    attempts.access++;if(holdStage==='access'&&attempts.access===1){seen();await gate;}
    if(deny)return route.fulfill({status:403,json:{error:{message:'No tiene permiso para consultar estas tasas.'}}});json=access;
   }else if(url.pathname==='/api/configuration/exchange-rates'){
    attempts.daily++;if(holdStage==='catalog'&&attempts.daily===1){seen();await gate;if(lateUnauthorized)return route.fulfill({status:401,json:{error:{message:'Obsolete session response'}}});json=daily;}else json=nextRows;
   }else if(url.pathname==='/api/configuration/consolidated-exchange-rates'){attempts.consolidated++;json=consolidated;}
   else if(url.pathname==='/api/health'||url.pathname==='/api/audit/record-actor')json={};
   try{await route.fulfill({json});}catch(error){if(!/Target page|Target closed|Route|intercept|Invalid Interception|Response body is unavailable|request.*cancel/i.test(error.message))throw error;}
  });
  await page.goto(target);await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
  await page.evaluate(()=>{localStorage.setItem('nexo_token','synthetic-rate-loading');localStorage.setItem('nexo_device_token','synthetic-rate-device');const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.authenticated=true;v.sessionReady=true;v.selectingRole=false;v.selectingCompany=false;v.activeRole={roleId:5,name:'Administrador'};v.activeCompany={subsidiaryId:1,name:'Synthetic holding'};v.roleAccess={loaded:true,isAdmin:true,grants:{},modules:[]};v.closeWorkspace();v.currentModule='Configuración';v.currentSection='Tipos de cambio';});
  if(lateUnauthorized)await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let first=true;window.fetch=(path,init={})=>{if(first&&String(path)==='/api/configuration/exchange-rates'){first=false;const{signal,...withoutAbort}=init;return originalFetch(path,withoutAbort);}return originalFetch(path,init);};});
  const load=(section='Tipos de cambio')=>page.evaluate(async section=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.currentSection=section;await v.loadCatalog();},section);
  const start=()=>page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;window.pendingRateLoad=v.loadCatalog();});
  const state=()=>page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;return{rows:v.rows,loading:v.tableLoading,error:v.tableError,catalog:v.activeCatalog?.slug,canCreate:v.activeCatalog?.allowCreate,authenticated:v.authenticated,token:v.token()};});
  return{page,calls,errors,release,heldSeen,attempts,load,start,state};
 }
 const ready=await fixture();await ready.load();assert.deepEqual((await ready.state()).rows.map(row=>row.exchange_rate_id),[12,11]);
 await ready.page.locator('input[aria-label="Buscar registros"]').fill('CRC');assert.equal(await ready.page.locator('tbody tr').count(),1);await ready.page.locator('input[aria-label="Buscar registros"]').fill('01/11/2026');assert.equal(await ready.page.locator('tbody tr').count(),1);await ready.page.locator('input[aria-label="Buscar registros"]').fill('');assert.equal(await ready.page.locator('tbody tr').count(),2);
 assert.deepEqual(ready.calls.filter(call=>call.path.startsWith('/api/configuration/')).map(call=>call.path),['/api/configuration/rates/access','/api/configuration/exchange-rates']);assert.deepEqual(ready.errors,[]);await ready.page.screenshot({path:'.local-tools/rate-catalog-ready.png',fullPage:true});await ready.page.close();
 for(const stage of ['access','catalog']){
  const delayed=await fixture({holdStage:stage});await delayed.page.clock.install();await delayed.start();await delayed.heldSeen;
  assert.equal((await delayed.state()).loading,true);await delayed.page.clock.fastForward(21000);
  await delayed.page.getByRole('alert').filter({hasText:/carga|tardando|tiempo|inténtelo|reintent/i}).waitFor();
  const failed=await delayed.state();assert.equal(failed.loading,false);assert.equal(failed.rows.length,0);assert.ok(failed.error);if(stage==='catalog')await delayed.page.screenshot({path:'.local-tools/rate-catalog-timeout.png',fullPage:true});
  delayed.release();await delayed.page.getByRole('button',{name:/Reintentar/i}).click();await delayed.page.waitForFunction(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;return!v.tableLoading&&v.rows.length===2&&!v.tableError;});
  assert.deepEqual((await delayed.state()).rows.map(row=>row.exchange_rate_id),[12,11]);assert.deepEqual(delayed.errors,[]);await delayed.page.close();
 }
 const denied=await fixture({deny:true});await denied.page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.rows=[{exchange_rate_id:99,spot_rate:999}];});await denied.load();
 const blocked=await denied.state();assert.equal(blocked.loading,false);assert.equal(blocked.rows.length,0);assert.match(blocked.error,/permiso/);assert.equal(blocked.canCreate,false);assert.equal(denied.attempts.daily,0);assert.deepEqual(denied.errors,[]);await denied.page.close();
 const navigation=await fixture({holdStage:'catalog'});await navigation.start();await navigation.heldSeen;await navigation.load('Tipos de cambio consolidados');assert.equal((await navigation.state()).rows[0].rate_id,8);navigation.release();await navigation.page.evaluate(()=>window.pendingRateLoad);
 const navigated=await navigation.state();assert.equal(navigated.catalog,'consolidated-exchange-rates');assert.equal(navigated.rows[0].rate_id,8);assert.ok(!navigated.error);assert.deepEqual(navigation.errors,[]);await navigation.page.close();
 const scopedRows=[{...daily[0],exchange_rate_id:22,spot_rate:501}],context=await fixture({holdStage:'catalog',nextRows:scopedRows});await context.start();await context.heldSeen;
 await context.page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.activeRole={roleId:1,name:'Contador de Subsidiaria'};v.activeCompany={subsidiaryId:2,name:'Synthetic source'};v.roleAccess={loaded:true,isAdmin:false,grants:{'configuration:exchange-rates':{canView:true,canCreate:false,canEdit:false,canDelete:false}},modules:[]};});await context.load();context.release();await context.page.evaluate(()=>window.pendingRateLoad);
 assert.deepEqual((await context.state()).rows.map(row=>row.exchange_rate_id),[22]);assert.deepEqual(context.errors,[]);await context.page.close();
 // Model a response already queued by the browser: abort is ignored for the
 // first read so the obsolete 401 must also be rejected by the context guard.
 const obsolete=await fixture({holdStage:'catalog',lateUnauthorized:true,nextRows:scopedRows});await obsolete.start();await obsolete.heldSeen;
 await obsolete.page.evaluate(()=>{localStorage.setItem('nexo_token','synthetic-rate-new-session');localStorage.setItem('nexo_device_token','synthetic-rate-new-device');const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.activeRole={roleId:1,name:'Contador de Subsidiaria'};v.activeCompany={subsidiaryId:2,name:'Synthetic source'};});await obsolete.load();obsolete.release();await obsolete.page.evaluate(()=>window.pendingRateLoad);
 const preserved=await obsolete.state();assert.equal(preserved.authenticated,true);assert.equal(preserved.token,'synthetic-rate-new-session');assert.deepEqual(preserved.rows.map(row=>row.exchange_rate_id),[22]);assert.ok(!preserved.error);assert.equal(obsolete.calls.filter(call=>call.path==='/api/auth/logout').length,0);assert.deepEqual(obsolete.errors,[]);await obsolete.page.close();
 assert.ok(allCalls.every(call=>['GET','HEAD'].includes(call.method)));
});
