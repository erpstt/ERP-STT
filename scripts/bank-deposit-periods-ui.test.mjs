import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {chromium,expect} from '@playwright/test';

const publicRoot=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const period=(id,name,start,end,flags={})=>({fiscal_period_id:id,period_name:name,subsidiary_id:24,start_date:start,end_date:end,is_closed:false,is_inactive:false,gl_closed:false,...flags});
const october=period(2410,'octubre 2026','2026-10-01','2026-10-31');
const november=period(2411,'noviembre 2026','2026-11-01','2026-11-30');
const options={
  subsidiary:{id:24,name:'Empresa sint\u00e9tica Jamaica',currencyId:11},
  location:{id:240,name:'Jamaica sint\u00e9tica'},
  accounts:[{id:6419,bankId:8,bankName:'Banco sint\u00e9tico',number:'20000006419',currencyId:11,currencyCode:'JMD',ledgerAccountId:110001,balance:100}],
  periods:[{...october,fiscal_period_id:9910,subsidiary_id:99},october,november]
};
const chart=[
  {account_id:110001,account_number:'110001',account_name:'Banco sint\u00e9tico',subsidiary_ids:[24],accepts_entries:true,is_inactive:false,is_summary:false},
  {account_id:421001,account_number:'421001',account_name:'Intereses ganados sint\u00e9ticos',subsidiary_ids:[24],accepts_entries:true,is_inactive:false,is_summary:false}
];
const legacyBankAccounts=[{bank_account_id:6419,bank_id:8,account_number:'20000006419',currency_id:11,account_id:110001,subsidiary_id:24,balance:100,is_credit_card:false}];
const detail={deposit:{deposit_id:7,deposit_number:'DEP-SYN-7',bank_reference:'REF-SYN-7',deposit_date:'2026-10-31',fiscal_period_id:2410,bank_account_id:6419,currency_id:11,location_id:240,locationName:'Jamaica sint\u00e9tica',memo:'Dep\u00f3sito sint\u00e9tico'},lines:[{amount:13.9,account_id:421001,payment_method_id:1,note:'Intereses sint\u00e9ticos'}],impact:[]};
let server,browser,base;

test.before(async()=>{
  server=createServer(async(request,response)=>{
    try{
      const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
      const file=resolve(publicRoot,`.${pathname}`);
      if(!file.startsWith(publicRoot+sep)){response.writeHead(403);response.end();return;}
      const content=await readFile(file);
      response.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});
      response.end(content);
    }catch{response.writeHead(404);response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser=await chromium.launch({headless:true,...(existsSync(chrome)?{executablePath:chrome}:{})});
});

test.after(async()=>{
  await browser?.close();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

async function fixture(t,{periods=options.periods,optionsStatus=200,omitPeriods=false,edit=false,locationsStatus=200,locations=[{location_id:240,name:'Jamaica sint\u00e9tica',subsidiary_id:24}]}={}){
  const context=await browser.newContext({viewport:{width:1500,height:950}});
  t.after(()=>context.close());
  await context.addInitScript(()=>{
    localStorage.setItem('nexo_token','synthetic-deposit-periods');
    localStorage.setItem('nexo_device_token','synthetic-device');
    localStorage.setItem('nexo_company','24');
  });
  const page=await context.newPage(),calls=[],errors=[];
  page.setDefaultTimeout(8000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
    const body=['POST','PUT','PATCH'].includes(method)?request.postDataJSON():null;
    calls.push({path,method,body});
    if(path==='/api/banking/deposits/options'){
      const response=structuredClone(options);
      if(omitPeriods)delete response.periods;else response.periods=structuredClone(periods);
      await route.fulfill({status:optionsStatus,json:optionsStatus===200?response:{error:{message:'No fue posible cargar las opciones del dep\u00f3sito.'}}});
      return;
    }
    if(path==='/api/organization/accounting-periods'){
      await route.fulfill({status:403,json:{error:{message:'Cat\u00e1logo fiscal no autorizado.'}}});
      return;
    }
    if(path==='/api/organization/locations'){
      await route.fulfill({status:locationsStatus,json:locationsStatus===200?locations:{error:{message:'Cat\u00e1logo de ubicaciones no autorizado.'}}});return;
    }
    if(path==='/api/banking/deposits/7'&&method==='GET'){
      await route.fulfill({json:detail});return;
    }
    if(path==='/api/banking/deposit-entry'&&method==='POST'||path==='/api/banking/deposits/7'&&method==='PUT'){
      await route.fulfill({json:{depositId:7,journalId:70,transactionNumber:'DEP-SYN-7',total:13.9}});return;
    }
    const catalogs={
      '/api/banking/banks':[{bank_id:8,bank_name:'Banco sint\u00e9tico'}],
      '/api/banking/bank-accounts':legacyBankAccounts,
      '/api/accounting/chart-accounts':chart,
      '/api/configuration/payment-methods':[{payment_method_id:1,method_name:'Transferencia sint\u00e9tica'}],
      '/api/organization/subsidiaries':[{subsidiary_id:24,name:'Empresa sint\u00e9tica Jamaica',currency_id:11}],
      '/api/organization/locations':[{location_id:240,name:'Jamaica sint\u00e9tica',subsidiary_id:24}],
      '/api/core/currencies':[{currency_id:11,currency_code:'JMD',name:'D\u00f3lar jamaicano'}]
    };
    await route.fulfill({json:catalogs[path]??[]});
  });
  await page.goto(`${base}/bank-deposit-entry.html${edit?'?id=7':''}`,{waitUntil:'load'});
  return{page,calls,errors};
}

async function completeDeposit(page,date='2026-10-31'){
  await page.selectOption('#bank','8');
  await page.selectOption('#bankAccount','6419');
  await page.fill('#depositDate',date);
  await page.locator('#depositDate').dispatchEvent('change');
  await page.fill('#memo','Intereses sint\u00e9ticos');
  await page.fill('#lines .account-search','421001');
  await page.locator('#lines .account-search').dispatchEvent('input');
  await page.fill('#lines [data-key="amount"]','13,90');
  await page.selectOption('#lines [data-key="payment_method_id"]','1');
}

const writes=app=>app.calls.filter(call=>call.method==='POST'&&call.path==='/api/banking/deposit-entry'||call.method==='PUT'&&call.path==='/api/banking/deposits/7');
const noLegacyPeriods=app=>assert.equal(app.calls.some(call=>call.path==='/api/organization/accounting-periods'),false,'Los dep\u00f3sitos no deben depender del permiso de consulta del cat\u00e1logo fiscal.');

test('deposito usa octubre abierto de la empresa activa sin consultar el catalogo fiscal',{timeout:30000},async t=>{
  const app=await fixture(t);
  await completeDeposit(app.page);
  await expect(app.page.locator('#period')).toHaveValue('2410');
  await expect(app.page.locator('#period option:checked')).toHaveText('octubre 2026');
  await app.page.click('#save');
  await expect(app.page.locator('#successModal')).toBeVisible();
  assert.equal(writes(app).length,1);
  assert.equal(writes(app)[0].body.fiscal_period_id,'2410');
  assert.equal(writes(app)[0].body.deposit_date,'2026-10-31');
  assert.equal(writes(app)[0].body.lines[0].amount,13.9);
  noLegacyPeriods(app);
  assert.deepEqual(app.errors,[]);
});

for(const scenario of [
  {name:'ubicacion compartida con otra filial',locations:[{location_id:240,name:'Jamaica sint\u00e9tica',subsidiary_id:3,subsidiary_ids:[3,24]}]},
  {name:'opciones del deposito sin permiso de catalogo de ubicaciones',locationsStatus:403}
]){
  test(`${scenario.name} conserva y envia la ubicacion autorizada`,{timeout:30000},async t=>{
    const app=await fixture(t,scenario);await completeDeposit(app.page);
    await expect(app.page.locator('#location')).toHaveValue('240');
    await expect(app.page.locator('#location option:checked')).toHaveText('Jamaica sint\u00e9tica');
    await app.page.click('#save');await expect(app.page.locator('#successModal')).toBeVisible();
    assert.equal(writes(app).length,1);assert.equal(writes(app)[0].body.location_id,'240');assert.deepEqual(app.errors,[]);
  });
}

test('cambiar la fecha actualiza el periodo y una fecha sin periodo no envia el deposito',{timeout:30000},async t=>{
  const app=await fixture(t);
  await completeDeposit(app.page);
  await expect(app.page.locator('#period')).toHaveValue('2410');
  await app.page.fill('#depositDate','2026-11-03');
  await app.page.locator('#depositDate').dispatchEvent('change');
  await expect(app.page.locator('#period')).toHaveValue('2411');
  await app.page.fill('#depositDate','2026-12-01');
  await app.page.locator('#depositDate').dispatchEvent('change');
  await expect(app.page.locator('#period')).toHaveValue('');
  await app.page.click('#save');
  await expect(app.page.locator('#error')).toContainText(/No existe.*per\u00edodo.*fecha/i);
  assert.equal(writes(app).length,0);
  noLegacyPeriods(app);
  assert.deepEqual(app.errors,[]);
});

for(const flag of ['is_closed','is_inactive','gl_closed']){
  test(`periodo ${flag} no se selecciona ni permite guardar`,{timeout:30000},async t=>{
    const app=await fixture(t,{periods:[{...october,[flag]:true},november]});
    await completeDeposit(app.page);
    await expect(app.page.locator('#period')).toHaveValue('');
    await app.page.click('#save');
    await expect(app.page.locator('#error')).toContainText(/per\u00edodo.*(abierto|cerrado|inactivo|fecha)/i);
    assert.equal(writes(app).length,0);
    assert.deepEqual(app.errors,[]);
  });
}

for(const scenario of [
  {name:'respuesta sin periodos',omitPeriods:true},
  {name:'periodos invalidos',periods:null},
  {name:'error de carga',optionsStatus:503}
]){
  test(`${scenario.name} muestra fallo de carga en vez de afirmar que no hay periodo`,{timeout:30000},async t=>{
    const app=await fixture(t,scenario);
    await expect(app.page.locator('#error')).toContainText(/carg|opciones|consult|disponib/i);
    if(!(await app.page.locator('#save').isDisabled())){
      await completeDeposit(app.page);
      await app.page.click('#save');
    }
    const message=await app.page.locator('#error').textContent();
    assert.doesNotMatch(message,/No existe.*per\u00edodo.*fecha/i);
    assert.match(message,/carg|opciones|consult|disponib/i);
    assert.equal(writes(app).length,0);
    noLegacyPeriods(app);
    assert.deepEqual(app.errors,[]);
  });
}

test('edicion conserva octubre desde las opciones y envia su periodo al actualizar',{timeout:30000},async t=>{
  const app=await fixture(t,{edit:true});
  await expect(app.page.locator('h1')).toContainText('DEP-SYN-7');
  await expect(app.page.locator('#save')).toBeEnabled();
  await expect(app.page.locator('#depositDate')).toHaveValue('2026-10-31');
  await expect(app.page.locator('#period')).toHaveValue('2410');
  await app.page.fill('#memo','Nota editada sint\u00e9tica');
  await app.page.click('#save');
  await expect(app.page.locator('#successModal')).toBeVisible();
  assert.equal(writes(app).length,1);
  assert.equal(writes(app)[0].method,'PUT');
  assert.equal(writes(app)[0].body.fiscal_period_id,'2410');
  assert.equal(writes(app)[0].body.deposit_date,'2026-10-31');
  noLegacyPeriods(app);
  assert.deepEqual(app.errors,[]);
});
