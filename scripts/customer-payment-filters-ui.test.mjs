import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {test} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {receiptOptions} from './fixtures/customer-payment-ui-context.mjs';

const publicRoot=resolve('public');
const mime={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8'};
let server,browser,base;

test.before(async()=>{
 server=createServer(async(request,response)=>{
  try{
   const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname),file=resolve(publicRoot,'.'+pathname);
   if(!file.startsWith(publicRoot+sep)){response.writeHead(403);response.end();return;}
   const content=await readFile(file);response.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});response.end(content);
  }catch{response.writeHead(404);response.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';browser=await chromium.launch({headless:true,...(existsSync(chrome)?{executablePath:chrome}:{})});
});
test.after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});

const receipt=(id,customer,date='2026-10-16')=>({id,number:'COB-SYN-'+id,date,customer,bank:'Banco de prueba',account:'001-SYN',reference:'REF-'+id,currency:'USD',amount:50,status:'APROBADO',advanceTotal:0,bankFeeTotal:0,cashNet:50});
const octoberRows=[receipt(7,'Cliente Alpha'),receipt(8,'Cliente Beta')];

async function fixture(){
 const context=await browser.newContext({locale:'es-CR',timezoneId:'America/Costa_Rica'});
 await context.addInitScript(()=>{
  const OriginalDate=Date,fixed=Date.parse('2026-11-03T15:00:00Z');
  globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
  localStorage.setItem('nexo_token','synthetic-payment-filters');localStorage.setItem('nexo_device_token','synthetic-device');
 });
 const page=await context.newPage(),calls=[],controls={},navigations=[];page.setDefaultTimeout(8000);
 page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations.push(frame.url());});
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/api/sales/customer-payments/options'){await route.fulfill({json:receiptOptions});return;}
  if(path==='/api/sales/customer-payments/report'){
   const filters=request.postDataJSON();calls.push(filters);
   if(controls.report){await controls.report(route,filters);return;}
   await route.fulfill({json:{rows:octoberRows.filter(row=>row.date>=filters.from&&row.date<=filters.to)}});return;
  }
  await route.fulfill({status:404,json:{error:{message:'Unexpected synthetic API request.'}}});
 });
 await page.goto(base+'/customer-payments.html');await expect(page.locator('#count')).toHaveText('0 registros');
 return{page,calls,controls,navigations,close:()=>context.close()};
}

async function october(page){await page.locator('#from').fill('2026-10-01');await page.locator('#to').fill('2026-10-31');}
const apply=page=>page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();

test('aplica octubre sin recargar y conserva las fechas y la búsqueda del usuario',{timeout:30000},async()=>{
 const app=await fixture();try{
  const {page}=app;assert.deepEqual(app.calls,[{from:'2026-11-01',to:'2026-11-03'}]);
  await october(page);await page.locator('#search').fill('Alpha');await apply(page);
  await expect(page.locator('#rows')).toContainText('Cliente Alpha');await expect(page.locator('#rows')).not.toContainText('Cliente Beta');await expect(page.locator('#count')).toHaveText('1 registros');
  assert.deepEqual(app.calls.at(-1),{from:'2026-10-01',to:'2026-10-31'});
  await expect(page.locator('#from')).toHaveValue('2026-10-01');await expect(page.locator('#to')).toHaveValue('2026-10-31');await expect(page.locator('#search')).toHaveValue('Alpha');
  assert.equal(app.navigations.length,1,'Aplicar filtros debe actualizar la consulta, sin navegar otra vez.');
 }finally{await app.close();}
});

test('Enter aplica el buscador y el intervalo elegido',{timeout:30000},async()=>{
 const app=await fixture();try{
  const {page}=app;await october(page);await page.locator('#search').fill('Beta');await page.locator('#search').press('Enter');
  await expect(page.locator('#rows')).toContainText('Cliente Beta');await expect(page.locator('#rows')).not.toContainText('Cliente Alpha');
  assert.deepEqual(app.calls.at(-1),{from:'2026-10-01',to:'2026-10-31'});assert.equal(app.navigations.length,1);
 }finally{await app.close();}
});

test('un intervalo vacío o invertido no consulta ni se presenta como cero cobros',{timeout:30000},async()=>{
 const app=await fixture();try{
  const {page}=app,before=app.calls.length;await page.locator('#from').fill('');await apply(page);
  await expect(page.locator('#message')).toContainText('Indique las fechas desde y hasta');await expect(page.locator('#count')).toHaveText('Consulta sin completar');await expect(page.locator('#rows')).toContainText('No fue posible consultar los cobros.');assert.equal(app.calls.length,before);
  await page.locator('#from').fill('2026-10-31');await page.locator('#to').fill('2026-10-01');await apply(page);
  await expect(page.locator('#message')).toHaveText('La fecha desde no puede ser posterior a la fecha hasta.');await expect(page.locator('#count')).toHaveText('Consulta sin completar');assert.equal(app.calls.length,before);
  await october(page);await apply(page);await expect(page.locator('#rows')).toContainText('Cliente Alpha');await expect(page.locator('#message')).toHaveText('');
 }finally{await app.close();}
});

test('una respuesta anterior tardía no reemplaza el resultado más reciente',{timeout:30000},async()=>{
 const app=await fixture();let release;
 try{
  const {page}=app,delayed=new Promise(resolve=>{release=resolve;});
  app.controls.report=async(route,filters)=>{
   if(filters.from==='2026-10-01'){await delayed;await route.fulfill({json:{rows:octoberRows}}).catch(()=>{});return;}
   await route.fulfill({json:{rows:[receipt(9,'Cliente de septiembre','2026-09-20')]}});
  };
  const oldRequest=request=>request.url().endsWith('/customer-payments/report')&&request.postDataJSON()?.from==='2026-10-01';
  const started=page.waitForRequest(oldRequest),settled=Promise.race([page.waitForEvent('requestfinished',{predicate:oldRequest}),page.waitForEvent('requestfailed',{predicate:oldRequest})]);
  await october(page);await apply(page);await started;
  await page.locator('#from').fill('2026-09-01');await page.locator('#to').fill('2026-09-30');await apply(page);
  await expect(page.locator('#rows')).toContainText('Cliente de septiembre');release();await settled;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect(page.locator('#rows')).toContainText('Cliente de septiembre');await expect(page.locator('#rows')).not.toContainText('Cliente Alpha');await expect(page.locator('#from')).toHaveValue('2026-09-01');await expect(page.locator('#count')).toHaveText('1 registros');await expect(page.locator('#message')).toHaveText('');
 }finally{release?.();await app.close();}
});

test('un error de consulta limpia el listado anterior y muestra que la consulta no terminó',{timeout:30000},async()=>{
 const app=await fixture();try{
  const {page}=app;await october(page);await apply(page);await expect(page.locator('#rows')).toContainText('Cliente Alpha');
  app.controls.report=route=>route.fulfill({status:503,json:{error:{message:'Servicio temporalmente no disponible.'}}});await apply(page);
  await expect(page.locator('#message')).toHaveText('Servicio temporalmente no disponible.');await expect(page.locator('#count')).toHaveText('Consulta sin completar');await expect(page.locator('#rows')).toHaveText('No fue posible consultar los cobros.');await expect(page.locator('#rows')).not.toContainText('Cliente Alpha');
 }finally{await app.close();}
});
