import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
  const publicPage=await browser.newPage({viewport:{width:1440,height:900}});
  await publicPage.goto('http://localhost:3000/',{waitUntil:'networkidle'});
  assert.equal(await publicPage.title(),'GENTIA — ERP inteligente');
  assert.equal(await publicPage.locator('.gentia-brand-hero img').getAttribute('src'),'/gentia-logo-reversed.svg');
  assert.equal(await publicPage.locator('.brand-panel').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(4, 46, 114)');
  assert.equal(await publicPage.locator('.submit').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(4, 46, 114)');
  assert.equal(await publicPage.locator('.gentia-brand-mobile').evaluate(element=>getComputedStyle(element).display),'none');
  assert.doesNotMatch(await publicPage.locator('body').innerText(),/\b(?:NEXO|Nexo)\b/);

  const mobile=await browser.newPage({viewport:{width:390,height:844}});
  await mobile.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await mobile.locator('.gentia-brand-mobile img').waitFor();
  assert.notEqual(await mobile.locator('.gentia-brand-mobile').evaluate(element=>getComputedStyle(element).display),'none');
  assert.equal(await mobile.locator('.brand-panel').evaluate(element=>getComputedStyle(element).display),'none');

  const app=await browser.newPage({viewport:{width:1440,height:900}});
  const fixtures={
    '/api/auth/roles':[{roleId:1,name:'Administrador'}],
    '/api/auth/select-role':{roleId:1,name:'Administrador'},
    '/api/auth/companies':[{subsidiaryId:7,name:'Empresa de pruebas',legalName:'Empresa de pruebas',logoUrl:null,currencyCode:'USD'}],
    '/api/auth/select-company':{subsidiaryId:7,name:'Empresa de pruebas',legalName:'Empresa de pruebas',logoUrl:null,currencyCode:'USD'},
    '/api/organization/subsidiaries':[{subsidiary_id:7,name:'Empresa de pruebas',currency_id:1,secondary_currency_ids:[]}],
    '/api/core/countries':[{country_id:1,country_code_iso2:'CR',name:'Costa Rica'}]
  };
  await app.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fixtures[path]??[])});
  });
  await app.addInitScript(()=>{
    const payload=btoa(JSON.stringify({email:'brand-test@example.test',exp:Math.floor(Date.now()/1000)+3600})).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    localStorage.setItem('nexo_token',`e30.${payload}.test`);
    localStorage.setItem('nexo_company','7');
    localStorage.setItem('nexo_role','1');
  });
  await app.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await app.locator('.workspace .gentia-brand-sidebar img').waitFor();
  assert.equal(await app.locator('.workspace .gentia-brand-sidebar img').getAttribute('src'),'/gentia-wordmark-reversed.svg');
  assert.equal(await app.locator('.sidebar').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(4, 46, 114)');
  assert.equal(await app.locator('.nav-link.active .nav-label').evaluate(element=>getComputedStyle(element).color),'rgb(255, 255, 255)');
  assert.doesNotMatch(await app.locator('.workspace').innerText(),/\b(?:NEXO|Nexo)\b/);

  const embedded=await browser.newPage({viewport:{width:1440,height:900}});
  await embedded.route('**/api/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({subsidiaries:[],currencies:[],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],journalOptions:{canReverse:false,modules:[]},pendingInvoiceOptions:{customers:[]}})}));
  await embedded.setContent('<iframe id="report" src="http://localhost:3000/accounting-reports.html" style="width:1400px;height:850px"></iframe>');
  const report=embedded.frameLocator('#report');
  await report.locator('header .gentia-brand-runtime img').waitFor();
  assert.equal(await report.locator('link[href^="/gentia-theme.css"]').count(),1);
  assert.equal(await report.locator('header .gentia-brand-runtime img').getAttribute('src'),'/gentia-wordmark-reversed.svg');
  assert.equal(await report.locator('body > header').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(4, 46, 114)');

  const reducedContext=await browser.newContext({reducedMotion:'reduce'});
  const reduced=await reducedContext.newPage();
  await reduced.goto('http://localhost:3000/gentia-logo.svg');
  assert.equal(await reduced.locator('.gentia-motion').first().evaluate(element=>getComputedStyle(element).display),'none');
  assert.notEqual(await reduced.locator('.gentia-reduced').first().evaluate(element=>getComputedStyle(element).display),'none');
  await reducedContext.close();

  console.log(JSON.stringify({passed:true,login:true,mobile:true,workspace:true,standalone:true,reducedMotion:true}));
}finally{
  await browser.close();
}
