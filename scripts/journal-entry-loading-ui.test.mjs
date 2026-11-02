import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium} from '@playwright/test';

const header={
 transactionTypes:[{abbreviation:'ASI_DIA',name:'Asiento de Diario General'},{abbreviation:'ASI_PEN',name:'Asientos Pendientes de Facturar'},{abbreviation:'ASI_NOM',name:'Asiento de Nómina'},{abbreviation:'ASI_LIQ',name:'Asiento de Liquidación'}],
 subsidiaries:[{subsidiary_id:1,name:'Synthetic subsidiary',currency_id:1,country_id:1,allowed_currency_ids:[1,2]}],
 locations:[{location_id:5,subsidiary_id:1,name:'Synthetic location'}],
 currencies:[{currency_id:1,currency_code:'CRC',name:'Colón'},{currency_id:2,currency_code:'USD',name:'Dólar'}],
 periods:[{fiscal_period_id:10,subsidiary_id:1,period_name:'Synthetic 2026',start_date:'2026-01-01',end_date:'2026-12-31',is_inactive:false}],
 rates:[{from_currency_id:2,to_currency_id:1,effective_date:'2026-01-01',spot_rate:500}],
};
const lineOptions={
 accounts:[{account_id:201,account_number:'101',account_name:'Synthetic debit',accepts_entries:true,is_inactive:false,subsidiary_ids:[1]},{account_id:202,account_number:'201',account_name:'Synthetic credit',accepts_entries:true,is_inactive:false,subsidiary_ids:[1]}],
 taxes:[],taxTypes:[],departments:[{department_id:21,name:'Synthetic department',type:'Interno',subsidiary_id:1}],
 classes:[],costs:[],creditors:[],related:[],customers:[],suppliers:[{supplier_id:31,company_name:'Synthetic supplier',subsidiary_ids:[1]}],employees:[],countries:[{country_id:1,name:'Costa Rica'}],
};
const edit={journal:{journal_id:17,journal_number:'ASI_DIA-SYN-17',journal_type:'Asiento de Diario General',journal_date:'2026-10-10',subsidiary_id:1,fiscal_period_id:10,currency_id:2,exchange_rate:515.123456,memo:'Synthetic saved memo'},lines:[
 {journal_line_id:1,account_id:201,debit:100,credit:0,gross_amount:100,entity_type:'Proveedor',supplier_id:31,department_id:21,note:'Synthetic saved debit'},
 {journal_line_id:2,account_id:202,debit:0,credit:100,gross_amount:100,note:'Synthetic saved credit'},
]};

test('asiento carga cabecera sin esperar líneas, limita consultas y recupera errores conservando los datos', {timeout:150000},async t=>{
 const root=resolve('public');
 const server=createServer(async(req,res)=>{try{const file=resolve(root,'.'+new URL(req.url,'http://fixture').pathname);if(!file.startsWith(root+sep))throw Error('Invalid path');res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const origin=`http://127.0.0.1:${server.address().port}`;
 async function scenario({editMode=false,headerFailures=0,lineFailures=0,supportFailures=0,holdLines=false}={}){
  const page=await browser.newPage({viewport:{width:1500,height:1000}}),calls=[],errors=[],unexpected=[];
  let releaseLines;const lineGate=new Promise(done=>releaseLines=done),attempts={header:0,lines:0,supports:0};
  await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-journal-token');localStorage.setItem('nexo_device_token','synthetic-journal-device');localStorage.setItem('nexo_company','1');localStorage.setItem('nexo_company_name','Synthetic subsidiary');});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
   const call={path:url.pathname,section:url.searchParams.get('section'),id:url.searchParams.get('id'),method:request.method()};calls.push(call);
   assert.equal(request.headers().authorization,'Bearer synthetic-journal-token');assert.equal(request.headers()['x-device-token'],'synthetic-journal-device');assert.equal(request.method(),'GET');
   if(url.pathname==='/api/accounting/journal-entry/options'){
    const section=url.searchParams.get('section');assert.ok(['header','lines'].includes(section));assert.equal(url.searchParams.get('id'),editMode?'17':null);attempts[section]++;
    if(section==='lines'&&holdLines)await lineGate;
    if(attempts[section]<=(section==='header'?headerFailures:lineFailures))return route.fulfill({status:503,json:{error:{message:`Synthetic ${section} unavailable`}}});
    return route.fulfill({json:section==='header'?header:lineOptions});
   }
   if(url.pathname==='/api/accounting/journal-entry/17')return route.fulfill({json:edit});
   if(url.pathname==='/api/accounting/journal-entry/17/supports'){
    attempts.supports++;if(attempts.supports<=supportFailures)return route.fulfill({status:503,json:{error:{message:'Synthetic supports unavailable'}}});
    return route.fulfill({json:[{support_id:91,journal_id:17,support_type:'Enlace',display_name:'Synthetic own support',support_url:'https://example.invalid/support'}]});
   }
   unexpected.push(call);return route.fulfill({status:400,json:{error:{message:'Unexpected fixture API'}}});
  });
  await page.goto(origin+'/journal-entry.html'+(editMode?'?id=17':''));
  return{page,calls,errors,unexpected,attempts,releaseLines,close:async()=>{releaseLines();assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);await page.close();}};
 }

 const progressive=await scenario({holdLines:true});
 await progressive.page.waitForFunction(()=>document.querySelector('#journalType').value==='Asiento de Diario General');
 assert.equal(await progressive.page.locator('#location').innerText(),'Synthetic location');
 assert.match(await progressive.page.locator('#journalDate').inputValue(),/^\d{4}-\d{2}-\d{2}$/);
 await mkdir('.local-tools',{recursive:true});await progressive.page.screenshot({path:'.local-tools/journal-loading-header-ready.png',fullPage:true});
 assert.equal(await progressive.page.locator('#save').isDisabled(),true);assert.equal(await progressive.page.locator('#addLine').isDisabled(),true);
 await progressive.page.locator('#memo').fill('Written while line catalogs are loading');
 await progressive.page.locator('#journalDate').fill('2026-10-10');await progressive.page.locator('#journalDate').dispatchEvent('change');
 await progressive.page.locator('#currency').selectOption('2');
 progressive.releaseLines();await progressive.page.waitForFunction(()=>!document.querySelector('#addLine').disabled);
 assert.equal(await progressive.page.locator('#memo').inputValue(),'Written while line catalogs are loading');assert.equal(await progressive.page.locator('#journalDate').inputValue(),'2026-10-10');assert.equal(await progressive.page.locator('#currency').inputValue(),'2');assert.equal(Number(await progressive.page.locator('#rate').inputValue()),500);
 assert.equal(await progressive.page.locator('#lines tr').count(),2);assert.equal(progressive.calls.length,2);assert.ok(progressive.calls.every(call=>call.path==='/api/accounting/journal-entry/options'));
 await progressive.page.screenshot({path:'.local-tools/journal-loading-ready.png',fullPage:true});
 await progressive.page.locator('#journalType').selectOption('Asientos Pendientes de Facturar');assert.equal(await progressive.page.locator('#lines tr').first().locator('[data-key=service_country_id]').inputValue(),'1');assert.equal(await progressive.page.locator('#lines tr').first().locator('[data-key=service_month]').isDisabled(),false);
 await progressive.page.locator('#supportsTab').click();assert.equal(progressive.calls.length,2);assert.equal(progressive.attempts.supports,0);
 await progressive.close();

 const failedLines=await scenario({lineFailures:1});await failedLines.page.locator('#retryJournalLoad').waitFor({state:'visible'});
 await failedLines.page.waitForFunction(()=>document.querySelector('#journalType').value==='Asiento de Diario General');
 assert.match(await failedLines.page.locator('#journalLoadMessage').innerText(),/Synthetic lines unavailable/);assert.equal(await failedLines.page.locator('#save').isDisabled(),true);
 await failedLines.page.locator('#memo').fill('Preserve memo on retry');await failedLines.page.locator('#currency').selectOption('2');
 await failedLines.page.locator('#journalDate').fill('2026-10-11');await failedLines.page.locator('#journalDate').dispatchEvent('change');
 await failedLines.page.locator('#retryJournalLoad').click();await failedLines.page.waitForFunction(()=>!document.querySelector('#addLine').disabled);
 assert.equal(await failedLines.page.locator('#memo').inputValue(),'Preserve memo on retry');assert.equal(await failedLines.page.locator('#journalDate').inputValue(),'2026-10-11');assert.equal(await failedLines.page.locator('#currency').inputValue(),'2');assert.deepEqual(failedLines.attempts,{header:1,lines:2,supports:0});assert.equal(await failedLines.page.locator('#lines tr').count(),2);await failedLines.close();

 const failedHeader=await scenario({headerFailures:1});await failedHeader.page.locator('#retryJournalLoad').waitFor({state:'visible'});
 assert.match(await failedHeader.page.locator('#journalLoadMessage').innerText(),/Synthetic header unavailable/);assert.doesNotMatch(await failedHeader.page.locator('#journalType').innerText(),/Cargando/);assert.doesNotMatch(await failedHeader.page.locator('#location').innerText(),/Cargando/);
 assert.equal(await failedHeader.page.locator('#save').isDisabled(),true);assert.equal(await failedHeader.page.locator('#memo').isDisabled(),true);await failedHeader.page.locator('#retryJournalLoad').click();await failedHeader.page.waitForFunction(()=>!document.querySelector('#save').disabled);
 assert.equal(await failedHeader.page.locator('#memo').inputValue(),'');assert.deepEqual(failedHeader.attempts,{header:2,lines:1,supports:0});await failedHeader.close();

 const editing=await scenario({editMode:true,supportFailures:1});await editing.page.waitForFunction(()=>!document.querySelector('#save').disabled);
 assert.equal(await editing.page.locator('#journalNumber').inputValue(),'ASI_DIA-SYN-17');assert.equal(await editing.page.locator('#journalDate').inputValue(),'2026-10-10');assert.equal(await editing.page.locator('#currency').inputValue(),'2');assert.equal(Number(await editing.page.locator('#rate').inputValue()),515.123456);assert.equal(await editing.page.locator('#memo').inputValue(),'Synthetic saved memo');
 assert.equal(await editing.page.locator('#lines tr').count(),2);assert.equal(await editing.page.locator('#lines tr').first().locator('[data-key=entity_id]').inputValue(),'31');assert.equal(await editing.page.locator('#lines tr').first().locator('[data-key=note]').inputValue(),'Synthetic saved debit');assert.equal(editing.calls.length,3);assert.equal(editing.attempts.supports,0);
 await editing.page.locator('#supportsTab').click();await editing.page.locator('#supportsRetry').waitFor({state:'visible'});assert.match(await editing.page.locator('#supportsStatus').innerText(),/Synthetic supports unavailable/);
 await editing.page.locator('#supportsRetry').click();await editing.page.locator('#supportList').getByText('Synthetic own support',{exact:true}).waitFor();assert.equal(editing.attempts.supports,2);
 await editing.page.locator('#linesTab').click();await editing.page.locator('#supportsTab').click();assert.equal(editing.attempts.supports,2);assert.equal(await editing.page.locator('#memo').inputValue(),'Synthetic saved memo');await editing.close();
});
