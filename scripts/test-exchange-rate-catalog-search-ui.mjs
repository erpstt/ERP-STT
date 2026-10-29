import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const rates=[
  {exchange_rate_id:12,from_currency_id:1,to_currency_id:3,effective_date:'2026-10-29',spot_rate:3.452},
  {exchange_rate_id:11,from_currency_id:1,to_currency_id:2,effective_date:'2026-10-29',spot_rate:455.21},
  {exchange_rate_id:10,from_currency_id:1,to_currency_id:4,effective_date:'2026-10-28',spot_rate:158.2977}
];
const fixtures={
  '/api/security/turnstile/config':{enabled:false},
  '/api/auth/roles':[{roleId:1,name:'Administrador'}],
  '/api/auth/select-role':{roleId:1,name:'Administrador'},
  '/api/security/my-role-access':{isAdmin:true,grants:[],modules:[]},
  '/api/auth/companies':[{subsidiaryId:1,name:'Empresa',legalName:'Empresa',currencyCode:'JMD'}],
  '/api/auth/select-company':{subsidiaryId:1,name:'Empresa',legalName:'Empresa',currencyCode:'JMD'},
  '/api/configuration/exchange-rates':rates,
  '/api/core/currencies':[
    {currency_id:1,currency_code:'USD',name:'Dólar estadounidense'},
    {currency_id:2,currency_code:'CRC',name:'Colón costarricense'},
    {currency_id:3,currency_code:'PEN',name:'Sol peruano'},
    {currency_id:4,currency_code:'JMD',name:'Dólar jamaicano'}
  ],
  '/api/organization/subsidiaries':[{subsidiary_id:1,name:'Empresa',currency_id:4,secondary_currency_ids:[1,2,3]}]
};
const page=await browser.newPage({viewport:{width:1400,height:900}}),pageErrors=[];
page.on('pageerror',error=>pageErrors.push(error.message));
await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fixtures[path]??[])});});
await page.addInitScript(()=>{const payload=btoa(JSON.stringify({email:'rates@example.test',exp:Math.floor(Date.now()/1000)+3600})).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');localStorage.setItem('nexo_token',`e30.${payload}.test`);localStorage.setItem('nexo_role','1');localStorage.setItem('nexo_company','1');});

try{
  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await page.locator('.workspace').waitFor();
  await page.locator('.nav-link').filter({hasText:'Configuración'}).click();
  await page.locator('.nav-children a').filter({hasText:'Tipos de cambio',hasNotText:'consolidados'}).click();
  await page.getByRole('heading',{name:'Tipos de cambio',exact:true}).waitFor();
  await page.locator('tbody tr').first().waitFor();
  assert.deepEqual(await page.locator('tbody .field-effective_date').allTextContents(),['2026-10-29','2026-10-29','2026-10-28']);
  const search=page.locator('input[aria-label="Buscar registros"]');
  for(const[term,expected]of[['PEN',1],['sol peruano',1],['colón costarricense',1],['2026-10-29',2],['29/10/2026',2],['28-10-2026',1]]){
    await search.fill(term);
    assert.equal(await page.locator('tbody tr').count(),expected,`La búsqueda ${term} debe devolver ${expected} registro(s).`);
  }
  await search.fill('');
  assert.deepEqual(await page.locator('tbody .field-effective_date').allTextContents(),['2026-10-29','2026-10-29','2026-10-28'],'Limpiar la búsqueda debe restaurar toda la lista en el orden original.');
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({newestFirst:true,destinationName:true,destinationCode:true,effectiveDateAliases:true,clearRestoresOrder:true}));
}finally{await browser.close();}
