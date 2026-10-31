import assert from 'node:assert/strict';import{test}from'node:test';import{createServer}from'node:http';import{readFile}from'node:fs/promises';import{resolve,extname,sep}from'node:path';import{chromium}from'@playwright/test';
test('interfaz separa lectura, capitalizacion/desglose y descarte con datos ficticios',{timeout:30000},async t=>{
 const root=resolve('public');const server=createServer(async(req,res)=>{try{const p=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!p.startsWith(root+sep))throw Error();const data=await readFile(p);res.setHeader('Content-Type',extname(p)==='.js'?'text/javascript':extname(p)==='.css'?'text/css':'text/html');res.end(data);}catch{res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());let writes=0;
 for(const mode of ['reader','creator','editor']){const page=await browser.newPage();await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-ui-token');localStorage.setItem('nexo_device_token','synthetic-ui-device-token');});
  await page.route('**/api/**',async route=>{assert.ok(route.request().url().endsWith('/proposals/report'));if(!route.request().url().endsWith('/proposals/report'))writes++;
   await route.fulfill({json:{rows:[{proposal_id:1,source_number:'SYNTHETIC',source_date:'2026-10-01',amount_local:1200,amount_foreign:1200,account_id:201,currency_code:'CRC',is_ppe:true}],reconciliation:{balanced:true,hasPrimaryBook:true,gl:1200,auxiliary:0,pending:1200,difference:0},options:{canManage:mode!=='reader',canCapitalize:mode==='creator',canDiscard:mode==='editor',currency:{code:'CRC'},categories:[{id:1,name:'Synthetic',accountId:201}],locations:[{id:1,name:'Synthetic'}],departments:[],classes:[],costs:[],expenseAccounts:[{id:203,name:'Synthetic expense'}]}}});});
  await page.goto(`http://127.0.0.1:${server.address().port}/asset-proposals.html`);await page.locator('#count').filter({hasText:'1 propuestas'}).waitFor();
  if(mode==='reader'){assert.equal(await page.locator('[data-capitalize]').count(),0);assert.equal(await page.locator('#group').isHidden(),true);}else{
   assert.equal(await page.locator('[data-capitalize]').isDisabled(),mode!=='creator');assert.equal(await page.locator('[data-discard]').isDisabled(),mode!=='editor');
   if(mode==='creator'){await page.locator('[data-split]').click();assert.equal(await page.locator('#quantity').inputValue(),'2');}else await page.locator('[data-discard]').click();
   assert.equal(await page.locator('#modal').isVisible(),true);assert.equal(await page.locator('#discardFields').isHidden(),mode!=='editor');await page.locator('#cancel').click();
  }await page.close();
 }assert.equal(writes,0);
});
