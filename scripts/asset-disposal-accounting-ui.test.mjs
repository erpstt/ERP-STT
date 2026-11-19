import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium} from '@playwright/test';
test('sale previews before posting; settings and cut use separate actions; non-sale disables proceeds',async t=>{
 const root=resolve('public');const server=createServer(async(req,res)=>{try{const p=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!p.startsWith(root+sep))throw Error();res.setHeader('Content-Type',extname(p)==='.js'?'text/javascript':extname(p)==='.css'?'text/css':'text/html');res.end(await readFile(p));}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1600,height:1100}});const errors=[],actions=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.setItem('nexo_token','synthetic-disposal');window.NexoRecordAudit={show(){}}});
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let result;
  if(path.endsWith('/operation-options'))result={subsidiary:{id:1,name:'Synthetic company'},assets:[{id:1,number:'AF-001',name:'Equipo de oficina',status:'ACTIVO',locationId:1,bookValue:2500}],subsidiaries:[],locations:[{id:1,name:'Oficina',subsidiaryId:1}],suppliers:[]};
  else if(path.endsWith('/operation-report'))result={permissions:{canCreate:true,canEdit:true,canDelete:true},rows:[]};
  else if(path.endsWith('/disposal-accounting')){const {action,payload}=route.request().postDataJSON();actions.push(action);
   if(action==='OPTIONS')result={settings:{loss_account_id:2,sale_loss_account_id:2,gain_account_id:3},canConfigure:true,accounts:[{id:1,name:'Banco'},{id:2,name:'Pérdida'},{id:3,name:'Utilidad'}],customers:[{id:1,name:'Cliente de prueba'}],currencies:[{id:1,name:'CRC'}],taxes:[{id:1,name:'IVA',rate:13}],currencyId:1};
   else if(action==='PREVIEW'){assert.equal(payload.sale_amount,4000);result={canPost:true,bookValue:2500,gainLoss:1500,message:'Asiento listo',lines:[{account_id:1,debit:4000,credit:0},{account_id:3,debit:0,credit:4000}]};}
   else if(action==='POST'){assert.ok(payload.request_id);result={number:'BAJ-ACT-001',journalId:7,message:'Contabilizada'};}
   else result={message:'Guardado'};
  }else throw Error(path);await route.fulfill({json:result});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/asset-operations.html?type=DISPOSAL`);await page.locator('#new').click();await page.locator('#asset').selectOption('1');assert.equal(await page.locator('#saleAmount').isDisabled(),true);
 await page.locator('#disposalType').selectOption('VENTA');assert.equal(await page.locator('#saleAmount').isDisabled(),false);await page.locator('#saleAmount').fill('4000');await page.locator('#saleCustomer').selectOption('1');await page.locator('#collectionAccount').selectOption('1');await page.locator('#saleTax').selectOption('1');await page.locator('#invoiceReference').fill('EXT-001');await page.locator('#disposalNote').fill('Venta de equipo');
 await page.locator('#save').click();await page.locator('#postingPreview tbody tr').first().waitFor();assert.ok(!actions.includes('POST'));assert.equal(await page.locator('#save').textContent(),'Contabilizar salida');
 await page.screenshot({path:'.task-tmp/disposal-preview.png',fullPage:true});await page.locator('#save').click();await page.locator('#modal').waitFor({state:'hidden'});assert.equal(actions.filter(x=>x==='POST').length,1);assert.deepEqual(errors,[]);
});
