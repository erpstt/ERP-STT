import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bankBrowserFixture} from './bank-browser-fixture.mjs';

// The real Vue shell and production static assets run against synthetic APIs.
// This fixture never starts the application backend or reads environment files.
const serverSource=await readFile(new URL('../../src/server.ts',import.meta.url),'utf8');
const branding=serverSource.match(/const guard=`([\s\S]*?)`;\s+const gentiaAssets='([^']*)';/);
const renewal=serverSource.match(/const html=content\.toString\('utf8'\),renewal='([^']+)';/);
assert.ok(branding&&renewal,'Represent the production static HTML assets');

function servedHtml(raw,{shell=false}={}){
  if(!shell)raw=raw.replace('</head>',branding[2]+'</head>').replace('<head>','<head>'+branding[1]);
  return raw.replace(/<head\b[^>]*>/i,head=>head+renewal[1]);
}
function syntheticToken(id,session='initial'){
  const body={sub:`synthetic-layout-user-${id}`,user_id:id,userId:id,email:`layout-${id}@example.test`,session_id:`synthetic-layout-session-${id}-${session}`,exp:Math.floor(Date.now()/1000)+3600};
  return Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(body)).toString('base64url')+'.synthetic';
}
function bootstrap(id,headerChoices=1){
  const company={subsidiaryId:1,name:'Empresa sintética',legalName:'Empresa sintética',currencyCode:'USD',allowedCurrencyIds:[1]};
  const role={roleId:2,name:'Administrador'};
  const companies=Array.from({length:headerChoices},(_,index)=>index===0?company:{...company,subsidiaryId:index+1,name:`Empresa sintética ${index+1}`,legalName:`Empresa sintética ${index+1}`});
  const roles=Array.from({length:headerChoices},(_,index)=>index===0?role:{roleId:index+2,name:`Rol sintético ${index+1}`});
  return {bootstrapVersion:1,user:{id,userId:id,user_id:id,name:`Usuario sintético ${id}`,email:`layout-${id}@example.test`},locale:'es',
    languages:[{locale:'es',name:'Español',isActive:true}],roles,activeRole:role,roleAccess:{isAdmin:true,grants:[],modules:[]},
    companies,activeCompany:company,requiresCompanySelection:false};
}
const invoice={invoice_id:1,invoice_number:'FAC-SINTETICA-000001',transaction_id:1,customer_id:1,so_id:null,subsidiary_id:1,due_date:'2026-11-30',total_amount:100};
const references={
  '/api/transaction-engine/transactions':[{transaction_id:1,tran_number:'FAC-SINTETICA-000001'}],
  '/api/entities/customers':[{customer_id:1,name:'Cliente sintético'}],
  '/api/sales/sales-orders':[],
  '/api/organization/subsidiaries':[{subsidiary_id:1,name:'Empresa sintética'}]
};

export async function workspaceShellLayoutFixture(t,{viewport={width:1440,height:900},userId=1,headerChoices=1}={}){
  const {page,baseURL}=await bankBrowserFixture(t,{viewport,timeout:12000});
  const calls=[],unexpected=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({token})=>{
    if(!localStorage.getItem('nexo_token'))localStorage.setItem('nexo_token',token);
    localStorage.setItem('nexo_device_token','synthetic-workspace-layout-device');
    localStorage.setItem('nexo_company','1');
    localStorage.setItem('nexo_role','2');
    localStorage.setItem('gentia_language','es');
  },{token:syntheticToken(userId)});
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==baseURL){await route.fallback();return;}
    if(url.pathname==='/'||url.pathname==='/index.html'){
      await route.fulfill({contentType:'text/html; charset=utf-8',body:servedHtml(await readFile(new URL('../../public/index.html',import.meta.url),'utf8'),{shell:true})});return;
    }
    if(url.pathname==='/approval-workflows.html'){
      await route.fulfill({contentType:'text/html; charset=utf-8',body:servedHtml(await readFile(new URL('../../public/approval-workflows.html',import.meta.url),'utf8'))});return;
    }
    if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
    calls.push({path:url.pathname,method:request.method()});
    let json;
    if(url.pathname==='/api/auth/bootstrap'){
      const token=request.headers().authorization?.slice(7)||'';
      let id=1;try{id=Number(JSON.parse(Buffer.from(token.split('.')[1],'base64url')).userId)||1;}catch{}
      json=bootstrap(id,headerChoices);
    }else if(url.pathname==='/api/security/turnstile/config')json={enabled:false};
    else if(url.pathname==='/api/approval-engine/inbox')json=[];
    else if(url.pathname==='/api/tax-calendar/list')json={notifications:[]};
    else if(url.pathname==='/api/approval-engine/options')json={company:'Empresa sintética',isAdmin:true,access:{canView:true,canCreate:false,canEdit:false,canDelete:false},entityTypes:[],roles:[],users:[],departments:[],costCenters:[]};
    else if(url.pathname==='/api/approval-engine/workflows')json=[];
    else if(url.pathname==='/api/sales/invoices')json=[invoice];
    else if(url.pathname==='/api/sales/invoice-catalog-options')json=Object.fromEntries(Object.entries(references).map(([key,value])=>[key.slice('/api/'.length),value]));
    else if(url.pathname in references)json=references[url.pathname];
    else if(url.pathname.startsWith('/api/audit/'))json={events:[]};
    else if(url.pathname==='/api/health')json={};
    else{
      unexpected.push(request.method()+' '+url.pathname);
      await route.fulfill({status:501,json:{error:{message:'Synthetic layout fixture blocked an unexpected API'}}});return;
    }
    await route.fulfill({json});
  });
  t.after(()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});
  async function ready(){
    await page.locator('.workspace').waitFor();
    await page.waitForFunction(()=>{
      const app=document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy;
      return app?.sessionReady&&app?.authenticated&&app?.activeCompany&&!app?.selectingCompany;
    });
  }
  let sessionSequence=0;
  async function reloadAs(id){
    await page.evaluate(token=>localStorage.setItem('nexo_token',token),syntheticToken(id,String(++sessionSequence)));
    await page.reload();await ready();
  }
  async function openWorkflow(){
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('nexo:open-workspace',{detail:{module:'Workflow',section:'Configuración de Flujos de Aprobación',url:'/approval-workflows.html'}})));
    const iframe=page.locator('.embedded-workspace iframe');await iframe.waitFor();
    const frame=await(await iframe.elementHandle()).contentFrame();
    await frame.locator('#inventory [data-inventory-id]').first().waitFor();
    return frame;
  }
  async function openInvoices(){
    await page.locator('#moduleSidebar .nav-link').filter({hasText:'Ventas'}).click();
    await page.locator('#moduleSidebar .nav-children a').filter({hasText:'Facturas de venta'}).click();
    await page.locator('.table-card tbody tr').first().waitFor();
  }
  await page.goto(baseURL);await ready();
  return {page,baseURL,calls,ready,reloadAs,openWorkflow,openInvoices};
}
