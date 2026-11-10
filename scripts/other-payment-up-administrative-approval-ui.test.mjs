import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';

// Actual UI modules, workspace guard and production theme; all APIs are synthetic.
// Opening a form or reading the route never submits an approval or executes a payment.
const source=await readFile('src/server.ts','utf8');
const branding=source.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/);
const renewal=source.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal,'Represent the production workspace assets');
function served(raw){const [,guard,assets]=branding;return raw.replace('</head>',assets+'</head>').replace('<head>','<head>'+guard).replace(/<head\b[^>]*>/i,head=>head+renewal[1]);}
const requestOptions={company:'Subsidiaria sintética',userId:1,admin:false,baseCurrencyId:1,
 currencies:[{id:1,name:'CRC'}],users:[{id:1,name:'Solicitante sintético'}],suppliers:[],
 accounts:[],customers:[],employees:[],otherNames:[],taxAgencies:[],departments:[],costCenters:[],banks:[],rates:[],beneficiaryBankAccounts:[]};
const workflowOptions={company:'Subsidiaria sintética',access:{canView:true,canCreate:false,canEdit:false,canDelete:false},
 entityTypes:[{id:'PAYMENT_REQUEST',name:'Solicitudes de pago'}],roles:[],users:[],departments:[],costCenters:[]};

async function fixture(t,width){
 const {page,baseURL}=await bankBrowserFixture(t,{viewport:{width,height:1000},timeout:10000});
 const calls=[],unexpected=[],errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  localStorage.setItem('nexo_token','synthetic-other-payment-token');
  localStorage.setItem('nexo_device_token','synthetic-other-payment-device');
  localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_role','2');
 });
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==baseURL){await route.fallback();return;}
  if(['/payment-requests.html','/approval-workflows.html'].includes(url.pathname)){
   await route.fulfill({contentType:'text/html; charset=utf-8',body:served(await readFile('public'+url.pathname,'utf8'))});return;
  }
  if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
  if(url.pathname.startsWith('/api/audit/')){await route.fulfill({json:{events:[]}});return;}
  const action=url.pathname.split('/').at(-1);calls.push({action,path:url.pathname,method:request.method()});
  let json;
  if(url.pathname.startsWith('/api/treasury/payment-requests/')){
   if(action==='access')json={canView:true,canCreate:true,canEdit:true,canDelete:false};
   else if(action==='options')json=requestOptions;
   else if(action==='report')json=[];
  }else if(url.pathname.startsWith('/api/approval-engine/')){
   if(action==='options')json=workflowOptions;
   else if(action==='workflows')json=[];
  }
  if(json===undefined){unexpected.push(request.method()+' '+url.pathname);await route.fulfill({status:501,json:{error:{message:'Unexpected API blocked by synthetic fixture'}}});return;}
  await route.fulfill({json});
 });
 await page.goto(baseURL);
 await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe src="'+baseURL+'/payment-requests.html"></iframe></body></html>');
 const frame=await(await page.locator('iframe').elementHandle()).contentFrame();
 await frame.waitForFunction(()=>document.getElementById('company')?.textContent==='Subsidiaria sintética'&&!document.getElementById('new').disabled);
 t.after(()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});
 return {page,frame,calls,baseURL};
}
async function capture(page,element,name){
 if(process.env.OTHER_PAYMENT_UP_ADMIN_CAPTURE!=='1')return;
 const directory=resolve('.local-tools/other-payment-up-administrative');await mkdir(directory,{recursive:true});
 await element.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(directory,name),fullPage:true});
}

for(const width of [1536,390])test(`Otros Pagos ${width}: explica UP seguido de Administrativo y mantiene pendiente hasta ambas aprobaciones`,{timeout:30000},async t=>{
 const {page,frame,calls,baseURL}=await fixture(t,width);
 await frame.locator('#new').click();
 const help=frame.locator('#otherApprovalHelp');assert.equal(await help.isVisible(),false);
 await frame.locator('#type').selectOption('OTROS');
 assert.equal(await help.isVisible(),true);
 const text=await help.innerText();
 assert.match(text,/con aprobación UP/i);
 assert.match(text,/primero.*UP.*después.*Aprobador Administrativo de la subsidiaria/s);
 assert.match(text,/permanece pendiente de aprobación hasta completar ambos pasos/i);
 assert.equal(await help.locator('input,select,button,a').count(),0);
 const box=await help.boundingBox();assert.ok(box.width>100&&box.width<=width);
 assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 await capture(page,help,`other-payment-notice-${width}.png`);
 await frame.locator('#type').selectOption('CXP');
 assert.equal(await help.isVisible(),false);
 assert.equal(await frame.locator('#cxpApprovalHelp').isVisible(),true);
 assert.equal(await frame.locator('[data-transition="APPROVE"],[data-transition="EXECUTE"]').count(),0);

 await frame.goto(baseURL+'/approval-workflows.html');
 const row=frame.locator('[data-inventory-id="PAYMENT_REQUEST_OTROS"]');await row.waitFor();
 const route=await row.innerText();
 assert.match(route,/primero.*UP.*después, obligatoriamente, el Aprobador Administrativo de la subsidiaria/s);
 assert.match(route,/pendiente hasta completar ambos pasos/i);
 assert.match(route,/Supervisor tributario/);
 assert.match(route,/respaldo autorizado/);
 assert.equal(await row.locator('[data-inventory-create],[data-inventory-edit]').count(),0);
 assert.equal(await frame.locator('[data-inventory-id="PAYMENT_REQUEST_CXP"]').getAttribute('data-state'),'automatic');
 assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 await capture(page,row,`other-payment-inventory-${width}.png`);
 assert.deepEqual(calls.filter(call=>!['access','options','report','workflows'].includes(call.action)),[]);
 assert.ok(calls.every(call=>call.method==='GET'||call.action==='report'));
});
