import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {expect} from '@playwright/test';
import {bankBrowserFixture} from './lib/bank-browser-fixture.mjs';
import {currencyGroups} from '../dist/modules/reports/classified-receivables.service.js';
const options={subsidiaries:[{id:10,name:'Empresa de prueba',currencyId:1}],currencies:[{id:1,code:'USD'}],books:[],costCenters:[],agingOptions:{customers:[],salesRepresentatives:[]}};
const rows=[{document_id:1,entity_name:'Cliente de prueba',document_number:'FAC-001',issue_date:'2026-10-01',due_date:'2026-10-31',original_amount:1000,applied_amount:200,pending:800,bucket:'1_30',discounted:false,intercompany:false,currency_code:'USD'},{document_id:2,entity_name:'Empresa relacionada',document_number:'FAC-002',issue_date:'2026-10-01',due_date:'2026-10-31',original_amount:5000,applied_amount:0,pending:5000,bucket:'CURRENT',discounted:false,intercompany:true,currency_code:'USD'},{document_id:3,entity_name:'<img src=x onerror="window.xss=1">',document_number:'FAC-003',issue_date:'2026-10-01',due_date:'2026-10-31',original_amount:2000,applied_amount:500,pending:1500,bucket:'1_30',discounted:true,intercompany:false,currency_code:'USD'}];
test('switch moves invoices, persists across month and reload, undoes, escapes data and downloads directly',{timeout:45000},async t=>{
 const {page,baseURL}=await bankBrowserFixture(t);const docs=structuredClone(rows),calls=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{localStorage.setItem('nexo_company','10');localStorage.setItem('nexo_token','synthetic');window.print=()=>{throw Error('printing prohibited');};});
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;
 if(path.endsWith('/options'))return route.fulfill({json:options});
 if(path.endsWith('/run')){const filters=route.request().postDataJSON(),report={rows:docs,total:docs.length,summary:{}};calls.push(filters);return route.fulfill({json:{...report,blocks:currencyGroups(report,filters,options)}});}
 if(path.endsWith('/mark')){const input=route.request().postDataJSON(),row=docs.find(r=>r.document_id===input.invoiceId);assert.equal(input.expected,row.discounted);row.discounted=input.discounted;return route.fulfill({json:{discounted:row.discounted}});}
 if(path.endsWith('/pdf')||path.endsWith('/excel')){const pdf=path.endsWith('/pdf');return route.fulfill({json:{fileName:pdf?'reporte.pdf':'reporte.xlsx',mimeType:pdf?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',base64:Buffer.from(pdf?'%PDF-synthetic':'synthetic-xlsx').toString('base64')}});}
 throw Error('Unexpected API '+path);
 });
 await page.goto(baseURL+'/classified-receivables.html');await expect(page.locator('#message')).toContainText('Seleccione');await page.locator('#consult').click();await expect(page.locator('#message')).toContainText('3 facturas');
 const block=key=>page.locator(`[data-block="${key}"]`);
 await expect(block('CUSTOMER')).toContainText('FAC-001');await expect(block('INTERCOMPANY')).toContainText('FAC-002');await expect(block('DISCOUNTED')).toContainText('FAC-003');assert.equal(await page.evaluate(()=>window.xss),undefined);
 await block('INTERCOMPANY').locator('[data-mark="2"]').click();await expect(block('DISCOUNTED')).toContainText('FAC-002');await expect(block('INTERCOMPANY')).toContainText('Sin facturas');
 await page.locator('#cutoff').fill('2026-12-31');await page.locator('#cutoff').dispatchEvent('change');await expect(page.locator('#pdf')).toBeDisabled();await page.locator('#consult').click();await expect(block('DISCOUNTED')).toContainText('FAC-002');
 await page.reload();await expect(page.locator('#message')).toContainText('Seleccione');await page.locator('#consult').click();await expect(block('DISCOUNTED')).toContainText('FAC-002');
 await block('DISCOUNTED').locator('[data-mark="2"]').click();await expect(block('INTERCOMPANY')).toContainText('FAC-002');
 for(const format of ['pdf','excel']){const pending=page.waitForEvent('download');await page.locator('#'+format).click();const download=await pending;assert.equal(download.suggestedFilename(),format==='pdf'?'reporte.pdf':'reporte.xlsx');}
 await mkdir('.local-tools/classified-receivables-qa',{recursive:true});await page.screenshot({path:'.local-tools/classified-receivables-qa/desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.local-tools/classified-receivables-qa/mobile.png',fullPage:true});
 assert.ok(calls.some(f=>f.dateTo==='2026-12-31'));assert.deepEqual(errors,[]);
});
