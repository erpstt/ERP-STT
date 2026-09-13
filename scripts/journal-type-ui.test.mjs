import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage();
 const row={journal_id:194,journal_number:'ASI_PEN-00000001',journal_type:'Asientos Pendientes de Facturar',journal_date:'2026-09-13',transaction_id:194,exchange_rate:1};
 await page.route('**/api/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/accounting/journals'?[row]:[]}));
 await page.goto('http://localhost:3000');
 await page.evaluate(row=>{
  const app=document.querySelector('#app')._vnode.component.proxy;
  app.authenticated=true;app.sessionReady=true;app.currentModule='Contabilidad';app.currentSection='Asientos contables';
  app.activeCompany={subsidiaryId:3,name:'Prueba'};app.rows=[row];
  localStorage.setItem('nexo_token','fixture');localStorage.setItem('nexo_device_token','fixture-device');
 },row);
 await page.getByRole('cell',{name:row.journal_type,exact:true}).waitFor();
 assert.equal(await page.getByRole('columnheader',{name:'Tipo de asiento',exact:true}).count(),1);
 assert.equal(await page.getByRole('cell',{name:'Asiento de Diario General',exact:true}).count(),0);
 await page.evaluate(()=>{const frame=document.createElement('iframe');frame.id='journal-test';frame.src='/journal-view.html?id=194';document.body.append(frame);});
 const frame=page.frameLocator('#journal-test');
 await frame.locator('#journalTitle').getByText(row.journal_type,{exact:true}).waitFor();
 assert.equal(await frame.locator('#number').innerText(),row.journal_number);
 console.log(JSON.stringify({passed:true,listType:true,documentTitle:true,number:true}));
}finally{await browser.close();}
