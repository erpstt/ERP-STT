import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {chromium} from '@playwright/test';
import ExcelJS from 'exceljs';
const attack='"><img src=x onerror="window.__xss=true"> & <b>dato</b>';
test('páginas de reportes: carga y descarga con API simuladas',{timeout:90000},async t=>{
 const root=resolve('public'),server=createServer(async(req,res)=>{try{const p=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!p.startsWith(root+sep))throw Error();res.setHeader('Content-Type',extname(p)==='.js'?'text/javascript':extname(p)==='.css'?'text/css':'text/html');res.end(await readFile(p));}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const base=process.env.A03_REPORT_UI_URL||`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const catalog=JSON.parse(await readFile(new URL('./fixtures/supplier-invoice-ui.json',import.meta.url),'utf8'));
 const options={subsidiaries:[{id:1,name:attack,currencyId:1}],currencies:[{id:1,code:'USD',symbol:attack}],books:[],periods:[],departments:[],locations:[],classes:[],costCenters:[],accounts:[],thirdParties:[],accountGroups:[],journalOptions:{canReverse:false,modules:[]},pendingInvoiceOptions:{customers:[]},agingOptions:{customers:[],suppliers:[]}};
 for(const file of ['accounting-reports.html?reporte=general-ledger','fixed-assets-reports.html?report=depreciation','consolidation.html'])await t.test(file,{timeout:25000},async st=>{
  const context=await browser.newContext();st.after(()=>context.close());const calls=[];
  await context.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-report-ui');localStorage.setItem('nexo_device_token','synthetic-report-device');localStorage.setItem('nexo_company','1');window.__downloads=[];const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{window.__downloads.push(blob);return create(blob);};const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(!this.hasAttribute('download'))return click.call(this);};});
  await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  await context.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;calls.push({path,method:req.method()});let json=catalog[path]??[];
   if(path==='/api/auth/companies')json=[{subsidiaryId:1,name:'Synthetic company'}];
   else if(path==='/api/reports/accounting/options')json=options;
   else if(path==='/api/reports/accounting/general-ledger')json={rows:[{account_id:1,account_number:'1101',account_name:attack,nature:'DEUDORA',journal_id:attack,journal_number:attack,transaction_number:'=1+1',date:'2026-11-02',debit:100,credit:0,opening_balance:0,running_balance:100,account_debit_total:100,account_final_balance:100}],total:1,summary:{}};
   else if(path==='/api/fixed-assets/analytics')json={subsidiary:{currency:'USD'},assetOptions:[{id:attack,number:'SYN',name:attack}],depreciations:[{date:'2026-11-02',period:attack,number:'SYN',asset:attack,category:'=1+1',amount:100,accumulated:200,assetId:1}]};
   else if(path==='/api/v1/accounting/consolidation')json={canRun:false,holding:{name:attack},currency:{code:attack},periods:[attack]};
   await route.fulfill({json});
  });
  const page=await context.newPage();await page.goto(base+'/index.html');await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
  await page.evaluate(url=>{const frame=document.createElement('iframe');frame.id='report-under-test';frame.src=url;document.body.append(frame);},new URL('/'+file,base).href);
  const frame=await(await page.locator('#report-under-test').elementHandle()).contentFrame();
  await frame.waitForFunction(attack=>document.body.textContent.includes(attack),attack);
  assert.equal(await frame.locator('img[src="x"],[onerror],svg[onload]').count(),0);assert.equal(await frame.evaluate(()=>window.__xss===true),false);assert.equal(await frame.evaluate(()=>localStorage.getItem('nexo_token')),'synthetic-report-ui');
  if(file.startsWith('consolidation')){assert.equal(await frame.locator('#holding option').textContent(),attack);assert.equal(await frame.locator('#period').inputValue(),attack);assert.ok(!calls.some(c=>c.method==='POST'&&c.path.startsWith('/api/v1/accounting/consolidation')),JSON.stringify(calls));}
  else{
   await frame.waitForFunction(attack=>document.getElementById('tbody')?.textContent.includes(attack),attack);
   if(file.startsWith('fixed'))assert.equal(await frame.locator('#asset option').nth(1).getAttribute('value'),attack);
   else assert.equal(await frame.locator('[data-journal]').first().getAttribute('data-journal'),attack);
   await frame.locator('#excel').click();await frame.waitForFunction(()=>window.__downloads.length>0);const bytes=await frame.evaluate(async()=>Array.from(new Uint8Array(await window.__downloads.at(-1).arrayBuffer()))),book=new ExcelJS.Workbook();await book.xlsx.load(Uint8Array.from(bytes).buffer);
   const values=[];for(const sheet of book.worksheets)sheet.eachRow(row=>row.eachCell(cell=>{values.push(cell.value);if(typeof cell.value==='string')assert.equal(cell.type,ExcelJS.ValueType.String);if(cell.formula)assert.match(cell.formula,/^SUM\([A-Z]+\d+:[A-Z]+\d+\)$/);}));assert.ok(values.includes(attack));assert.ok(values.includes('=1+1'));assert.ok(values.includes(100));assert.equal(await frame.locator('img[src="x"],[onerror],svg[onload]').count(),0);
   const before=await frame.evaluate(()=>window.__downloads.length);await frame.locator('#csv').click();await frame.waitForFunction(before=>window.__downloads.length>before,before);const csv=await frame.evaluate(()=>window.__downloads.at(-1).text());assert.ok(csv.includes('"\t=1+1"'));assert.ok(csv.includes('"100"'));
  }
  assert.ok(!calls.some(c=>c.method==='PUT'||c.method==='DELETE'||c.method==='POST'&&!['/api/tax-calendar/list','/api/reports/accounting/general-ledger','/api/fixed-assets/analytics','/api/auth/session/validate','/api/auth/device/validate'].includes(c.path)&&!c.path.startsWith('/api/auth/')),JSON.stringify(calls));
 });
});
